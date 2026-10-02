// What leaves the machine: best-effort classification of a tool call into the
// remote hosts it is likely to reach, read from the command text. No `$` here,
// so it is easy to test and the directory can read it plainly.
//
// Labels are built only from fixed program and subcommand names, never from
// arguments, so tokens and paths in a command line are not recorded.

export type Kind = 'bash' | 'web' | 'search' | 'mcp'

export type Target = { host: string; kind: Kind; label: string }

// A git remote the command uses without spelling out a URL: resolved later
// from the repository's config. `dir` is where git runs (from cd / -C), when known.
export type GitRemote = { remote: string; op: 'push' | 'fetch'; dir: string | null; all: boolean; config?: string[] }

export const DEFAULT_ALLOW = [
  'github.com', 'githubusercontent.com', 'githubassets.com', 'ghcr.io',
  'registry.npmjs.org', 'npmjs.org', 'registry.yarnpkg.com',
  'pypi.org', 'pythonhosted.org', 'anaconda.com', 'anaconda.org',
  'crates.io', 'proxy.golang.org', 'sum.golang.org', 'rubygems.org',
  'formulae.brew.sh', 'ghcr.io', 'docker.io', 'cdn.cocoapods.org', 'anthropic.com', 'claude.ai',
]

// Hosts that never leave the machine.
export function isLocal(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

// Strip control and bidi characters before a host or label is shown or stored.
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
}

// The host of a URL with any scheme: the authority ends at / ? # and userinfo
// is only what comes before an @ inside that authority.
export function hostOfUrl(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)/i.exec(url.trim())
  if (!m) return null
  if ((m[1] as string).toLowerCase() === 'file') return null
  const authority = m[2] as string
  const hostport = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const host = hostport.startsWith('[') ? hostport.slice(0, hostport.indexOf(']') + 1) : (hostport.split(':')[0] as string)
  const h = clean(host).toLowerCase().replace(/\.$/, '')
  return h.length > 0 ? h : null
}

// A host named without a scheme (`user:pass@proxy:8080`, `proxy.example`): read as an authority so userinfo
// (a password or a token) is dropped, and refused unless what is left looks like a host name or address.
export function hostOfAuthority(value: string): string | null {
  const v = value.trim()
  const h = hostOfUrl(v) ?? hostOfUrl(`http://${v}`)
  if (h === null) return null
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h) ? h : null
}

const URL_SCAN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi

function urlHosts(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(URL_SCAN)) {
    const h = hostOfUrl(m[0])
    if (h) out.push(h)
  }
  return out
}

// A comma- or pipe-separated list of URLs (GOPROXY, extra index lists).
function listHosts(value: string): string[] {
  return value.split(/[,|\s]+/).map(v => hostOfUrl(v)).filter((h): h is string => h !== null)
}

// Shell words of one simple command: quotes removed, no expansion.
export function words(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[(i += 1)]
      else cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[(i += 1)]
      started = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (started || cur) out.push(cur)
  return out
}

// Take heredoc bodies out of the command line. A body fed to a shell (`bash <<EOF`) is commands, and an
// unquoted body still expands `$(…)` and backticks: both come back as `nested` command lines to classify.
// Any other body is input to a command and never runs.
export function stripHeredocs(command: string): { text: string; nested: string[] } {
  const lines = command.split('\n')
  const out: string[] = []
  const nested: string[] = []
  let open: { end: string; quoted: boolean; shell: boolean; body: string[] }[] = []
  for (const line of lines) {
    if (open.length > 0) {
      const cur = open[0] as { end: string; quoted: boolean; shell: boolean; body: string[] }
      if (line.replace(/^\t+/, '') === cur.end) {
        const body = cur.body.join('\n')
        if (cur.shell) nested.push(body)
        else if (!cur.quoted) for (const m of body.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g)) nested.push((m[1] ?? m[2] ?? '') as string)
        open = open.slice(1)
      } else cur.body.push(line)
      continue
    }
    out.push(line)
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      const before = line.slice(0, m.index ?? 0)
      const shell = /(^|[;&|(]\s*)(?:sudo\s+)?(?:\S*\/)?(?:ba|z|da|k)?sh(\s+-[a-z]+)*\s*$/.test(before)
      open.push({ end: m[2] as string, quoted: (m[1] ?? '') !== '', shell, body: [] })
    }
  }
  return { text: out.join('\n'), nested }
}

// Split a command line into simple commands at && || ; | & and newlines,
// outside quotes, and lift $( … ) and ` … ` bodies out as their own commands.
export function segments(command: string): string[] {
  const out: string[] = []
  const inner: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  const stripped = stripHeredocs(command)
  const text = stripped.text
  inner.push(...stripped.nested)
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      cur += ch + (text[(i += 1)] as string)
      continue
    }
    if (ch === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth += 1
        else if (text[j] === ')') depth -= 1
        j += 1
      }
      inner.push(text.slice(i + 2, j - 1))
      cur += '"$SUB"'
      i = j - 1
      continue
    }
    if (ch === '`') {
      const j = text.indexOf('`', i + 1)
      const end = j === -1 ? text.length : j
      inner.push(text.slice(i + 1, end))
      cur += '"$SUB"'
      i = end
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i += 1
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  for (const body of inner) out.push(...segments(body))
  return out
}

// Wrapper programs and the flags of theirs that take a separate argument.
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  time: new Set(['-f', '-o', '--format', '--output']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  caffeinate: new Set(['-t', '-w']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-a']),
  command: new Set(),
  exec: new Set(['-a']),
  stdbuf: new Set(['-i', '-o', '-e']),
}

type Program = { argv: string[]; env: Record<string, string>; nested: string[] }

// Drop leading VAR=value assignments and wrappers; return the program's argv,
// the env it set, and any command line a wrapper carries as a string (env -S, sh -c).
function program(input: string[]): Program {
  const env: Record<string, string> = {}
  const nested: string[] = []
  let argv = input
  for (let guard = 0; guard < 8; guard += 1) {
    let i = 0
    while (i < argv.length) {
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i] as string)
      if (!assign) break
      env[assign[1] as string] = assign[2] as string
      i += 1
    }
    argv = argv.slice(i)
    const name = base(argv[0] ?? '')
    const takes = WRAPPERS[name]
    if (takes === undefined) break
    i = 1
    while (i < argv.length) {
      const a = argv[i] as string
      if (a === '--') {
        i += 1
        break
      }
      if (name === 'env' && (a === '-S' || a === '--split-string')) {
        nested.push(argv[i + 1] ?? '')
        i += 2
        continue
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        const eq = a.indexOf('=')
        env[a.slice(0, eq)] = a.slice(eq + 1)
        i += 1
        continue
      }
      if (!a.startsWith('-')) {
        if (name === 'timeout' && /^\d/.test(a)) {
          i += 1
          continue
        }
        break
      }
      i += takes.has(a) ? 2 : 1
    }
    argv = argv.slice(i)
  }
  const name = base(argv[0] ?? '')
  if (['sh', 'bash', 'zsh', 'dash', 'fish'].includes(name)) {
    const c = argv.indexOf('-c')
    const lc = argv.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
    const at = c !== -1 ? c : lc
    if (at !== -1 && argv[at + 1] !== undefined) nested.push(argv[at + 1] as string)
  }
  if (name === 'eval') nested.push(argv.slice(1).join(' '))
  return { argv, env, nested }
}

function flagValues(argv: string[], names: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string
    for (const n of names) {
      if (a === n && argv[i + 1] !== undefined) out.push(argv[i + 1] as string)
      else if (a.startsWith(n + '=')) out.push(a.slice(n.length + 1))
      else if (n.length === 2 && !n.startsWith('--') && a.startsWith(n) && a.length > 2 && !a.startsWith('--')) out.push(a.slice(2))
    }
  }
  return out
}

// Positional arguments, skipping the values of flags that take one.
function positionals(argv: string[], takesValue: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string
    if (a === '--') {
      out.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('-')) {
      if (takesValue.has(a)) i += 1
      continue
    }
    out.push(a)
  }
  return out
}

const base = (p: string) => p.split('/').pop() ?? p

const PROXY_ENV = ['ALL_PROXY', 'all_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

// Programs whose URL arguments they actually fetch. Anything else (echo, grep,
// cat, git commit -m …) merely mentions a URL.
const DIALERS = new Set([
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'open', 'xdg-open',
  'yt-dlp', 'youtube-dl', 'ffmpeg', 'ffprobe', 'aria2c', 'lynx', 'w3m', 'links', 'httpie', 'http', 'https', 'xh',
  'psql', 'pg_dump', 'pg_restore', 'mysql', 'mysqldump', 'mongosh', 'mongo', 'mongodump', 'redis-cli', 'clickhouse-client',
  'websocat', 'wscat', 'grpcurl', 'k6', 'ab', 'hey', 'wrk', 'newman', 'lighthouse', 'playwright',
])

const CURL_ARGS = new Set([
  '-o', '--output', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-u', '--user',
  '-X', '--request', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-F', '--form',
  '-T', '--upload-file', '-w', '--write-out', '--connect-to', '--resolve', '-m', '--max-time', '--retry', '-K', '--config',
  '-E', '--cert', '--key', '--cacert', '-r', '--range', '-z', '--time-cond', '--output-dir', '-D', '--dump-header',
  '--trace', '--trace-ascii', '--stderr', '--interface', '--dns-servers', '-Y', '-y', '--limit-rate', '-C', '--continue-at',
])
const WGET_ARGS = new Set(['-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix', '-U', '--user-agent', '--header', '-t', '--tries', '-T', '--timeout', '--user', '--password', '-a', '-i', '--input-file'])

const NPM_NET = new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'publish', 'view', 'info', 'show', 'dlx', 'create', 'outdated', 'audit', 'login', 'exec', 'x', 'unpublish', 'deprecate', 'search'])
const PY_NET = new Set(['install', 'add', 'sync', 'lock', 'update', 'download', 'publish', 'upgrade'])
const GH_LOCAL = new Set(['help', 'alias', 'completion', 'config', 'version', '--version', '--help', '-h', ''])

type Ctx = { dir: string | null; env: Record<string, string>; home: string | null }

// Database and cache clients that name their server with -h / --host.
const HOST_FLAG_CLIENTS = new Set(['psql', 'pg_dump', 'pg_restore', 'mysql', 'mysqldump', 'redis-cli', 'mongosh', 'mongo', 'mongodump', 'clickhouse-client'])
// A dotted word that is a file name, not a host (`backup.tar.gz`).
const FILE_LIKE = /\.(tar|gz|tgz|bz2|xz|zip|json|txt|sh|js|mjs|ts|py|rb|md|html?|xml|ya?ml|toml|csv|log|png|jpe?g|gif|svg|pdf|lock|conf|cfg|ini|env)$/i

// The targets one simple command reaches, and remotes it names without a URL.
function classifySegment(segment: string, ctx: Ctx): { targets: Target[]; remotes: GitRemote[]; nested: string[] } {
  const targets: Target[] = []
  const remotes: GitRemote[] = []
  const { argv, env: localEnv, nested } = program(words(segment))
  const env = { ...ctx.env, ...localEnv }
  const cmd = base(argv[0] ?? '')
  const sub = argv[1] ?? ''
  const add = (host: string | null, label: string) => {
    if (host) targets.push({ host: clean(host).toLowerCase(), kind: 'bash', label })
  }
  const addUrls = (values: readonly string[], label: string) => {
    for (const v of values) add(hostOfUrl(v), label)
  }
  const operandUrls = (label: string) => {
    for (const a of argv.slice(1)) if (!a.startsWith('-') || a.includes('://')) add(hostOfUrl(a.replace(/^[^=]*=(?=[a-z][a-z0-9+.-]*:\/\/)/i, '')), label)
  }
  const proxies = (label: string) => {
    for (const k of PROXY_ENV) if (env[k]) add(hostOfAuthority(env[k] as string), `${label} proxy`)
  }

  switch (cmd) {
    case 'cd': {
      const to = argv[1]
      if (to && !to.startsWith('-') && !to.includes('$')) {
        const home = to === '~' || to.startsWith('~/') ? ctx.home : null
        if (to.startsWith('~')) ctx.dir = home === null || (to !== '~' && !to.startsWith('~/')) ? null : home + to.slice(1)
        else ctx.dir = to.startsWith('/') ? to : ctx.dir ? `${ctx.dir}/${to}` : null
      }
      break
    }
    case 'export':
      for (const a of argv.slice(1)) {
        const eq = a.indexOf('=')
        if (eq > 0) ctx.env[a.slice(0, eq)] = a.slice(eq + 1)
      }
      break
    case 'curl': case 'wget': {
      const takes = cmd === 'curl' ? CURL_ARGS : WGET_ARGS
      const pos = positionals(argv.slice(1), takes)
      for (const p of pos) {
        const bare = p.split(/[/?#]/)[0] as string
        const hostish = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(bare) && !FILE_LIKE.test(bare.split(':')[0] as string)
        add(hostOfUrl(p) ?? (hostish ? hostOfAuthority(bare) : null), cmd)
      }
      for (const v of flagValues(argv, ['-x', '--proxy', '--preproxy', '--socks5', '--socks5-hostname'])) add(hostOfAuthority(v), `${cmd} proxy`)
      // --resolve host:port:addr and --connect-to h1:p1:h2:p2 send the request somewhere other than the URL's host.
      for (const v of flagValues(argv, ['--resolve'])) {
        for (const addr of v.split(':').slice(2).join(':').replace(/^\+/, '').split(',')) add(hostOfAuthority(addr.replace(/^\[|\]$/g, '')), `${cmd} resolve`)
      }
      for (const v of flagValues(argv, ['--connect-to'])) {
        const to = v.split(':')[2] ?? ''
        if (to !== '') add(hostOfAuthority(to.replace(/^\[|\]$/g, '')), `${cmd} connect-to`)
      }
      proxies(cmd)
      break
    }
    case 'gh': {
      const rest = positionals(argv.slice(1), new Set(['-R', '--repo', '--hostname']))
      if (GH_LOCAL.has(rest[0] ?? '')) break
      add(env.GH_HOST ?? flagValues(argv, ['--hostname'])[0] ?? 'github.com', rest[0] ? `gh ${rest[0]}` : 'gh')
      proxies('gh')
      break
    }
    case 'git': {
      let i = 1
      let dir = ctx.dir
      const configUrls: string[] = []
      const cliConfig: string[] = []
      while (i < argv.length && (argv[i] as string).startsWith('-')) {
        const a = argv[i] as string
        if (a === '-C' && argv[i + 1] !== undefined) {
          const to = argv[i + 1] as string
          dir = to.startsWith('/') ? to : dir ? `${dir}/${to}` : to
          i += 2
          continue
        }
        if (a === '-c' && argv[i + 1] !== undefined) {
          const kv = argv[i + 1] as string
          if (/^(https?\.)?(http|https)\.(.*\.)?proxy=/i.test(kv) || /^http\..*proxy=/i.test(kv)) configUrls.push(kv.slice(kv.indexOf('=') + 1))
          cliConfig.push(kv)
          i += 2
          continue
        }
        i += 1
      }
      const op = argv[i] ?? ''
      const rest = argv.slice(i + 1)
      const NET = ['push', 'pull', 'fetch', 'clone', 'ls-remote', 'remote', 'submodule']
      if (!NET.includes(op)) break
      for (const u of configUrls) add(hostOfAuthority(u), 'git proxy')
      proxies('git')
      if (op === 'remote' && !['update', 'show', 'prune'].includes(rest[0] ?? '')) break
      if (op === 'submodule' && rest[0] !== 'update') break
      const args = op === 'remote' || op === 'submodule' ? rest.slice(1) : rest
      const pos = positionals(args, new Set(['-o', '--push-option', '--depth', '-b', '--branch', '--origin', '--upload-pack', '--receive-pack', '--recurse-submodules-default', '-j', '--jobs']))
      // Only the repository operand can be a URL; what follows it is refspecs (`HEAD:main`), never hosts.
      const repo = pos[0] ?? ''
      const explicit = repo === '' ? null : (hostOfUrl(repo) ?? scpHost(repo))
      if (explicit !== null) {
        add(explicit, `git ${op}`)
        break
      }
      if (op === 'clone' || op === 'submodule') break
      const all = args.includes('--all') || (op === 'remote' && rest[0] === 'update' && pos.length === 0)
      remotes.push({ remote: all ? '*' : repo, op: op === 'push' ? 'push' : 'fetch', dir, all, ...(cliConfig.length > 0 ? { config: cliConfig } : {}) })
      break
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': case 'npx': case 'bunx': {
      const runs = cmd === 'npx' || cmd === 'bunx' || NPM_NET.has(sub) || (cmd === 'yarn' && (sub === '' || sub === 'install'))
      if (!runs) break
      const label = cmd === 'npx' || cmd === 'bunx' ? cmd : NPM_NET.has(sub) ? `${cmd} ${sub}` : cmd
      const regs = [
        ...flagValues(argv, ['--registry']),
        ...['npm_config_registry', 'NPM_CONFIG_REGISTRY', 'YARN_REGISTRY', 'YARN_NPM_REGISTRY_SERVER', 'BUN_CONFIG_REGISTRY'].map(k => env[k] ?? '').filter(Boolean),
      ]
      if (regs.length > 0) addUrls(regs, label)
      else add(cmd === 'yarn' ? 'registry.yarnpkg.com' : 'registry.npmjs.org', label)
      operandUrls(label)
      proxies(label)
      break
    }
    case 'pip': case 'pip3': case 'pipx': case 'poetry': case 'uv': {
      const op = cmd === 'uv' && sub === 'pip' ? (argv[2] ?? '') : sub
      if (!PY_NET.has(op)) break
      const label = `${cmd} ${op}`
      const main = [
        ...flagValues(argv, ['--index-url', '-i', '--index', '--default-index']),
        ...['PIP_INDEX_URL', 'UV_INDEX_URL', 'UV_DEFAULT_INDEX'].map(k => env[k] ?? '').filter(Boolean),
      ]
      const extra = [
        ...flagValues(argv, ['--extra-index-url', '--find-links', '-f']),
        ...['PIP_EXTRA_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'PIP_FIND_LINKS'].map(k => env[k] ?? '').filter(Boolean),
      ]
      if (main.length > 0) for (const m of main) for (const h of listHosts(m)) add(h, label)
      else add('pypi.org', label)
      for (const x of extra) for (const h of listHosts(x)) add(h, label)
      operandUrls(label)
      proxies(label)
      break
    }
    case 'conda': case 'mamba': case 'micromamba': {
      if (!['install', 'create', 'update', 'upgrade', 'search'].includes(sub)) break
      const channels = flagValues(argv, ['-c', '--channel'])
      let any = false
      for (const c of channels) {
        const h = hostOfUrl(c)
        if (h) {
          add(h, `${cmd} ${sub}`)
          any = true
        }
      }
      if (!any || channels.some(c => !c.includes('://'))) add('conda.anaconda.org', `${cmd} ${sub}`)
      proxies(cmd)
      break
    }
    case 'brew':
      if (['install', 'upgrade', 'update', 'reinstall', 'fetch', 'tap'].includes(sub)) {
        add(env.HOMEBREW_BOTTLE_DOMAIN ? hostOfUrl(env.HOMEBREW_BOTTLE_DOMAIN) : 'formulae.brew.sh', `brew ${sub}`)
        operandUrls(`brew ${sub}`)
      }
      break
    case 'docker': case 'podman': case 'nerdctl': {
      if (!['pull', 'push', 'login', 'run', 'create'].includes(sub)) break
      const takes = new Set(['--platform', '-u', '--username', '-p', '--password', '--context', '-e', '--env', '-v', '--volume', '--name', '-w', '--workdir', '--network', '--entrypoint', '-l', '--label', '--mount', '--user', '--add-host', '--env-file', '-h', '--hostname'])
      const pos = positionals(argv.slice(2), takes)
      const image = pos[0] ?? ''
      if (sub === 'login') {
        add(image || 'docker.io', `${cmd} login`)
        break
      }
      const parts = image.split('/')
      const first = parts[0] ?? ''
      const isRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')
      if (image) add(isRegistry ? (first.split(':')[0] as string) : 'docker.io', `${cmd} ${sub}`)
      break
    }
    case 'cargo': {
      if (!['add', 'install', 'update', 'fetch', 'publish', 'search', 'build', 'check'].includes(sub)) break
      if (sub === 'build' || sub === 'check') break
      const git = flagValues(argv, ['--git', '--registry', '--index'])
      add('crates.io', `cargo ${sub}`)
      for (const g of git) add(hostOfUrl(g) ?? scpHost(g), `cargo ${sub}`)
      break
    }
    case 'go': {
      if (!(sub === 'get' || sub === 'install' || (sub === 'mod' && argv[2] === 'download'))) break
      const proxy = env.GOPROXY
      const hosts = proxy ? listHosts(proxy) : ['proxy.golang.org']
      for (const h of hosts) add(h, `go ${sub}`)
      if ((proxy !== undefined && /\b(direct|off)\b/.test(proxy)) || env.GOPRIVATE || env.GONOPROXY) {
        for (const p of positionals(argv.slice(2), new Set())) {
          const first = p.split('/')[0] ?? ''
          if (first.includes('.')) add(first.split('@')[0] as string, `go ${sub}`)
        }
      }
      break
    }
    case 'gem':
      if (['install', 'update', 'push', 'fetch'].includes(sub)) {
        const src = flagValues(argv, ['--source', '-s', '--clear-sources'])
        if (src.length > 0) for (const s of src) add(hostOfUrl(s), `gem ${sub}`)
        else add('rubygems.org', `gem ${sub}`)
      }
      break
    case 'bundle':
      if (sub === '' || sub === 'install' || sub === 'update') add('rubygems.org', `bundle ${sub || 'install'}`)
      break
    case 'pod':
      if (sub === 'install' || sub === 'update' || sub === 'repo') add('cdn.cocoapods.org', `pod ${sub}`)
      break
    case 'aws':
      if (sub && sub !== 'help' && sub !== 'configure') add('amazonaws.com', 'aws')
      break
    case 'gcloud': case 'gsutil': case 'bq':
      if (sub && sub !== 'help' && sub !== 'config') add('googleapis.com', cmd)
      break
    case 'az':
      if (sub && sub !== 'help') add('management.azure.com', 'az')
      break
    case 'kubectl': case 'helm': {
      const server = flagValues(argv, ['--server', '-s', '--kube-apiserver'])
      if (server.length > 0) for (const s of server) add(hostOfAuthority(s), cmd)
      else if (sub && !['help', 'version', 'completion', 'config', 'template', 'lint', 'create'].includes(sub)) add('kube-apiserver', cmd)
      break
    }
    case 'terraform': case 'tofu':
      if (['init', 'plan', 'apply', 'destroy', 'refresh', 'import'].includes(sub)) add('registry.terraform.io', cmd)
      break
    case 'ssh': case 'scp': case 'sftp': case 'rsync': case 'mosh': {
      const takes = new Set(['-p', '-P', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B'])
      for (const j of flagValues(argv, ['-J'])) for (const hop of j.split(',')) add(hop.split('@').pop()?.split(':')[0] ?? null, `${cmd} jump`)
      for (const o of flagValues(argv, ['-o'])) {
        const pj = /^ProxyJump[= ](.+)$/i.exec(o)
        if (pj) for (const hop of (pj[1] as string).split(',')) add(hop.split('@').pop()?.split(':')[0] ?? null, `${cmd} jump`)
      }
      for (const f of [...flagValues(argv, ['-L']), ...flagValues(argv, ['-R'])]) {
        const parts = f.split(':')
        if (parts.length >= 3) add(parts[parts.length - 2] as string, `${cmd} forward`)
      }
      for (const w of flagValues(argv, ['-W'])) add(w.split(':')[0] ?? null, `${cmd} forward`)
      const pos = positionals(argv.slice(1), takes)
      if (cmd === 'ssh' || cmd === 'mosh' || cmd === 'sftp') {
        const target = pos[0]
        if (target) add(hostOfUrl(target) ?? target.split('@').pop()?.split(':')[0] ?? null, cmd)
      } else {
        for (const p of pos) add(hostOfUrl(p) ?? scpHost(p), cmd)
      }
      break
    }
    case 'nc': case 'ncat': case 'netcat': case 'telnet': case 'socat': {
      const pos = positionals(argv.slice(1), new Set(['-p', '-s', '-w', '-x', '-X', '-i', '-q']))
      const host = pos.find(a => !/^\d+$/.test(a))
      if (host && !host.includes(':')) add(host, cmd)
      for (const p of pos) {
        const m = /^(?:tcp|udp|ssl|openssl)[46]?:([^:]+):\d+/i.exec(p)
        if (m) add(m[1] as string, cmd)
      }
      break
    }
    default:
      if (DIALERS.has(cmd)) {
        for (const host of urlHosts(argv.slice(1).join(' '))) add(host, cmd)
        if (HOST_FLAG_CLIENTS.has(cmd)) for (const v of flagValues(argv, ['-h', '--host'])) add(hostOfAuthority(v), cmd)
        proxies(cmd)
      }
  }
  return { targets, remotes, nested }
}

// The host of scp-like `user@host:path` (but not a Windows drive or a URL).
function scpHost(arg: string): string | null {
  if (arg.includes('://')) return null
  const m = /^(?:[\w.-]+@)?([a-zA-Z0-9][\w-]*(?:\.[\w-]+)+|[a-zA-Z0-9][\w-]+):(?!\/\/)/.exec(arg)
  if (!m) return null
  const host = m[1] as string
  return /^[a-zA-Z]$/.test(host) ? null : host.toLowerCase()
}

// Every remote target of a Bash command line, plus remotes named without a URL
// (resolved later from the repository's config). `cwd` seeds `cd` tracking.
export function classifyBash(command: string, cwd: string | null = null, home: string | null = null): { targets: Target[]; remotes: GitRemote[] } {
  const targets: Target[] = []
  const remotes: GitRemote[] = []
  const ctx: Ctx = { dir: cwd, env: {}, home }
  const queue = segments(command)
  for (let n = 0; n < queue.length && n < 200; n += 1) {
    const one = classifySegment(queue[n] as string, ctx)
    targets.push(...one.targets)
    remotes.push(...one.remotes)
    for (const body of one.nested) queue.push(...segments(body))
  }
  return { targets: dedupe(targets), remotes }
}

function dedupe(list: Target[]): Target[] {
  const seen = new Set<string>()
  return list.filter(t => {
    const k = `${t.kind}:${t.host}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// One git config file as [section, subsection, key, value] rows, in order. Enough of git's format for the
// keys this reads: `[remote "x"]`, `[branch "x"]`, `[url "x"]`, `[remote]`, `key = value`.
function configRows(config: string): { section: string; sub: string; key: string; value: string }[] {
  const out: { section: string; sub: string; key: string; value: string }[] = []
  let section = ''
  let sub = ''
  for (const line of config.split(/\r?\n/)) {
    const head = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
    if (head) {
      section = (head[1] as string).toLowerCase()
      sub = (head[2] ?? '').replace(/\\(.)/g, '$1')
      continue
    }
    const kv = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (kv && section !== '') out.push({ section, sub, key: (kv[1] as string).toLowerCase(), value: (kv[2] as string).replace(/^"(.*)"$/, '$1') })
  }
  return out
}

// `-c section.sub.key=value` from the command line, as config rows (they apply after the file's).
function cliRows(pairs: readonly string[]): { section: string; sub: string; key: string; value: string }[] {
  return pairs.flatMap(kv => {
    const eq = kv.indexOf('=')
    if (eq < 0) return []
    const name = kv.slice(0, eq)
    const first = name.indexOf('.')
    const last = name.lastIndexOf('.')
    if (first < 0) return []
    return [{ section: name.slice(0, first).toLowerCase(), sub: first === last ? '' : name.slice(first + 1, last), key: name.slice(last + 1).toLowerCase(), value: kv.slice(eq + 1) }]
  })
}

// Remote names and every fetch / push URL each has (git pushes to all of a remote's pushurls).
export function remotesOf(config: string): Map<string, { url: string[]; pushurl: string[] }> {
  const out = new Map<string, { url: string[]; pushurl: string[] }>()
  for (const r of configRows(config)) {
    if (r.section !== 'remote' || r.sub === '') continue
    const entry = out.get(r.sub) ?? { url: [], pushurl: [] }
    if (r.key === 'url') entry.url.push(r.value)
    if (r.key === 'pushurl') entry.pushurl.push(r.value)
    out.set(r.sub, entry)
  }
  return out
}

// git's url.<base>.insteadOf / pushInsteadOf: the longest matching prefix wins, and a pushInsteadOf beats an
// insteadOf for push URLs.
export function rewriteUrl(url: string, rows: readonly { section: string; sub: string; key: string; value: string }[], op: 'push' | 'fetch'): string {
  let best: { base: string; from: string; push: boolean } | null = null
  for (const r of rows) {
    if (r.section !== 'url' || (r.key !== 'insteadof' && r.key !== 'pushinsteadof')) continue
    const push = r.key === 'pushinsteadof'
    if (push && op !== 'push') continue
    if (!url.startsWith(r.value)) continue
    if (best === null || r.value.length > best.from.length || (r.value.length === best.from.length && push && !best.push)) best = { base: r.sub, from: r.value, push }
  }
  return best === null ? url : best.base + url.slice(best.from.length)
}

// The URLs a remote uses for an operation: every pushurl for push when set, else its urls; rewrites applied.
export function remoteUrls(config: string, remote: string, op: 'push' | 'fetch' = 'fetch', cli: readonly string[] = []): string[] {
  const rows = [...configRows(config), ...cliRows(cli)]
  const r = remotesOf(config).get(remote)
  if (!r) return []
  const raw = op === 'push' && r.pushurl.length > 0 ? r.pushurl : r.url
  // An explicit pushurl is used as written; a url used for push still goes through pushInsteadOf.
  return raw.map(u => (op === 'push' && r.pushurl.length > 0 ? rewriteUrl(u, rows, 'fetch') : rewriteUrl(u, rows, op)))
}

// The URL a git remote uses for an operation (the first of remoteUrls).
export function remoteUrl(config: string, remote: string, op: 'push' | 'fetch' = 'fetch'): string | null {
  return remoteUrls(config, remote, op)[0] ?? null
}

// Host of a git remote URL, either a URL or scp-like `git@host:path`.
export function hostOfRemote(url: string): string | null {
  return hostOfUrl(url) ?? scpHost(url.trim())
}

// The remote a bare `git push` / `git pull` uses, in git's order: for a push, the branch's pushRemote, then
// remote.pushDefault; then the branch's remote, else `origin`, else the only remote.
export function defaultRemote(config: string, head: string | null, op: 'push' | 'fetch' = 'fetch', cli: readonly string[] = []): string | null {
  const rows = [...configRows(config), ...cliRows(cli)]
  const names = [...remotesOf(config).keys()]
  const branch = head ? /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())?.[1] : undefined
  const last = (section: string, sub: string, key: string) => rows.filter(r => r.section === section && r.sub === sub && r.key === key).pop()?.value
  const pick = (name: string | undefined) => (name !== undefined && names.includes(name) ? name : null)
  if (op === 'push') {
    const pushed = pick(branch ? last('branch', branch, 'pushremote') : undefined) ?? pick(last('remote', '', 'pushdefault'))
    if (pushed !== null) return pushed
  }
  const fromBranch = pick(branch ? last('branch', branch, 'remote') : undefined)
  if (fromBranch !== null) return fromBranch
  if (names.includes('origin')) return 'origin'
  return names.length === 1 ? (names[0] as string) : null
}

// Is a host expected (exact match or a subdomain of an entry)?
export function isAllowed(host: string, allow: readonly string[]): boolean {
  if (isLocal(host)) return true
  return allow.some(a => {
    const entry = normalizeHost(a)
    return entry.length > 0 && (host === entry || host.endsWith('.' + entry))
  })
}

// An allowlist entry as typed (`*.corp.com`, `https://corp.com/x`, `corp.com:443`) to a bare host.
export function normalizeHost(entry: string): string {
  let e = entry.trim().toLowerCase()
  const viaUrl = hostOfUrl(e)
  if (viaUrl) e = viaUrl
  e = e.replace(/^\*\./, '').replace(/\/.*$/, '')
  if (!e.startsWith('[') && !e.startsWith('mcp:')) e = e.replace(/:\d+$/, '')
  return e.replace(/\.$/, '')
}

export function parseAllow(text: string): string[] {
  return text.split(/[\s,]+/).map(normalizeHost).filter(Boolean)
}
