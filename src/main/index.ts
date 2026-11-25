import { app, shell, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeTheme } from 'electron'
import { basename, join, dirname } from 'node:path'
import {
  writeFile as fsp,
  readFile as fsReadFile,
  access as fsAccess,
  appendFile,
  mkdir as fsMkdir,
  unlink as fsUnlink
} from 'node:fs/promises'
import { watch as fsWatch, readFileSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { buildAppMenu } from './menu'
import { buildLinkTree, organizeAfterSave } from './linktree'
import {
  writePiConfig,
  importFromPi,
  listProviderStatus,
  listOllamaModels,
  probeDraft,
  saveProviders,
  setProviderKey,
  testProvider,
  type ProviderConfig
} from './providers'
import { settingsStore, type WorkspaceEntry } from './store'
import { themeBackground, themeKind } from './theme-meta'
import {
  closeVaultSession,
  createVault,
  currentVault,
  flushVault,
  isVault,
  openVaultSession,
  readVaultConfig,
  scheduleVaultFlush,
  VaultError
} from './vault'
import {
  listWorkspace,
  parsePageFile,
  readPage,
  searchWorkspace,
  savePage,
  createPage,
  deletePageOrFolder,
  resolvePageLink,
  readTextFile,
  writeTextFile,
  fileKind,
  listAllPages,
  createWorkspace,
  validateWorkspace,
  convertToWorkspace,
  convertLoosePage,
  workspaceIndex,
  workspaceTasks,
  toggleTask,
  workspaceGraph,
  workspaceMedia,
  readInbox,
  addInboxItem,
  toggleInboxItem,
  serializePageFile
} from './workspace'
import { logLine } from './log'
// Type-only: the shape the renderer sends for a print job. Erased at compile
// time, so the preload's contextBridge code never reaches the main bundle.
import type { PagePrintPayload } from '../preload/index'
import {
  listAvailableModels,
  listAgentSessions,
  readAgentSessionMessages,
  lastAssistantText,
  ONE_SHOT_TIMEOUT_MS,
  type AgentHandle,
  type AgentSettings,
  type OneShotRequest
} from './agent'
import {
  HARNESS_NONE,
  harnessKind,
  listHarnesses,
  runOneShotForHarness,
  startAgentForHarness,
  validateHarness
} from './agent-driver'
import { terminateAllAcpChildren } from './agent-acp'

// Nothing pi does should reach the network for catalogs or packages.
process.env.PI_OFFLINE = '1'

let mainWindow: BrowserWindow | null = null
let agent: AgentHandle | null = null

/** The selected backend. No AI is the shipped default. */
function activeHarness(): string {
  const id = ((settingsStore.get('agentHarness') as string | undefined) || HARNESS_NONE)
  return harnessKind(id) === 'unknown' ? HARNESS_NONE : id
}

/** Dismantle the live driver and let a child process go with it. */
async function stopAgent(): Promise<void> {
  const current = agent
  agent = null
  if (!current) return
  try {
    await current.dispose()
  } catch {
    /* already gone */
  }
}
/**
 * Which conversation created (or last edited) each `.qz`, keyed by
 * workspace-relative path. Filled by the workspace watcher whenever a quiz
 * changes while a session is attached, so marking can go back to the
 * conversation that knows the paper instead of a context-free grader.
 *
 * In memory only: it is a live-routing hint, not a property of the file. When
 * the app restarts, no session is attached, and grading falls back to the
 * isolated one-shot exactly as before.
 */
const quizSessions = new Map<string, string>()
/** True while a chat turn is in flight, so a marking call never interleaves. */
let agentBusy = false
/** Set when the user presses Stop, so a transport-error retry cannot resurrect
 *  a run they deliberately ended. */
let agentAbortRequested = false

function getWorkspace(): string | null {
  // YESTION_WORKSPACE pins a dev/test instance to a throwaway workspace.
  if (process.env.YESTION_WORKSPACE) return process.env.YESTION_WORKSPACE
  // An unlocked private workspace is read/written through its decrypted copy;
  // everything else (tree, editors, viewers, watcher) stays path-based.
  const vault = currentVault()
  if (vault) return vault.workDir
  const w = settingsStore.get('workspace') as string | undefined
  return w && w.length > 0 ? w : null
}

/** The workspace path as the user knows it (the hidden vault folder for private ones). */
function getWorkspaceDisplay(): string | null {
  const vault = currentVault()
  if (vault) return vault.root
  return getWorkspace()
}

async function workspaceEntries(): Promise<(WorkspaceEntry & { missing: boolean; unlocked: boolean })[]> {
  const vault = currentVault()
  const list = (settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []
  const out: (WorkspaceEntry & { missing: boolean; unlocked: boolean })[] = []
  for (const w of list) {
    let missing = false
    try {
      await fsAccess(w.path)
    } catch {
      missing = true
    }
    out.push({ ...w, missing, unlocked: !!vault && vault.root === w.path })
  }
  return out
}

/** One-time migration: an existing single-workspace setting becomes the list. */
async function migrateWorkspaceList(): Promise<void> {
  const list = (settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []
  if (list.length > 0) return
  const w = settingsStore.get('workspace') as string | null
  if (!w) return
  const isPrivate = await isVault(w)
  let name = w.split('/').pop() ?? 'Workspace'
  if (isPrivate) {
    const cfg = await readVaultConfig(w)
    name = cfg?.name ?? name.replace(/^\./, '').replace(/\.yestion$/, '')
  }
  settingsStore.set('workspaces', [{ path: w, name, kind: isPrivate ? 'private' : 'plain' }])
}

async function createWindow(): Promise<BrowserWindow> {
  // The theme below (and every setting the renderer reads at boot) must come
  // from the file, not the defaults.
  await settingsStore.ready()
  // Paint the window in the user's own theme background from the very first
  // frame — a dark-theme user used to get a white flash on every launch.
  const theme = settingsStore.get('theme') as string | undefined
  nativeTheme.themeSource = themeKind(theme)
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    // Low enough to share a half-screen tile on a laptop. At 900 the window
    // could not sit beside another app whose own minimum is 900 (Kimi Code),
    // and macOS refused the split — while Chrome, with a small minimum, worked.
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: 'Meridiem',
    // The app's own chrome is the top of the window: the traffic lights float
    // over the sidebar (which leaves room for them) instead of a system title
    // bar stacking a second bar above the app's own. The top strip of both
    // columns is the drag handle — see the app-region rules in styles.css.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: themeBackground(theme),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The print host is a second window; leaving it up would keep the app
    // "running with windows" after the one you can see is gone.
    destroyPrintHost()
    terminateAllAcpChildren()
    void stopAgent()
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isCmd = process.platform === 'darwin' ? input.meta : input.control
    if (!isCmd) return
    const key = input.key
    // macOS reports the zoom-in gesture as ⌘⇧= on most keyboard layouts, which
    // the '+' menu accelerator never matches — handle it here (as zoom-out
    // already was), plus ⌘0 to reset.
    const isPlus = key === '=' || key === '+' || key === 'numadd'
    const isMinus = key === '-' || key === '_' || key === '\u2212' || key === 'numsub'
    const isZero = key === '0' || key === 'num0'
    if (isPlus) {
      if (Date.now() - zoomMenuState.inAt < 300) return
      event.preventDefault()
      win.webContents.setZoomLevel(Math.min(5, win.webContents.getZoomLevel() + 0.5))
      return
    }
    if (isMinus) {
      if (Date.now() - zoomMenuState.outAt < 300) return
      event.preventDefault()
      win.webContents.setZoomLevel(Math.max(-3, win.webContents.getZoomLevel() - 0.5))
      return
    }
    if (isZero) {
      event.preventDefault()
      win.webContents.setZoomLevel(0)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// ---------------- IPC: workspace ----------------

// ---------------------------------------------------------------------------
// Workspace file watcher.
//
// Our own saves echo back through it, so they are tagged (selfWrites) and
// skipped; everything else — the built-in agent, an external pi/CLI agent, a
// Finder edit — refreshes the tree and reloads the open page.
// ---------------------------------------------------------------------------
const stopWatching = (): void => {
  watchedRoot = null
  try { wsWatcher?.close() } catch { /* ignore */ }
  wsWatcher = null
  if (wsWatcherTimer) { clearTimeout(wsWatcherTimer); wsWatcherTimer = null }
  pendingChanges.clear()
}
let wsWatcher: import('node:fs').FSWatcher | null = null
let wsWatcherTimer: ReturnType<typeof setTimeout> | null = null
/** Every path seen since the debounce window opened. */
const pendingChanges = new Set<string>()
// Files this app wrote itself (page saves). The watcher sees them moments
// later; treating them as "external" made the renderer reload the page and
// dump the caret at the end of the document. Anything NOT in here is an
// agent / external editor change and must refresh the UI.
const selfWrites = new Map<string, { body: string; at: number }>()

/** Record bytes this app just wrote, so the watcher treats their echo as ours. */
function rememberSelfWrite(root: string, rel: string): void {
  try {
    selfWrites.set(rel.replace(/\\/g, '/'), {
      body: readFileSync(join(root, rel), 'utf-8'),
      at: Date.now()
    })
  } catch {
    /* binary or missing: the watcher will simply treat it as external */
  }
}

let watchedRoot: string | null = null

/** Start (or move) the watcher for `root` if it isn't already watching it. */
const ensureWatching = (root: string | null): void => {
  if (!root || root === watchedRoot) return
  watchWorkspace(root)
}

const watchWorkspace = (root: string): void => {
  // Paths are workspace-relative, so a mapping from another workspace could
  // point at the wrong file's conversation.
  if (watchedRoot !== root) quizSessions.clear()
  watchedRoot = root
  try { wsWatcher?.close() } catch { /* ignore */ }
  wsWatcher = null
  pendingChanges.clear()
  try {
    wsWatcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = String(filename).replace(/\\/g, '/')
      if (rel.startsWith('.yestion') || rel.startsWith('.pi')) return
      // Collect, do not overwrite: a burst of writes used to reset the debounce
      // timer and remember only the last filename, so every other changed file
      // — including the page on screen — was never reported.
      pendingChanges.add(rel)
      if (wsWatcherTimer) clearTimeout(wsWatcherTimer)
      wsWatcherTimer = setTimeout(() => {
        wsWatcherTimer = null
        const changed = [...pendingChanges]
        pendingChanges.clear()
        // Private workspaces: mirror edits (including the agent's) back into
        // the encrypted container instead of telling the UI to re-read files.
        if (currentVault()) {
          if (changed.length > 0) scheduleVaultFlush()
          return
        }
        for (const rel of changed) {
          // Our own save echoing back? Then there is nothing to refresh.
          const mine = selfWrites.get(rel)
          if (mine) {
            if (Date.now() - mine.at > 8000) {
              selfWrites.delete(rel)
            } else {
              try {
                if (readFileSync(join(root, rel), 'utf-8') === mine.body) {
                  selfWrites.delete(rel)
                  continue
                }
              } catch {
                /* unreadable → treat as external */
              }
            }
          }
          // Remember which conversation is behind a quiz as it is written. The
          // agent's own file writes arrive here as external changes, so the
          // session attached at that moment is the one that authored the paper.
          if (rel.toLowerCase().endsWith('.qz')) {
            const session = agent?.sessionFile()
            if (session) quizSessions.set(rel, session)
          }
          mainWindow?.webContents.send('ws:external-change', rel)
        }
      }, 350)
    })
  } catch (err) {
    // Was a hardcoded /tmp file nothing ever read; the app log is where the
    // user (and support) actually look.
    void logLine(`workspace watcher failed to start: ${String(err)}`, 'warn')
  }
}

// -------------------------------------------------------------------------
// Print host: a hidden window that does the printing.
//
// Print jobs used to run against the window on screen, which had two
// consequences the user could see. printToPDF lays its window out in print
// media, so every preview refresh blanked the app down to the page content
// and back — a few times a second while typing — and Chromium paints the
// printed page's canvas in the window's own background colour, which the main
// window takes from the theme. Exports came out with a band of --bg in the
// paper margins, and a dark theme printed a black page underneath the text.
//
// This window loads the same renderer with ?print=1 (see initPrintHost) and
// is created white, so the paper is white — and the visible window is left
// entirely alone.
// -------------------------------------------------------------------------
let printHost: BrowserWindow | null = null
let printHostLoading: Promise<BrowserWindow> | null = null

async function getPrintHost(): Promise<BrowserWindow> {
  if (printHost && !printHost.isDestroyed()) return printHost
  if (!printHostLoading) {
    printHostLoading = (async (): Promise<BrowserWindow> => {
      const win = new BrowserWindow({
        width: 1240,
        height: 1754,
        show: false,
        backgroundColor: '#ffffff',
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false,
          contextIsolation: true
        }
      })
      win.on('closed', () => {
        if (printHost === win) printHost = null
        if (printHostLoading) printHostLoading = null
      })
      const loaded = new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve())
      })
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?print=1`)
      } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { print: '1' } })
      }
      await loaded
      printHost = win
      return win
    })()
  }
  return printHostLoading
}

/** Hand one page to the host, wait for it to settle, and print it. */
async function renderPagePdf(payload: PagePrintPayload): Promise<{ data: Buffer; marginIn: number }> {
  const host = await getPrintHost()
  const marginIn = payload.margins === 'thin' ? 0.28 : payload.margins === 'wide' ? 0.95 : 0.55
  // executeJavaScript resolves with the promise the host returns, so this
  // waits for the fonts, the layout and the images before printing.
  await host.webContents.executeJavaScript(`window.__yestionPrint(${JSON.stringify(JSON.stringify(payload))})`)
  const data = await host.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    scale: 1,
    margins: { top: marginIn, bottom: marginIn, left: marginIn, right: marginIn }
  })
  return { data, marginIn }
}

/** Drop the hidden window (and its renderer) when the app no longer needs it. */
function destroyPrintHost(): void {
  const win = printHost
  printHost = null
  printHostLoading = null
  if (win && !win.isDestroyed()) win.destroy()
}

function registerWorkspaceHandlers(): void {
  ipcMain.handle('ws:get', async () => {
    const vault = currentVault()
    return {
      workspace: getWorkspace() ?? null,
      displayPath: getWorkspaceDisplay() ?? null,
      name: vault ? vault.name : null,
      private: !!vault,
      locked: !vault && (await isVault(settingsStore.get('workspace') as string ?? '')),
      theme: settingsStore.get('theme') as string | undefined,
      previewFont: settingsStore.get('previewFont') as string | undefined
    }
  })
  ipcMain.handle('file:pick', async (_e, title?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: title || 'Link a file (PDF, image, …)',
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const abs = result.filePaths[0]
    const root = getWorkspace()
    // Store a workspace-relative path when possible so the workspace stays portable.
    const path = root && abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs
    return { path, name: abs.split('/').pop() ?? abs }
  })
  /** Crude page count for diagnostics: Chromium writes a /Type /Page per page. */
  const countPdfPages = (data: Buffer | Uint8Array): number => {
    try {
      const text = Buffer.from(data).toString('latin1')
      const m = text.match(/\/Type\s*\/Page[^s]/g)
      return m ? m.length : 0
    } catch {
      return 0
    }
  }

  const logPrint = async (kind: string, marginIn: number, data: Buffer | Uint8Array): Promise<void> => {
    try {
      await appendFile(
        join(app.getPath('userData'), 'meridiem.log'),
        `${new Date().toISOString()} [print] ${kind} margin=${marginIn}in bytes=${data.length} pages=${countPdfPages(data)}\n`,
        'utf-8'
      )
    } catch {
      /* ignore */
    }
  }

  // Same print path as the export, but returns the bytes — used by the live PDF
  // preview so what you see is the real pagination, not an approximation.
  ipcMain.handle('page:print-pdf', async (_event, payload: PagePrintPayload) => {
    const { data, marginIn } = await renderPagePdf(payload)
    await logPrint('preview', marginIn, data)
    return new Uint8Array(data)
  })

  ipcMain.handle(
    'page:export-pdf',
    async (
      _event,
      payload: PagePrintPayload & { relPath: string }
    ): Promise<{ path: string; pages: number } | null> => {
    const root = getWorkspace()
    if (!root) return null
    const abs = join(root, payload.relPath)
    const clean = payload.title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'page'
    const defaultPath = join(dirname(abs), `${clean}.pdf`)
    let filePath = defaultPath
    if (!process.env.YESTION_EXPORT_PATH) {
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export to PDF',
        defaultPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (res.canceled || !res.filePath) return null
      filePath = res.filePath
    } else {
      filePath = process.env.YESTION_EXPORT_PATH
    }
    // Print the hidden host rather than the window the user is looking at: the
    // host is white, so the paper is white whatever theme the app is wearing,
    // and printing it never disturbs the visible window. It runs the same
    // renderer with the same inlined fonts (a throwaway page could not resolve
    // the @font-face URLs inside app.asar, which dropped every CJK glyph).
    // No scale factor: printToPDF ignores the window's zoom level, so the PDF
    // always comes out at the print stylesheet's own sizes (12pt body).
    // Margins in inches, chosen in the export popover.
    // The PDF's /Title is the host window's document.title, so hand it the name
    // the file just got: the viewer then shows what the user called it, which
    // is the page's title unless they typed something else in the save dialog.
    const { data, marginIn } = await renderPagePdf({ ...payload, docTitle: basename(filePath, '.pdf') })
    await logPrint('export', marginIn, data)
    await fsp(filePath, data)
    return { path: filePath, pages: countPdfPages(data) }
    }
  )

  // File IPC accepts both workspace-relative and absolute paths, so files that
  // live outside the workspace (e.g. ~/Downloads) still open in the built-in
  // viewers instead of being handed to the system app.
  const resolveFile = (p: string): string | null => {
    if (p.startsWith('/')) return p
    const root = getWorkspace()
    return root ? join(root, p) : null
  }
  ipcMain.handle('file:kind', async (_e, p: string) => {
    const abs = resolveFile(p)
    if (!abs) return null
    try {
      return await fileKind(abs)
    } catch {
      return null
    }
  })
  ipcMain.handle('file:readText', async (_e, p: string) => {
    const abs = resolveFile(p)
    if (!abs) return null
    try {
      const content = await readTextFile(abs)
      return { content, absolutePath: abs }
    } catch {
      return null
    }
  })
  ipcMain.handle('file:writeText', async (_e, p: string, content: string) => {
    const abs = resolveFile(p)
    if (!abs) return false
    try {
      await writeTextFile(abs, content)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('file:readBytes', async (_e, p: string) => {
    const abs = await resolveFile(p)
    if (!abs) return null
    try {
      const buf = await fsReadFile(abs)
      return new Uint8Array(buf)
    } catch {
      return null
    }
  })

  ipcMain.handle('file:readImage', async (_e, p: string) => {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
    const mimes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml'
    }
    const mimeType = mimes[ext]
    if (!mimeType) return null
    const buf = await fsReadFile(p)
    return { data: buf.toString('base64'), mimeType, name: p.split('/').pop() ?? p }
  })
  ipcMain.handle('file:pickImage', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Attach an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
    const mimes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp'
    }
    const mimeType = mimes[ext]
    if (!mimeType) return null
    const buf = await fsReadFile(p)
    return { data: buf.toString('base64'), mimeType, name: p.split('/').pop() ?? p }
  })
  ipcMain.handle('file:openPath', async (_e, p: string) => {
    return shell.openPath(p)
  })
  // Copy an image dropped/pasted into a page next to the page file, so pages
  // keep their assets in plain files (and inside private workspaces the write
  // goes through the vault's decrypted copy like any other edit).
  ipcMain.handle('file:importImage', async (_e, payload: { dir: string; name: string; mimeType?: string; data: string }) => {
    const root = getWorkspace()
    if (!root) return null
    const dir = payload.dir
    if (!dir.startsWith(root)) return null
    try {
      await fsAccess(dir)
    } catch {
      return null
    }
    const mimes: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg',
      'image/avif': '.avif'
    }
    const rawName = basename(payload.name || 'image')
    let ext = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.')).toLowerCase() : ''
    if (!ext || ext.length > 6) ext = mimes[payload.mimeType ?? ''] ?? '.png'
    const base = rawName
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\- ]+/g, '_')
      // No spaces: they're legal in filenames but need escaping inside markdown
      // links, so keep new assets simple.
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim()
      .slice(0, 60) || 'image'
    let target = join(dir, base + ext)
    let n = 2
    while (true) {
      try {
        await fsAccess(target)
        target = join(dir, `${base}-${n}${ext}`)
        n++
      } catch {
        break
      }
    }
    await fsp(target, Buffer.from(payload.data, 'base64'))
    return { name: target.slice(dir.length + 1), path: target }
  })

  ipcMain.handle('file:reveal', async (_e, p: string) => {
    const abs = await resolveFile(p)
    if (abs) shell.showItemInFolder(abs)
    return true
  })
  ipcMain.handle('file:copyPath', async (_e, p: string) => {
    const abs = await resolveFile(p)
    if (abs) clipboard.writeText(abs)
    return abs
  })
  ipcMain.handle('dir:choose', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a location',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  // ---- workspace switcher -------------------------------------------------
  ipcMain.handle('ws:list', async () => {
    await migrateWorkspaceList()
    return workspaceEntries()
  })

  ipcMain.handle('ws:addToList', async (_e, payload: { path: string; name?: string }) => {
    await migrateWorkspaceList()
    const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
    const isPrivate = await isVault(payload.path)
    let name = payload.name?.trim() || (payload.path.split('/').pop() ?? 'Workspace')
    if (isPrivate) name = (await readVaultConfig(payload.path))?.name || name.replace(/^\./, '').replace(/\.yestion$/, '')
    if (!list.some((w) => w.path === payload.path)) {
      list.push({ path: payload.path, name, kind: isPrivate ? 'private' : 'plain' })
      settingsStore.set('workspaces', list)
    }
    return workspaceEntries()
  })

  ipcMain.handle('ws:forget', async (_e, path: string) => {
    await migrateWorkspaceList()
    const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).filter((w) => w.path !== path)
    settingsStore.set('workspaces', list)
    return workspaceEntries()
  })

  ipcMain.handle('ws:create-workspace', async (_e, payload: { name: string; parentDir: string; private?: boolean; password?: string }) => {
    if (payload.private) {
      if (!payload.password) throw new VaultError('corrupt', 'A password is required.')
      const root = await createVault(payload.parentDir, payload.name, payload.password)
      const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
      if (!list.some((w) => w.path === root)) list.push({ path: root, name: payload.name.trim(), kind: 'private' })
      settingsStore.set('workspaces', list)
      await openVaultSession(root, payload.password)
      await stopAgent()
      settingsStore.set('workspace', root)
      watchWorkspace(getWorkspace() as string)
      return root
    }
    const root = await createWorkspace(payload.parentDir, payload.name)
    const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
    if (!list.some((w) => w.path === root)) list.push({ path: root, name: payload.name.trim(), kind: 'plain' })
    settingsStore.set('workspaces', list)
    await stopAgent()
    settingsStore.set('workspace', root)
    watchWorkspace(root)
    return root
  })

  // Unlock (or switch to) a private workspace.
  ipcMain.handle('ws:unlock', async (_e, payload: { path: string; password: string }) => {
    try {
      await closeVaultSession()
      const session = await openVaultSession(payload.path, payload.password)
      await stopAgent()
      settingsStore.set('workspace', payload.path)
      watchWorkspace(session.workDir)
      // Silently skipping a file the user can't see is how vault data goes
      // "missing" with no explanation. Say which ones, and that they are safe.
      const warning =
        session.unreadable.length > 0
          ? `${session.unreadable.length} file${session.unreadable.length === 1 ? '' : 's'} could not be unlocked and ` +
            `left untouched: ${session.unreadable.slice(0, 5).join(', ')}` +
            (session.unreadable.length > 5 ? `, +${session.unreadable.length - 5} more` : '')
          : undefined
      return { ok: true, name: session.name, warning }
    } catch (err) {
      const code = err instanceof VaultError ? err.code : 'corrupt'
      return { ok: false, code, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ws:lock', async () => {
    if (!currentVault()) return { ok: true }
    await stopAgent()
    await closeVaultSession()
    stopWatching()
    return { ok: true }
  })

  ipcMain.handle('ws:changePassword', async (_e, payload: { current: string; next: string }) => {
    const vault = currentVault()
    const root = vault?.root ?? (settingsStore.get('workspace') as string)
    if (!root) return { ok: false, message: 'No private workspace is open.' }
    try {
      await flushVault()
      const { changeVaultPassword } = await import('./vault')
      await changeVaultPassword(root, payload.current, payload.next)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('ws:switch', async (_e, path: string) => {
    if (await isVault(path)) return { ok: false, private: true, message: 'This workspace needs its password.' }
    await stopAgent()
    await closeVaultSession()
    settingsStore.set('workspace', path)
    stopWatching()
    watchWorkspace(path)
    return { ok: true, private: false }
  })

  ipcMain.handle('ws:convert', async (_e, payload: { root: string; name?: string }) => {
    const root = await convertToWorkspace(payload.root, payload.name)
    const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
    if (!list.some((w) => w.path === root)) {
      list.push({ path: root, name: payload.name?.trim() || (root.split('/').pop() ?? 'Workspace'), kind: 'plain' })
      settingsStore.set('workspaces', list)
    }
    await stopAgent()
    settingsStore.set('workspace', root)
    watchWorkspace(root)
    return root
  })
  ipcMain.handle('ws:open', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a Meridiem workspace',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    const root = result.filePaths[0]
    const isPrivate0 = await isVault(root)
    if (isPrivate0) {
      const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
      if (!list.some((w) => w.path === root)) {
        list.push({ path: root, name: (await readVaultConfig(root))?.name || 'Private', kind: 'private' })
        settingsStore.set('workspaces', list)
      }
      return { ok: false, private: true, path: root }
    }
    const info = await validateWorkspace(root)
    if (!info) return { ok: false, error: 'Not a Meridiem workspace. Create one instead (or convert this folder from the welcome screen).' }
    await stopAgent()
    settingsStore.set('workspace', root)
    watchWorkspace(root)
    return { ok: true, path: root, name: info.name }
  })
  ipcMain.handle('ws:choose', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose Meridiem workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const isPrivate = await isVault(path)
    const list = ((settingsStore.get('workspaces') as WorkspaceEntry[] | undefined) ?? []).slice()
    if (!list.some((w) => w.path === path)) {
      const name = isPrivate
        ? (await readVaultConfig(path))?.name || (path.split('/').pop() ?? 'Workspace')
        : (path.split('/').pop() ?? 'Workspace')
      list.push({ path, name, kind: isPrivate ? 'private' : 'plain' })
      settingsStore.set('workspaces', list)
    }
    settingsStore.set('workspace', path)
    return path
  })
  ipcMain.handle('ws:tree', async () => {
    // The renderer always asks for the tree on boot and after every change;
    // this is the reliable moment to (re)start the file watcher, because
    // settings aren't loaded yet when the window is first created.
    ensureWatching(getWorkspace())
    const root = getWorkspace()
    if (!root) return []
    // The sidebar mirrors the LINKS inside pages; `treeMode: 'folders'` brings
    // back the plain folder listing.
    const mode = (settingsStore.get('treeMode') as string | undefined) ?? 'links'
    if (mode === 'folders') return listWorkspace(root)
    try {
      return await buildLinkTree(root)
    } catch (err) {
      console.error('[meridiem] link tree failed, falling back to folders:', err)
      return listWorkspace(root)
    }
  })
  ipcMain.handle('ws:search', async (_e, query: string) => {
    const root = getWorkspace()
    if (!root) return []
    return searchWorkspace(root, query)
  })
  ipcMain.handle('ws:read', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return null
    try {
      return await readPage(join(root, relPath), relPath)
    } catch (err) {
      // Switching workspace restores the tabs of the workspace you left; their
      // paths usually don't exist in the new one. "No such page" is an answer,
      // not a fault, and the renderer already skips null entries.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      return null
    }
  })
  // In-flight quiz attempts. These are the answers a candidate has typed, not
  // page content, and they used to live only in the renderer's memory — a
  // relaunch, a crash or a stray quit threw away an entire paper. They live
  // under `.yestion/attempts/`, which both the watcher and the tree skip.
  const attemptPath = (root: string, relPath: string): string => {
    const safe = relPath
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('__')
    return join(root, '.yestion', 'attempts', `${safe}.json`)
  }
  ipcMain.handle('quiz:attemptSave', async (_e, relPath: string, data: string) => {
    const root = getWorkspace()
    if (!root) return false
    const file = attemptPath(root, relPath)
    await fsMkdir(dirname(file), { recursive: true })
    await fsp(file, data, 'utf-8')
    return true
  })
  ipcMain.handle('quiz:attemptLoad', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return null
    try {
      return await fsReadFile(attemptPath(root, relPath), 'utf-8')
    } catch {
      return null
    }
  })
  ipcMain.handle('quiz:attemptClear', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return false
    try {
      await fsUnlink(attemptPath(root, relPath))
    } catch {
      /* nothing saved yet */
    }
    return true
  })

  ipcMain.handle('ws:save', async (_e, payload: { relPath: string; title: string; icon: string; body: string }) => {
    const root = getWorkspace()
    if (!root) return false
    const abs = join(root, payload.relPath)
    let beforeBody = ''
    try {
      beforeBody = parsePageFile(await fsReadFile(abs, 'utf-8'), '').body
    } catch {
      /* new page */
    }
    await savePage(abs, payload.title, payload.icon, payload.body)
    // Adding a link adopts the target under this page. Removing one never moves
    // a file (there is no workspace Bin). Skipped in encrypted workspaces.
    if (!currentVault()) {
      try {
        const moves = await organizeAfterSave(root, payload.relPath, beforeBody, payload.body)
        if (moves.length > 0) {
          // The open tab may be one of the moved pages: the renderer remaps its
          // paths before saving again, so we never write to a stale location.
          for (const m of moves) {
            try {
              selfWrites.set(m.to, { body: readFileSync(join(root, m.to), 'utf-8'), at: Date.now() })
            } catch {
              /* ignore */
            }
          }
          mainWindow?.webContents.send('ws:page-moved', moves)
        }
      } catch (err) {
        console.error('[meridiem] organizing after save failed:', err)
      }
    }
    // Remember the exact bytes so the watcher can tell this write apart from an
    // agent's edit to the same file.
    try {
      selfWrites.set(payload.relPath.replace(/\\/g, '/'), {
        body: readFileSync(abs, 'utf-8'),
        at: Date.now()
      })
    } catch {
      /* ignore */
    }
    return true
  })
  ipcMain.handle('ws:create', async (_e, payload: { parentRel: string | null; title: string }) => {
    const root = getWorkspace()
    if (!root) return null
    const page = await createPage(root, payload.parentRel, payload.title)
    if (page) rememberSelfWrite(root, page.relPath)
    return page
  })
  // Daily notes are loose `Daily/YYYY-MM-DD.md` files rather than folder pages:
  // a day is a leaf, and a year of folders would drown the tree. Kept here
  // because it is the one place allowed to create the Daily folder on demand.
  ipcMain.handle('ws:daily', async (_e, date: unknown) => {
    const root = getWorkspace()
    if (!root) return null
    const clean = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : new Date().toISOString().slice(0, 10)
    const relPath = `Daily/${clean}.md`
    const abs = join(root, relPath)
    await fsMkdir(join(root, 'Daily'), { recursive: true })
    try {
      const existing = await readPage(abs, relPath)
      if (existing) return existing
    } catch {
      /* not created yet */
    }
    await savePage(abs, clean, '', '')
    rememberSelfWrite(root, relPath)
    return { relPath, absolutePath: abs, title: clean, icon: '', body: '' }
  })
  ipcMain.handle('ws:convert-loose', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return relPath
    const next = await convertLoosePage(root, relPath)
    if (next && next !== relPath) rememberSelfWrite(root, next)
    return next
  })
  ipcMain.handle('ws:weekly', async (_e, key: unknown) => {
    const root = getWorkspace()
    if (!root) return null
    const clean = typeof key === 'string' && /^\d{4}-W\d{2}$/.test(key) ? key : null
    if (!clean) return null
    const relPath = `Weekly/${clean}.md`
    const abs = join(root, relPath)
    await fsMkdir(join(root, 'Weekly'), { recursive: true })
    try {
      const existing = await readPage(abs, relPath)
      if (existing) return existing
    } catch {
      /* not created yet */
    }
    await savePage(abs, clean, '', '')
    rememberSelfWrite(root, relPath)
    return { relPath, absolutePath: abs, title: clean, icon: '', body: '' }
  })
  // A template is a file you copy, not a file you edit. Markdown templates
  // become ordinary root pages; .qz templates become root papers with the same
  // body, so an exam template is never opened in the page editor.
  ipcMain.handle('ws:use-template', async (_e, payload: { relPath: string; title?: string }) => {
    const root = getWorkspace()
    if (!root) return null
    const srcAbs = join(root, payload.relPath)
    const raw = await fsReadFile(srcAbs, 'utf-8')
    const parsed = parsePageFile(raw, payload.relPath.split('/').pop() || 'Template')
    const title = (payload.title || parsed.title || 'Untitled').trim()
    if (/\.qz$/i.test(payload.relPath)) {
      const base = title.replace(/[/\\:*?"<>|]/g, '-').replace(/\.+$/g, '') || 'Untitled paper'
      let name = base
      let n = 2
      while (true) {
        try {
          await fsAccess(join(root, `${name}.qz`))
          name = `${base} ${n++}`
        } catch {
          break
        }
      }
      const relPath = `${name}.qz`
      const abs = join(root, relPath)
      await fsMkdir(dirname(abs), { recursive: true })
      await fsp(abs, serializePageFile(title, parsed.icon, parsed.body), 'utf-8')
      rememberSelfWrite(root, relPath)
      return { relPath, absolutePath: abs, title, icon: parsed.icon, body: parsed.body }
    }
    const page = await createPage(root, null, title)
    await savePage(page.absolutePath, title, parsed.icon, parsed.body)
    rememberSelfWrite(root, page.relPath)
    return { ...page, title, icon: parsed.icon, body: parsed.body }
  })
  // Workspace-mode projections (Notes views, graph, tasks, media, Inbox).
  ipcMain.handle('ws:index', async () => {
    const root = getWorkspace()
    return root ? workspaceIndex(root) : []
  })
  ipcMain.handle('ws:tasks', async () => {
    const root = getWorkspace()
    return root ? workspaceTasks(root) : []
  })
  ipcMain.handle('ws:toggle-task', async (_e, payload: { relPath: string; line: number; checked: boolean }) => {
    const root = getWorkspace()
    if (!root) return false
    return toggleTask(root, payload.relPath, payload.line, payload.checked)
  })
  ipcMain.handle('ws:graph', async () => {
    const root = getWorkspace()
    return root ? workspaceGraph(root) : { nodes: [], edges: [] }
  })
  ipcMain.handle('ws:media', async () => {
    const root = getWorkspace()
    return root ? workspaceMedia(root) : []
  })
  ipcMain.handle('ws:inbox', async () => {
    const root = getWorkspace()
    return root ? readInbox(root) : []
  })
  ipcMain.handle('ws:inbox-add', async (_e, text: string) => {
    const root = getWorkspace()
    return root ? addInboxItem(root, text) : []
  })
  ipcMain.handle('ws:inbox-toggle', async (_e, payload: { line: number; checked: boolean }) => {
    const root = getWorkspace()
    return root ? toggleInboxItem(root, payload.line, payload.checked) : []
  })
  ipcMain.handle('ws:delete', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return false
    // Deleting a page means deleting its folder, and the file goes to the
    // macOS Trash — not to a workspace `Bin/` folder and not to oblivion.
    const abs = join(root, relPath)
    const target = /[/\\]index\.md$/i.test(abs) ? dirname(abs) : abs
    try {
      await shell.trashItem(target)
    } catch {
      // No Trash available (some network volumes): fall back to a real delete.
      await deletePageOrFolder(target)
    }
    return true
  })
  ipcMain.handle('ws:resolve-link', async (_e, linkText: string, fromDir?: string) => {
    const root = getWorkspace()
    if (!root) return null
    return resolvePageLink(root, linkText, fromDir)
  })
  ipcMain.handle('ws:all-pages', async () => {
    const root = getWorkspace()
    if (!root) return []
    return listAllPages(root)
  })
  ipcMain.handle('ws:reveal', async (_e, relPath: string) => {
    const root = getWorkspace()
    if (!root) return
    shell.showItemInFolder(join(root, relPath))
  })
  ipcMain.handle('ws:open-folder-in-finder', async () => {
    const root = getWorkspace()
    if (!root) return
    shell.openPath(root)
  })
}

// ---------------- IPC: agent ----------------

function registerAgentHandlers(): void {
  const send = (channel: string, payload: unknown): void => {
    mainWindow?.webContents.send(channel, payload)
  }

  let agentSettings: AgentSettings | null = null

  /** What the renderer needs to know about the live session. */
  const startPayload = (): { model: string; contextWindow: number | null; sessionFile: string | null } => ({
    model: agent?.modelLabel ?? '',
    contextWindow: agent?.contextWindow() ?? null,
    sessionFile: agent?.sessionFile() ?? null
  })

  /** How the last assistant message of a turn ended, captured from the event
   *  stream — the same data the panel logs. The handle's message array does not
   *  reliably carry it. */
  let lastTurnOutcome: { stopReason?: string; errorMessage?: string } | null = null

  const launch = async (root: string, settings: AgentSettings) => {
    if (agent) {
      await agent.dispose()
      agent = null
    }
    const harness = activeHarness()
    if (harnessKind(harness) === 'none') {
      throw new Error('AI is turned off. Choose a harness in Settings (⌘,).')
    }
    agentSettings = settings
    agent = await startAgentForHarness(
      harness,
      root,
      { ...settings, thinkingLevel: (settingsStore.get('agentThinking') as string) || 'max' },
      (event) => {
        const ev = event as {
          type?: string
          message?: { role?: string; stopReason?: string; errorMessage?: string }
        }
        if (ev?.type === 'message_end' || ev?.type === 'turn_end') {
          const msg = ev.message
          if (msg?.role === 'assistant') {
            lastTurnOutcome = { stopReason: msg.stopReason, errorMessage: msg.errorMessage }
          }
        }
        send('agent:event', event)
      }
    )
    const payload = startPayload()
    send('agent:started', payload)
    void logLine(`agent session ${settings.newSession ? 'new' : 'attach'} → ${payload.sessionFile ?? payload.model}`)
    return payload
  }

  const requireWorkspace = (): string => {
    if (currentVault()) {
      throw new Error('The agent is unavailable in private workspaces (their files are encrypted on disk).')
    }
    const root = getWorkspace()
    if (!root) throw new Error('Choose a workspace folder first')
    return root
  }

  /**
   * Errors that mean the stream died rather than the work being impossible:
   * a dropped connection, a provider restart, a gateway timeout. pi retries a
   * stream it knows about; `terminated` and friends arrive as a finished
   * assistant message with `stopReason: "error"` and are not retried, which is
   * what made a long task stop mid-sentence.
   */
  /** Errors that mean retrying cannot help. */
  const PERMANENT_ERROR =
    /\b(?:400|401|403|404)\b|invalid api key|authentication|unauthori[sz]ed|model .*not found|insufficient|quota|balance|billing|context length/i

  async function promptWithContinuation(
    handle: AgentHandle,
    text: string,
    images?: { data: string; mimeType: string }[]
  ): Promise<void> {
    agentAbortRequested = false
    lastTurnOutcome = null
    await handle.prompt(text, images)
    // pi retries interrupted streams; an external harness owns its own retry
    // policy and a second prompt would be a second user turn.
    if (harnessKind(activeHarness()) !== 'pi') return
    // Two extra attempts. Enough to ride out a dropped stream; not enough to
    // hammer a provider that is genuinely down.
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (agentAbortRequested) return
      // Cast defeats TS's control-flow narrowing: the assignment happens in the
      // event subscription, which the compiler cannot see across the await.
      const outcome = lastTurnOutcome as {
        stopReason?: string
        errorMessage?: string
      } | null
      if (!outcome) return
      const stop = outcome.stopReason ?? ''
      const errText = String(outcome.errorMessage ?? '')
      // Only a provider *error* is retried. `aborted` is never continued: it
      // is what a user Stop produces, and a Stop must end the run even if the
      // flag arrives a tick late. Every error is retried unless the text names
      // a condition retrying cannot fix, because providers word a dropped
      // stream a dozen ways ("Connection error." is one).
      const continuable = stop === 'error' && !PERMANENT_ERROR.test(errText)
      if (!continuable) return
      void logLine(
        `agent: turn ended early (${stop}${errText ? `: ${errText}` : ''}) — continuing (${attempt}/2)`,
        'warn'
      )
      send('agent:event', {
        type: 'retry_scheduled',
        attempt,
        maxAttempts: 2,
        errorMessage: outcome.errorMessage
      })
      lastTurnOutcome = null
      await handle.prompt(
        'The previous response was cut off by a transport error. Continue exactly where you left off. ' +
          'Do not repeat work that is already done and do not restart the task.'
      )
    }
  }

  ipcMain.handle('agent:start', async (_e, settings: AgentSettings) => {
    const root = requireWorkspace()
    // Same settings and a live session? Reuse it — restarting per message is
    // what made the agent forget the conversation.
    if (agent && agentSettings && JSON.stringify(agentSettings) === JSON.stringify(settings)) {
      const payload = startPayload()
      send('agent:started', payload)
      return payload
    }
    return launch(root, settings)
  })

  // Detach whatever is running and attach to one explicit conversation. Keeping
  // this in a single handler means the renderer never has to guess the agent's
  // state (a stop-then-start pair raced with in-flight prompts).
  ipcMain.handle('agent:resume', async (_e, settings: AgentSettings) => {
    const root = requireWorkspace()
    // ACP sessions live in the external harness, not in Meridiem's pi session
    // files. "Resume" therefore means "keep the live external session, or start
    // one if there isn't one"; starting a fresh child on every prompt would wipe
    // the conversation between turns.
    if (harnessKind(activeHarness()) !== 'pi') {
      if (agent) {
        const payload = startPayload()
        send('agent:started', payload)
        return payload
      }
      return launch(root, settings)
    }
    if (!settings.sessionFile) throw new Error('No conversation to resume')
    if (agent && agent.sessionFile() === settings.sessionFile) {
      const payload = startPayload()
      send('agent:started', payload)
      return payload
    }
    return launch(root, settings)
  })

  ipcMain.handle(
    'agent:prompt',
    async (
      _e,
      text: string,
      context?: { title: string; relPath: string } | null,
      images?: { data: string; mimeType: string }[]
    ) => {
      if (!agent) throw new Error('Agent is not running')
      const withContext = context && context.title
        ? `[User is viewing the page "${context.title}" (${context.relPath}) in Meridiem right now.]\n\n${text}`
        : text
      agentBusy = true
      try {
        await promptWithContinuation(agent, withContext, images)
      } finally {
        agentBusy = false
      }
    }
  )

  // The grader's transport. Deliberately not `agent:prompt`: this must leave no
  // trace in the transcript and must not race a turn the user is having.
  ipcMain.handle('agent:oneshot', async (_e, req: OneShotRequest) => {
    const root = getWorkspace()
    if (!root) return { ok: false, text: '', error: 'No workspace open', elapsedMs: 0 }
    const harness = activeHarness()
    if (harnessKind(harness) === 'none') {
      return {
        ok: false,
        text: '',
        error: 'AI is turned off. Use the marking scheme to mark this answer yourself.',
        elapsedMs: 0
      }
    }
    // The model the user has configured for the panel. Reading it from the
    // store rather than from `agentSettings` means grading works even if the
    // chat panel was never opened this session.
    const settings: AgentSettings = agentSettings ?? {
      provider: (settingsStore.get('agentProvider') as string) || 'anthropic',
      model: (settingsStore.get('agentModel') as string) || '',
      apiKey: (settingsStore.get('agentApiKey') as string) || '',
      thinkingLevel: (settingsStore.get('agentThinking') as string) || 'low'
    }
    const result = await runOneShotForHarness(harness, root, settings, req)
    if (!result.ok) void logLine(`agent oneshot failed: ${result.error ?? 'unknown'}`, 'error')
    return result
  })

  /**
   * Marking transport for the quiz runner.
   *
   * When the conversation that wrote the paper is still the attached session,
   * the marking request is sent there as a normal turn — the model keeps the
   * context it had while authoring the quiz, and the exchange is visible in
   * the transcript. Otherwise (another conversation is open, the app was
   * restarted, or the user is mid-turn) it degrades to the isolated one-shot,
   * which is what grading used to be. The quiz clock is paused either way.
   */
  ipcMain.handle(
    'agent:gradeQuiz',
    async (
      _e,
      req: { relPath: string; system: string; prompt: string; timeoutMs?: number }
    ): Promise<{ ok: boolean; text: string; error?: string; elapsedMs: number }> => {
      const started = Date.now()
      const elapsed = (): number => Date.now() - started
      const harness = activeHarness()
      if (harnessKind(harness) === 'none') {
        return {
          ok: false,
          text: '',
          error: 'AI is turned off. Use the marking scheme below to mark this answer yourself.',
          elapsedMs: 0
        }
      }
      const target = quizSessions.get(req.relPath)
      const live = agent
      const inChat =
        harnessKind(harness) === 'pi' && !!live && !!target && live.sessionFile() === target && !agentBusy

      if (live && inChat) {
        const prefix = `[Quiz marking request from the Meridiem quiz runner. Do not use any tools — reply with the JSON object only.]\n\n${req.system}`
        const text = `${prefix}\n\n---\n\n${req.prompt}`
        const timeoutMs = req.timeoutMs ?? ONE_SHOT_TIMEOUT_MS
        let timer: ReturnType<typeof setTimeout> | null = null
        agentBusy = true
        // The panel did not type this message; tell it to show the user turn so
        // the transcript reads as a conversation rather than a reply from nowhere.
        send('agent:injected-prompt', text)
        try {
          await Promise.race([
            live.prompt(text),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('The conversation did not answer in time.')),
                timeoutMs
              )
            })
          ])
          const reply = lastAssistantText(live.messages()).trim()
          if (!reply) {
            return { ok: false, text: '', error: 'The conversation returned no text.', elapsedMs: elapsed() }
          }
          return { ok: true, text: reply, elapsedMs: elapsed() }
        } catch (err) {
          // Stop the turn we started: a reply that lands after the runner has
          // already fallen back would appear in the chat as an orphan.
          void live.abort().catch(() => undefined)
          return { ok: false, text: '', error: String((err as Error)?.message ?? err), elapsedMs: elapsed() }
        } finally {
          if (timer) clearTimeout(timer)
          agentBusy = false
          send('agent:injected-done', null)
        }
      }

      // No creating conversation is attached — the context-free path.
      const root = getWorkspace()
      if (!root) return { ok: false, text: '', error: 'No workspace open', elapsedMs: elapsed() }
      const settings: AgentSettings = agentSettings ?? {
        provider: (settingsStore.get('agentProvider') as string) || 'anthropic',
        model: (settingsStore.get('agentModel') as string) || '',
        apiKey: (settingsStore.get('agentApiKey') as string) || '',
        thinkingLevel: (settingsStore.get('agentThinking') as string) || 'low'
      }
      return runOneShotForHarness(harness, root, settings, req)
    }
  )

  ipcMain.handle('agent:sessions', async () => {
    if (harnessKind(activeHarness()) !== 'pi') return []
    const root = getWorkspace()
    if (!root) return []
    return listAgentSessions(root)
  })

  ipcMain.handle('agent:sessionMessages', async (_e, sessionPath: string) => {
    return readAgentSessionMessages(sessionPath)
  })

  ipcMain.handle('agent:sessionCurrent', async () => {
    return harnessKind(activeHarness()) === 'pi' ? agent?.sessionFile() ?? null : null
  })

  // Native context menu for pages / PDFs / files in the sidebar and tab strip.
  ipcMain.handle('ui:itemMenu', async (event, payload: { relPath: string; kind: string; name?: string; isTab?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    if (!win) return
    const action = (a: string): void => send('item:action', { action: a, ...payload })
    // A blank tab has no file behind it: nothing to open, reveal or copy.
    if (payload.kind === 'new') {
      const blankItems: Electron.MenuItemConstructorOptions[] = [
        { label: 'Close Tab', click: () => action('close-tab') },
        { label: 'Close Other Tabs', click: () => action('close-others') }
      ]
      if (process.env.YESTION_MENU_DRY_RUN === '1') {
        console.log('[item-menu]', JSON.stringify(payload))
        return
      }
      const blankMenu = Menu.buildFromTemplate(blankItems)
      const blankWin = BrowserWindow.fromWebContents(event.sender)
      if (blankWin) blankMenu.popup({ window: blankWin })
      return
    }
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: 'Open', click: () => action('open') },
      { label: 'Open in New Tab', click: () => action('new-tab') },
      { type: 'separator' },
      { label: 'Reveal in Finder', click: () => action('reveal') },
      { label: 'Copy Path', click: () => action('copy-path') }
    ]
    if (payload.kind === 'page' || payload.kind === 'quiz') {
      items.push({ label: 'Copy Page Link', click: () => action('copy-link') })
    }
    if (payload.isTab) {
      items.push(
        { type: 'separator' },
        { label: 'Close Tab', click: () => action('close-tab') },
        { label: 'Close Other Tabs', click: () => action('close-others') }
      )
    }
    // Headless test path: YESTION_MENU_DRY_RUN=1 logs the payload instead of
    // opening a native popup, and YESTION_MENU_ACTION=<action> replays a menu
    // choice so the renderer-side handling can be exercised from a script.
    if (process.env.YESTION_MENU_DRY_RUN === '1') {
      console.log('[item-menu]', JSON.stringify(payload))
      const replay = process.env.YESTION_MENU_ACTION
      if (replay && replay !== 'none') send('item:action', { action: replay, ...payload })
      return
    }
    const menu = Menu.buildFromTemplate(items)
    const target = BrowserWindow.fromWebContents(event.sender)
    if (target) menu.popup({ window: target })
    else menu.popup({ window: win })
  })

  ipcMain.handle('agent:abort', async () => {
    agentAbortRequested = true
    await agent?.abort()
  })

  ipcMain.handle('agent:models', async () => {
    if (harnessKind(activeHarness()) !== 'pi') return []
    try {
      return await listAvailableModels()
    } catch (err) {
      return []
    }
  })

  // ---- providers & models (Meridiem's own config) ----
  ipcMain.handle('providers:list', async () => listProviderStatus())
  ipcMain.handle('providers:save', async (_e, payload: { providers: ProviderConfig[] }) => {
    await saveProviders(payload.providers)
    // A changed provider/model set means new sessions must pick it up.
    return true
  })
  ipcMain.handle('providers:key', async (_e, payload: { id: string; key: string }) => {
    await setProviderKey(payload.id, payload.key)
    await writePiConfig()
    return true
  })
  ipcMain.handle('providers:test', async (_e, id: string) => testProvider(id))
  ipcMain.handle('providers:seed', async () => {
    const count = await importFromPi()
    if (count > 0) await writePiConfig()
    return count
  })
  ipcMain.handle('providers:ollama', async (_e, baseUrl: string) => listOllamaModels(baseUrl))
  ipcMain.handle('providers:testDraft', async (_e, draft: { baseUrl: string; api: string; key: string; modelId: string }) =>
    probeDraft(draft)
  )

  ipcMain.handle('agent:compact', async (_e, instructions?: string) => {
    if (!agent) throw new Error('Agent is not running')
    return agent.compact(instructions)
  })

  ipcMain.handle('agent:thinking', async (_e, level: string) => {
    if (!agent) throw new Error('Agent is not running')
    agent.setThinking(level)
    return true
  })

  ipcMain.handle('agent:restart', async () => {
    await stopAgent()
    return true
  })

  ipcMain.handle('agent:harnesses', async (_e, force?: boolean) => listHarnesses(force === true))
  ipcMain.handle('agent:harnessGet', async () => activeHarness())
  ipcMain.handle('agent:harnessSet', async (_e, id: string) => {
    const check = await validateHarness(id)
    if (!check.ok) return { ok: false, harness: activeHarness(), message: check.message }
    await stopAgent()
    settingsStore.set('agentHarness', id)
    send('agent:stopped', true)
    void logLine(
      `agent harness → ${id}${check.path ? ` (${check.path})` : ''}`,
      'info'
    )
    return { ok: true, harness: id, path: check.path }
  })

  ipcMain.handle('agent:stop', async () => {
    await stopAgent()
    send('agent:stopped', true)
  })
}

/**
 * Quit is the one path that must leave nothing behind. A plain `app.quit()`
 * let the recursive fs watcher, the ACP child process and an in-flight pi
 * stream outlive the window, so Activity Monitor kept a Meridiem process (and
 * sometimes a whole CLI) alive after ⌘Q. Every one of them is torn down here,
 * then the process exits directly.
 */
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    try {
      stopWatching()
    } catch {
      /* watcher already closed */
    }
    try {
      terminateAllAcpChildren()
    } catch {
      /* no child processes */
    }
    try {
      await stopAgent()
    } catch {
      /* handle already disposed */
    }
    try {
      destroyPrintHost()
    } catch {
      /* no print host */
    }
    try {
      if (currentVault()) await closeVaultSession()
    } catch {
      /* vault already closed */
    }
    // Destroy, rather than close, so no window's close handler can start
    // another async teardown on the way out.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy()
    }
    app.exit(0)
  })()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.gloomybreaker.meridiem')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerWorkspaceHandlers()
  registerAgentHandlers()
  buildAppMenu(async () => {
    mainWindow = await createWindow()
  }, async (cmd: string) => {
    mainWindow?.webContents.send('menu-action', cmd)
  })

  // Renderer-side diagnostics land in a log file so failures in the app can be
  // read from a terminal (the window has no console attached).
  ipcMain.handle('app:log', async (_e, entry: { level?: string; message: string }) => {
    const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info'
    await logLine(entry.message, level)
    return true
  })

  ipcMain.handle('settings:get', (_e, key: string) => settingsStore.get(key as never))
  ipcMain.handle('settings:getAll', () => settingsStore.getAll())
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    settingsStore.set(key as never, value as never)
  })
  ipcMain.handle('settings:setMany', (_e, patch: Record<string, unknown>) => {
    settingsStore.setMany(patch as never)
  })

  void createWindow().then((w) => {
    mainWindow = w
    // Watch the workspace from launch: without this the app only noticed
    // external/agent edits after a workspace switch.
    ensureWatching(getWorkspace())
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // Not getAllWindows(): the hidden print host is a window too, and the dock
  // icon has to reopen the app whether or not one is still alive.
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Keep the reference: the menu and the export dialog both need it, and it
    // used to be dropped here, so a reopened window's menu items went nowhere.
    void createWindow().then((w) => {
      mainWindow = w
    })
  }
})

// Imported for the zoom menu state (menu.ts shares zoomMenuState).
import { zoomMenuState } from './menu'
