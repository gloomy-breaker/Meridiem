export interface WorkspaceChild {
  name: string
  path: string
  relPath: string
  kind: 'page' | 'folder' | 'pdf' | 'image' | 'file' | 'binary' | 'quiz'
  title?: string
  icon?: string
  children?: WorkspaceChild[]
}

export interface WorkspacePage {
  relPath: string
  absolutePath: string
  title: string
  icon: string
  body: string
}

export interface PagePrintPayload {
  markdown: string
  baseDir: string | null
  title: string
  icon: string
  showTitle: boolean
  showIcon: boolean
  font: string
  scale: number
  margins?: 'thin' | 'medium' | 'wide'
  /** What the PDF should be titled; the page title when it is not set. */
  docTitle?: string
}

export interface AgentSettings {
  provider: string
  model: string
  apiKey: string
  sessionFile?: string
  newSession?: boolean
}

export interface Api {
  wsList: () => Promise<
    { path: string; name: string; kind: 'plain' | 'private'; missing: boolean; unlocked: boolean }[]
  >
  wsAddToList: (payload: { path: string; name?: string }) => Promise<unknown>
  wsForget: (path: string) => Promise<unknown>
  wsSwitch: (path: string) => Promise<{ ok: boolean; private?: boolean; message?: string }>
  wsUnlock: (payload: { path: string; password: string }) => Promise<{ ok: boolean; name?: string; code?: string; message?: string; warning?: string }>
  wsLock: () => Promise<{ ok: boolean }>
  wsChangePassword: (payload: { current: string; next: string }) => Promise<{ ok: boolean; message?: string }>
  wsGet: () => Promise<{
    workspace: string | null
    displayPath?: string | null
    name?: string | null
    private?: boolean
    locked?: boolean
    theme?: string
    previewFont?: string
  }>
  wsChoose: () => Promise<string | null>
  dirChoose: () => Promise<string | null>
  filePick: (title?: string) => Promise<{ path: string; name: string } | null>
  readTextFile: (relPath: string) => Promise<{ content: string; absolutePath: string } | null>
  fileKind: (relPath: string) => Promise<'pdf' | 'image' | 'text' | 'binary' | null>
  writeTextFile: (relPath: string, content: string) => Promise<boolean>
  openPath: (p: string) => Promise<string>
  pickImage: () => Promise<{ data: string; mimeType: string; name: string } | null>
  readImage: (p: string) => Promise<{ data: string; mimeType: string; name: string } | null>
  readBytes: (p: string) => Promise<Uint8Array | null>
  revealPath: (p: string) => Promise<boolean>
  importImage: (payload: { dir: string; name: string; mimeType?: string; data: string }) => Promise<{ name: string; path: string } | null>
  getPathForFile: (file: File) => string
  copyPath: (p: string) => Promise<string | null>
  showItemMenu: (payload: { relPath: string; kind: string; name?: string; isTab?: boolean }) => Promise<void>
  onItemAction: (cb: (payload: { action: string; relPath: string; kind: string; name?: string }) => void) => void
  agentSessions: () => Promise<
    { path: string; id: string; name?: string; firstMessage: string; created: string; modified: string; messageCount: number }[]
  >
  agentSessionMessages: (sessionPath: string) => Promise<unknown[]>
  agentSessionCurrent: () => Promise<string | null>
  log: (entry: { level?: string; message: string }) => Promise<boolean>
  providersList: () => Promise<
    {
      id: string
      name: string
      baseUrl: string
      api: string
      hasKey: boolean
      models: {
        id: string
        name: string
        contextWindow: number
        maxTokens: number
        reasoning: boolean
        input: { text: boolean; image: boolean; audio: boolean; video: boolean }
      }[]
    }[]
  >
  providersSave: (providers: unknown[]) => Promise<boolean>
  providersKey: (id: string, key: string) => Promise<boolean>
  providersTest: (id: string) => Promise<{ ok: boolean; message: string }>
  providersSeed: () => Promise<number>
  providersOllama: (baseUrl: string) => Promise<{ ok: boolean; models: string[]; message: string }>
  providersTestDraft: (draft: { baseUrl: string; api: string; key: string; modelId: string }) =>
    Promise<{ ok: boolean; message: string }>
  printPagePdf: (payload: PagePrintPayload) => Promise<Uint8Array>
  exportPagePdf: (payload: PagePrintPayload & { relPath: string }) => Promise<{ path: string; pages: number } | null>
  wsCreateWorkspace: (payload: { name: string; parentDir: string; private?: boolean; password?: string }) => Promise<string>
  wsConvertWorkspace: (payload: { root: string; name?: string }) => Promise<string>
  wsOpenWorkspace: () => Promise<{ ok: boolean; path?: string; name?: string; canceled?: boolean; error?: string }>
  wsTree: () => Promise<WorkspaceChild>
  wsConvertLoose: (relPath: string) => Promise<string>
  wsRead: (relPath: string) => Promise<WorkspacePage | null>
  quizAttemptLoad: (relPath: string) => Promise<string | null>
  quizAttemptSave: (relPath: string, data: string) => Promise<boolean>
  quizAttemptClear: (relPath: string) => Promise<boolean>
  wsSearch: (query: string) => Promise<
    { relPath: string; title: string; icon: string; kind: string; line: number; snippet: string }[]
  >
  wsSave: (payload: { relPath: string; title: string; icon: string; body: string }) => Promise<boolean>
  wsCreate: (payload: { parentRel: string | null; title: string }) => Promise<WorkspacePage | null>
  /** Open (or create) `Daily/YYYY-MM-DD.md` and return it. */
  wsDaily: (date: string) => Promise<WorkspacePage | null>
  wsDelete: (relPath: string) => Promise<boolean>
  wsResolveLink: (linkText: string, fromDir?: string) => Promise<WorkspacePage | null>
  wsAllPages: () => Promise<{ relPath: string; title: string; icon: string }[]>
  wsReveal: (relPath: string) => Promise<void>
  wsOpenInFinder: () => Promise<void>

  agentStart: (settings: {
    provider: string
    model: string
    apiKey: string
    sessionFile?: string
    newSession?: boolean
  }) => Promise<{ model: string; contextWindow: number | null; sessionFile: string | null }>
  agentResume: (settings: {
    provider: string
    model: string
    apiKey: string
    sessionFile: string
  }) => Promise<{ model: string; contextWindow: number | null; sessionFile: string | null }>
  agentPrompt: (text: string, context?: { title: string; relPath: string } | null, images?: { data: string; mimeType: string }[]) => Promise<void>
  agentAbort: () => Promise<void>
  agentStop: () => Promise<void>
  /** One-shot model call: no tools, no session file, no trace in the panel. */
  agentOneshot: (req: {
    system: string
    prompt: string
    timeoutMs?: number
    thinkingLevel?: string
  }) => Promise<{ ok: boolean; text: string; error?: string; elapsedMs: number }>
  agentModels: () => Promise<
    { provider: string; providerName: string; id: string; name: string; contextWindow: number }[]
  >
  agentCompact: (instructions?: string) => Promise<unknown>
  agentThinking: (level: string) => Promise<boolean>
  agentRestart: () => Promise<boolean>
  onAgentEvent: (callback: (event: unknown) => void) => () => void
  onAgentStarted: (callback: (payload: { model: string; contextWindow?: number | null }) => void) => () => void
  onAgentStopped: (callback: () => void) => () => void
  onAgentInjectedPrompt: (callback: (text: string) => void) => () => void
  onAgentInjectedDone: (callback: () => void) => () => void
  agentGradeQuiz: (req: {
    relPath: string
    system: string
    prompt: string
    timeoutMs?: number
  }) => Promise<{ ok: boolean; text: string; error?: string; elapsedMs: number }>

  getSettings: <K extends string>(key: K) => Promise<unknown>
  getSettingsAll: () => Promise<Record<string, unknown>>
  setSettings: (key: string, value: unknown) => Promise<void>
  setSettingsMany: (patch: Record<string, unknown>) => Promise<void>
  onMenuAction: (callback: (action: string) => void) => () => void
  onPageMoved: (
    fn: (moves: { from: string; to: string; fromDir?: string; toDir?: string }[]) => void
  ) => () => void
  onWsExternalChange: (fn: (relPath: string) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
