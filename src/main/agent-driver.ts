/**
 * The AgentDriver boundary.
 *
 * Three selectable backends, one interface:
 *
 *   none → no process, no pi import, no key; the panel is hidden and exam prose
 *          is self-marked from the official scheme.
 *   acp  → an external ACP harness (`opencode acp`, …), spawned per session and
 *          scoped to the workspace.
 *   pi   → the existing in-process agent with Meridiem's own providers and
 *          macOS Keychain API keys.
 *
 * main/index.ts asks this module for the active harness, so no call site needs
 * to know which backend is in use.
 */

import {
  detectAcpHarnesses,
  resolveAcpBinary,
  runAcpOneShot,
  startAcpSession,
  type AcpHarnessInfo
} from './agent-acp'
import {
  runOneShot,
  startAgentSession,
  type AgentHandle,
  type AgentSettings,
  type OneShotRequest,
  type OneShotResult
} from './agent'

export const HARNESS_NONE = 'none'
export const HARNESS_PI = 'pi'
export const HARNESS_ACP_PREFIX = 'acp:'

export type HarnessKind = 'none' | 'pi' | 'acp' | 'unknown'

export interface HarnessInfo {
  /** `none`, `pi` or `acp:<tool>` */
  id: string
  kind: HarnessKind
  label: string
  installed: boolean
  /** ACP only: absolute binary path. */
  path?: string
  /** ACP only: the CLI name (`opencode`, `claude`, `codex`). */
  tool?: string
}

export function harnessKind(id: string | undefined | null): HarnessKind {
  if (!id || id === HARNESS_NONE) return 'none'
  if (id === HARNESS_PI) return 'pi'
  if (id.startsWith(HARNESS_ACP_PREFIX)) return 'acp'
  return 'unknown'
}

export function harnessTool(id: string): string | null {
  return id.startsWith(HARNESS_ACP_PREFIX) ? id.slice(HARNESS_ACP_PREFIX.length) : null
}

export function harnessLabel(id: string): string {
  if (id === HARNESS_NONE) return 'Off (No AI)'
  if (id === HARNESS_PI) return 'Built-in (pi)'
  const tool = harnessTool(id)
  return tool ? `${tool[0].toUpperCase()}${tool.slice(1)} (ACP)` : 'Unknown harness'
}

/** Off, every known ACP CLI with its install state, then built-in pi. */
export async function listHarnesses(force = false): Promise<HarnessInfo[]> {
  const acp = await detectAcpHarnesses(force)
  return [
    { id: HARNESS_NONE, kind: 'none', label: 'Off (No AI)', installed: true },
    ...acp.map((h: AcpHarnessInfo) => ({
      id: h.id,
      kind: 'acp' as const,
      label: `${h.label} (ACP)`,
      installed: h.installed,
      ...(h.path ? { path: h.path } : {}),
      tool: h.tool
    })),
    { id: HARNESS_PI, kind: 'pi', label: 'Built-in (pi + API key)', installed: true }
  ]
}

/** Validate a harness id before writing it to settings. */
export async function validateHarness(id: string): Promise<{ ok: boolean; message?: string; path?: string }> {
  if (id === HARNESS_NONE || id === HARNESS_PI) return { ok: true }
  const tool = harnessTool(id)
  if (!tool) return { ok: false, message: 'Unknown AI harness.' }
  const path = await resolveAcpBinary(tool)
  return path
    ? { ok: true, path }
    : { ok: false, message: `${tool} is not installed or not on this app's PATH.` }
}

export async function startAgentForHarness(
  harness: string,
  root: string,
  settings: AgentSettings,
  onEvent: (event: unknown) => void
): Promise<AgentHandle> {
  return driverFor(harness).start(root, settings, onEvent)
}

export async function runOneShotForHarness(
  harness: string,
  root: string,
  settings: AgentSettings,
  req: OneShotRequest
): Promise<OneShotResult> {
  return driverFor(harness).oneShot(root, settings, req)
}

/** The driver contract every backend implements. */
export interface AgentDriver {
  id: string
  kind: 'none' | 'pi' | 'acp'
  start: (
    root: string,
    settings: AgentSettings,
    onEvent: (event: unknown) => void
  ) => Promise<AgentHandle>
  oneShot: (root: string, settings: AgentSettings, req: OneShotRequest) => Promise<OneShotResult>
}

/** Resolve a harness id to its driver. Unknown ids behave like Off. */
export function driverFor(harness: string): AgentDriver {
  const kind = harnessKind(harness)
  if (kind === 'pi') {
    return {
      id: HARNESS_PI,
      kind: 'pi',
      start: (root, settings, onEvent) => startAgentSession(root, settings, '', onEvent),
      oneShot: (_root, settings, req) => runOneShot(settings, req)
    }
  }
  if (kind === 'acp') {
    const tool = harnessTool(harness)
    return {
      id: harness,
      kind: 'acp',
      start: (root, _settings, onEvent) => {
        if (!tool) throw new Error('Unknown ACP harness.')
        return startAcpSession({ cwd: root, tool, onEvent })
      },
      oneShot: (root, _settings, req) => {
        if (!tool) {
          return Promise.resolve({ ok: false, text: '', error: 'Unknown ACP harness.', elapsedMs: 0 })
        }
        return runAcpOneShot(root, tool, req)
      }
    }
  }
  return {
    id: HARNESS_NONE,
    kind: 'none',
    start: async () => {
      throw new Error('AI is turned off. Choose a harness in Settings (⌘,).')
    },
    oneShot: async () => ({
      ok: false,
      text: '',
      error: 'AI is turned off. Use the marking scheme to mark this answer yourself.',
      elapsedMs: 0
    })
  }
}
