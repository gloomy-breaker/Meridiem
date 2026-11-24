import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import deepseekSearchExtensionSource from './agent-extensions/deepseek-search.ts?raw'
import systemPromptAppend from './prompts/system.md?raw'
import { listModels, loadProviders, migratePiSessions, writePiConfig, sessionsDir } from './providers'
import yestionSkillText from './prompts/skill.md?raw'
import { logLine } from './log'

// pi is an ESM-only package; the main bundle is CJS, so load it dynamically.
// (Type-only imports are erased at compile time and are safe.)
type PiSessionEvent = {
  type: string
  /** `text_delta` streams a piece; `text_end` carries the whole block. */
  assistantMessageEvent?: { type: string; delta?: string; content?: string }
  error?: string
}

export interface AgentSettings {
  provider: string
  model: string
  apiKey: string
  thinkingLevel?: string
  /** Resume this pi session file (.jsonl) instead of starting a new one. */
  sessionFile?: string
  /** Force a brand new session (used by "New chat"). */
  newSession?: boolean
}

export interface AgentSessionInfo {
  path: string
  id: string
  name?: string
  firstMessage: string
  created: string
  modified: string
  messageCount: number
}

export interface AgentHandle {
  prompt: (text: string, images?: { data: string; mimeType: string }[]) => Promise<void>
  abort: () => Promise<void>
  dispose: () => Promise<void>
  compact: (instructions?: string) => Promise<unknown>
  setThinking: (level: string) => void
  modelLabel: string
  /** pi session file backing this conversation (undefined before the first message). */
  sessionFile: () => string | undefined
  messages: () => unknown[]
  /** Context window of the active model, when known. */
  contextWindow: () => number | null
}

interface PiApi {
  createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: unknown }>
  ModelRuntime: {
    create: (opts?: Record<string, unknown>) => Promise<{
      setRuntimeApiKey: (provider: string, key: string) => Promise<void>
      getModel: (provider: string, id: string) => unknown
      getAvailable: () => Promise<readonly { provider: string; id: string }[]>
    }>
  }
  DefaultResourceLoader: unknown
  getAgentDir: () => string
  SessionManager: {
    inMemory: (cwd?: string) => unknown
    create: (cwd: string, sessionDir?: string, options?: unknown) => unknown
    open: (path: string, sessionDir?: string, cwdOverride?: string) => unknown
    list: (cwd: string, sessionDir?: string) => Promise<
      { path: string; id: string; name?: string; firstMessage: string; created: Date; modified: Date; messageCount: number }[]
    >
  }
}

let piPromise: Promise<PiApi> | null = null
let currentHandle: AgentHandle | null = null

export function getCurrentHandle(): AgentHandle | null {
  return currentHandle
}

/**
 * The models the app offers: exactly what is configured in Meridiem's own
 * provider store. pi's built-in catalog (the hundred unusable entries) is never
 * shown and never fetched.
 */
export async function listAvailableModels(): Promise<
  { provider: string; providerName: string; id: string; name: string; contextWindow: number }[]
> {
  return listModels()
}

/** Import providers/keys from ~/.pi/agent on first run (returns the count). */
export async function importPiProviders(): Promise<number> {
  return (await loadProviders()).length
}
function loadPi(): Promise<PiApi> {
  piPromise ??= import('@earendil-works/pi-coding-agent') as Promise<PiApi>
  return piPromise
}

function yestionSystemPrompt(workspaceRoot: string): string {
  return systemPromptAppend.replaceAll('{{WORKSPACE_ROOT}}', workspaceRoot)
}

// ---------------------------------------------------------------------------
// Bundled agent extensions
// ---------------------------------------------------------------------------

/**
 * Extensions that ship with the app (DeepSeek web search/fetch today).
 *
 * They live here as plain TypeScript so they stay readable, and are inlined into
 * the main bundle at build time; at session start they are written into
 * `<userData>/agent/extensions/`, which pi's resource loader scans for both the
 * chat agent and any session the user later resumes. The files are app-owned
 * and rewritten on change, so local edits in the user's agent dir do not survive.
 */
const BUNDLED_EXTENSIONS: { file: string; source: string }[] = [
  { file: 'deepseek-search.ts', source: deepseekSearchExtensionSource }
]

async function seedAgentExtensions(agentDir: string): Promise<void> {
  const dir = join(agentDir, 'extensions')
  for (const { file, source } of BUNDLED_EXTENSIONS) {
    const path = join(dir, file)
    try {
      if ((await fs.readFile(path, 'utf-8')) === source) continue
    } catch {
      /* first run: nothing there yet */
    }
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path, source, 'utf-8')
      void logLine(`agent extensions: wrote ${path}`, 'info')
    } catch (err) {
      // A missing search tool is a degraded agent, not a broken app: keep going.
      void logLine(`agent extensions: could not write ${path}: ${String((err as Error)?.message ?? err)}`, 'error')
    }
  }
}

// The Meridiem skill: seeded at .pi/skills/yestion/SKILL.md *only when missing*,
// so the user can tune it without the app overwriting their edits. The text
// lives in src/main/prompts/skill.md.
const YESTION_SKILL_TEXT = yestionSkillText

/** Recent conversations for this workspace, newest first. */
export async function listAgentSessions(workspaceRoot: string): Promise<AgentSessionInfo[]> {
  const pi = await loadPi()
  try {
    // One-time: bring any conversations from a ~/.pi setup across, so resuming
    // still works for people who used the pi CLI in this workspace.
    await migratePiSessions(workspaceRoot)
    const sessions = await pi.SessionManager.list(workspaceRoot, sessionsDir(workspaceRoot))
    return sessions
      .filter((s) => s.messageCount > 0)
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
      .slice(0, 40)
      .map((s) => ({
        path: s.path,
        id: s.id,
        name: s.name,
        firstMessage: (s.firstMessage ?? '')
          .replace(/^\[User is viewing the page[^\]]*\]\s*/, '')
          .replace(/\s+/g, ' ')
          .slice(0, 140),
        created: new Date(s.created).toISOString(),
        modified: new Date(s.modified).toISOString(),
        messageCount: s.messageCount
      }))
  } catch (err) {
    // An error here used to look identical to "no conversations yet", which
    // hides real faults from whoever is looking at the picker.
    void logLine(`agent sessions: listing failed: ${String((err as Error)?.message ?? err)}`, 'error')
    return []
  }
}

/**
 * Read a stored conversation as renderable messages.
 *
 * Parsed straight from the session JSONL (rather than through SessionManager,
 * which loaded nothing for the currently-open session) and image payloads are
 * replaced with a placeholder so the IPC payload stays small.
 */
export async function readAgentSessionMessages(sessionPath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(sessionPath, 'utf-8')
    const entries: { type?: string; id?: string; parentId?: string | null; message?: unknown }[] = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        entries.push(JSON.parse(text))
      } catch {
        /* skip malformed line */
      }
    }
    if (entries.length === 0) return []
    const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id as string, e]))
    const parentIds = new Set(entries.map((e) => e.parentId).filter(Boolean) as string[])
    // The active branch is the chain from the newest leaf back to the root.
    let leaf = [...entries].reverse().find((e) => e.id && !parentIds.has(e.id))
    const chain: typeof entries = []
    const guard = new Set<string>()
    while (leaf) {
      chain.push(leaf)
      if (!leaf.id || guard.has(leaf.id)) break
      guard.add(leaf.id)
      leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined
      if (!leaf) break
    }
    chain.reverse()
    return chain.filter((e) => e.type === 'message' && e.message).map((e) => stripImageData(e.message))
  } catch (err) {
    // A session file that does not exist yet (the agent has not written its
    // first message) is normal, not an error worth logging loudly.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      void logLine(`agent session read failed (${sessionPath}): ${String((err as Error)?.message ?? err)}`, 'error')
    }
    return []
  }
}

function stripImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImageData)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'data' && typeof v === 'string' && v.length > 512) continue
      out[k] = stripImageData(v)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// One-shot calls
// ---------------------------------------------------------------------------

export interface OneShotRequest {
  /**
   * Replaces the system prompt outright. A grader is not a notebook assistant:
   * it must not inherit the Meridiem skill, the workspace context files, or the
   * "you are editing this page" framing.
   */
  system: string
  /** The single user turn. */
  prompt: string
  /** Abort after this long. Defaults to `ONE_SHOT_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Defaults to `'low'`: marking against a rubric does not need deep reasoning,
   *  and the caller is sitting in front of a paused exam clock waiting. */
  thinkingLevel?: string
}

export interface OneShotResult {
  ok: boolean
  /** The model's reply, trimmed. Empty when `ok` is false. */
  text: string
  /** Why it failed, when it did. */
  error?: string
  /** Wall-clock ms, so the caller can add the pause back to a running clock. */
  elapsedMs: number
}

/** A grading call that has not answered in this long has stopped being useful. */
export const ONE_SHOT_TIMEOUT_MS = 90_000

interface OneShotSession {
  messages?: unknown[]
  subscribe: (fn: (event: PiSessionEvent) => void) => () => void
  prompt: (text: string) => Promise<void>
  abort: () => Promise<void>
  dispose: () => void
}

/** Concatenated text of the last assistant message, for a reply that never
 *  streamed (or streamed less than the final message holds). */
export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown }
    if (m?.role !== 'assistant') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    return blocks
      .map((b) => b as { type?: string; text?: string })
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
  }
  return ''
}

// One call at a time. Each one builds its own ModelRuntime, and two of those
// interleaving over the same auth/models files underneath the user's live chat
// session is a race with nothing to gain from winning it.
let oneShotQueue: Promise<unknown> = Promise.resolve()

/**
 * Ask the model one question and give back its answer — no tools, no session
 * file, no transcript, nothing the user can see or resume.
 *
 * This exists because grading an exam answer is not a chat turn: routing it
 * through the live handle would scroll marking prompts through the agent panel
 * and race whatever the user is already asking. Failures are returned rather
 * than thrown, because every caller has to degrade gracefully anyway — an exam
 * must never be blocked by a network call.
 */
export function runOneShot(settings: AgentSettings, req: OneShotRequest): Promise<OneShotResult> {
  const next = () => oneShotNow(settings, req)
  const run = oneShotQueue.then(next, next)
  oneShotQueue = run.catch(() => undefined)
  return run
}

async function oneShotNow(settings: AgentSettings, req: OneShotRequest): Promise<OneShotResult> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const fail = (error: string): OneShotResult => ({ ok: false, text: '', error, elapsedMs: elapsed() })

  let session: OneShotSession | null = null
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    const pi = await loadPi()
    const piConfig = await writePiConfig()
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: piConfig.authPath,
      modelsPath: piConfig.modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    if (settings.apiKey) {
      await modelRuntime.setRuntimeApiKey(settings.provider, settings.apiKey)
    }
    const model = settings.model ? modelRuntime.getModel(settings.provider, settings.model) : undefined

    // A bare loader: the task text IS the system prompt, there are no skills to
    // discover, no AGENTS.md to fold in, and nothing from the workspace to leak
    // into a marking decision.
    const LoaderCtor = pi.DefaultResourceLoader as unknown as new (opts: Record<string, unknown>) => {
      reload: () => Promise<void>
    }
    const loader = new LoaderCtor({
      cwd: process.cwd(),
      agentDir: piConfig.agentDir,
      systemPrompt: req.system,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    })
    await loader.reload()

    const sessionOpts: Record<string, unknown> = {
      cwd: process.cwd(),
      thinkingLevel: req.thinkingLevel ?? 'low',
      modelRuntime,
      resourceLoader: loader,
      // Never on disk: a grading call is not a conversation to open or resume.
      sessionManager: pi.SessionManager.inMemory(),
      // The whole difference between "mark this answer" and "go edit the
      // workspace" is whether the model is holding tools.
      noTools: 'all'
    }
    if (model) sessionOpts.model = model
    const created = await pi.createAgentSession(sessionOpts)
    session = created.session as OneShotSession

    // Prefer the stream, fall back to the stored message: `text_end` carries the
    // whole block, `text_delta` arrives piecewise, and some providers do neither.
    let streamed = ''
    unsubscribe = session.subscribe((event) => {
      const ame = event.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined
      if (!ame) return
      if (ame.type === 'text_delta' && ame.delta) streamed += ame.delta
      else if (ame.type === 'text_end' && typeof ame.content === 'string' && ame.content.length > streamed.length) {
        streamed = ame.content
      }
    })

    const timeoutMs = req.timeoutMs ?? ONE_SHOT_TIMEOUT_MS
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const outcome = await Promise.race([
      session.prompt(req.prompt).then(() => 'done' as const),
      timedOut
    ])
    if (outcome === 'timeout') {
      await session.abort().catch(() => undefined)
      return fail(`no answer within ${Math.round(timeoutMs / 1000)}s`)
    }

    const text = (streamed || lastAssistantText(session.messages ?? [])).trim()
    if (!text) return fail('the model returned nothing')
    return { ok: true, text, elapsedMs: elapsed() }
  } catch (err) {
    return fail(String((err as Error)?.message ?? err))
  } finally {
    if (timer !== null) clearTimeout(timer)
    unsubscribe?.()
    try {
      session?.dispose()
    } catch {
      /* already torn down */
    }
  }
}

export async function startAgentSession(
  workspaceRoot: string,
  settings: AgentSettings,
  authDir: string,
  onEvent: (event: PiSessionEvent) => void
): Promise<AgentHandle> {
  const pi = await loadPi()
  // Share the user's existing pi credentials/model configs (so Meridiem's agent
  // uses the same providers, keys and models as their terminal pi). Meridiem's
  // own BYOK settings act as an override when set.
  // pi is fed from Meridiem's own provider store (userData/agent/…): our
  // providers, our models, our keys. No catalog refresh, no ~/.pi dependency.
  const piConfig = await writePiConfig()
  // Bundled extensions need to find Meridiem's own auth.json/models.json (their
  // default lookup is ~/.pi/agent), and must be on disk before the loader scans.
  process.env.YESTION_AGENT_DIR = piConfig.agentDir
  await seedAgentExtensions(piConfig.agentDir)
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: piConfig.authPath,
    modelsPath: piConfig.modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  void authDir // reserved for future local-only keys
  if (settings.apiKey) {
    await modelRuntime.setRuntimeApiKey(settings.provider, settings.apiKey)
  }

  // Only pin a model when the user explicitly asks; otherwise let pi use its
  // own configured default model from ~/.pi/agent settings.
  const model = settings.model ? modelRuntime.getModel(settings.provider, settings.model) : undefined

  // The workspace-conventions skill (id `yestion`, retained for compatibility)
  // lives in the workspace itself so pi discovers it like any other skill AND
  // the user can read/edit/tune it in plain files.
  const skillDir = join(workspaceRoot, '.pi', 'skills', 'yestion')
  await fs.mkdir(skillDir, { recursive: true })
  const skillPath = join(skillDir, 'SKILL.md')
  // Seed it, and keep it current — but never silently overwrite a file the
  // user has tuned. `.seed` records the hash of the text the app last wrote:
  //   - hash matches (untouched since seeding) → safe to bring up to date;
  //   - hash differs (the user edited it)      → leave it alone;
  //   - no `.seed` (an install from before this scheme) → copy the old file to
  //     SKILL.md.bak, then update, so a tuned copy is recoverable.
  // The old behaviour overwrote the file on every start and threw away edits;
  // the next behaviour seeded once and left a stale skill behind forever.
  const seedPath = join(skillDir, '.seed')
  const shippedHash = createHash('sha256').update(YESTION_SKILL_TEXT).digest('hex')
  try {
    const existing = await fs.readFile(skillPath, 'utf-8')
    let seedHash = ''
    try {
      seedHash = (await fs.readFile(seedPath, 'utf-8')).trim()
    } catch {
      // No seed record: an older install.
    }
    const existingHash = createHash('sha256').update(existing).digest('hex')
    if (existingHash !== shippedHash) {
      if (!seedHash) {
        await fs.writeFile(`${skillPath}.bak`, existing, 'utf-8')
        await fs.writeFile(skillPath, YESTION_SKILL_TEXT, 'utf-8')
      } else if (seedHash === existingHash) {
        await fs.writeFile(skillPath, YESTION_SKILL_TEXT, 'utf-8')
      }
      // Otherwise the user edited it — respect that.
    }
    await fs.writeFile(seedPath, shippedHash, 'utf-8')
  } catch {
    await fs.writeFile(skillPath, YESTION_SKILL_TEXT, 'utf-8')
    await fs.writeFile(seedPath, shippedHash, 'utf-8')
  }

  const LoaderCtor = pi.DefaultResourceLoader as unknown as new (opts: {
    cwd: string
    agentDir: string
    appendSystemPromptOverride?: (base: string[]) => string[]
  }) => { reload: () => Promise<void> }
  const loader = new LoaderCtor({
    cwd: workspaceRoot,
    agentDir: piConfig.agentDir,
    appendSystemPromptOverride: (base) => [...base, yestionSystemPrompt(workspaceRoot)]
  })
  await loader.reload()

  // Providers support different thinking levels (DeepSeek has no `xhigh`).
  // Asking for one it does not map is how a turn can end up producing nothing,
  // so clamp to the nearest level the configured model actually supports.
  const requestedLevel = (settings.thinkingLevel as string) || 'max'
  let effectiveLevel = requestedLevel
  try {
    const providers = await loadProviders()
    const modelCfg = providers
      .find((p) => p.id === settings.provider)
      ?.models.find((m) => m.id === settings.model)
    const map = modelCfg?.thinkingLevelMap
    if (map && !(requestedLevel in map && map[requestedLevel])) {
      const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      const idx = order.indexOf(requestedLevel)
      let best = ''
      for (let d = 1; d < order.length && !best; d++) {
        for (const cand of [order[idx - d], order[idx + d]]) {
          if (cand && cand in map && map[cand]) {
            best = cand
            break
          }
        }
      }
      if (best) effectiveLevel = best
    }
    if (effectiveLevel !== requestedLevel) {
      console.warn(`[meridiem] thinking level ${requestedLevel} → ${effectiveLevel} (${modelCfg?.id ?? 'model'})`)
    }
  } catch {
    /* keep the requested level */
  }

  const sessionOpts: Record<string, unknown> = {
    cwd: workspaceRoot,
    thinkingLevel: effectiveLevel,
    modelRuntime,
    resourceLoader: loader,
    // Sessions persist to the user's pi session dir (~/.pi/agent/sessions/...)
    // so conversations can be listed and resumed here — and with `pi -r` in the
    // terminal, since it's the same format and location.
    sessionManager: settings.newSession
      ? pi.SessionManager.create(workspaceRoot, sessionsDir(workspaceRoot))
      : settings.sessionFile
        ? pi.SessionManager.open(settings.sessionFile, sessionsDir(workspaceRoot))
        : pi.SessionManager.create(workspaceRoot, sessionsDir(workspaceRoot))
  }
  if (model) sessionOpts.model = model
  const { session } = await pi.createAgentSession(sessionOpts)

  const typed = session as {
    sessionFile?: string
    messages?: unknown[]
    model?: { contextWindow?: number }
    subscribe: (fn: (event: PiSessionEvent) => void) => () => void
    prompt: (text: string, options?: { images?: { type: 'image'; data: string; mimeType: string }[] }) => Promise<void>
    abort: () => Promise<void>
    dispose: () => void
  }
  const unsubscribe = typed.subscribe((event) => {
    try {
      onEvent(event)
    } catch {
      // Renderer gone; ignore.
    }
  })

  const handleResult: AgentHandle = {
    modelLabel: model ? `${String((model as { provider: string }).provider)}/${String((model as { id: string }).id)}` : 'pi default',
    prompt: (text, images) =>
      typed.prompt(text, images && images.length > 0 ? { images: images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) } : undefined),
    abort: () => typed.abort(),
    compact: (instructions) => (typed as unknown as { compact: (i?: string) => Promise<unknown> }).compact(instructions),
    setThinking: (level) => (typed as unknown as { setThinkingLevel: (l: string) => void }).setThinkingLevel(level),
    sessionFile: () => typed.sessionFile,
    messages: () => typed.messages ?? [],
    contextWindow: () => (typeof typed.model?.contextWindow === 'number' ? typed.model.contextWindow : null),
    dispose: async () => {
      unsubscribe()
      typed.dispose()
      if (currentHandle === handleResult) currentHandle = null
    }
  }
  currentHandle = handleResult
  return handleResult
}
