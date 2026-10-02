// One outbound target of a call: when, which tool, which host, and how it
// ended. `label` is the program and subcommand only, never arguments.
export type TraceEvent = {
  id: string
  at: number
  tool: string
  host: string
  kind: 'bash' | 'web' | 'search' | 'mcp'
  label: string
  status: 'pending' | 'ok' | 'error' | 'denied'
  ms?: number
  agent?: string
}

// Per host: first and last contact, totals, the latest outcome, and its
// first-seen slot (which fixes its place on the map).
export type HostInfo = { first: number; last: number; count: number; errors: number; lastStatus: 'ok' | 'error' | 'pending' | 'denied'; slot: number }

declare module 'claude-code' {
  interface PluginState {
    'netrunner-trace': {
      events: TraceEvent[]
      hosts: Record<string, HostInfo>
      allow: string[]
      calls: number
    }
  }
}
