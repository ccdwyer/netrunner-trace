import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HostInfo, TraceEvent } from '../types'
import { DEFAULT_ALLOW, classifyBash, clean, defaultRemote, hostOfRemote, hostOfUrl, isLocal, normalizeHost, parseAllow, remoteUrls, remotesOf } from './net'
import type { GitRemote, Target } from './net'
import { PACKET_MS, drawMap, encodeCells } from './map'
import type { MapNode, NodeStyle, Packet } from './map'

const events = atom({ plugin: 'netrunner-trace', key: 'events' } as const, [])
const hosts = atom({ plugin: 'netrunner-trace', key: 'hosts' } as const, {})
const allow = atom({ plugin: 'netrunner-trace', key: 'allow' } as const, [])
const calls = atom({ plugin: 'netrunner-trace', key: 'calls' } as const, 0)

const PANE = 'netrunner-trace'
const KEEP = 200
const FLASH_MS = 3000
const FRAME_MS = 33
const MAP_SLOTS = 16
const MAX_COLS = 160
const MAX_ROWS = 32
const UNKNOWN = new Set(['git:unresolved', 'kube-apiserver'])
// Hosts kept in the inventory; the least recently seen expected ones give way first.
const MAX_HOSTS = 200
// With nothing moving, the map repaints at most this often.
const IDLE_MS = 400

// Animation lives in module memory: packets and flashes are seconds long, so a
// reload losing them costs nothing. What exists (events, hosts) is in $.state.
let packets: Packet[] = []
const flashes = new Map<string, number>()
let mounted: { columns: number; rows: number } | null = null
let timer: { cancel: () => void } | null = null
let misses = 0
let seq = 0
let configured: string[] = []
let ticker = true
let home: string | null = null
let lastBlit = 0
// The allowlist, normalised once per change, and the map's node choice, recomputed only when hosts change.
let allowCache: { key: string; list: string[] } | null = null
let nodeCache: { hosts: Record<string, HostInfo>; allowKey: string; shown: [string, HostInfo][]; hidden: number } | null = null

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '~' : s)

// `list` is already normalised (see allowList), so this is a plain suffix check.
function allowedBy(host: string, list: readonly string[]): boolean {
  return isLocal(host) || list.some(entry => entry.length > 0 && (host === entry || host.endsWith('.' + entry)))
}

function expected(host: string, list: readonly string[]): boolean {
  return host.startsWith('mcp:') || host === 'web-search' || UNKNOWN.has(host) || allowedBy(host, list)
}

// Host names are data: stored keys carry a prefix, so no host ("constructor", "__proto__") is ever a special
// or inherited property, in memory or once the state is serialised.
const KEY = 'host:'

function own(all: Record<string, HostInfo>, host: string): HostInfo | undefined {
  return Object.hasOwn(all, KEY + host) ? all[KEY + host] : undefined
}

function setOwn(all: Record<string, HostInfo>, host: string, info: HostInfo): void {
  all[KEY + host] = info
}

function hostEntries(all: Record<string, HostInfo>): [string, HostInfo][] {
  return Object.entries(all)
    .filter(([k]) => k.startsWith(KEY))
    .map(([k, v]) => [k.slice(KEY.length), v])
}

function styleOf(host: string, info: HostInfo, list: readonly string[]): NodeStyle {
  if (host.startsWith('mcp:')) return 'mcp'
  if (host === 'web-search') return 'web'
  if (UNKNOWN.has(host)) return 'unknown'
  if (isLocal(host)) return 'local'
  if (!allowedBy(host, list)) return 'flagged'
  if (info.lastStatus === 'error') return 'error'
  return 'ok'
}

// Up to MAP_SLOTS nodes: unexpected hosts always, then the most recent. The choice is cached until the hosts
// or the allowlist change, so a frame costs the drawn nodes, not the whole inventory.
function pickNodes(all: Record<string, HostInfo>, list: readonly string[]): { nodes: MapNode[]; hidden: number } {
  const allowKey = list.join(',')
  if (nodeCache === null || nodeCache.hosts !== all || nodeCache.allowKey !== allowKey) {
    const entries = hostEntries(all)
    const ranked = entries.sort((a, b) => {
      const fa = expected(a[0], list) ? 1 : 0
      const fb = expected(b[0], list) ? 1 : 0
      return fa - fb || b[1].last - a[1].last
    })
    const shown = ranked.slice(0, MAP_SLOTS)
    nodeCache = { hosts: all, allowKey, shown, hidden: Math.max(0, entries.length - shown.length) }
  }
  const nodes = nodeCache.shown.map(([host, info]) => ({ host, style: styleOf(host, info, list), flashUntil: flashes.get(host) ?? 0, count: info.count, slot: info.slot }))
  return { nodes, hidden: nodeCache.hidden }
}

function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function mark(status: TraceEvent['status']): string {
  if (status === 'ok') return '+'
  if (status === 'error') return 'x'
  if (status === 'denied') return '-'
  return '>'
}

// Targets known from the call itself, before it runs (no file reads).
function directTargets(call: { tool: string; [k: string]: unknown }, cwd: string | null, homeDir: string | null): { targets: Target[]; remotes: GitRemote[] } {
  const tool = call.tool
  if (tool === 'WebFetch') {
    const host = hostOfUrl(String(call.url ?? ''))
    return { targets: host ? [{ host, kind: 'web', label: 'WebFetch' }] : [], remotes: [] }
  }
  if (tool === 'WebSearch') return { targets: [{ host: 'web-search', kind: 'search', label: 'WebSearch' }], remotes: [] }
  if (tool.startsWith('mcp__')) {
    const server = clean(tool.split('__')[1] ?? 'mcp').toLowerCase()
    return { targets: [{ host: `mcp:${server}`, kind: 'mcp', label: 'MCP call' }], remotes: [] }
  }
  if (tool !== 'Bash') return { targets: [], remotes: [] }
  return classifyBash(String(call.command ?? ''), cwd, homeDir)
}

// The git directory for a working dir: walk up to a .git folder or a .git file
// (worktrees, submodules), and its common dir for the shared config.
async function gitDirs($: EngineInterface, start: string): Promise<{ config: string | null; head: string | null }> {
  let dir = start
  for (let i = 0; i < 40 && dir.length > 0; i += 1) {
    const dotgit = `${dir}/.git`
    let kind: string | null = null
    try {
      kind = (await $.fs.stat(dotgit)).kind
    } catch {
      kind = null
    }
    if (kind === 'dir') return { config: await readOr($, `${dotgit}/config`), head: await readOr($, `${dotgit}/HEAD`) }
    if (kind === 'file') {
      const pointer = (await readOr($, dotgit)) ?? ''
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
      if (!m) return { config: null, head: null }
      const gitdir = (m[1] as string).startsWith('/') ? (m[1] as string) : `${dir}/${m[1]}`
      const common = ((await readOr($, `${gitdir}/commondir`)) ?? '').trim()
      const commonDir = common === '' ? gitdir : common.startsWith('/') ? common : `${gitdir}/${common}`
      return { config: await readOr($, `${commonDir}/config`), head: await readOr($, `${gitdir}/HEAD`) }
    }
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir) break
    dir = up
  }
  return { config: null, head: null }
}

async function readOr($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

// Hosts behind remotes the command named without a URL. Read-only.
async function resolveRemotes($: EngineInterface, remotes: readonly GitRemote[], cwd: string | null): Promise<Target[]> {
  const out: Target[] = []
  for (const r of remotes) {
    const start = r.dir ?? cwd
    const { config, head } = start ? await gitDirs($, start) : { config: null, head: null }
    const cli = r.config ?? []
    const names = config === null ? [] : r.all ? [...remotesOf(config).keys()] : [r.remote || defaultRemote(config, head, r.op, cli) || '']
    let found = false
    for (const name of names) {
      // Every URL the operation uses (all pushurls for a push), with insteadOf rewrites applied.
      for (const url of config === null || !name ? [] : remoteUrls(config, name, r.op, cli)) {
        const host = hostOfRemote(url)
        if (host && !out.some(t => t.host === host)) {
          out.push({ host, kind: 'bash', label: r.op === 'push' ? 'git push' : 'git fetch' })
          found = true
        }
      }
    }
    if (!found) out.push({ host: 'git:unresolved', kind: 'bash', label: 'git' })
  }
  return out
}

async function allowList($: EngineInterface): Promise<string[]> {
  const extra = await read($, allow)
  const key = extra.join(',')
  if (allowCache === null || allowCache.key !== key) {
    allowCache = { key, list: [...DEFAULT_ALLOW, ...configured, ...extra].map(normalizeHost).filter(Boolean) }
  }
  return allowCache.list
}

function launch(host: string, dir: 'out' | 'in', ok: boolean, at: number) {
  packets.push({ host, dir, ok, startedAt: at })
  if (packets.length > 64) packets = packets.slice(-64)
}

// Record targets as pending events and bump their hosts; returns the event ids.
// `at` is when the call started (what the log shows); packets and first-contact flashes start now.
async function recordStart($: EngineInterface, targets: readonly Target[], tool: string, agent: string | undefined, at: number): Promise<string[]> {
  const now = await $.clock.now()
  const ids = targets.map(() => `t${at}-${(seq += 1)}`)
  const before = await read($, hosts)
  await update($, events, cur => {
    const added = targets.map((t, i): TraceEvent => ({
      id: ids[i] as string,
      at,
      tool: clean(tool),
      host: t.host,
      kind: t.kind,
      label: short(clean(t.label), 24),
      status: 'pending',
      ...(agent !== undefined ? { agent } : {}),
    }))
    const all = [...cur, ...added]
    // Trim finished rows only, so a pending row is never dropped before it resolves.
    let excess = all.length - KEEP
    return excess <= 0 ? all : all.filter(ev => (excess > 0 && ev.status !== 'pending' ? ((excess -= 1), false) : true))
  })
  const list = await allowList($)
  await update($, hosts, all => {
    const out: Record<string, HostInfo> = { ...all }
    let next = Math.max(-1, ...Object.values(out).map(h => h.slot)) + 1
    for (const t of targets) {
      const was = own(out, t.host)
      setOwn(out, t.host, was
        ? { ...was, last: at, count: was.count + 1, lastStatus: 'pending' }
        : { first: at, last: at, count: 1, errors: 0, lastStatus: 'pending', slot: next++ })
    }
    // Bounded: the least recently seen expected hosts give way first, unexpected ones last.
    const known = hostEntries(out)
    if (known.length > MAX_HOSTS) {
      const drop = known
        .sort((a, b) => (expected(a[0], list) ? 0 : 1) - (expected(b[0], list) ? 0 : 1) || a[1].last - b[1].last)
        .slice(0, known.length - MAX_HOSTS)
      for (const [host] of drop) delete out[KEY + host]
    }
    return out
  })
  for (const t of targets) {
    if (own(before, t.host) === undefined) flashes.set(t.host, now + FLASH_MS)
    launch(t.host, 'out', true, now)
  }
  return ids
}

async function recordEnd($: EngineInterface, ids: readonly string[], targets: readonly Target[], status: TraceEvent['status'], started: number) {
  const ended = await $.clock.now()
  await update($, events, cur => cur.map(ev => (ids.includes(ev.id) ? { ...ev, status, ms: ended - started } : ev)))
  await update($, hosts, all => {
    const out: Record<string, HostInfo> = { ...all }
    for (const t of targets) {
      const was = own(out, t.host)
      if (was) setOwn(out, t.host, { ...was, lastStatus: status, errors: was.errors + (status === 'error' ? 1 : 0) })
    }
    return out
  })
  if (status !== 'denied') for (const t of targets) launch(t.host, 'in', status === 'ok', ended)
}

// Draw the next frame into the mounted map; stop when the pane is gone.
async function frame($: EngineInterface) {
  if (mounted === null) {
    stopAnimation()
    return
  }
  const now = await $.clock.now()
  packets = packets.filter(p => now - p.startedAt < PACKET_MS)
  for (const [host, until] of flashes) if (until < now) flashes.delete(host)
  // Nothing in flight and no ring pulsing: repaint rarely.
  if (packets.length === 0 && flashes.size === 0 && now - lastBlit < IDLE_MS) return
  lastBlit = now
  const all = await read($, hosts)
  const { nodes, hidden } = pickNodes(all, await allowList($))
  const { columns, rows } = mounted
  const cells = encodeCells(drawMap(columns, rows, nodes, packets, now, hidden))
  const res = await $.ui.blit({ requestId: PANE, key: 'map', cells, columns, rows })
  if (res.deny !== undefined) {
    misses += 1
    if (misses > 60) {
      mounted = null
      stopAnimation()
    }
  } else {
    misses = 0
  }
}

function stopAnimation() {
  if (timer !== null) timer.cancel()
  timer = null
  misses = 0
}

function startAnimation($: EngineInterface) {
  if (timer !== null) return
  misses = 0
  timer = $.clock.every(FRAME_MS, () => frame($))
}

async function reset($: EngineInterface) {
  await update($, events, () => [])
  await update($, hosts, () => ({}))
  await update($, calls, () => 0)
  packets = []
  flashes.clear()
}

function summary(all: Record<string, HostInfo>, total: number, list: readonly string[]): string {
  const names = hostEntries(all).sort((a, b) => a[1].first - b[1].first)
  if (names.length === 0) return 'Netrunner Trace: no outbound traffic this session.'
  const flagged = names.filter(([host]) => !expected(host, list)).map(([host]) => host)
  const lines = names.map(([host, info]) => `${!expected(host, list) ? '!' : ' '} ${host}  ${info.count} call${info.count === 1 ? '' : 's'}${info.errors ? `, ${info.errors} failed` : ''}${host.startsWith('mcp:') ? ' (destination unknown)' : ''}`)
  return [
    `Netrunner Trace: ${total} outbound call${total === 1 ? '' : 's'} to ${names.length} host${names.length === 1 ? '' : 's'}${flagged.length ? `, ${flagged.length} unexpected (${flagged.join(', ')})` : ''}.`,
    ...lines,
  ].join('\n')
}

export const register: Register = (on, options) => {
  configured = parseAllow(String(options.allowedHosts ?? ''))
  ticker = options.showTicker !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'trace',
      description: 'Netrunner Trace: open the live map of hosts the agent reaches (clear, allow <host>, hosts)',
      argumentHint: '[clear | allow <host> | hosts]',
      immediate: true,
    })
    return next(e)
  })

  on('session.end', ($, e, next) => {
    mounted = null
    stopAnimation()
    return next(e)
  })

  on('command.run', { command: 'trace' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'clear') {
      await reset($)
      return { text: 'Netrunner Trace: cleared.' }
    }
    if (verb === 'allow' && arg) {
      const host = normalizeHost(arg)
      await update($, allow, list => (list.includes(host) ? list : [...list, host]))
      return { text: `Netrunner Trace: ${host} (and its subdomains) is expected for the rest of this session.` }
    }
    const all = await read($, hosts)
    const total = await read($, calls)
    const list = await allowList($)
    if (verb === 'hosts') return { text: summary(all, total, list) }
    // 46 = header + unexpected banner + 32-row map + log rule + 10 log lines + clear button
    const opened = await $.ui.open({ id: PANE, title: 'Netrunner Trace', rows: 46 })
    startAnimation($)
    return { text: opened.isPlaced === false ? `${summary(all, total, list)}\n(Widen the terminal to see the map.)` : 'Netrunner Trace: map open.' }
  })

  on('tool.call', async ($, e, next) => {
    // Bookkeeping never stands between the agent and its tool: every step
    // around `next` is best effort, and `next` runs exactly once.
    let cwd: string | null = null
    let direct: Target[] = []
    let ids: string[] = []
    let started = 0
    try {
      // Only a shell command needs the folder it runs in (cd, git -C, a repo's remotes).
      if (e.tool === 'Bash') {
        cwd = await $.session.cwd()
        if (home === null) {
          try {
            home = (await $.env.get('HOME')) ?? ''
          } catch {
            home = ''
          }
        }
      }
      const found = directTargets(e as { tool: string; [k: string]: unknown }, cwd, home === '' ? null : home)
      direct = found.targets
      if (direct.length > 0 || found.remotes.length > 0) {
        started = await $.clock.now()
        await update($, calls, n => n + 1)
        // Remotes named without a URL are resolved now, from the config as it is before the command runs,
        // so the map shows where a push is going while it runs.
        if (found.remotes.length > 0) {
          const resolved = await resolveRemotes($, found.remotes, cwd)
          direct = [...direct, ...resolved.filter(t => !direct.some(d => d.host === t.host))]
        }
        if (direct.length > 0) ids = await recordStart($, direct, e.tool, e.agentId, started)
      }
    } catch {
      direct = []
      ids = []
    }

    let ran
    try {
      ran = await next(e)
    } catch (err) {
      try {
        if (ids.length > 0) await recordEnd($, ids, direct, 'error', started)
      } catch {
        // best effort
      }
      throw err
    }

    try {
      const status: TraceEvent['status'] = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
      if (ids.length > 0) await recordEnd($, ids, direct, status, started)
    } catch {
      // best effort
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, hosts)
    const list = await read($, events)
    const total = await read($, calls)
    const allowed = await allowList($)
    const now = await $.clock.now()
    const names = hostEntries(all).map(([n]) => n)
    const flagged = names.filter(n => !expected(n, allowed))
    const head = `NETRUNNER TRACE  ${total} call${total === 1 ? '' : 's'} · ${names.length} host${names.length === 1 ? '' : 's'} · ${flagged.length} unexpected`
    const width = Math.max(30, e.props.bodyColumns)
    const viewRows = e.viewport?.rows ?? 30
    const logRows = Math.max(4, Math.min(10, Math.floor(viewRows / 4)))
    const recent = list.slice(-logRows).reverse()
    const logLine = (ev: TraceEvent) =>
      short(`${clock(ev.at)} ${mark(ev.status)} ${ev.tool.startsWith('mcp__') ? 'MCP' : ev.tool} ${ev.label} -> ${ev.host}${ev.ms !== undefined ? ` ${(ev.ms / 1000).toFixed(1)}s` : ''}${ev.agent ? ' (subagent)' : ''}`, width)
    const tone = (ev: TraceEvent) => (!expected(ev.host, allowed) ? 'red' : ev.status === 'error' ? 'yellow' : 'green')

    if (e.surface === 'terminal') {
      const { Box, Text, Raster, Button } = $.ui.resolve(e)
      const columns = Math.min(MAX_COLS, width)
      const rows = Math.max(10, Math.min(MAX_ROWS, viewRows - logRows - 7))
      mounted = { columns, rows }
      startAnimation($)
      const { nodes, hidden } = pickNodes(all, allowed)
      const cells = encodeCells(drawMap(columns, rows, nodes, packets, now, hidden))
      return (
        <Box flexDirection="column">
          <Text color="green" bold>
            {head}
          </Text>
          {flagged.length > 0 && <Text color="red">{short(`! unexpected: ${flagged.join(', ')}`, width)}</Text>}
          <Raster key="map" columns={columns} rows={rows} cells={cells} />
          <Text color="green" dimColor>
            {'─'.repeat(Math.min(width - 4, 60))} log
          </Text>
          {recent.length === 0 && <Text dimColor>waiting for outbound calls…</Text>}
          {recent.map(ev => (
            <Text key={ev.id} color={tone(ev)}>
              {logLine(ev)}
            </Text>
          ))}
          <Box>
            <Button key="clear" label="clear" onPress={() => reset($)} />
          </Box>
        </Box>
      )
    }

    // Surfaces without Raster get the same facts as text.
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>{head}</Text>
        {names.length === 0 && <Text>No outbound traffic yet.</Text>}
        {names.map(n => (
          <Text key={n}>
            {!expected(n, allowed) ? '! ' : '  '}
            {n} · {own(all, n)?.count} call{own(all, n)?.count === 1 ? '' : 's'}
            {own(all, n)?.errors ? `, ${own(all, n)?.errors} failed` : ''}
          </Text>
        ))}
        {recent.map(ev => (
          <Text key={ev.id}>{logLine(ev)}</Text>
        ))}
        <Box>
          <Button key="clear" label="clear" onPress={() => reset($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ticker || e.props.hasSurvey) return next(e)
    const list = await read($, events)
    if (list.length === 0) return next(e)
    const all = await read($, hosts)
    const allowed = await allowList($)
    // The three most recently seen unexpected hosts are pinned first, then the most recent others.
    const flagged = hostEntries(all)
      .filter(([host]) => !expected(host, allowed))
      .sort((a, b) => b[1].last - a[1].last)
      .map(([host]) => host)
    const seen: string[] = [...flagged.slice(0, 3)]
    for (let i = list.length - 1; i >= 0 && seen.length < 4; i -= 1) {
      const host = (list[i] as TraceEvent).host
      if (!seen.includes(host)) seen.push(host)
    }
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green">⇄ trace </Text>
          {seen.map(host => (
            <Text key={host} color={flagged.includes(host) ? 'red' : 'green'} dimColor={!flagged.includes(host)}>
              {flagged.includes(host) ? '! ' : ''}
              {short(host, 28)}
              {'  '}
            </Text>
          ))}
          <Text dimColor>· /trace</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
