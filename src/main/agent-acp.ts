/**
 * Agent Client Protocol (ACP) driver.
 *
 * Meridiem's built-in agent is pi. This driver is the other half of the
 * pluggable backend: it speaks JSON-RPC to an external ACP harness
 * (`opencode acp`, `claude acp`, `codex acp`) over stdio and translates the
 * ACP session stream into the event shapes the existing agent panel already
 * understands. Nothing in the renderer knows which driver produced a turn.
 *
 * Two practical constraints shape this file:
 *
 *  - A macOS .app launched from Finder inherits a tiny PATH, so a binary that
 *    works in Terminal can be invisible here. Detection therefore searches the
 *    standard CLI directories as well as PATH (see detectAcpHarnesses).
 *  - The harness is a child process. Every exit path — switching drivers,
 *    switching workspaces, quitting — must terminate it, or a notes app leaves
 *    an idle coding agent in the background. The active set at the bottom is
 *    the last line of defence.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { logLine } from './log'
import { lastAssistantText, type AgentHandle } from './agent'
import type { OneShotRequest, OneShotResult } from './agent'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface AcpHarnessInfo {
  /** `acp:opencode` */
  id: string
  tool: string
  label: string
  installed: boolean
  /** Absolute path when installed. */
  path?: string
}

const KNOWN_TOOLS: { tool: string; label: string; extraDirs: string[] }[] = [
  { tool: 'opencode', label: 'OpenCode', extraDirs: ['.opencode/bin'] },
  { tool: 'claude', label: 'Claude Code', extraDirs: ['.claude/local', '.local/bin'] },
  { tool: 'codex', label: 'Codex', extraDirs: ['.codex/bin', '.local/bin'] }
]

/** Every directory a GUI-launched app should look in for a CLI. */
export function cliSearchDirs(): string[] {
  const home = homedir()
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
  return [...new Set(dirs.filter(Boolean))]
}

async function executable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findBinary(tool: string): Promise<string | null> {
  const extra = KNOWN_TOOLS.find((t) => t.tool === tool)?.extraDirs ?? []
  const dirs = cliSearchDirs()
  for (const dir of extra) {
    const abs = join(homedir(), dir, tool)
    if (await executable(abs)) return abs
  }
  for (const dir of dirs) {
    const abs = join(dir, tool)
    if (await executable(abs)) return abs
  }
  return null
}

let detectionCache: { at: number; value: AcpHarnessInfo[] } | null = null

/** All known ACP harnesses, installed or not. Cached briefly: Settings can be
 *  opened and closed faster than a filesystem walk should run. */
export async function detectAcpHarnesses(force = false): Promise<AcpHarnessInfo[]> {
  if (!force && detectionCache && Date.now() - detectionCache.at < 8000) return detectionCache.value
  const value = await Promise.all(
    KNOWN_TOOLS.map(async (entry) => {
      const path = await findBinary(entry.tool)
      return {
        id: `acp:${entry.tool}`,
        tool: entry.tool,
        label: entry.label,
        installed: !!path,
        ...(path ? { path } : {})
      }
    })
  )
  detectionCache = { at: Date.now(), value }
  return value
}

export async function resolveAcpBinary(tool: string): Promise<string | null> {
  return findBinary(tool)
}

// ---------------------------------------------------------------------------
// JSON-RPC over NDJSON stdio
// ---------------------------------------------------------------------------

type JsonRpcId = number | string
interface RpcMessage {
  jsonrpc?: '2.0'
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface Rpc {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  onNotification: (fn: (method: string, params: unknown) => void) => void
  onRequest: (fn: (method: string, params: unknown) => Promise<unknown>) => void
  close: () => void
  readonly closed: boolean
}

function createRpc(child: ChildProcessWithoutNullStreams): Rpc {
  let nextId = 1
  let closed = false
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let notificationHandler: (method: string, params: unknown) => void = () => undefined
  let requestHandler: (method: string, params: unknown) => Promise<unknown> = async () => {
    throw new Error('No ACP request handler')
  }

  const send = (message: RpcMessage): void => {
    if (closed) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    } catch (err) {
      void logLine(`acp: write failed: ${String((err as Error)?.message ?? err)}`, 'error')
    }
  }

  const rejectAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      pending.delete(id)
    }
  }

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let msg: RpcMessage
    try {
      msg = JSON.parse(text) as RpcMessage
    } catch {
      void logLine(`acp: unreadable stdout line: ${text.slice(0, 200)}`, 'warn')
      return
    }
    // Response to one of our requests.
    if (msg.id !== undefined && !msg.method) {
      const key = typeof msg.id === 'string' ? Number(msg.id) : msg.id
      const entry = pending.get(key)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(key)
      if (msg.error) entry.reject(new Error(String(msg.error.message ?? 'ACP request failed')))
      else entry.resolve(msg.result)
      return
    }
    // Request from the agent (permission, fs, terminal).
    if (msg.method && msg.id !== undefined) {
      void (async () => {
        try {
          const result = await requestHandler(msg.method as string, msg.params)
          send({ id: msg.id, result })
        } catch (err) {
          send({
            id: msg.id,
            error: { code: -32000, message: String((err as Error)?.message ?? err) }
          })
        }
      })()
      return
    }
    // Notification.
    if (msg.method) notificationHandler(msg.method, msg.params)
  })

  const close = (): void => {
    if (closed) return
    closed = true
    rl.close()
    rejectAll('ACP connection closed')
  }

  child.on('exit', () => close())
  child.on('error', () => close())

  return {
    request(method, params, timeoutMs = 120_000) {
      if (closed) return Promise.reject(new Error('ACP connection closed'))
      const id = nextId++
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new Error(`${method} timed out`))
        }, timeoutMs)
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
        send({ id, method, params })
      })
    },
    notify(method, params) {
      send({ method, params })
    },
    onNotification(fn) {
      notificationHandler = fn
    },
    onRequest(fn) {
      requestHandler = fn
    },
    close,
    get closed() {
      return closed
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface AcpToolCall {
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
  locations?: { path?: string }[]
  content?: unknown
  rawOutput?: unknown
  started: boolean
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('')
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (o.content !== undefined) return contentText(o.content)
    if (o.delta !== undefined) return contentText(o.delta)
  }
  return ''
}

function withinWorkspace(cwd: string, path: string): boolean {
  const abs = resolve(path)
  const rel = relative(cwd, abs)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export interface AcpSessionOptions {
  cwd: string
  tool: string
  onEvent: (event: unknown) => void
  /** Used by one-shot grading; the interactive panel leaves this false. */
  noToolsNote?: string
}

/** Start one external ACP session scoped to `cwd`. */
export async function startAcpSession(opts: AcpSessionOptions): Promise<AgentHandle> {
  const { cwd, tool, onEvent } = opts
  const binary = await resolveAcpBinary(tool)
  if (!binary) {
    const info = KNOWN_TOOLS.find((t) => t.tool === tool)
    throw new Error(
      `${info?.label ?? tool} is not installed or not on this app's PATH. ` +
        'Choose Off or Built-in in Settings → AI harness, or install the CLI.'
    )
  }
  const label = KNOWN_TOOLS.find((t) => t.tool === tool)?.label ?? tool
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DISABLE_LSP: 'true',
    PATH: cliSearchDirs().join(':')
  }
  const child = spawn(binary, ['acp'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A new process group lets us take down any tool processes the harness
    // starts, not just the JSON-RPC parent.
    detached: process.platform !== 'win32'
  })
  activeChildren.add(child)
  let stderrTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000)
    if (chunk.trim()) void logLine(`acp[${tool}] stderr: ${chunk.trim().slice(0, 500)}`, 'warn')
  })
  child.on('exit', (code, signal) => {
    activeChildren.delete(child)
    void logLine(`acp[${tool}]: exited ${code ?? ''} ${signal ?? ''}`.trim(), code === 0 ? 'info' : 'warn')
  })

  const rpc = createRpc(child)
  let sessionId = ''
  let modelLabel = `${label} · ACP`
  let contextWindow: number | null = null
  let lastText = ''
  let busy = false
  let disposed = false
  let abortPrompt: (() => void) | null = null
  let turnText = ''
  const tools = new Map<string, AcpToolCall>()

  const emit = (event: unknown): void => {
    try {
      onEvent(event)
    } catch {
      /* renderer gone */
    }
  }

  const emitText = (delta: string): void => {
    if (!delta) return
    turnText += delta
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
  }

  const emitThinking = (delta: string): void => {
    if (!delta) return
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } })
  }

  const toolStart = (call: AcpToolCall): void => {
    if (call.started) return
    call.started = true
    const args: Record<string, unknown> = { ...(call.rawInput ?? {}) }
    if (!args.path && call.locations?.[0]?.path) args.path = call.locations[0].path
    emit({
      type: 'tool_execution_start',
      toolCallId: call.toolCallId,
      toolName: call.title || call.kind || 'tool',
      args
    })
  }

  const toolUpdate = (update: Record<string, unknown>): void => {
    const id = String(update.toolCallId ?? '')
    if (!id) return
    const existing = tools.get(id)
    const call: AcpToolCall =
      existing ??
      ({
        toolCallId: id,
        title: typeof update.title === 'string' ? update.title : undefined,
        kind: typeof update.kind === 'string' ? update.kind : undefined,
        rawInput: (update.rawInput as Record<string, unknown>) ?? {},
        locations: Array.isArray(update.locations) ? (update.locations as { path?: string }[]) : [],
        started: false
      } satisfies AcpToolCall)
    if (update.title) call.title = String(update.title)
    if (update.kind) call.kind = String(update.kind)
    if (update.rawInput && typeof update.rawInput === 'object') {
      call.rawInput = { ...(call.rawInput ?? {}), ...(update.rawInput as Record<string, unknown>) }
    }
    if (Array.isArray(update.locations)) call.locations = update.locations as { path?: string }[]
    if (update.content !== undefined) call.content = update.content
    if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput
    call.status = typeof update.status === 'string' ? update.status : call.status
    tools.set(id, call)

    // Wait for the first update that actually carries the input: opencode sends
    // a pending call with `{}` before the tool knows what it is doing.
    if (!call.started && (call.status === 'in_progress' || Object.keys(call.rawInput ?? {}).length > 0 || update.content)) {
      toolStart(call)
    }
    const output = contentText(call.content) || contentText(call.rawOutput)
    if (output) {
      emit({ type: 'tool_execution_update', toolCallId: id, partial: output })
    }
    if (call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled') {
      toolStart(call)
      emit({
        type: 'tool_execution_end',
        toolCallId: id,
        result: output,
        isError: call.status === 'failed'
      })
    }
  }

  const onUpdate = (params: unknown): void => {
    const p = params as { sessionId?: string; update?: Record<string, unknown> } | undefined
    if (!p?.update) return
    if (p.sessionId && sessionId && p.sessionId !== sessionId) return
    const u = p.update
    const kind = String(u.sessionUpdate ?? '')
    switch (kind) {
      case 'agent_message_chunk':
        emitText(contentText(u.content))
        break
      case 'agent_thought_chunk':
        emitThinking(contentText(u.content))
        break
      case 'tool_call':
      case 'tool_call_update':
        toolUpdate(u)
        break
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries : []
        if (entries.length > 0) {
          const text = entries
            .map((e) => {
              const entry = e as Record<string, unknown>
              return `${entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '→' : '·'} ${String(entry.content ?? '')}`
            })
            .join('\n')
          emitThinking(`Plan:\n${text}\n`)
        }
        break
      }
      case 'usage_update': {
        const used = Number(u.used ?? 0)
        const size = Number(u.size ?? 0)
        if (size > 0) contextWindow = size
        if (used > 0) emit({ type: 'acp_usage', usage: { promptTokens: used, totalTokens: used } })
        break
      }
      case 'config_option_update': {
        const options = Array.isArray(u.configOptions) ? u.configOptions : []
        const model = options.find((o) => {
          const opt = o as Record<string, unknown>
          return opt.category === 'model' || opt.id === 'model'
        }) as Record<string, unknown> | undefined
        const current = model?.currentValue
        if (typeof current === 'string' && current) modelLabel = `${label} · ${current}`
        break
      }
      default:
        // available_commands_update, current_mode_update, user_message_chunk, …
        break
    }
  }

  rpc.onNotification((method, params) => {
    if (method === 'session/update') onUpdate(params)
  })

  rpc.onRequest(async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'session/request_permission') {
      const options = Array.isArray(p.options) ? (p.options as Record<string, unknown>[]) : []
      const allow =
        options.find((o) => String(o.kind ?? '').startsWith('allow')) ??
        options.find((o) => o.optionId) ??
        options[0]
      const optionId = allow?.optionId
      if (!optionId) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId } }
    }
    if (method === 'fs/read_text_file') {
      const path = String(p.path ?? '')
      if (!withinWorkspace(cwd, path)) throw new Error('ACP read outside the workspace was refused')
      let content = await fs.readFile(path, 'utf-8')
      const line = Number(p.line ?? 0)
      const limit = Number(p.limit ?? 0)
      if (line > 0) {
        const lines = content.split('\n')
        content = lines.slice(line - 1, limit > 0 ? line - 1 + limit : undefined).join('\n')
      }
      return { content }
    }
    if (method === 'fs/write_text_file') {
      const path = String(p.path ?? '')
      if (!withinWorkspace(cwd, path)) throw new Error('ACP write outside the workspace was refused')
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.writeFile(path, String(p.content ?? ''), 'utf-8')
      return null
    }
    throw new Error(`Unsupported ACP request: ${method}`)
  })

  try {
    const init = (await rpc.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false
        }
      },
      25_000
    )) as { agentInfo?: { name?: string } }
    if (init?.agentInfo?.name) {
      modelLabel = `${init.agentInfo.name} · ACP`
    }
    const created = (await rpc.request(
      'session/new',
      { cwd, mcpServers: [] },
      35_000
    )) as { sessionId?: string; configOptions?: Record<string, unknown>[] }
    if (!created?.sessionId) throw new Error('The ACP harness did not create a session.')
    sessionId = created.sessionId
    const model = (created.configOptions ?? []).find(
      (o) => o.category === 'model' || o.id === 'model'
    ) as Record<string, unknown> | undefined
    if (typeof model?.currentValue === 'string' && model.currentValue) {
      modelLabel = `${label} · ${model.currentValue}`
    }
  } catch (err) {
    rpc.close()
    killChildTree(child, 'SIGTERM')
    activeChildren.delete(child)
    throw err
  }

  void logLine(`acp[${tool}]: session ${sessionId} in ${cwd}`)

  const handle: AgentHandle = {
    modelLabel,
    prompt: async (text, images) => {
      if (disposed) throw new Error('The ACP session is closed')
      if (busy) throw new Error('The agent is already answering')
      busy = true
      turnText = ''
      tools.clear()
      const prompt = [
        { type: 'text', text: opts.noToolsNote ? `${opts.noToolsNote}\n\n${text}` : text }
      ]
      for (const image of images ?? []) {
        prompt.push({ type: 'image', data: image.data, mimeType: image.mimeType } as never)
      }
      const aborted = new Promise<'aborted'>((resolveAbort) => {
        abortPrompt = () => resolveAbort('aborted')
      })
      try {
        const outcome = await Promise.race([
          rpc.request('session/prompt', { sessionId, prompt }, 15 * 60_000),
          aborted
        ])
        if (outcome === 'aborted') {
          emit({
            type: 'message_end',
            message: { role: 'assistant', content: [], stopReason: 'aborted' }
          })
          return
        }
        const result = outcome as { stopReason?: string }
        lastText = turnText
        // A final `text_end` carries the whole block even if the harness sent
        // no deltas (or the renderer missed them). The panel creates the text
        // row from this, then message_end closes the turn.
        if (turnText) {
          emit({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_end', content: turnText }
          })
        }
        emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: turnText }],
            stopReason: result?.stopReason ?? 'end_turn'
          }
        })
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: turnText }],
            stopReason: 'error',
            errorMessage: `${message}${stderrTail ? `\n${stderrTail.slice(-500)}` : ''}`
          }
        })
        throw err
      } finally {
        busy = false
        abortPrompt = null
        for (const call of tools.values()) {
          if (!call.started) toolStart(call)
        }
      }
    },
    abort: async () => {
      if (sessionId) rpc.notify('session/cancel', { sessionId })
      abortPrompt?.()
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      abortPrompt?.()
      rpc.close()
      activeChildren.delete(child)
      killChildTree(child, 'SIGTERM')
      const killTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), 1200)
      killTimer.unref?.()
    },
    compact: async () => {
      // The external harness owns its own context management; its /compact
      // command is available through the composer as a normal prompt.
      return null
    },
    setThinking: () => {
      /* ACP harnesses expose effort through their own config; not wired here. */
    },
    sessionFile: () => undefined,
    messages: () =>
      lastText ? [{ role: 'assistant', content: [{ type: 'text', text: lastText }] }] : [],
    contextWindow: () => contextWindow
  }
  return handle
}

/** One throwaway ACP turn, for marking a prose answer. */
export async function runAcpOneShot(
  root: string,
  tool: string,
  req: OneShotRequest
): Promise<OneShotResult> {
  const started = Date.now()
  let handle: AgentHandle | null = null
  const timeoutMs = req.timeoutMs ?? 90_000
  try {
    handle = await startAcpSession({
      cwd: root,
      tool,
      onEvent: () => undefined,
      noToolsNote:
        'This is a marking request. Do not use tools, do not edit files, and reply with the requested JSON only.'
    })
    const answer = handle.prompt(`${req.system}\n\n---\n\n${req.prompt}`)
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    const outcome = await Promise.race([answer.then(() => 'done' as const), timeout])
    if (outcome === 'timeout') {
      await handle.abort().catch(() => undefined)
      return { ok: false, text: '', error: `no answer within ${Math.round(timeoutMs / 1000)}s`, elapsedMs: Date.now() - started }
    }
    const text = lastAssistantText(handle.messages()).trim()
    if (!text) return { ok: false, text: '', error: 'the ACP harness returned nothing', elapsedMs: Date.now() - started }
    return { ok: true, text, elapsedMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: String((err as Error)?.message ?? err),
      elapsedMs: Date.now() - started
    }
  } finally {
    await handle?.dispose().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Child-process registry
// ---------------------------------------------------------------------------

const activeChildren = new Set<ChildProcessWithoutNullStreams>()

function killChildTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid
  try {
    if (pid && process.platform !== 'win32') process.kill(-pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* gone */
    }
  }
}

/** Kill every ACP child. Called from before-quit and driver/workspace changes. */
export function terminateAllAcpChildren(): void {
  for (const child of activeChildren) {
    killChildTree(child, 'SIGTERM')
    const timer = setTimeout(() => killChildTree(child, 'SIGKILL'), 800)
    timer.unref?.()
  }
  activeChildren.clear()
}

export function activeAcpCount(): number {
  return activeChildren.size
}
