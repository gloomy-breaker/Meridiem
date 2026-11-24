import { contextBridge, ipcRenderer, webUtils } from 'electron'

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

/**
 * One page, flattened so the hidden print host can render it without a
 * workspace of its own. Everything the print stylesheet reads travels with the
 * page: the paper has to look the same whatever the exporting window was doing.
 */
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

const api = {
  wsList: (): Promise<
    { path: string; name: string; kind: 'plain' | 'private'; missing: boolean; unlocked: boolean }[]
  > => ipcRenderer.invoke('ws:list'),
  wsAddToList: (payload: { path: string; name?: string }) => ipcRenderer.invoke('ws:addToList', payload),
  wsForget: (path: string) => ipcRenderer.invoke('ws:forget', path),
  wsSwitch: (path: string): Promise<{ ok: boolean; private?: boolean; message?: string }> => ipcRenderer.invoke('ws:switch', path),
  wsUnlock: (payload: { path: string; password: string }): Promise<{ ok: boolean; name?: string; code?: string; message?: string; warning?: string }> =>
    ipcRenderer.invoke('ws:unlock', payload),
  wsLock: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('ws:lock'),
  wsChangePassword: (payload: { current: string; next: string }): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('ws:changePassword', payload),
  wsGet: (): Promise<{ workspace: string | null; theme?: string; previewFont?: string }> => ipcRenderer.invoke('ws:get'),
  wsChoose: (): Promise<string | null> => ipcRenderer.invoke('ws:choose'),
  dirChoose: (): Promise<string | null> => ipcRenderer.invoke('dir:choose'),
  filePick: (title?: string): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke('file:pick', title),
  readTextFile: (relPath: string): Promise<{ content: string; absolutePath: string } | null> => ipcRenderer.invoke('file:readText', relPath),
  fileKind: (relPath: string): Promise<'pdf' | 'image' | 'text' | 'binary' | null> => ipcRenderer.invoke('file:kind', relPath),
  writeTextFile: (relPath: string, content: string): Promise<boolean> => ipcRenderer.invoke('file:writeText', relPath, content),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('file:openPath', p),
  pickImage: (): Promise<{ data: string; mimeType: string; name: string } | null> => ipcRenderer.invoke('file:pickImage'),
  readImage: (p: string): Promise<{ data: string; mimeType: string; name: string } | null> => ipcRenderer.invoke('file:readImage', p),
  readBytes: (p: string): Promise<Uint8Array | null> => ipcRenderer.invoke('file:readBytes', p),
  revealPath: (p: string): Promise<boolean> => ipcRenderer.invoke('file:reveal', p),
  importImage: (payload: { dir: string; name: string; mimeType?: string; data: string }): Promise<{ name: string; path: string } | null> =>
    ipcRenderer.invoke('file:importImage', payload),
  // Absolute path of a dragged/pasted file (empty string for clipboard images).
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  copyPath: (p: string): Promise<string | null> => ipcRenderer.invoke('file:copyPath', p),
  showItemMenu: (payload: { relPath: string; kind: string; name?: string; isTab?: boolean }): Promise<void> =>
    ipcRenderer.invoke('ui:itemMenu', payload),
  onItemAction: (cb: (payload: { action: string; relPath: string; kind: string; name?: string }) => void): void => {
    ipcRenderer.removeAllListeners('item:action')
    ipcRenderer.on('item:action', (_e, payload) => cb(payload))
  },
  agentSessions: (): Promise<
    { path: string; id: string; name?: string; firstMessage: string; created: string; modified: string; messageCount: number }[]
  > => ipcRenderer.invoke('agent:sessions'),
  agentSessionMessages: (sessionPath: string): Promise<unknown[]> => ipcRenderer.invoke('agent:sessionMessages', sessionPath),
  agentSessionCurrent: (): Promise<string | null> => ipcRenderer.invoke('agent:sessionCurrent'),
  log: (entry: { level?: string; message: string }): Promise<boolean> => ipcRenderer.invoke('app:log', entry),
  providersList: (): Promise<unknown[]> => ipcRenderer.invoke('providers:list'),
  providersSave: (providers: unknown[]): Promise<boolean> => ipcRenderer.invoke('providers:save', { providers }),
  providersKey: (id: string, key: string): Promise<boolean> => ipcRenderer.invoke('providers:key', { id, key }),
  providersTest: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('providers:test', id),
  providersSeed: (): Promise<number> => ipcRenderer.invoke('providers:seed'),
  providersOllama: (baseUrl: string): Promise<{ ok: boolean; models: string[]; message: string }> =>
    ipcRenderer.invoke('providers:ollama', baseUrl),
  providersTestDraft: (draft: { baseUrl: string; api: string; key: string; modelId: string }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('providers:testDraft', draft),
  printPagePdf: (payload: PagePrintPayload): Promise<Uint8Array> =>
    ipcRenderer.invoke('page:print-pdf', payload),
  exportPagePdf: (payload: PagePrintPayload & { relPath: string }): Promise<{ path: string; pages: number } | null> =>
    ipcRenderer.invoke('page:export-pdf', payload),
  wsCreateWorkspace: (payload: { name: string; parentDir: string; private?: boolean; password?: string }): Promise<string> => ipcRenderer.invoke('ws:create-workspace', payload),
  wsConvertWorkspace: (payload: { root: string; name?: string }): Promise<string> => ipcRenderer.invoke('ws:convert', payload),
  wsOpenWorkspace: (): Promise<{ ok: boolean; path?: string; name?: string; canceled?: boolean; error?: string }> => ipcRenderer.invoke('ws:open'),
  wsTree: (): Promise<WorkspaceChild> => ipcRenderer.invoke('ws:tree'),
  wsConvertLoose: (relPath: string): Promise<string> => ipcRenderer.invoke('ws:convert-loose', relPath),
  wsRead: (relPath: string): Promise<WorkspacePage | null> => ipcRenderer.invoke('ws:read', relPath),
  /** In-flight quiz answers, saved under `.yestion/attempts/`. */
  quizAttemptLoad: (relPath: string): Promise<string | null> => ipcRenderer.invoke('quiz:attemptLoad', relPath),
  quizAttemptSave: (relPath: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('quiz:attemptSave', relPath, data),
  quizAttemptClear: (relPath: string): Promise<boolean> => ipcRenderer.invoke('quiz:attemptClear', relPath),
  wsSearch: (query: string): Promise<
    { relPath: string; title: string; icon: string; kind: string; line: number; snippet: string }[]
  > => ipcRenderer.invoke('ws:search', query),
  wsSave: (payload: { relPath: string; title: string; icon: string; body: string }): Promise<boolean> => ipcRenderer.invoke('ws:save', payload),
  wsCreate: (payload: { parentRel: string | null; title: string }): Promise<WorkspacePage | null> => ipcRenderer.invoke('ws:create', payload),
  /** Open (or create) `Daily/YYYY-MM-DD.md` and return it. */
  wsDaily: (date: string): Promise<WorkspacePage | null> => ipcRenderer.invoke('ws:daily', date),
  wsDelete: (relPath: string): Promise<boolean> => ipcRenderer.invoke('ws:delete', relPath),
  wsResolveLink: (linkText: string, fromDir?: string): Promise<WorkspacePage | null> => ipcRenderer.invoke('ws:resolve-link', linkText, fromDir),
  wsAllPages: (): Promise<{ relPath: string; title: string; icon: string }[]> => ipcRenderer.invoke('ws:all-pages'),
  wsReveal: (relPath: string): Promise<void> => ipcRenderer.invoke('ws:reveal', relPath),
  wsOpenInFinder: (): Promise<void> => ipcRenderer.invoke('ws:open-folder-in-finder'),

  agentStart: (settings: {
    provider: string
    model: string
    apiKey: string
    sessionFile?: string
    newSession?: boolean
  }): Promise<{ model: string; contextWindow: number | null; sessionFile: string | null }> =>
    ipcRenderer.invoke('agent:start', settings),
  agentResume: (settings: {
    provider: string
    model: string
    apiKey: string
    sessionFile: string
  }): Promise<{ model: string; contextWindow: number | null; sessionFile: string | null }> =>
    ipcRenderer.invoke('agent:resume', settings),
  agentPrompt: (text: string, context?: { title: string; relPath: string } | null, images?: { data: string; mimeType: string }[]): Promise<void> => ipcRenderer.invoke('agent:prompt', text, context, images),
  agentAbort: (): Promise<void> => ipcRenderer.invoke('agent:abort'),
  agentStop: (): Promise<void> => ipcRenderer.invoke('agent:stop'),
  agentOneshot: (req: {
    system: string
    prompt: string
    timeoutMs?: number
    thinkingLevel?: string
  }): Promise<{ ok: boolean; text: string; error?: string; elapsedMs: number }> =>
    ipcRenderer.invoke('agent:oneshot', req),
  /** Marking: goes to the conversation that wrote the quiz when it is attached,
   *  and falls back to the isolated one-shot when it is not. */
  agentGradeQuiz: (req: {
    relPath: string
    system: string
    prompt: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; text: string; error?: string; elapsedMs: number }> =>
    ipcRenderer.invoke('agent:gradeQuiz', req),
  agentModels: (): Promise<
    { provider: string; providerName: string; id: string; name: string; contextWindow: number }[]
  > => ipcRenderer.invoke('agent:models'),
  agentCompact: (instructions?: string): Promise<unknown> => ipcRenderer.invoke('agent:compact', instructions),
  agentThinking: (level: string): Promise<boolean> => ipcRenderer.invoke('agent:thinking', level),
  agentRestart: (): Promise<boolean> => ipcRenderer.invoke('agent:restart'),
  onAgentEvent: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: unknown): void => callback(event)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onAgentStarted: (
    callback: (payload: { model: string; contextWindow?: number | null }) => void
  ): (() => void) => {
    // Main sends { model, contextWindow, sessionFile }; the panel reads the
    // first two, so the listener type must carry them (it used to be model-only,
    // which silently promised less than the wire format).
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { model: string; contextWindow?: number | null }
    ): void => callback(payload)
    ipcRenderer.on('agent:started', listener)
    return () => ipcRenderer.removeListener('agent:started', listener)
  },
  onAgentStopped: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('agent:stopped', listener)
    return () => ipcRenderer.removeListener('agent:stopped', listener)
  },
  /** A prompt the main process sent into this conversation on its own (quiz
   *  marking), so the panel can show the user turn it did not type. */
  onAgentInjectedPrompt: (callback: (text: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, text: string): void => callback(text)
    ipcRenderer.on('agent:injected-prompt', listener)
    return () => ipcRenderer.removeListener('agent:injected-prompt', listener)
  },
  onAgentInjectedDone: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('agent:injected-done', listener)
    return () => ipcRenderer.removeListener('agent:injected-done', listener)
  },

  getSettings: <K extends string>(key: K): Promise<unknown> => ipcRenderer.invoke('settings:get', key),
  /** Whole settings object in one round trip (boot reads ~20 keys). */
  getSettingsAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:getAll'),
  setSettings: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value),
  /** Several keys in one write (e.g. openTabs + activeTab). */
  setSettingsMany: (patch: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('settings:setMany', patch),
  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on('menu-action', listener)
    return () => ipcRenderer.removeListener('menu-action', listener)
  },
  onPageMoved: (
    fn: (moves: { from: string; to: string; fromDir?: string; toDir?: string }[]) => void
  ): (() => void) => {
    const listener = (_e: unknown, moves: { from: string; to: string; fromDir?: string; toDir?: string }[]): void =>
      fn(moves)
    ipcRenderer.on('ws:page-moved', listener)
    return () => ipcRenderer.removeListener('ws:page-moved', listener)
  },
  onWsExternalChange: (fn: (relPath: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, relPath: string): void => fn(relPath)
    ipcRenderer.on('ws:external-change', listener)
    return () => ipcRenderer.removeListener('ws:external-change', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
