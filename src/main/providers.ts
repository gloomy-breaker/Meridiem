// ---------------------------------------------------------------------------
// Providers & models — Meridiem's own configuration.
//
// This replaces "read whatever pi happens to have configured". The app owns a
// list of providers (name, base URL, wire protocol, API key) and the models
// under each one (id, display name, context window, what inputs it takes), and
// it *generates* pi's config from that store. So:
//
//   * the model picker shows exactly the models you added — never pi's built-in
//     catalog with a hundred entries you cannot use,
//   * no model catalog is ever fetched over the network (the runtime is told not
//     to refresh),
//   * API keys live in the OS keychain (Electron safeStorage), not in
//     ~/.pi/agent/auth.json,
//   * sessions live in the app's own data directory.
//
// `~/.pi/agent/models.json` + `auth.json` are imported once, on first run, so
// an existing pi setup carries over instead of having to be retyped.
// ---------------------------------------------------------------------------
import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Wire protocols pi can talk. */
export const WIRE_APIS = [
  { id: 'openai-completions', label: 'OpenAI-compatible (/chat/completions)' },
  { id: 'openai-responses', label: 'OpenAI Responses API' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Generative AI' }
] as const

export interface ModelInputs {
  text: boolean
  image: boolean
  audio: boolean
  video: boolean
}

export interface ModelConfig {
  /** What goes on the wire (e.g. `deepseek-flash`). */
  id: string
  /** What the picker shows. */
  name: string
  contextWindow: number
  maxTokens: number
  /** Model can produce reasoning/thinking output. */
  reasoning: boolean
  input: ModelInputs
  /** Position in the (flat) models list. New models append at the end. */
  order?: number
  /**
   * Which thinking levels this model accepts. Providers differ — DeepSeek maps
   * low/high/max and has no `xhigh` — and passing an unmapped level through is
   * how a turn ends up producing no answer at all.
   */
  thinkingLevelMap?: Record<string, string | null>
  /**
   * Provider quirks pi needs to talk to it correctly, e.g.
   * `{ thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true }`.
   * Dropping these broke DeepSeek's reasoning stream (the reply stopped).
   */
  compat?: Record<string, unknown>
}

export interface ProviderConfig {
  /** Slug used in pi's config and in settings (e.g. `deepseek`). */
  id: string
  name: string
  baseUrl: string
  api: string
  models: ModelConfig[]
}

export interface ProviderStatus extends ProviderConfig {
  hasKey: boolean
}

export function defaultInputs(): ModelInputs {
  return { text: true, image: false, audio: false, video: false }
}

/** Trim what people paste: stray whitespace and trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function agentDir(): string {
  return join(app.getPath('userData'), 'agent')
}
function providersPath(): string {
  return join(agentDir(), 'providers.json')
}
function keysPath(): string {
  return join(agentDir(), 'keys.json')
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown, secret = false): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: secret ? 0o600 : 0o644 })
}

// ---- store -----------------------------------------------------------------

let cache: ProviderConfig[] | null = null
let loading: Promise<ProviderConfig[]> | null = null
/** Live list for the probe helpers below. */
let providers: ProviderConfig[] = []

/**
 * Load (and on first run seed) the provider store.
 *
 * Memoised as a single in-flight promise: the renderer asks for providers,
 * models and the settings UI at the same time on boot, and letting those race
 * meant several seeding passes wrote keys.json/models.json over each other —
 * which lost keys and truncated the generated pi config.
 */
/**
 * Fill in `compat` / `thinkingLevelMap` from a pi setup for models that were
 * imported before we carried those fields. Read-only, and only fills blanks.
 */
async function backfillModelMeta(list: ProviderConfig[]): Promise<boolean> {
  const piDir = process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const legacy = await readJson<PiModelFile>(join(piDir, 'models.json'), { providers: {} })
  let changed = false
  for (const provider of list) {
    const src = legacy.providers?.[provider.id]
    if (!src) continue
    for (const model of provider.models) {
      const match = (src.models ?? []).find((m) => m.id === model.id)
      if (!match) continue
      if (!model.compat && match.compat) {
        model.compat = match.compat
        changed = true
      }
      if (!model.thinkingLevelMap && match.thinkingLevelMap) {
        model.thinkingLevelMap = match.thinkingLevelMap
        changed = true
      }
    }
  }
  return changed
}

export function loadProviders(): Promise<ProviderConfig[]> {
  if (cache) return Promise.resolve(cache)
  loading ??= (async () => {
    const stored = await readJson<{ providers?: ProviderConfig[] }>(providersPath(), {})
    cache = stored.providers ?? []
    providers = cache // the probe helpers read this mirror
    let dirty = await backfillModelMeta(cache)
    // Give every model a position (older stores have none) so the list keeps a
    // stable, user-controlled order instead of being sorted.
    let next = cache.reduce((max, p) => p.models.reduce((m, x) => Math.max(m, x.order ?? 0), max), 0)
    for (const provider of cache) {
      for (const model of provider.models) {
        if (typeof model.order !== 'number') {
          model.order = ++next
          dirty = true
        }
      }
    }
    if (dirty) await writeJson(providersPath(), { providers: cache })
    // Keep pi's generated config in step with the store (also when empty).
    await writePiConfig()
    return cache
  })()
  return loading
}

/** Import providers, models and keys from a ~/.pi/agent setup (explicit action). */
export async function importFromPi(): Promise<number> {
  const seeded = await seedFromPi()
  if (seeded.length === 0) return 0
  const existing = await loadProviders()
  const byId = new Map(existing.map((p) => [p.id, p]))
  for (const p of seeded) byId.set(p.id, p)
  await saveProviders([...byId.values()])
  return seeded.length
}

export async function saveProviders(list: ProviderConfig[]): Promise<void> {
  for (const provider of list) provider.baseUrl = normalizeBaseUrl(provider.baseUrl)
  cache = list
  providers = list
  await writeJson(providersPath(), { providers: list })
  await writePiConfig()
}

export async function setProviderKey(providerId: string, key: string): Promise<void> {
  const keys = await readJson<Record<string, string>>(keysPath(), {})
  if (!key) {
    delete keys[providerId]
  } else if (safeStorage.isEncryptionAvailable()) {
    keys[providerId] = 'enc:' + safeStorage.encryptString(key).toString('base64')
  } else {
    keys[providerId] = 'raw:' + Buffer.from(key, 'utf-8').toString('base64')
  }
  await writeJson(keysPath(), keys, true)
}

/**
 * Key for the in-flight draft probe. Held in memory only: this used to be
 * written into the real `keys.json` as a 'draft' provider and restored
 * afterwards, so a crash (or two probes at once) could strand the entry in the
 * user's key file — or lose the file outright.
 */
let draftKey: string | null = null

export async function getProviderKey(providerId: string): Promise<string | undefined> {
  // Settings' Test button probes a key that has not been saved yet.
  if (providerId === 'draft') return draftKey ?? undefined
  const keys = await readJson<Record<string, string>>(keysPath(), {})
  const stored = keys[providerId]
  if (!stored) return undefined
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf-8')
  } catch {
    return undefined
  }
  return undefined
}

export async function listProviderStatus(): Promise<ProviderStatus[]> {
  const providers = await loadProviders()
  return Promise.all(
    providers.map(async (p) => ({ ...p, hasKey: Boolean(await getProviderKey(p.id)) }))
  )
}

/** Every model, flattened — what the agent's model picker shows. */
export async function listModels(): Promise<
  { provider: string; providerName: string; id: string; name: string; contextWindow: number }[]
> {
  const providers = await loadProviders()
  return providers
    .flatMap((p) =>
      p.models.map((m) => ({
        provider: p.id,
        providerName: p.name,
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow,
        order: m.order ?? 0
      }))
    )
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest)
}

// ---- pi bridge -------------------------------------------------------------

/** Presets the onboarding wizard offers (and Settings can prefill from). */
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', modelId: 'deepseek-flash', modelName: 'DeepSeek V4.1 Flash', contextWindow: 1000000 },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', modelId: 'gpt-4o-mini', modelName: 'GPT-4o mini', contextWindow: 128000 },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', modelId: 'claude-sonnet-4-5', modelName: 'Claude Sonnet 4.5', contextWindow: 200000 },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', modelId: 'anthropic/claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5 (OpenRouter)', contextWindow: 200000 },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', modelId: 'llama-3.3-70b-versatile', modelName: 'Llama 3.3 70B', contextWindow: 128000 },
  { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', api: 'google-generative-ai', modelId: 'gemini-2.0-flash', modelName: 'Gemini 2.0 Flash', contextWindow: 1000000 },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', modelId: 'qwen2.5-coder:7b', modelName: 'Qwen2.5 Coder 7B (local)', contextWindow: 32000 }
] as const

interface PiModelFile {
  providers: Record<
    string,
    {
      baseUrl: string
      api: string
      models: {
        id: string
        name: string
        reasoning?: boolean
        input?: string[]
        contextWindow?: number
        maxTokens?: number
        thinkingLevelMap?: Record<string, string | null> | null
        compat?: Record<string, unknown> | null
      }[]
    }
  >
}

/**
 * Write pi's two config files from our store, into the app's own directory, and
 * return the paths to hand to ModelRuntime. Nothing outside the app's data
 * directory is touched.
 */
let piWrite: Promise<void> = Promise.resolve()

export async function writePiConfig(): Promise<{ agentDir: string; authPath: string; modelsPath: string }> {
  // Queue behind any write already running: interleaved writes truncated the
  // generated files.
  await piWrite.catch(() => undefined)
  let release: () => void = () => undefined
  piWrite = new Promise<void>((r) => {
    release = r
  })
  try {
    return await writePiConfigNow()
  } finally {
    release()
  }
}

async function writePiConfigNow(): Promise<{ agentDir: string; authPath: string; modelsPath: string }> {
  const providers = await loadProviders()
  const models: PiModelFile = { providers: {} }
  const auth: Record<string, { type: string; key: string }> = {}
  for (const p of providers) {
    models.providers[p.id] = {
      baseUrl: normalizeBaseUrl(p.baseUrl),
      api: p.api,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: m.reasoning,
        input: (Object.keys(m.input) as (keyof ModelInputs)[]).filter((k) => m.input[k]),
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        ...(m.compat ? { compat: m.compat } : {})
      }))
    }
    const key = await getProviderKey(p.id)
    if (key) auth[p.id] = { type: 'api_key', key }
  }
  const dir = agentDir()
  const modelsPath = join(dir, 'models.json')
  const authPath = join(dir, 'auth.json')
  await writeJson(modelsPath, models)
  await writeJson(authPath, auth, true)
  return { agentDir: dir, authPath, modelsPath }
}

/** Import providers, models and keys from the user's own pi setup (once). */
export async function seedFromPi(): Promise<ProviderConfig[]> {
  const piDir = process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const seededKeys: [string, string][] = []
  const file = await readJson<PiModelFile>(join(piDir, 'models.json'), { providers: {} })
  const ids = Object.keys(file.providers ?? {})
  if (ids.length === 0) return []
  const auth = await readJson<Record<string, { key?: string }>>(join(piDir, 'auth.json'), {})
  const out: ProviderConfig[] = []
  for (const id of ids) {
    const p = file.providers[id]
    out.push({
      id,
      name: prettyProviderName(id),
      baseUrl: p.baseUrl ?? '',
      api: p.api ?? 'openai-completions',
      models: (p.models ?? []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 8192,
        reasoning: Boolean(m.reasoning),
        thinkingLevelMap: m.thinkingLevelMap ?? undefined,
        compat: m.compat ?? undefined,
        input: {
          text: !m.input || m.input.includes('text'),
          image: Boolean(m.input?.includes('image')),
          audio: Boolean(m.input?.includes('audio')),
          video: Boolean(m.input?.includes('video'))
        }
      }))
    })
    const key = auth[id]?.key
    if (key) seededKeys.push([id, key])
  }
  // Write the keys in one pass (writing per provider raced with the store save).
  if (seededKeys.length > 0) {
    const keys = await readJson<Record<string, string>>(keysPath(), {})
    for (const [id, key] of seededKeys) {
      keys[id] = safeStorage.isEncryptionAvailable()
        ? 'enc:' + safeStorage.encryptString(key).toString('base64')
        : 'raw:' + Buffer.from(key, 'utf-8').toString('base64')
    }
    await writeJson(keysPath(), keys, true)
  }
  return out
}

function prettyProviderName(id: string): string {
  const known: Record<string, string> = {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    xai: 'xAI',
    mistral: 'Mistral',
    aliyun: 'Aliyun (DashScope)',
    'moonshotai-cn': 'Moonshot (CN)',
    'minimax-cn': 'MiniMax (CN)',
    local: 'Local (Ollama / llama.cpp)'
  }
  return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

/** Connectivity probe for arbitrary settings (used by onboarding's Test). */
export async function probeDraft(draft: {
  baseUrl: string
  api: string
  key: string
  modelId: string
}): Promise<{ ok: boolean; message: string }> {
  const provider = {
    id: 'draft',
    name: 'this provider',
    baseUrl: draft.baseUrl,
    api: draft.api,
    models: []
  }
  const original = providers
  providers = [{ ...provider, models: [{ id: draft.modelId, name: draft.modelId, contextWindow: 0, maxTokens: 0, reasoning: false, input: { text: true, image: false, audio: false, video: false } }] }]
  draftKey = draft.key || null
  try {
    return await testProvider('draft')
  } finally {
    providers = original
    draftKey = null
  }
}

/**
 * Ask a local Ollama daemon which models it has.
 * `/api/tags` lives at the server root (the OpenAI-compatible base ends in
 * `/v1`), so strip that first.
 */
export async function listOllamaModels(
  baseUrl: string
): Promise<{ ok: boolean; models: string[]; message: string }> {
  // Use the origin: the OpenAI-compatible base ends in `/v1`, but the tag list
  // lives at the server root — and a base URL may carry a path or a stray space.
  let root = 'http://localhost:11434'
  try {
    root = new URL(normalizeBaseUrl(baseUrl) || 'http://localhost:11434').origin
  } catch {
    /* keep the default */
  }
  try {
    const res = await fetch(`${root}/api/tags`)
    if (!res.ok) return { ok: false, models: [], message: `Ollama replied ${res.status} ${res.statusText}` }
    const data = (await res.json()) as { models?: { name?: string; model?: string; details?: { parameter_size?: string } }[] }
    const models = (data.models ?? [])
      .map((m) => m.name ?? m.model ?? '')
      .filter((n) => n.length > 0)
    return {
      ok: true,
      models,
      message: models.length ? `${models.length} local model${models.length === 1 ? '' : 's'} found` : 'No local models installed yet'
    }
  } catch (err) {
    return {
      ok: false,
      models: [],
      message: `Could not reach Ollama at ${root} — is it running? (${(err as Error).message})`
    }
  }
}

/** Quick connectivity probe for the Test button. */
export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return { ok: false, message: 'Unknown provider' }
  const key = await getProviderKey(providerId)
  // A local server (Ollama, llama.cpp, LM Studio) needs no key.
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(provider.baseUrl)
  if (!key && !isLocal) return { ok: false, message: 'No API key set' }
  const model = provider.models[0]?.id
  if (!model) return { ok: false, message: 'No models configured — use “Import from Ollama” or add one' }
  try {
    if (provider.api.startsWith('anthropic')) {
      if (!key) return { ok: false, message: 'This provider needs an API key' }
      const res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      })
      return res.ok
        ? { ok: true, message: `Reached ${provider.name} (${model})` }
        : { ok: false, message: `${res.status} ${res.statusText}` }
    }
    if (provider.api.startsWith('google')) {
      if (!key) return { ok: false, message: 'This provider needs an API key' }
      const res = await fetch(
        `${normalizeBaseUrl(provider.baseUrl)}/v1beta/models?key=${encodeURIComponent(key)}`
      )
      return res.ok
        ? { ok: true, message: `Reached ${provider.name}` }
        : { ok: false, message: `${res.status} ${res.statusText}` }
    }
    const res = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
    })
    if (res.ok) return { ok: true, message: `Reached ${provider.name} (${model})` }
    const text = await res.text().catch(() => '')
    return { ok: false, message: `${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 160)}` : ''}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Conversations.
//
// Stored per workspace inside the app's own data directory, mirroring pi's
// `--path--` folder convention so the two layouts line up and existing pi
// sessions can simply be copied across (see migratePiSessions).
// ---------------------------------------------------------------------------

function workspaceSlug(workspaceRoot: string): string {
  // pi's convention: drop the leading slash, turn path separators into dashes,
  // keep everything else (dots, underscores, dashes) and wrap in `--…--`.
  // Getting this wrong put our sessions in a `---Users…--` folder that pi's own
  // migration source could never match.
  const normalized = workspaceRoot.replace(/^\/+/, '').replace(/\//g, '-')
  return `--${normalized}--`
}

/** Where this workspace's conversations are stored. */
export function sessionsDir(workspaceRoot: string): string {
  return join(agentDir(), 'sessions', workspaceSlug(workspaceRoot))
}

/**
 * Copy conversations from a `~/.pi/agent` setup into the app's own directory,
 * once, for the workspace in question. Nothing is moved or deleted, and an
 * existing file with the same name is never overwritten.
 */
export async function migratePiSessions(workspaceRoot: string): Promise<number> {
  const target = sessionsDir(workspaceRoot)
  const legacy = join(process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions', workspaceSlug(workspaceRoot))
  let entries: string[]
  try {
    entries = await fs.readdir(legacy)
  } catch {
    // No legacy ~/.pi setup is the normal case, not a failure.
    return 0
  }
  await fs.mkdir(target, { recursive: true })
  let copied = 0
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const dest = join(target, name)
    try {
      await fs.access(dest)
      continue // already have it
    } catch {
      /* not there yet */
    }
    try {
      await fs.copyFile(join(legacy, name), dest)
      copied++
    } catch {
      /* skip unreadable */
    }
  }
  return copied
}
