import { createRichEditor, dismissEditorFloats, localFileUrl, onEditorCountChange, readCounts, type RichEditor, type MeridiemPageOpts } from './wysiwyg'
import { createEditor, type MarkdownEditor } from './editor'
import { applyTheme, getTheme, nextTheme, resolveTheme, THEMES } from './themes'
import { fillFontSelect, fontById, printableStack } from './fonts'
import { setupOnboarding } from './onboarding'
import { setupSidebar } from './sidebar'
import { setupAgentPanel } from './agent'
import { setupSettings } from './settings'
import { EMOJI_LIST, EMOJI_GROUPS } from './emoji-data'
import { applyIcon, iconEl, iconSvg, type IconName } from './icons'
import { anchorFloat, dismissFloats, installFloatDismissal, registerFloatCloser } from './floats'
import './styles.css'
import { createPdfViewer, type PdfViewerHandle } from './pdf-viewer'
import { createNewTabPane, type NewTabItem } from './newtab'
import { createQuizPane } from './quiz-pane'
import { parseQz } from './qz'
import { countText, formatCount, type CountMode } from './word-count'
import {
  collectDailyNotes,
  dailyTitle,
  formatDailyDate,
  relativeDay,
  setupCalendar,
  shiftDateKey,
  todayKey,
  weekKeyForDate,
  weeklyTitle,
  type CalendarHandle,
  type DailyNote
} from './calendar'
import { renderWorkspaceMode, type WorkspaceModeId, type WorkspaceViewId } from './workspace-modes'
import { keybinds } from './keybinds'

// Fonts live in ./fonts.ts (shared with the settings modal).

// Rendered text size. Only the type scale changes: the text column keeps its
// width, so bigger sizes mean fewer words per line (unlike zoom, which would
// scale the column with the text).
const RENDER_SIZES = [
  { id: 'xs', label: 'Size: Extra small', px: 13, scale: 13 / 16 },
  { id: 's', label: 'Size: Small', px: 14.5, scale: 14.5 / 16 },
  { id: 'm', label: 'Size: Medium', px: 16, scale: 1 },
  { id: 'l', label: 'Size: Large', px: 18, scale: 18 / 16 },
  { id: 'xl', label: 'Size: Extra large', px: 20.5, scale: 20.5 / 16 }
] as const

function applyRenderSize(id: string): void {
  const size = RENDER_SIZES.find((s) => s.id === id) ?? RENDER_SIZES[2]
  const root = document.documentElement
  root.style.setProperty('--render-font-size', size.px + 'px')
  root.style.setProperty('--render-font-scale', String(size.scale))
  root.dataset.renderSize = size.id
}

// ---- DOM ----
const welcomeEl = document.getElementById('welcome') as HTMLElement
const emptyStateEl = document.getElementById('empty-state') as HTMLElement
const pageViewEl = document.getElementById('page-view') as HTMLElement
const pageLoaderEl = document.getElementById('page-loader') as HTMLElement
const breadcrumbsEl = document.getElementById('breadcrumbs') as HTMLElement
const pageIconEl = document.getElementById('page-icon') as HTMLButtonElement

/**
 * The icon at the top of the document. An emoji the user picked stays an
 * emoji — it is their page, and the icon picker is right there. A page with no
 * icon gets the line-art sheet instead of the app's old hardcoded 📄, which
 * read as a default rather than as "no icon set".
 */
function paintPageIcon(icon: string): void {
  pageIconEl.classList.toggle('no-icon', !icon)
  applyIcon(pageIconEl, icon, 'doc', 46)
}
const pageTitleEl = document.getElementById('page-title') as HTMLInputElement
const editorMount = document.getElementById('editor-mount') as HTMLElement
const codeMount = document.getElementById('code-mount') as HTMLElement
const toggleSourceBtn = document.getElementById('toggle-source-btn') as HTMLButtonElement
const saveStatusEl = document.getElementById('save-status') as HTMLElement
const workspaceNameEl = document.getElementById('workspace-name') as HTMLElement
const pdfPaneEl = document.getElementById('pdf-pane') as HTMLElement
const quizPaneEl = document.getElementById('quiz-pane') as HTMLElement
const pdfViewEl = document.getElementById('pdf-view') as HTMLElement
const imagePaneEl = document.getElementById('image-pane') as HTMLElement
const imageViewEl = document.getElementById('image-view') as HTMLImageElement
const imageStageEl = document.getElementById('image-stage') as HTMLElement
const wordCountEl = document.getElementById('word-count') as HTMLElement
const statWordsEl = document.getElementById('stat-words') as HTMLElement
const statCharsEl = document.getElementById('stat-chars') as HTMLElement
const statLinesEl = document.getElementById('stat-lines') as HTMLElement
const statReadEl = document.getElementById('stat-read') as HTMLElement
const pageStatusEl = document.getElementById('page-status') as HTMLElement
const modePaneEl = document.getElementById('mode-pane') as HTMLElement
const modeBodyEl = document.getElementById('mode-body') as HTMLElement

// ---- state ----
let currentPage: { relPath: string; absolutePath: string; title: string; icon: string; body: string; dirRel: string } | null = null
let sourceMode = false
/** Absolute workspace root, kept for optimistic daily/weekly opens. */
let workspaceRootCache: string | null = null

const DAILY_REL = /(?:^|\/)Daily\/(\d{4}-\d{2}-\d{2})\.md$/i
const WEEKLY_REL = /(?:^|\/)Weekly\/(\d{4}-W\d{2})\.md$/i

function dailyKeyOf(relPath: string): string | null {
  return DAILY_REL.exec(relPath)?.[1] ?? null
}
function weeklyKeyOf(relPath: string): string | null {
  return WEEKLY_REL.exec(relPath)?.[1] ?? null
}

/** What the header says for a file: dated notes get human titles. */
function displayTitleFor(relPath: string, fallback: string): string {
  const daily = dailyKeyOf(relPath)
  if (daily) return dailyTitle(daily)
  const weekly = weeklyKeyOf(relPath)
  if (weekly) return weeklyTitle(weekly)
  return fallback
}

// ---- word count ----
// The mode is a display preference, not a property of the page: a student who
// writes in Chinese sets it once and every page follows.
let countMode: CountMode = 'words'
/** The last text seen, kept so a mode change can repaint without re-reading. */
let lastCountText = ''
let lastCountSelection = ''

function paintWordCount(text: string, selected: string): void {
  lastCountText = text
  lastCountSelection = selected
  const total = countText(text, countMode)
  // A collapsed caret is not a selection: it reports the page's own count.
  const sel = selected === '' ? null : countText(selected, countMode)
  // Keep the old footer string in the DOM (hidden) — it is the a11y-friendly
  // sentence, while the floating pill shows the four numbers at a glance.
  wordCountEl.textContent = total === 0 && sel === null ? '' : formatCount(total, sel, countMode)

  const chars = [...text.replace(/\r/g, '').replace(/\n/g, '')].length
  const lines = text === '' ? 0 : text.split('\n').length
  const readable = countMode === 'asian' ? Math.round(chars / 400) : Math.round(total / 200)
  const readMinutes = total === 0 ? 0 : Math.max(1, readable)
  const nf = (n: number): string => n.toLocaleString('en-US')
  statWordsEl.textContent = nf(sel ?? total)
  statCharsEl.textContent = nf(chars)
  statLinesEl.textContent = nf(lines)
  statReadEl.textContent = total === 0 ? '0 min' : `${readMinutes} min`
  pageStatusEl.title = sel === null ? '' : `${sel.toLocaleString('en-US')} selected of ${total.toLocaleString('en-US')}`
  pageStatusEl.hidden = total === 0 && sel === null
}

function setCountMode(mode: CountMode): void {
  countMode = mode
  paintWordCount(lastCountText, lastCountSelection)
}

/**
 * Repaint from whichever surface is on screen.
 *
 * The rich editor's `setContent` runs with `emitUpdate: false`, so loading a
 * page does not reach the listener above; this is what fills the footer on
 * open, on a tab switch, and on a mode change.
 *
 * `ignoreSelection` is for a freshly loaded page: CodeMirror maps the old
 * caret through a content swap, so the previous page's selection can survive
 * as a range and would be reported against the new text.
 */
function refreshWordCount(ignoreSelection = false): void {
  if (viewMode !== 'rich') {
    const state = codeEditor.view.state
    const { from, to } = state.selection.main
    const selected = !ignoreSelection && from !== to ? state.sliceDoc(from, to) : ''
    paintWordCount(state.doc.toString(), selected)
    return
  }
  const counts = readCounts(richEditor)
  paintWordCount(counts.text, ignoreSelection ? '' : counts.selected)
}

// Every rich editor reports here, including the split pane's — but the footer
// sits under the page pane and describes *that* page, so the split editors are
// ignored. In source view the markdown pane's own listener is the one that
// must win, so nothing here may paint over it.
onEditorCountChange((view, counts) => {
  if (view !== richEditor.view) return
  if (viewMode === 'source') return
  paintWordCount(counts.text, counts.selected)
})

// ---- save state (queued, per page) ----
// Editing bumps a revision for the page; a save job is an immutable snapshot of
// (body, title, icon, rev). Jobs drain serially. A page is "pending" while its
// latest edit revision has not been written yet, so the status line can never
// claim "Saved" while newer keystrokes are still unwritten. The previous
// implementation flipped a single `dirty = false` after each write, which
// silently dropped any keystrokes typed while that write was in flight.
interface SaveJob {
  relPath: string
  title: string
  icon: string
  body: string
  rev: number
}
const saveQueue: SaveJob[] = []
let saveInFlight = false
let revCounter = 0
let quiesceWaiters: Array<() => void> = []
const editRev = new Map<string, number>()
const savedRev = new Map<string, number>()
// Echo suppression: our own save comes back through the file watcher ~0.5s
// later. Reloading that identical content re-creates the editor state and dumps
// the caret at the end of the document — so remember the bytes we persisted,
// per page.
const lastPersistedBody = new Map<string, string>()

// Save: debounce + flush on blur/hidden.
let saveTimer: number | null = null
const SAVE_DEBOUNCE_MS = 1200

// ---- page content cache ----
// Tab switching and back/forward re-open the same pages constantly; re-reading
// every one from disk (and re-parsing it in both editors) on each click is the
// main reason navigation didn't feel instant. The watcher invalidates entries
// changed outside the app and saves refresh them in place, so a hit is always
// at least as fresh as the tree the user is clicking.
type CachedPage = NonNullable<Awaited<ReturnType<typeof window.api.wsRead>>>
const pageCache = new Map<string, CachedPage>()
/** Workspace the cache belongs to — different workspaces reuse relative paths. */
let cacheWorkspacePath: string | null = null
const PAGE_CACHE_MAX = 64
function cachePage(page: CachedPage): void {
  pageCache.delete(page.relPath)
  pageCache.set(page.relPath, page)
  if (pageCache.size <= PAGE_CACHE_MAX) return
  for (const key of pageCache.keys()) {
    // Never evict the page on screen or the one just cached.
    if (key === currentPage?.relPath || key === page.relPath) continue
    pageCache.delete(key)
    break
  }
}
function dropCachedPage(rel: string): void {
  pageCache.delete(rel)
}
async function fetchPageEntry(rel: string): Promise<CachedPage | null> {
  const cached = pageCache.get(rel)
  // A page with unwritten edits must come from disk: the queued write is sent
  // before this read, so the main process returns the newest bytes. Serving the
  // cache here would show the user their pre-edit copy.
  if (cached && !isPending(rel) && !saveQueue.some((j) => j.relPath === rel)) return cached
  const page = await window.api.wsRead(rel)
  if (!page) return null
  cachePage(page)
  return page
}

function nextRev(): number {
  return ++revCounter
}
function isPending(rel: string): boolean {
  return (editRev.get(rel) ?? 0) > (savedRev.get(rel) ?? 0)
}
function resolveQuiesce(): void {
  if (saveInFlight || saveQueue.length > 0) return
  const waiters = quiesceWaiters
  quiesceWaiters = []
  for (const w of waiters) w()
}
/** Resolves once every queued write has settled (written or re-queued). */
function whenSaveQuiescent(): Promise<void> {
  if (!saveInFlight && saveQueue.length === 0) return Promise.resolve()
  return new Promise((resolve) => quiesceWaiters.push(resolve))
}
/** Queue (or merge) a snapshot for its page; the newest revision per page wins. */
function enqueueSave(job: SaveJob): void {
  const i = saveQueue.findIndex((j) => j.relPath === job.relPath)
  if (i >= 0) {
    if (job.rev >= saveQueue[i].rev) saveQueue[i] = job
  } else {
    saveQueue.push(job)
  }
  void drainSaveQueue()
}
async function drainSaveQueue(): Promise<void> {
  if (saveInFlight) return
  const job = saveQueue.shift()
  if (!job) {
    resolveQuiesce()
    return
  }
  saveInFlight = true
  try {
    const ok = await window.api.wsSave({
      relPath: job.relPath,
      title: job.title,
      icon: job.icon,
      body: job.body
    })
    if (!ok) throw new Error('save rejected')
    savedRev.set(job.relPath, job.rev)
    lastPersistedBody.set(job.relPath, job.body)
    // Refresh the cached copy so reopening this page stays a hit and shows the
    // title/icon the user just saved.
    const cached = pageCache.get(job.relPath)
    if (cached) pageCache.set(job.relPath, { ...cached, title: job.title, icon: job.icon, body: job.body })
    if (currentPage?.relPath === job.relPath) {
      if (!isPending(job.relPath)) {
        setSaveStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      }
      // Keep the sidebar row in sync with title/icon edits without re-reading
      // every file in the workspace (that is what made saving feel heavy).
      updateTreeLabel(job.relPath, job.title, job.icon)
    }
  } catch (err) {
    console.error('[meridiem] save failed:', err)
    if (currentPage?.relPath === job.relPath) {
      setSaveStatus('Save failed — retrying')
    }
    // Never drop the write: re-queue after a backoff (merges with newer edits).
    window.setTimeout(() => enqueueSave(job), 5000)
    saveInFlight = false
    return
  }
  saveInFlight = false
  void drainSaveQueue()
}

function setSaveStatus(text: string, kind: 'ok' | 'pending' | 'error' = 'ok'): void {
  saveStatusEl.textContent = text
  saveStatusEl.classList.toggle('ok', kind === 'ok')
  saveStatusEl.classList.toggle('pending', kind === 'pending')
  saveStatusEl.classList.toggle('error', kind === 'error')
  if (text) saveStatusEl.title = new Date().toLocaleTimeString() + ' — ' + text
}

/** Snapshot the current page and queue it. No-op unless there are unwritten edits. */
function persistNow(): void {
  if (!currentPage) return
  const rel = currentPage.relPath
  if (!isPending(rel)) return
  enqueueSave({
    relPath: rel,
    title: pageTitleEl.value.trim() || currentPage.title,
    icon: currentPage.icon,
    body: getActiveBody(),
    rev: editRev.get(rel) ?? nextRev()
  })
}

/** Queue pending edits now; resolves once the queue drains (fire-and-forget is fine). */
function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  persistNow()
  return whenSaveQuiescent()
}

function scheduleSave(): void {
  if (!currentPage) return
  editRev.set(currentPage.relPath, nextRev())
  setSaveStatus('Unsaved…', 'pending')
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    persistNow()
  }, SAVE_DEBOUNCE_MS)
}

// Which surface last produced the document: the file as loaded, the rich
// editor, or the plain-text editor. When nothing has been edited we save the
// ORIGINAL markdown bytes back, so merely viewing a note in rich mode can never
// rewrite/reformat it (that round trip is what merged break-only lines).
let docSource: 'loaded' | 'rich' | 'code' = 'loaded'
let loadedMarkdown = ''
let programmatic = false

function getActiveBody(): string {
  if (sourceMode || docSource === 'code') {
    const text = codeEditor.getContent()
    // Markdown needs a terminating newline: at EOF a trailing hard-break
    // backslash is read back as a literal character, which made break-heavy
    // notes change on every save/load. Same convention most editors use.
    return text.endsWith('\n') ? text : text + '\n'
  }
  if (docSource === 'rich') return richEditor.getMarkdown()
  return loadedMarkdown || richEditor.getMarkdown()
}

// Load markdown into both surfaces without marking either as the author.
function loadIntoEditors(markdown: string): void {
  programmatic = true
  try {
    // Fill only the surface(s) the user can actually see. The hidden editor is
    // written by applyViewMode when it becomes visible, so parsing both on
    // every open was pure waste.
    if (viewMode === 'split') {
      richEditor.setContent(markdown)
      codeEditor.setContent(markdown)
    } else if (viewMode === 'source') {
      codeEditor.setContent(markdown)
    } else {
      richEditor.setContent(markdown)
    }
  } finally {
    programmatic = false
  }
  loadedMarkdown = markdown
  docSource = 'loaded'
  lastSyncedMd = markdown
  refreshWordCount(true)
}

function flushSplitSave(): void {
  if (!splitDirty) return
  if (splitSaveTimer !== null) {
    window.clearTimeout(splitSaveTimer)
    splitSaveTimer = null
  }
  void saveSplitNow()
}

window.addEventListener('blur', () => {
  void persistNow()
  flushSplitSave()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void persistNow()
    flushSplitSave()
  }
})

// ---- editors ----
const richEditorEl = document.createElement('div')
richEditorEl.className = 'markdown-body rich-editor'
editorMount.appendChild(richEditorEl)

/** In the print host there is no open page — the one being printed supplies
 *  its own folder so relative images resolve (see initPrintHost). */
let printHostBaseDir: string | null = null

const pageOpts: MeridiemPageOpts = {
  getBaseDir: () =>
    printHostBaseDir ?? (currentPage ? currentPage.absolutePath.replace(/\/[^/]*$/, '') : null),
  resolvePage: async (name) => {
    const page = await window.api.wsResolveLink(name, currentPage?.dirRel ?? undefined)
    return page ? { title: page.title, icon: page.icon } : null
  },
  openPage: async (name) => {
    const page = await window.api.wsResolveLink(name, currentPage?.dirRel ?? undefined)
    if (page) await openPageByRel(page.relPath)
  },
  getPages: () => window.api.wsAllPages(),
  createPage: (name: string) => createPageNamed(name),
  // A new page/[[page]] chip just landed in the editor → save immediately so
  // the link can never be lost to the debounce (or a quick navigation).
  afterNewPageLink: () => window.setTimeout(flushSave, 60),
  openFileRef: (absolutePath: string) => void openFileRef(absolutePath)
}

// The link model moves pages on disk (unlinking exiles a page to bin/, a new
// link adopts it). Anything pointing at the old path has to follow, or the next
// save would recreate the page at its old location.
window.api.onPageMoved((moves) => {
  for (const move of moves) {
    // Follow the cached bytes to the new path so the next open is still a hit.
    const cached = pageCache.get(move.from)
    if (cached) {
      pageCache.delete(move.from)
      pageCache.set(move.to, {
        ...cached,
        relPath: move.to,
        absolutePath: cached.absolutePath.replace(move.from, move.to)
      })
    }
    for (const tab of tabs) {
      if (tab.relPath === move.from) tab.relPath = move.to
    }
    if (currentPage && currentPage.relPath === move.from) {
      currentPage = {
        ...currentPage,
        relPath: move.to,
        absolutePath: currentPage.absolutePath.replace(currentPage.relPath, move.to),
        dirRel: dirOf(move.to)
      }
    }
    const remembered = scrollMemory.get(move.from)
    if (remembered !== undefined) {
      scrollMemory.delete(move.from)
      scrollMemory.set(move.to, remembered)
    }
    const rememberedState = editorStateMemory.get(move.from)
    if (rememberedState) {
      editorStateMemory.delete(move.from)
      editorStateMemory.set(move.to, rememberedState)
    }
    const rememberedSelection = selectionMemory.get(move.from)
    if (rememberedSelection) {
      selectionMemory.delete(move.from)
      selectionMemory.set(move.to, rememberedSelection)
    }
    if (splitRel === move.from) splitRel = move.to
  }
  renderTabs()
  persistTabs()
  void refreshTree()
})

// The agent (or Finder) edits files on disk; refresh what the user sees.
window.api.onWsExternalChange((rel) => {
  dropCachedPage(rel)
  void (async () => {
    await refreshTree()
    // A quiz is neither a page nor a text file, so it needs its own branch —
    // without this an agent editing an open paper leaves a stale runner on
    // screen. Gated on the pane actually being up, so leaving it can't fire.
    if (!quizPaneEl.hidden && currentQuizRel !== null && rel === currentQuizRel) {
      const fresh = await window.api.wsRead(rel)
      if (fresh) {
        const body = fresh.body
        const doc = parseQz(body)
        if (doc.questions.length === 0) {
          // The paper stopped parsing (an edit in the middle of a block, an
          // external write that broke the file). Show the text rather than an
          // empty runner.
          await openTextFile(rel, { tab: false })
        } else {
          quizPane.render({
            relPath: fresh.relPath,
            title: fresh.title,
            icon: fresh.icon,
            body,
            doc,
            baseDir: fresh.absolutePath.replace(/\/[^/]*$/, '')
          })
        }
      }
      return
    }
    if (currentFile && rel === currentFile.relPath && !fileDirty) {
      const fresh = await window.api.readTextFile(currentFile.relPath)
      if (fresh && textEditor) {
        textEditor.setContent(fresh.content)
        setFileStatus('')
      }
      return
    }
    if (!currentPage) return
    if (rel !== currentPage.relPath) return
    // Preserve the user's own unsaved typing; otherwise reload from disk.
    if (isPending(currentPage.relPath)) {
      setSaveStatus('File changed on disk — save to overwrite')
      return
    }
    const fresh = await window.api.wsRead(currentPage.relPath)
    if (!fresh) return
    // The main process already filters out our own saves, so this is an agent /
    // external edit. When the body is unchanged (a rename, an icon tweak, or a
    // write with identical bytes) just sync the metadata — re-setting identical
    // content would push the caret to the end of the document.
    if (fresh.body === lastPersistedBody.get(currentPage.relPath)) {
      currentPage = { ...fresh, dirRel: dirOf(fresh.relPath) }
      pageIconEl.textContent = fresh.icon
      pageIconEl.classList.toggle('no-icon', !fresh.icon)
      pageTitleEl.value = fresh.title
      refreshActiveTabLabel(fresh.title, fresh.icon)
      persistTabs()
      return
    }
    currentPage = { ...fresh, dirRel: dirOf(fresh.relPath) }
    paintPageIcon(fresh.icon)
    pageTitleEl.value = fresh.title
    editorStateMemory.delete(currentPage.relPath)
    loadIntoEditors(fresh.body)
    setSaveStatus('')
  })()
})

const richEditor: RichEditor = createRichEditor(richEditorEl, '', () => {
  // A programmatic write (page load, mode switch, split sync) is not a user
  // edit — it must not mark the page dirty or kick off a save.
  if (programmatic) return
  docSource = 'rich'
  scheduleSave()
  scheduleSplitSync()
  schedulePrintPreview()
}, pageOpts)

const codeEditor: MarkdownEditor = createEditor(
  codeMount,
  '',
  resolveTheme('light').kind,
  () => {
    if (programmatic) return
    docSource = 'code'
    if (sourceMode || viewMode === 'split') scheduleSave()
    scheduleSplitSync()
  },
  // Source view counts the markdown it is showing, including its syntax. It is
  // the text on screen, so it is the honest thing to report. Split view shows
  // this pane too, and it is editable there, so it reports as well — whichever
  // surface the user last touched owns the number.
  (text, selected) => {
    if (viewMode !== 'rich') paintWordCount(text, selected)
  }
)
richEditorEl.addEventListener('focusin', flushSplitSync)
codeMount.addEventListener('focusin', flushSplitSync)

// ---- page open ----
function dirOf(relPath: string): string {
  if (relPath.endsWith('/index.md')) return relPath.slice(0, -'/index.md'.length)
  return relPath.includes('/') ? relPath.replace(/\/[^/]*$/, '') : ''
}

// Every async open bumps this; a slower load that finishes after a newer click
// would otherwise flash its stale content over the page the user just opened.
let loadSeq = 0

async function openPageByRel(relPath: string, opts: { tab?: boolean } = {}): Promise<void> {
  // Queue the current page's pending edits BEFORE switching. The snapshot is
  // captured synchronously here, so navigation never waits on the disk write
  // and can't drop a debounced edit.
  flushSave()
  const seq = ++loadSeq
  const page = await fetchPageEntry(relPath)
  if (!page || seq !== loadSeq) return
  const shownTitle = displayTitleFor(page.relPath, page.title)
  recordNav({ rel: page.relPath, kind: 'page', title: shownTitle })
  currentPage = { ...page, title: shownTitle, dirRel: dirOf(relPath) }
  // A freshly loaded page has no unwritten edits.
  editRev.delete(page.relPath)
  savedRev.delete(page.relPath)
  setSaveStatus('')
  releasePdfViewer()
  // This one used to leave an image pane on screen underneath the page that
  // replaced it, which is why the panes are now hidden in one place.
  showOnlyPane(pageViewEl)
  currentFile = null
  welcomeEl.hidden = true
  emptyStateEl.hidden = true
  pageLoaderEl.hidden = true
  paintPageIcon(page.icon)
  pageTitleEl.value = shownTitle
  markActiveInTree(page.relPath)
  updatePinButton()
  if (opts.tab !== false) upsertActiveTab({ relPath: page.relPath, kind: 'page', title: shownTitle, icon: page.icon })
  dismissFloats()
  schedulePrintPreview(200)
  lastPersistedBody.set(page.relPath, page.body)
  scheduleOutline(120)
  renderBreadcrumbs()
  toggleSourceBtn.textContent = 'Split'
  viewMode = 'rich'
  sourceMode = false
  codeMount.hidden = true
  editorMount.hidden = false
  ;(document.querySelector('.page-scroll') as HTMLElement).classList.remove('split-view')
  const rememberedState = editorStateMemory.get(page.relPath)
  if (rememberedState && viewMode === 'rich') {
    programmatic = true
    try {
      richEditor.setState(rememberedState.state)
    } catch {
      loadIntoEditors(rememberedState.markdown || page.body)
    } finally {
      programmatic = false
    }
    loadedMarkdown = rememberedState.markdown || page.body
    lastSyncedMd = loadedMarkdown
    docSource = loadedMarkdown === page.body ? 'loaded' : 'rich'
    refreshWordCount(true)
  } else {
    loadIntoEditors(page.body)
    const rememberedSelection = selectionMemory.get(page.relPath)
    if (rememberedSelection && viewMode === 'rich') {
      try {
        richEditor.setSelection(rememberedSelection)
      } catch {
        /* document shorter than the remembered caret */
      }
    }
  }
  window.scrollTo(0, 0)
}

// ---------------------------------------------------------------------------
// Notion-style tabs: several pages / PDFs / files open side by side, persisted
// per workspace. Clicking the sidebar replaces the active tab; ⌘-click or the
// "+" button opens another one.
// ---------------------------------------------------------------------------
interface TabInfo {
  relPath: string
  /** 'new' is a blank tab: it holds no file, only the landing page. Its
   *  relPath is a synthetic key (`__newtab__:…`) so the strip can still key
   *  tabs by path. */
  kind: 'page' | 'pdf' | 'image' | 'file' | 'binary' | 'quiz' | 'new' | 'view' | 'graph'
  title: string
  icon?: string
  /** Remembered scroll position of this tab's content. */
  scrollTop?: number
}

// Workspace-relative paths keep tabs deduplicating (a PDF opened from a page
// chip used to be stored as an absolute path, so clicking the same file in the
// tree produced a second, duplicate tab).
async function normalizeRel(p: string): Promise<string> {
  if (!p.startsWith('/')) return p
  const info = await window.api.wsGet()
  const root = info.workspace
  if (root && p.startsWith(root + '/')) return p.slice(root.length + 1)
  return p
}

let tabs: TabInfo[] = []
let activeTab = 0
/** What each workspace had open, so switching away and back lands where you
 *  left off instead of on the other workspace's page list. Session-only: the
 *  last workspace's tabs are still restored from settings on a cold start. */
const tabsByWorkspace = new Map<string, { tabs: TabInfo[]; activeTab: number }>()

// ---------------------------------------------------------------------------
// Browser-style navigation history (back / forward arrows in the toolbar).
// Every content load funnels through loadTabContent, so that is where entries
// are recorded; going back/forward replays an entry without recording it.
// ---------------------------------------------------------------------------
interface NavEntry {
  rel: string
  kind: string
  title: string
}

let navHistory: NavEntry[] = []
let navIndex = -1
let navReplaying = false
const NAV_LIMIT = 200

function updateNavButtons(): void {
  const back = document.getElementById('nav-back') as HTMLButtonElement | null
  const fwd = document.getElementById('nav-forward') as HTMLButtonElement | null
  if (back) back.disabled = navIndex <= 0
  if (fwd) fwd.disabled = navIndex >= navHistory.length - 1
}

function recordNav(entry: NavEntry): void {
  if (navReplaying) return
  const current = navHistory[navIndex]
  if (current && current.rel === entry.rel && current.kind === entry.kind) return
  // Navigating away from the middle of the history drops the forward entries,
  // exactly like a browser.
  navHistory = navHistory.slice(0, navIndex + 1)
  navHistory.push(entry)
  if (navHistory.length > NAV_LIMIT) navHistory.shift()
  navIndex = navHistory.length - 1
  updateNavButtons()
}

function replayNav(entry: NavEntry): void {
  navReplaying = true
  void openRel(entry.rel, entry.kind)
    .catch((err) => console.warn('history navigation failed', err))
    .finally(() => {
      navReplaying = false
      updateNavButtons()
    })
}

function goBack(): void {
  if (navIndex <= 0) return
  navIndex--
  recordNavFromIndex()
}

function goForward(): void {
  if (navIndex >= navHistory.length - 1) return
  navIndex++
  recordNavFromIndex()
}

function recordNavFromIndex(): void {
  const entry = navHistory[navIndex]
  updateNavButtons()
  if (entry) replayNav(entry)
}
const tabBarEl = document.getElementById('tab-bar') as HTMLElement

/** The tab strip's icon: the page's own emoji if the user set one, else line art. */
function tabIconName(tab: TabInfo): IconName {
  if (tab.kind === 'new') return 'home'
  if (tab.kind === 'graph') return 'network'
  if (tab.kind === 'view') {
    if (tab.relPath.endsWith(':inbox')) return 'tray'
    if (tab.relPath.endsWith(':tasks')) return 'check'
    if (tab.relPath.endsWith(':media')) return 'image'
    return 'table'
  }
  if (tab.kind === 'pdf') return 'doc'
  if (tab.kind === 'image') return 'image'
  if (tab.kind === 'file') return fileIconName(tab.relPath)
  if (tab.kind === 'binary') return 'doc'
  if (tab.kind === 'quiz') return 'quiz'
  if (/^Daily\//.test(tab.relPath) || /^Weekly\//.test(tab.relPath)) return 'calendar'
  return 'doc'
}

function paintTabIcon(el: HTMLElement, tab: TabInfo): void {
  applyIcon(el, tab.kind === 'new' ? null : tab.icon, tabIconName(tab), 13)
}

function persistTabs(): void {
  // Both keys describe one thing (the tab strip) — write them together so a
  // crash can't leave activeTab pointing outside openTabs.
  void window.api.setSettingsMany({ openTabs: tabs, activeTab })
}

/** Index of the tab a tab element currently represents (tab paths are unique). */
function tabIndexForEl(el: HTMLElement): number {
  return tabs.findIndex((t) => t.relPath === el.dataset.rel)
}

// Built once per element; every handler resolves its tab by relPath at event
// time so the listener survives reordering and reuse.
function makeTabEl(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tab'
  el.draggable = true
  const icon = document.createElement('span')
  icon.className = 'tab-icon'
  const label = document.createElement('span')
  label.className = 'tab-label'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tab-close'
  close.textContent = '✕'
  close.title = 'Close tab'
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    const i = tabIndexForEl(el)
    if (i >= 0) closeTab(i)
  })
  el.append(icon, label, close)
  el.addEventListener('click', () => {
    const i = tabIndexForEl(el)
    if (i < 0) return
    const tab = tabs[i]
    // In split view the tab strip belongs to the active pane: clicking a tab
    // puts it in the pane the user is working in.
    if (splitOpen && activePane === 'right' && tab.relPath !== tabs[activeTab]?.relPath) {
      void setSplitTarget(tab.relPath, tab.kind, tab.title)
      return
    }
    void activateTab(i)
  })
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault()
      const i = tabIndexForEl(el)
      if (i >= 0) closeTab(i)
    }
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const i = tabIndexForEl(el)
    if (i < 0) return
    const tab = tabs[i]
    // Workspace-view tabs have no file behind them; a file menu would offer
    // reveal/delete on a synthetic path.
    if (tab.kind === 'view' || tab.kind === 'graph') return
    void window.api.showItemMenu({ relPath: tab.relPath, kind: tab.kind, name: tab.title, isTab: true })
  })
  el.addEventListener('dragstart', (e) => {
    const i = tabIndexForEl(el)
    if (i >= 0) e.dataTransfer?.setData('text/yestion-tab', String(i))
  })
  el.addEventListener('dragover', (e) => e.preventDefault())
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    const from = Number(e.dataTransfer?.getData('text/yestion-tab') ?? '-1')
    const i = tabIndexForEl(el)
    if (from < 0 || i < 0 || from === i) return
    const [moved] = tabs.splice(from, 1)
    tabs.splice(i, 0, moved)
    activeTab = tabs.indexOf(moved)
    renderTabs()
    persistTabs()
  })
  return el
}

let tabAddEl: HTMLButtonElement | null = null

function renderTabs(): void {
  tabBarEl.hidden = tabs.length === 0
  renderOpenEditors()
  // Reconcile keyed by relPath: repainting on a click must not detach and
  // rebuild every tab node (and its six listeners) each time.
  const byRel = new Map<string, HTMLElement>()
  for (const child of Array.from(tabBarEl.children) as HTMLElement[]) {
    if (child.classList.contains('tab') && child.dataset.rel) byRel.set(child.dataset.rel, child)
  }
  const leftRel = tabs[activeTab]?.relPath
  const activeRel = splitOpen && activePane === 'right' ? splitRel : leftRel
  const otherRel = splitOpen ? (activePane === 'right' ? leftRel : splitRel) : null
  const seen = new Set<string>()
  for (const tab of tabs) {
    let el = byRel.get(tab.relPath)
    if (!el) {
      el = makeTabEl()
      el.dataset.rel = tab.relPath
    }
    seen.add(tab.relPath)
    el.className =
      'tab' +
      (tab.relPath === activeRel ? ' active' : '') +
      (otherRel && tab.relPath === otherRel ? ' in-split' : '')
    el.title = tab.relPath
    paintTabIcon(el.querySelector('.tab-icon') as HTMLElement, tab)
    ;(el.querySelector('.tab-label') as HTMLElement).textContent = tab.title
    tabBarEl.appendChild(el) // re-appending moves the node into place (order = tabs)
  }
  for (const [rel, el] of byRel) {
    if (!seen.has(rel)) el.remove()
  }
  if (tabs.length === 0) return
  if (!tabAddEl) {
    tabAddEl = document.createElement('button')
    tabAddEl.type = 'button'
    tabAddEl.className = 'tab-add'
    tabAddEl.textContent = '＋'
    tabAddEl.title = 'New tab (⌘T)'
    tabAddEl.addEventListener('click', () => void newTab())
  }
  tabBarEl.appendChild(tabAddEl)
}

function upsertActiveTab(info: TabInfo): void {
  if (tabs.length === 0) {
    tabs.push(info)
    activeTab = 0
  } else {
    // The slot is being repurposed for a different page: keep the scroll
    // memory only when it is the same page (a title/icon refresh).
    const prev = tabs[activeTab]
    tabs[activeTab] = prev && prev.relPath === info.relPath ? { ...info, scrollTop: prev.scrollTop } : info
  }
  renderTabs()
  persistTabs()
}

function tabIndexFor(relPath: string): number {
  return tabs.findIndex((t) => t.relPath === relPath)
}

// Which element scrolls depends on which pane is showing.
function captureActiveScroll(): number | undefined {
  if (!pageViewEl.hidden) {
    const el = pageViewEl.querySelector('.page-scroll') as HTMLElement | null
    return el?.scrollTop ?? 0
  }
  if (!pdfPaneEl.hidden) return pdfViewEl.scrollTop
  if (!imagePaneEl.hidden) return imageStageEl.scrollTop
  if (!textPaneEl.hidden) {
    const el = textMountEl.querySelector('.cm-scroller') as HTMLElement | null
    return el?.scrollTop ?? 0
  }
  if (!newTabPane.el.hidden) return newTabPane.scrollEl.scrollTop
  if (!modePaneEl.hidden) {
    const el = modePaneEl.querySelector('.mode-scroll') as HTMLElement | null
    return el?.scrollTop ?? 0
  }
  return undefined
}

function restoreActiveScroll(top: number | undefined): void {
  if (top === undefined || top <= 0) return
  if (!pageViewEl.hidden) {
    const el = pageViewEl.querySelector('.page-scroll') as HTMLElement | null
    if (el) el.scrollTop = top
  } else if (!pdfPaneEl.hidden) {
    pdfViewEl.scrollTop = top
  } else if (!imagePaneEl.hidden) {
    imageStageEl.scrollTop = top
  } else if (!textPaneEl.hidden) {
    const el = textMountEl.querySelector('.cm-scroller') as HTMLElement | null
    if (el) el.scrollTop = top
  } else if (!newTabPane.el.hidden) {
    newTabPane.scrollEl.scrollTop = top
  } else if (!modePaneEl.hidden) {
    const el = modePaneEl.querySelector('.mode-scroll') as HTMLElement | null
    if (el) el.scrollTop = top
  }
}

async function activateTab(i: number): Promise<void> {
  const tab = tabs[i]
  if (!tab) return
  // Remember where the tab we are leaving was scrolled to, before activeTab
  // moves on to the incoming one.
  if (i !== activeTab) {
    captureScrollForShownContent()
    captureSelectionForShownContent()
  }
  activeTab = i
  renderTabs()
  persistTabs()
  await loadTabContent(tab)
}

// Scroll positions per page/file, so switching tabs — or coming back to a page
// from the tree — lands where the user left off.
const scrollMemory = new Map<string, number>()
/** Caret/selection per page, restored after the document is swapped in place. */
const selectionMemory = new Map<string, { from: number; to: number }>()

function captureSelectionForShownContent(): void {
  if (pageViewEl.hidden || !currentPage || viewMode !== 'rich') return
  try {
    selectionMemory.set(currentPage.relPath, richEditor.getSelection())
    editorStateMemory.set(currentPage.relPath, {
      state: richEditor.getState(),
      markdown: getActiveBody()
    })
  } catch {
    /* editor not mounted yet */
  }
}

/** Whole ProseMirror state per tab: document, caret and undo history. */
const editorStateMemory = new Map<
  string,
  { state: ReturnType<RichEditor['getState']>; markdown: string }
>()

/** Rel path of whatever the visible pane is showing right now. */
function shownRelPath(): string | null {
  if (!pageViewEl.hidden) return currentPage?.relPath ?? null
  if (!pdfPaneEl.hidden) return currentPdfPath
  if (!imagePaneEl.hidden) return currentImagePath
  if (!textPaneEl.hidden) return currentFile?.relPath ?? null
  if (!newTabPane.el.hidden) return tabs[activeTab]?.relPath ?? null
  if (!modePaneEl.hidden) return tabs[activeTab]?.relPath ?? null
  return null
}

/** Park the scroll position of whatever is on screen. */
function captureScrollForShownContent(): void {
  const pos = captureActiveScroll()
  if (pos === undefined) return // nothing visible (boot, empty state)
  const rel = shownRelPath()
  if (!rel) return
  scrollMemory.set(rel, pos)
  const tab = tabs.find((t) => t.relPath === rel)
  if (tab) tab.scrollTop = pos
}

function scrollForTab(tab: TabInfo): number | undefined {
  return scrollMemory.get(tab.relPath) ?? tab.scrollTop
}

async function loadTabContent(tab: TabInfo): Promise<void> {
  // A tab restored from settings may carry a stale kind — older builds saved a
  // `.qz` as a page before the runner existed. Opening it as a page is the
  // destroy-the-file path, so the extension always wins.
  if (tab.kind !== 'quiz' && /\.qz$/i.test(tab.relPath)) tab.kind = 'quiz'
  // A blank tab is a destination of its own, not a stop in the history: back
  // should step over it rather than land on an empty page.
  if (tab.kind !== 'new') recordNav({ rel: tab.relPath, kind: tab.kind, title: tab.title })
  // Menus and pickers from the tab we're leaving don't belong over this one.
  dismissFloats()
  if (tab.kind !== 'view' && tab.kind !== 'graph') paintSidebarMode('notes')
  try {
    if (tab.kind === 'new') showNewTab()
    else if (tab.kind === 'view' || tab.kind === 'graph') await showModeForTab(tab)
    else if (tab.kind === 'pdf') await openPdf(tab.relPath, { tab: false })
    else if (tab.kind === 'image') await openImage(tab.relPath, { tab: false })
    else if (tab.kind === 'file' || tab.kind === 'binary') await openTextFile(tab.relPath, { tab: false })
    else if (tab.kind === 'quiz') await openQuiz(tab.relPath, { tab: false })
    else await openPageByRel(tab.relPath)
  } catch (err) {
    // A tab that can't be loaded must not wedge the app: report it and leave
    // the loader hidden rather than spinning forever.
    console.warn('tab load failed', tab.kind, err)
    pageLoaderEl.hidden = true
  }
  restoreActiveScroll(scrollForTab(tab))
}

/** Tabs closed this session, newest last, so ⌘⇧T can bring one back. */
const closedTabs: { tab: TabInfo; index: number }[] = []

function closeTab(i: number): void {
  if (i < 0 || i >= tabs.length) return
  if (i !== activeTab) {
    captureScrollForShownContent()
    captureSelectionForShownContent()
  }
  const [removed] = tabs.splice(i, 1)
  if (removed) {
    closedTabs.push({ tab: { ...removed }, index: i })
    if (closedTabs.length > 40) closedTabs.shift()
  }
  if (tabs.length === 0) {
    activeTab = 0
    renderTabs()
    persistTabs()
    void showNothingOpen()
    return
  }
  if (activeTab >= tabs.length) activeTab = tabs.length - 1
  else if (i < activeTab) activeTab--
  renderTabs()
  persistTabs()
  void activateTab(activeTab)
}

/** ⌘⇧T: restore the most recently closed tab at the slot it left. */
async function reopenClosedTab(): Promise<void> {
  const last = closedTabs.pop()
  if (!last) {
    notify('No recently closed tab')
    return
  }
  const tab = last.tab
  // A blank tab's synthetic key would collide with its earlier self.
  if (tab.kind === 'new') tab.relPath = blankTabRel()
  captureScrollForShownContent()
  const at = Math.max(0, Math.min(last.index, tabs.length))
  tabs.splice(at, 0, tab)
  activeTab = at
  renderTabs()
  persistTabs()
  await loadTabContent(tab)
}

/** Ctrl+Tab / Ctrl+Shift+Tab and ⌘⇧[ / ⌘⇧]: walk the strip cyclically. */
async function cycleTab(delta: number): Promise<void> {
  if (tabs.length < 2) return
  const next = (activeTab + delta + tabs.length) % tabs.length
  await activateTab(next)
}

/** Closing the last tab. In a workspace with pages that means a blank tab —
 *  the "No pages yet" screen is a first-run explanation of what a workspace
 *  is, and it is the wrong thing to say to someone who just closed a page. */
async function showNothingOpen(): Promise<void> {
  try {
    const pages = await window.api.wsAllPages()
    if (pages.length > 0) {
      // No tab is open, so Home is not a tab: it is the whole window. The next
      // click on a recent item or a quick action opens a real tab.
      showNewTab()
      paintSidebarMode('notes')
      return
    }
  } catch {
    /* fall through to the empty state */
  }
  showNoTabs()
}

function showNoTabs(): void {
  currentPage = null
  currentFile = null
  currentImagePath = null
  currentPdfPath = null
  currentQuizRel = null
  pdfHandle?.destroy()
  pdfHandle = null
  showOnlyPane(null)
  welcomeEl.hidden = true
  pageLoaderEl.hidden = true
  emptyStateEl.hidden = false
  breadcrumbsEl.innerHTML = ''
  paintSidebarMode('notes')
}

// Open a page/PDF/file, reusing an existing tab unless asked for a new one.
async function openRel(relIn: string, kind: string, asNewTab = false): Promise<void> {
  if (kind === 'new') {
    await newTab()
    return
  }
  if (kind === 'view' || kind === 'graph') {
    const mode = relIn.replace(/^__mode__:/, '') as WorkspaceModeId
    if (mode in MODE_TITLES) {
      await openModeTab(mode)
      return
    }
  }
  const rel = await normalizeRel(relIn)
  // A `.qz` is always a quiz, whatever route got here (a first-page boot, a
  // restored tab saved by an older build, a link). Loading one as a page puts
  // its tags in the page editor, and one keystroke rewrites the file.
  if (/\.qz$/i.test(rel)) kind = 'quiz'
  const existing = tabIndexFor(rel)
  if (existing >= 0 && !asNewTab) {
    if (existing !== activeTab) captureScrollForShownContent()
    activeTab = existing
    renderTabs()
    persistTabs()
    await loadTabContent(tabs[existing])
    return
  }
  const displayKind = (kind === 'binary' ? 'binary' : kind) as TabInfo['kind']
  const info: TabInfo = { relPath: rel, kind: displayKind, title: rel.split('/').filter(Boolean).pop() ?? rel }
  if (kind === 'page' || kind === 'quiz') {
    const page = await window.api.wsRead(rel)
    if (page) {
      info.title = page.title
      info.icon = page.icon
    }
  }
  if (asNewTab) {
    captureScrollForShownContent()
    tabs.push(info)
    activeTab = tabs.length - 1
    renderTabs()
    persistTabs()
  } else {
    upsertActiveTab(info)
  }
  noteRecent({ relPath: info.relPath, kind: info.kind, title: info.title, icon: info.icon })
  await loadTabContent(info)
}

// The page title/icon change → keep the tab label in sync.
function refreshActiveTabLabel(title: string, icon: string): void {
  const tab = tabs[activeTab]
  if (!tab) return
  tab.title = title
  tab.icon = icon
  renderTabs()
  persistTabs()
}

/** Rebuild the tab strip from `remembered` (a workspace we've already visited
 *  this session) or from the last persisted set. Returns true when at least one
 *  tab survived; the caller opens a page to fall back to otherwise. */
async function restoreTabs(remembered?: { tabs: TabInfo[]; activeTab: number }): Promise<boolean> {
  const saved = remembered?.tabs ?? ((await window.api.getSettings('openTabs')) as TabInfo[] | undefined) ?? []
  const savedActive = remembered?.activeTab ?? ((await window.api.getSettings('activeTab')) as number | undefined) ?? 0
  const info = await window.api.wsGet()
  if (!info.workspace || saved.length === 0) {
    tabs = []
    activeTab = 0
    renderTabs()
    return false
  }
  const candidates = saved.filter((t) => t && typeof t.relPath === 'string')
  // Drop tabs whose file disappeared while the app was closed, so a stale
  // entry can't strand the window on an empty view.
  tabs = []
  let keptBlank = false
  for (const t of candidates) {
    // A blank tab has no file to check on. Keep at most one (its synthetic
    // path is rewritten so two sessions can't collide on the same key), and
    // skip the file probe entirely.
    if (t.kind === 'new') {
      if (keptBlank) continue
      keptBlank = true
      tabs.push({ relPath: blankTabRel(), kind: 'new', title: 'Home' })
      continue
    }
    // Workspace-view tabs have no file behind them; their synthetic path is
    // the destination. Keep at most one of each.
    if (t.kind === 'view' || t.kind === 'graph') {
      if (tabs.some((x) => x.relPath === t.relPath)) continue
      tabs.push(t)
      continue
    }
    try {
      const kind = await window.api.fileKind(t.relPath)
      if (t.kind === 'page') {
        const page = await window.api.wsRead(t.relPath)
        if (page) tabs.push(t)
        continue
      }
      if (!kind) continue
      tabs.push({ ...t, kind: kind === 'image' ? 'image' : t.kind })
    } catch {
      /* skip unreadable tab */
    }
  }
  if (tabs.length === 0) {
    activeTab = 0
    renderTabs()
    return false
  }
  activeTab = Math.max(0, Math.min(savedActive, tabs.length - 1))
  renderTabs()
  await loadTabContent(tabs[activeTab])
  return true
}

// ---- blank tabs and the landing page they show ----
// A synthetic path keeps the strip's relPath keys unique; the counter keeps
// two blank tabs created in the same millisecond apart.
let blankTabSeq = 0
function blankTabRel(): string {
  return `__newtab__:${Date.now().toString(36)}-${++blankTabSeq}`
}

/** Recently opened pages and files, newest first — what the landing page
 *  offers under "Recent". Stored with the workspace it describes: the paths in
 *  it only mean something inside one workspace. */
let recentItems: NewTabItem[] = []
const RECENT_LIMIT = 8
function noteRecent(item: NewTabItem): void {
  if (item.kind === 'new' || item.kind === 'binary') return
  recentItems = [item, ...recentItems.filter((r) => r.relPath !== item.relPath)].slice(0, RECENT_LIMIT)
  void window.api.setSettings('recentPages', { root: cacheWorkspacePath, items: recentItems })
}

const newTabPane = createNewTabPane({
  allPages: () => window.api.wsAllPages(),
  recent: () => recentItems,
  open: (item) => void openRel(item.relPath, item.kind),
  createPage: () => void createNewPage('__root__'),
  openDaily: () => void openDaily(todayKey()),
  openFile: () => {
    void (async () => {
      const picked = await window.api.filePick('Open a file')
      if (picked) await openFileRef(picked.path)
    })()
  },
  openWorkspace: () => {
    void (async () => {
      const res = await window.api.wsOpenWorkspace()
      if (res.ok) await initWorkspace()
    })()
  },
  searchWorkspace: () => openSearch()
})

const quizPane = createQuizPane()

/** The .qz currently in the runner, or null. Derived state would be better,
 *  but the external-change handler needs it before the pane is re-rendered. */
let currentQuizRel: string | null = null

/**
 * Hide every content surface, then reveal the one that should be on screen.
 *
 * This used to be spelled out by hand at nine call sites, and the file carries
 * the scar: the comment in `openPageByRel` records a page being painted over a
 * leftover image pane. Adding a tenth pane to nine hand-written blocks leaves
 * nine places to forget it, so the panes live in one list.
 *
 * `newTabPane` is a controller rather than an element. The welcome, empty,
 * loader and locked surfaces are deliberately NOT handled here — they are not
 * content panes and each call site wants different things from them.
 */
function showOnlyPane(el: HTMLElement | null): void {
  pageViewEl.hidden = true
  pdfPaneEl.hidden = true
  imagePaneEl.hidden = true
  textPaneEl.hidden = true
  quizPaneEl.hidden = true
  modePaneEl.hidden = true
  newTabPane.hide()
  if (el) el.hidden = false
}

function showNewTab(): void {
  // The page we are leaving may have edits still queued; snapshot them before
  // the editor is swapped out from under the save queue.
  flushSave()
  currentPage = null
  currentFile = null
  currentImagePath = null
  currentPdfPath = null
  currentQuizRel = null
  releasePdfViewer()
  showOnlyPane(null)
  welcomeEl.hidden = true
  emptyStateEl.hidden = true
  pageLoaderEl.hidden = true
  breadcrumbsEl.innerHTML = ''
  markActiveInTree(null)
  updatePinButton()
  newTabPane.show()
}

/** ⌘T / the strip's "＋": a real empty tab, not a popover over the page you
 *  were reading. Going back to an existing blank tab beats stacking another. */
async function newTab(): Promise<void> {
  const existing = tabs.findIndex((t) => t.kind === 'new')
  if (existing >= 0) {
    await activateTab(existing)
    newTabPane.focusSearch()
    return
  }
  captureScrollForShownContent()
  const tab: TabInfo = { relPath: blankTabRel(), kind: 'new', title: 'Home' }
  tabs.push(tab)
  activeTab = tabs.length - 1
  renderTabs()
  persistTabs()
  await loadTabContent(tab)
  newTabPane.focusSearch()
}

// ---- built-in plaintext viewer for non-page files (.txt, .py, .dxf, …) ----
const textPaneEl = document.getElementById('text-pane') as HTMLElement
const textMountEl = document.getElementById('text-mount') as HTMLElement
const textNameEl = document.getElementById('text-name') as HTMLElement
const textIconEl = document.getElementById('text-icon') as HTMLElement
const textStatusEl = document.getElementById('text-status') as HTMLElement
let currentFile: { relPath: string; absolutePath: string } | null = null
let currentPdfPath: string | null = null
let textEditor: MarkdownEditor | null = null
let fileSaveTimer: number | null = null
let fileDirty = false

function setFileStatus(text: string, kind: 'ok' | 'pending' | 'error' = 'ok'): void {
  textStatusEl.textContent = text
  textStatusEl.classList.toggle('ok', kind === 'ok')
  textStatusEl.classList.toggle('pending', kind === 'pending')
  textStatusEl.classList.toggle('error', kind === 'error')
}

function fileIconName(relPath: string): IconName {
  const ext = (relPath.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['py', 'js', 'ts', 'tsx', 'jsx', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'lua', 'php', 'sql'].includes(ext)) return 'code'
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'csv', 'tsv'].includes(ext)) return 'table'
  if (['dxf', 'dwg', 'stl', 'obj'].includes(ext)) return 'ruler'
  return 'doc'
}

async function flushTextFile(): Promise<void> {
  if (!currentFile || !textEditor || !fileDirty) return
  if (fileSaveTimer !== null) {
    window.clearTimeout(fileSaveTimer)
    fileSaveTimer = null
  }
  const rel = currentFile.relPath
  const ok = await window.api.writeTextFile(rel, textEditor.getContent())
  if (currentFile?.relPath !== rel) return
  fileDirty = false
  setFileStatus(
    ok ? 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Save failed',
    ok ? 'ok' : 'error'
  )
}

async function openTextFile(pathOrRel: string, opts: { tab?: boolean } = {}): Promise<void> {
  recordNav({ rel: pathOrRel, kind: 'file', title: pathOrRel })
  if (fileDirty) await flushTextFile()
  const seq = ++loadSeq
  const res = await window.api.readTextFile(pathOrRel)
  if (!res || seq !== loadSeq) return
  const pathOrRel2 = pathOrRel
  currentPage = null
  releasePdfViewer()
  currentFile = { relPath: pathOrRel2, absolutePath: res.absolutePath }
  showOnlyPane(textPaneEl)
  emptyStateEl.hidden = true
  welcomeEl.hidden = true
  pageLoaderEl.hidden = true
  const name = pathOrRel.split('/').pop() ?? pathOrRel
  textNameEl.textContent = name
  textNameEl.title = res.absolutePath
  textIconEl.replaceChildren(iconEl(fileIconName(pathOrRel), 15))
  if (!textEditor) {
    textEditor = createEditor(textMountEl, '', resolveTheme(themeId).kind, () => {
      fileDirty = true
      setFileStatus('Unsaved…', 'pending')
      if (fileSaveTimer !== null) window.clearTimeout(fileSaveTimer)
      fileSaveTimer = window.setTimeout(() => void flushTextFile(), 1200)
    })
  } else {
    textEditor.setTheme(resolveTheme(themeId).kind)
  }
  textEditor.setContent(res.content)
  fileDirty = false
  setFileStatus('')
  breadcrumbsEl.innerHTML = ''
  const crumb = document.createElement('span')
  crumb.className = 'crumb'
  crumb.textContent = name
  breadcrumbsEl.appendChild(crumb)
  markActiveInTree(pathOrRel)
  if (opts.tab !== false) upsertActiveTab({ relPath: pathOrRel, kind: 'file', title: name })
}

/**
 * Open a `.qz` paper in the runner.
 *
 * The one thing this must never do is hand the file to the page editor. A `.qz`
 * that reaches `loadTabContent`'s default arm opens as a *page*, and the first
 * keystroke writes it back through `serializePageFile` as front matter plus a
 * markdown body — the question blocks are destroyed, not merely mis-rendered.
 * So `openQuiz` is dispatched explicitly and fails safe: a file that parses to
 * no questions at all opens as plain text instead of as an empty runner.
 */
async function openQuiz(relPath: string, opts: { tab?: boolean } = {}): Promise<void> {
  // Callers hand us either form — the tree passes a relPath, an in-page file
  // chip passes an absolute one.
  const rel = await normalizeRel(relPath)
  recordNav({ rel, kind: 'quiz', title: rel })
  if (fileDirty) await flushTextFile()
  flushSave()
  const seq = ++loadSeq
  const page = await window.api.wsRead(rel)
  if (seq !== loadSeq) return
  if (!page) {
    pageLoaderEl.hidden = true
    return
  }
  const doc = parseQz(page.body)
  if (doc.questions.length === 0) {
    // Failing safe costs a worse view; failing open costs the paper.
    await openTextFile(rel, { tab: opts.tab })
    return
  }

  currentPage = null
  currentFile = null
  currentImagePath = null
  currentPdfPath = null
  releasePdfViewer()
  showOnlyPane(quizPaneEl)
  emptyStateEl.hidden = true
  welcomeEl.hidden = true
  pageLoaderEl.hidden = true
  breadcrumbsEl.innerHTML = ''
  const crumb = document.createElement('span')
  crumb.className = 'crumb'
  crumb.append(iconEl('quiz', 14), document.createTextNode(page.title))
  breadcrumbsEl.appendChild(crumb)
  currentQuizRel = page.relPath
  quizPane.render({
    relPath: page.relPath,
    title: page.title,
    icon: page.icon,
    body: page.body,
    doc,
    baseDir: page.absolutePath.replace(/\/[^/]*$/, '')
  })
  markActiveInTree(page.relPath)
  if (opts.tab !== false) {
    upsertActiveTab({ relPath: page.relPath, kind: 'quiz', title: page.title, icon: page.icon })
  }
}

// Any in-page file reference (📎 chips, [text](file.pdf) links) opens in the
// built-in viewers when the file lives in the workspace.
async function openFileRef(absolutePath: string): Promise<void> {
  // A .qz is text to `fileKind`, so it has to be caught by extension or it
  // lands in the plaintext viewer — the one place a paper could be edited into
  // a page.
  if (/\.qz$/i.test(absolutePath)) return openQuiz(absolutePath)
  // Workspace-relative or absolute — both open in the built-in viewers; only
  // genuinely binary files go to the system app.
  const kind = await window.api.fileKind(absolutePath)
  if (kind === 'pdf') await openPdf(absolutePath)
  else if (kind === 'image') await openImage(absolutePath)
  else if (kind === 'text') await openTextFile(absolutePath)
  else await window.api.openPath(absolutePath)
}

async function openBinaryFile(relPath: string): Promise<void> {
  const info = await window.api.wsGet()
  if (!info.workspace) return
  const abs = relPath.startsWith('/') ? relPath : info.workspace + '/' + relPath
  const kind = await window.api.fileKind(abs)
  if (kind === 'image') return openImage(abs)
  if (kind === 'pdf') return openPdf(abs)
  if (kind === 'text') return openTextFile(abs)
  await window.api.openPath(abs)
}

let pdfHandle: PdfViewerHandle | null = null

// Tear the pdf.js document down (canvas memory is significant) whenever we
// leave the PDF pane; it's recreated on the next open.
function releasePdfViewer(): void {
  if (!pdfHandle) {
    pdfViewEl.innerHTML = ''
    return
  }
  try {
    pdfHandle.destroy()
  } catch {
    /* already gone */
  }
  pdfHandle = null
  pdfViewEl.innerHTML = ''
}

async function openPdf(pathOrRel: string, opts: { tab?: boolean } = {}): Promise<void> {
  recordNav({ rel: pathOrRel, kind: 'pdf', title: pathOrRel })
  if (fileDirty) await flushTextFile()
  flushSave()
  const seq = ++loadSeq
  const info = await window.api.wsGet()
  if (seq !== loadSeq) return
  const abs = pathOrRel.startsWith('/')
    ? pathOrRel
    : info.workspace
      ? info.workspace + '/' + pathOrRel
      : pathOrRel
  const name = pathOrRel.split('/').pop() ?? pathOrRel
  const pdfNameEl = document.getElementById('pdf-name')
  if (pdfNameEl) {
    pdfNameEl.textContent = name
    pdfNameEl.title = abs
  }
  currentPdfPath = abs
  currentImagePath = null
  if (opts.tab !== false) {
    const rel = await normalizeRel(pathOrRel)
    upsertActiveTab({ relPath: rel, kind: 'pdf', title: name })
  }
  currentPage = null
  currentFile = null
  showOnlyPane(pdfPaneEl)
  emptyStateEl.hidden = true
  breadcrumbsEl.innerHTML = ''
  const crumb = document.createElement('span')
  crumb.className = 'crumb'
  crumb.append(iconEl('doc', 14), document.createTextNode(name))
  breadcrumbsEl.appendChild(crumb)

  pdfHandle?.destroy()
  pdfHandle = null
  pdfViewEl.scrollTop = 0
  pdfViewEl.innerHTML = '<div class="pdf-loading">Loading PDF…</div>'
  const bytes = await window.api.readBytes(abs)
  if (!bytes || bytes.byteLength === 0) {
    pdfViewEl.innerHTML = '<div class="pdf-loading">Could not read this PDF.</div>'
    return
  }
  try {
    const handle = await createPdfViewer({
      container: pdfViewEl,
      bytes,
      onState: (s) => {
        const label = document.getElementById('pdf-zoom-label')
        if (label) label.textContent = Math.round(s.scale * 100) + '%'
        const pages = document.getElementById('pdf-pages')
        if (pages) pages.textContent = s.pages > 1 ? 'page ' + s.page + ' / ' + s.pages : '1 page'
      }
    })
    pdfHandle = handle
    pdfViewEl.scrollTop = 0
  } catch (err) {
    pdfViewEl.innerHTML =
      '<div class="pdf-loading">Could not display this PDF.<br><span class="muted">' +
      String(err instanceof Error ? err.message : err).slice(0, 200) +
      '</span></div>'
  }
}

// ---------------------------------------------------------------------------
// In-app image viewer: any png/jpg/gif/webp/svg in the workspace (or referenced
// from a page) opens here instead of being handed to Preview.
// ---------------------------------------------------------------------------
let currentImagePath: string | null = null
let imageZoom = 1
let imageNatural = { w: 0, h: 0 }

function applyImageZoom(): void {
  imageViewEl.style.width = Math.round(imageNatural.w * imageZoom) + 'px'
  const label = document.getElementById('image-zoom-label')
  if (label) label.textContent = Math.round(imageZoom * 100) + '%'
}

function fitImage(): void {
  if (!imageNatural.w) return
  const avail = Math.max(120, imageStageEl.clientWidth - 48)
  imageZoom = Math.min(1, avail / imageNatural.w)
  applyImageZoom()
}

async function openImage(pathOrRel: string, opts: { tab?: boolean } = {}): Promise<void> {
  recordNav({ rel: pathOrRel, kind: 'image', title: pathOrRel })
  if (fileDirty) await flushTextFile()
  flushSave()
  const seq = ++loadSeq
  const info = await window.api.wsGet()
  const abs = pathOrRel.startsWith('/')
    ? pathOrRel
    : info.workspace
      ? info.workspace + '/' + pathOrRel
      : pathOrRel
  const res = await window.api.readImage(abs)
  if (seq !== loadSeq) return
  if (!res) {
    await window.api.openPath(abs)
    return
  }
  const name = res.name
  currentImagePath = abs
  currentPdfPath = null
  if (opts.tab !== false) {
    const rel = await normalizeRel(pathOrRel)
    upsertActiveTab({ relPath: rel, kind: 'image', title: name })
  }
  currentPage = null
  currentFile = null
  releasePdfViewer()
  showOnlyPane(imagePaneEl)
  emptyStateEl.hidden = true
  const nameEl = document.getElementById('image-name')
  if (nameEl) {
    nameEl.textContent = name
    nameEl.title = abs
  }
  breadcrumbsEl.innerHTML = ''
  const crumb = document.createElement('span')
  crumb.className = 'crumb'
  crumb.append(iconEl('image', 14), document.createTextNode(name))
  breadcrumbsEl.appendChild(crumb)
  imageViewEl.src = 'data:' + res.mimeType + ';base64,' + res.data
  await new Promise<void>((resolve) => {
    if (imageViewEl.complete && imageViewEl.naturalWidth > 0) return resolve()
    imageViewEl.onload = () => resolve()
    imageViewEl.onerror = () => resolve()
    window.setTimeout(resolve, 4000)
  })
  imageNatural = { w: imageViewEl.naturalWidth || 800, h: imageViewEl.naturalHeight || 600 }
  fitImage()
  imageStageEl.scrollTo({ top: 0, left: 0 })
}

function toggleSource(): void {
  if (!currentPage) return
  viewMode = viewMode === 'rich' ? 'split' : viewMode === 'split' ? 'source' : 'rich'
  applyViewMode()
}

function applyViewMode(): void {
  const split = viewMode === 'split'
  const source = viewMode === 'source'
  // Capture the live document from whichever surface the user was editing
  // BEFORE flipping modes. (Switching used to sync the wrong direction, so
  // edits made in the plain-text pane were silently reverted by the rich
  // editor's copy when you switched back.)
  const body = getActiveBody()
  sourceMode = source
  editorMount.hidden = source
  codeMount.hidden = !split && !source
  ;(document.querySelector('.page-scroll') as HTMLElement).classList.toggle('split-view', split)
  toggleSourceBtn.textContent = viewMode === 'rich' ? 'Split' : viewMode === 'split' ? 'Source' : 'Rich text'
  programmatic = true
  try {
    if (split) {
      // Both surfaces get the same document, then stay live-synced.
      richEditor.setContent(body)
      codeEditor.setContent(body)
    } else if (source) {
      codeEditor.setContent(body)
    } else {
      richEditor.setContent(body)
    }
  } finally {
    programmatic = false
  }
  // Both panes now hold `body`; record that so the focus-triggered sync below
  // is a no-op instead of pushing one pane over the other.
  const changed = body !== lastSyncedMd
  lastSyncedMd = body
  if (split) {
    codeEditor.view.focus()
  } else if (source) {
    codeEditor.view.focus()
  } else {
    richEditor.focus()
  }
  // The count follows the surface being looked at: source view counts the
  // markdown, rich view counts what will be read.
  refreshWordCount()
  // Merely switching modes must never dirty the page — only a body that differs
  // from what is on disk does.
  if (changed) scheduleSave()
}

// ---- split view live sync ----
let viewMode: 'rich' | 'split' | 'source' = 'rich'
let splitBusy = false
let splitTimer: number | null = null
// Markdown currently reflected in BOTH panes, and the pane that last produced
// the document. Together these stop a stale timer from overwriting a fresh edit
// with the other pane's older copy.
let lastSyncedMd: string | null = null
let composing = false
for (const el of [richEditorEl, codeMount]) {
  el.addEventListener('compositionstart', () => { composing = true })
  el.addEventListener('compositionend', () => { composing = false })
}

function scheduleSplitSync(): void {
  if (viewMode !== 'split' || splitBusy) return
  if (splitTimer !== null) window.clearTimeout(splitTimer)
  splitTimer = window.setTimeout(runSplitSync, 150)
}

/** Sync now (used when focus moves panes) instead of waiting for the timer. */
function flushSplitSync(): void {
  if (viewMode !== 'split') return
  if (splitTimer !== null) {
    window.clearTimeout(splitTimer)
    splitTimer = null
  }
  runSplitSync()
}

function runSplitSync(): void {
  splitTimer = null
  if (viewMode !== 'split' || splitBusy) return
  // Never disturb an in-progress IME composition.
  if (composing) return
  // Direction comes from whatever produced the current document — not from
  // which pane was focused last. Clicking the other pane must not punish the
  // text the user just typed.
  const from = docSource
  if (from !== 'rich' && from !== 'code') return
  splitBusy = true
  programmatic = true
  try {
    const md = from === 'rich' ? richEditor.getMarkdown() : codeEditor.getContent()
    if (md === lastSyncedMd) return
    lastSyncedMd = md
    if (from === 'rich') codeEditor.setContent(md)
    else richEditor.setContent(md)
  } finally {
    programmatic = false
    splitBusy = false
  }
}

// ---- sidebar ----
let lastRoot: SidebarNodeLike | null = null

interface SidebarNodeLike {
  name: string
  relPath: string
  dirRel?: string
  // Must cover every kind the main process can emit (see workspace.ts) —
  // 'image' was missing here and in the preload type.
  kind: 'page' | 'folder' | 'pdf' | 'image' | 'file' | 'binary' | 'quiz'
  title?: string
  icon?: string
  children?: SidebarNodeLike[]
}

function findNodeByDirRel(node: SidebarNodeLike, dirRel: string): SidebarNodeLike | null {
  if ((node.dirRel ?? '') === dirRel && (node.kind === 'page' || node.kind === 'folder')) return node
  for (const c of node.children ?? []) {
    const found = findNodeByDirRel(c, dirRel)
    if (found) return found
  }
  return null
}

function findNodeByRel(node: SidebarNodeLike, relPath: string): SidebarNodeLike | null {
  if (node.relPath === relPath) return node
  for (const c of node.children ?? []) {
    const found = findNodeByRel(c, relPath)
    if (found) return found
  }
  return null
}

function findParentOf(node: SidebarNodeLike, target: SidebarNodeLike): SidebarNodeLike | null {
  for (const c of node.children ?? []) {
    if (c === target || c.relPath === target.relPath) return node
    const found = findParentOf(c, target)
    if (found) return found
  }
  return null
}

// Opening a page or saving its content must not re-read every file in the
// workspace and rebuild the whole tree. These helpers touch only the rows that
// actually changed: the active highlight, and one page's label/icon.
function treeRow(rel: string): HTMLElement | null {
  const nav = document.getElementById('page-tree')
  if (!nav) return null
  return nav.querySelector<HTMLElement>(`.tree-item[data-rel="${CSS.escape(rel)}"]`)
}
function markActiveInTree(rel: string | null): void {
  const nav = document.getElementById('page-tree') as HTMLElement | null
  if (!nav) return
  if (rel) nav.dataset.currentRel = rel
  for (const row of nav.querySelectorAll<HTMLElement>('.tree-item.active')) {
    row.classList.remove('active')
  }
  if (!rel) return
  treeRow(rel)?.classList.add('active')
}
function updateTreeLabel(rel: string, title: string, icon: string): void {
  const row = treeRow(rel)
  if (!row) return
  const label = row.querySelector<HTMLElement>('.tree-label')
  if (label) label.textContent = title
  const iconEl = row.querySelector<HTMLElement>('.tree-icon')
  if (iconEl) iconEl.textContent = icon || ''
}

async function refreshTree(): Promise<void> {
  const tree = await window.api.wsTree()
  lastRoot = tree
  setupSidebar(tree, {
    currentRel: currentPage?.relPath ?? null,
    notesOnly: true,
    onOpen: (rel, kind, newTab) => {
      // With the second pane active, navigation lands there (that is the page
      // the user is working on).
      if (splitOpen && activePane === 'right' && !newTab) {
        void setSplitTarget(rel, kind)
        return
      }
      // openRel is the canonical router: it dedupes tabs, honours ⌘-click, and
      // dispatches each kind (page / pdf / image / file) to the right viewer.
      if (kind === 'binary') void openBinaryFile(rel)
      else void openRel(rel, kind, newTab === true)
    }
  })
  refreshDailySurfaces()
  if (sidebarMode === 'templates') void renderTemplates()
  if (sidebarMode === 'views') renderViewsList()
}

// ---- daily notes & the sidebar mini-calendar ----
let calendarHandle: CalendarHandle | null = null
let dailyNotes: DailyNote[] = []

/** Repaint the calendar and the pinned list from the current workspace. */
function refreshDailySurfaces(): void {
  dailyNotes = collectDailyNotes(lastRoot)
  refreshPinned()
  if (!calendarHandle) {
    const mount = document.getElementById('mini-calendar')
    if (mount) {
      calendarHandle = setupCalendar(mount, {
        onPick: (date) => void openDaily(date),
        onToday: () => void openDaily(todayKey()),
        onWeek: (key) => void openWeekly(key),
        noteDates: () => new Set(dailyNotes.map((n) => n.date))
      })
    }
  } else {
    calendarHandle.refresh()
  }
}

/** Open `Daily/YYYY-MM-DD.md`, creating it if it does not exist yet.
 *
 * The tab is shown first — from cache or an empty sheet — and the file write
 * plus the tree scan happen behind it. The old order (create → rescan the whole
 * workspace → open) was the flash on every calendar click.
 */
async function openDaily(date: string): Promise<void> {
  if (!workspaceRootCache) return
  const rel = `Daily/${date}.md`
  const existing = tabIndexFor(rel)
  if (existing >= 0) {
    await activateTab(existing)
    return
  }
  const known = dailyNotes.some((n) => n.relPath === rel) || pageCache.has(rel)
  if (!known && workspaceRootCache) {
    // A placeholder keeps openRel synchronous-feeling; the real bytes replace it
    // as soon as the main process has written the file.
    cachePage({
      relPath: rel,
      absolutePath: `${workspaceRootCache}/${rel}`,
      title: dailyTitle(date),
      icon: '',
      body: ''
    })
  }
  void (async () => {
    const created = await window.api.wsDaily(date)
    if (!created) return
    created.title = dailyTitle(date)
    cachePage(created)
    if (currentPage?.relPath === rel && !isPending(rel)) {
      currentPage = { ...created, dirRel: dirOf(rel) }
      pageTitleEl.value = created.title
      refreshActiveTabLabel(created.title, created.icon)
      if (created.body) loadIntoEditors(created.body)
    }
    // Kept off the click's critical path: the calendar only needs the tab.
    void refreshTree()
  })()
  await openRel(rel, 'page')
  refreshActiveTabLabel(dailyTitle(date), '')
  renderBreadcrumbs()
}

async function openWeekly(key: string): Promise<void> {
  if (!workspaceRootCache) return
  const rel = `Weekly/${key}.md`
  const existing = tabIndexFor(rel)
  if (existing >= 0) {
    await activateTab(existing)
    return
  }
  const known = pageCache.has(rel)
  if (!known && workspaceRootCache) {
    cachePage({
      relPath: rel,
      absolutePath: `${workspaceRootCache}/${rel}`,
      title: weeklyTitle(key),
      icon: '',
      body: ''
    })
  }
  void (async () => {
    const created = await window.api.wsWeekly(key)
    if (!created) return
    created.title = weeklyTitle(key)
    cachePage(created)
    if (currentPage?.relPath === rel && !isPending(rel)) {
      currentPage = { ...created, dirRel: dirOf(rel) }
      pageTitleEl.value = created.title
      refreshActiveTabLabel(created.title, created.icon)
      if (created.body) loadIntoEditors(created.body)
    }
    void refreshTree()
  })()
  await openRel(rel, 'page')
  refreshActiveTabLabel(weeklyTitle(key), '')
  renderBreadcrumbs()
}

// ---- workspace modes (Notes / Templates / Views / Graph / Inbox / Tasks / Media) ----
type SidebarMode = 'notes' | 'templates' | 'views' | 'graph' | 'inbox' | 'tasks' | 'media'
let sidebarMode: SidebarMode = 'notes'
let activeViewId: WorkspaceViewId = 'all'

const MODE_TITLES: Record<WorkspaceModeId, string> = {
  recent: 'Recently written',
  pending: 'Pending tasks',
  exams: 'Exam papers',
  all: 'All notes',
  graph: 'Graph',
  inbox: 'Inbox',
  tasks: 'Tasks',
  media: 'Files & media'
}

const VIEW_DEFS: { id: WorkspaceViewId; title: string; sub: string; icon: IconName }[] = [
  { id: 'recent', title: 'Recently written', sub: 'Newest changes first', icon: 'clock' },
  { id: 'pending', title: 'Pending tasks', sub: 'Unchecked boxes by note', icon: 'check' },
  { id: 'exams', title: 'Exam papers', sub: 'Every .qz paper', icon: 'quiz' },
  { id: 'all', title: 'All notes', sub: 'The whole workspace', icon: 'table' }
]

function modeRel(mode: WorkspaceModeId): string {
  return `__mode__:${mode}`
}

function tabMode(tab: TabInfo): WorkspaceModeId | null {
  if (tab.kind === 'graph') return 'graph'
  if (tab.kind !== 'view') return null
  const raw = tab.relPath.replace(/^__mode__:/, '')
  if (raw in MODE_TITLES) return raw as WorkspaceModeId
  return null
}

function sidebarModeForMode(mode: WorkspaceModeId): SidebarMode {
  if (mode === 'recent' || mode === 'pending' || mode === 'exams' || mode === 'all') return 'views'
  return mode
}

function paintSidebarMode(mode: SidebarMode): void {
  sidebarMode = mode
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('.viewstrip-btn'))) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode)
  }
  const notes = document.getElementById('notes-view')
  const templates = document.getElementById('templates-view')
  const views = document.getElementById('views-view')
  const side = document.getElementById('mode-side-panel')
  if (notes) notes.hidden = mode !== 'notes'
  if (templates) templates.hidden = mode !== 'templates'
  if (views) views.hidden = mode !== 'views'
  if (side) side.hidden = !['graph', 'inbox', 'tasks', 'media'].includes(mode)
  if (mode === 'templates') void renderTemplates()
  if (mode === 'views') renderViewsList()
  if (['graph', 'inbox', 'tasks', 'media'].includes(mode)) updateModeSidePanel(mode, '')
}

async function activateSidebarMode(mode: SidebarMode): Promise<void> {
  if (mode === 'notes') {
    paintSidebarMode('notes')
    const tab = tabs[activeTab]
    if (tab && (tab.kind === 'view' || tab.kind === 'graph')) {
      const previous = [...tabs].reverse().find((t) => t.kind !== 'view' && t.kind !== 'graph')
      if (previous) await activateTab(tabs.indexOf(previous))
      else await newTab()
    }
    return
  }
  paintSidebarMode(mode)
  if (mode === 'templates') {
    // Templates are a way to start a note, not a canvas of their own: return
    // the main pane to the note you were reading (or Home) while the sidebar
    // shows the gallery.
    const tab = tabs[activeTab]
    if (tab && (tab.kind === 'view' || tab.kind === 'graph')) {
      const previous = [...tabs].reverse().find((t) => t.kind !== 'view' && t.kind !== 'graph')
      if (previous) await activateTab(tabs.indexOf(previous))
      else if (tabs.length === 0) showNewTab()
      else {
        tabs = tabs.filter((t) => t.kind !== 'view' && t.kind !== 'graph')
        activeTab = 0
        renderTabs()
        persistTabs()
        showNewTab()
      }
      paintSidebarMode('templates')
    }
    return
  }
  if (mode === 'views') {
    await openModeTab(activeViewId)
    return
  }
  await openModeTab(mode as WorkspaceModeId)
}

async function openModeTab(mode: WorkspaceModeId): Promise<void> {
  const rel = modeRel(mode)
  const existing = tabIndexFor(rel)
  if (existing >= 0 && existing !== activeTab) {
    captureScrollForShownContent()
    activeTab = existing
    renderTabs()
    persistTabs()
    await loadTabContent(tabs[existing])
    return
  }
  if (existing >= 0) {
    // Pressing the active mode again refreshes the projection.
    await loadTabContent(tabs[existing])
    return
  }
  captureScrollForShownContent()
  const kind: TabInfo['kind'] = mode === 'graph' ? 'graph' : 'view'
  const tab: TabInfo = { relPath: rel, kind, title: MODE_TITLES[mode] }
  tabs.push(tab)
  activeTab = tabs.length - 1
  renderTabs()
  persistTabs()
  await loadTabContent(tab)
}

/** Paint one of the whole-canvas workspace projections in the active tab. */
async function showModeForTab(tab: TabInfo): Promise<void> {
  const mode = tabMode(tab)
  if (!mode) return
  flushSave()
  currentPage = null
  currentFile = null
  currentImagePath = null
  currentPdfPath = null
  currentQuizRel = null
  releasePdfViewer()
  showOnlyPane(modePaneEl)
  welcomeEl.hidden = true
  emptyStateEl.hidden = true
  pageLoaderEl.hidden = true
  breadcrumbsEl.innerHTML = ''
  markActiveInTree(null)
  updatePinButton()
  if (mode === 'recent' || mode === 'pending' || mode === 'exams' || mode === 'all') activeViewId = mode
  paintSidebarMode(sidebarModeForMode(mode))
  const count = await renderWorkspaceMode(modeBodyEl, mode, {
    open: (rel, kind) => void openRel(rel, kind),
    notify: (text) => notify(text),
    afterChange: () => void refreshTree(),
    openInboxNote: () => void openRel('Inbox.md', 'page'),
    summary: (n) => updateModeSidePanel(sidebarModeForMode(mode), String(n))
  })
  updateModeSidePanel(sidebarModeForMode(mode), count)
}

function updateModeSidePanel(mode: SidebarMode, count: string): void {
  const title = document.getElementById('mode-side-title')
  const sub = document.getElementById('mode-side-sub')
  const body = document.getElementById('mode-side-body')
  if (!title || !sub || !body) return
  const n = Number(count) || 0
  title.textContent =
    mode === 'graph' ? 'Graph' : mode === 'inbox' ? 'Inbox' : mode === 'tasks' ? 'Tasks' : 'Files & media'
  sub.textContent =
    mode === 'graph'
      ? `${n} note${n === 1 ? '' : 's'} mapped. Drag a node to rearrange; click to open.`
      : mode === 'inbox'
        ? `${n} active capture${n === 1 ? '' : 's'} waiting for triage.`
        : mode === 'tasks'
          ? `${n} task${n === 1 ? '' : 's'} in this filter.`
          : `${n} item${n === 1 ? '' : 's'} in this filter.`
  body.replaceChildren()
  if (mode === 'inbox') {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'mode-side-action'
    open.textContent = 'Open Inbox.md'
    open.addEventListener('click', () => void openRel('Inbox.md', 'page'))
    body.appendChild(open)
  }
  if (mode === 'graph') {
    const all = document.createElement('button')
    all.type = 'button'
    all.className = 'mode-side-action'
    all.textContent = 'All notes'
    all.addEventListener('click', () => void openModeTab('all'))
    body.appendChild(all)
  }
}

function renderViewsList(): void {
  const host = document.getElementById('views-list')
  if (!host) return
  host.replaceChildren()
  const activeMode = tabMode(tabs[activeTab] ?? ({} as TabInfo))
  for (const def of VIEW_DEFS) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'views-row' + (activeMode === def.id ? ' is-active' : '')
    const icon = document.createElement('span')
    icon.className = 'views-row-icon'
    icon.append(iconEl(def.icon, 14))
    const text = document.createElement('span')
    text.className = 'views-row-text'
    const title = document.createElement('span')
    title.className = 'views-row-title'
    title.textContent = def.title
    const sub = document.createElement('span')
    sub.className = 'views-row-sub'
    sub.textContent = def.sub
    text.append(title, sub)
    row.append(icon, text)
    row.addEventListener('click', () => {
      activeViewId = def.id
      void openModeTab(def.id)
    })
    host.appendChild(row)
  }
}

// ---- sidebars: pinned items, templates, mode summaries ----

interface PinnedItem {
  relPath: string
  title: string
  kind: string
  icon?: string
}

function pinsKey(): string {
  return `meridiem:pins:${cacheWorkspacePath ?? 'none'}`
}

function readPins(): PinnedItem[] {
  try {
    const raw = localStorage.getItem(pinsKey())
    const parsed = raw ? (JSON.parse(raw) as PinnedItem[]) : []
    return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.relPath === 'string') : []
  } catch {
    return []
  }
}

function writePins(items: PinnedItem[]): void {
  try {
    localStorage.setItem(pinsKey(), JSON.stringify(items))
  } catch {
    /* private mode / quota: pins are a convenience, never a save */
  }
}

function refreshPinned(): void {
  const block = document.getElementById('pinned-block')
  const host = document.getElementById('pinned-list')
  if (!block || !host) return
  const pins = readPins()
  block.hidden = pins.length === 0
  host.replaceChildren()
  for (const pin of pins) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'pinned-row'
    const icon = document.createElement('span')
    icon.className = 'pinned-icon'
    applyIcon(icon, pin.icon, pin.kind === 'quiz' ? 'quiz' : 'doc', 13)
    const label = document.createElement('span')
    label.className = 'pinned-name'
    label.textContent = pin.title
    const unpin = document.createElement('span')
    unpin.className = 'pinned-unpin'
    unpin.textContent = '×'
    unpin.title = 'Unpin'
    unpin.addEventListener('click', (e) => {
      e.stopPropagation()
      writePins(readPins().filter((p) => p.relPath !== pin.relPath))
      refreshPinned()
      updatePinButton()
    })
    row.append(icon, label, unpin)
    row.title = pin.relPath
    row.addEventListener('click', () => void openRel(pin.relPath, pin.kind))
    host.appendChild(row)
  }
}

function updatePinButton(): void {
  const btn = document.getElementById('pin-note-btn') as HTMLButtonElement | null
  if (!btn) return
  const rel = currentPage?.relPath
  const pinned = !!rel && readPins().some((p) => p.relPath === rel)
  btn.classList.toggle('active', pinned)
  btn.title = pinned ? 'Unpin from sidebar' : 'Pin to sidebar'
  btn.disabled = !rel
}

function togglePinCurrent(): void {
  if (!currentPage) return
  const rel = currentPage.relPath
  const pins = readPins()
  const existing = pins.find((p) => p.relPath === rel)
  if (existing) writePins(pins.filter((p) => p.relPath !== rel))
  else {
    writePins([
      ...pins,
      { relPath: rel, title: currentPage.title, kind: rel.endsWith('.qz') ? 'quiz' : 'page', icon: currentPage.icon }
    ])
  }
  refreshPinned()
  updatePinButton()
}

async function renderTemplates(): Promise<void> {
  const host = document.getElementById('templates-list')
  if (!host) return
  host.replaceChildren()
  const loading = document.createElement('div')
  loading.className = 'sidebar-empty'
  loading.textContent = 'Reading templates…'
  host.appendChild(loading)
  let templates: { relPath: string; title: string; icon: string; kind: string }[] = []
  try {
    const index = await window.api.wsIndex()
    templates = index
      .filter((e) => /^Templates\//i.test(e.relPath))
      .sort((a, b) => a.title.localeCompare(b.title))
  } catch {
    /* empty state below */
  }
  host.replaceChildren()
  if (templates.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-empty'
    empty.textContent = 'Put .md or .qz files in a Templates/ folder, or press + to start one.'
    host.appendChild(empty)
    return
  }
  for (const template of templates) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'template-row'
    const icon = document.createElement('span')
    icon.className = 'template-icon'
    applyIcon(icon, template.icon, template.kind === 'quiz' ? 'quiz' : 'template', 14)
    const text = document.createElement('span')
    text.className = 'template-text'
    const title = document.createElement('span')
    title.className = 'template-title'
    title.textContent = template.title
    const sub = document.createElement('span')
    sub.className = 'template-sub'
    sub.textContent = template.kind === 'quiz' ? 'New paper from this exam' : 'New note from this template'
    text.append(title, sub)
    row.append(icon, text)
    row.title = `Create from ${template.relPath}`
    row.addEventListener('click', () => void useTemplate(template.relPath))
    host.appendChild(row)
  }
}

async function useTemplate(relPath: string): Promise<void> {
  const page = await window.api.wsUseTemplate({ relPath })
  if (!page) return
  await refreshTree()
  await openRel(page.relPath, page.relPath.toLowerCase().endsWith('.qz') ? 'quiz' : 'page')
}

async function newTemplate(): Promise<void> {
  const page = await window.api.wsCreate({ parentRel: 'Templates', title: 'Untitled template' })
  if (!page) return
  await refreshTree()
  await openPageByRel(page.relPath)
  requestAnimationFrame(() => pageTitleEl.focus())
}

let toastTimer: number | null = null
function notify(text: string): void {
  let toast = document.getElementById('app-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'app-toast'
    toast.className = 'app-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = text
  toast.classList.add('is-visible')
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast?.classList.remove('is-visible')
    toastTimer = null
  }, 1800)
}

// (openWeekly lives above with openDaily, next to the optimistic-open helpers.)

// ---- theme / fonts ----
let themeId = 'octarineDark'
function syncThemeSelect(): void {
  const el = document.getElementById('theme-select') as HTMLSelectElement | null
  if (el) el.value = themeId
}

function setTheme(id: string): void {
  const theme = applyTheme(id)
  // The picker remembers the user's choice (including "system"), while the
  // editors need the concrete light/dark palette that was resolved.
  themeId = getTheme(id).id
  codeEditor.setTheme(theme.kind)
  textEditor?.setTheme(theme.kind)
  syncThemeSelect()
  void window.api.setSettings('theme', themeId)
}
function cycleTheme(): void {
  setTheme(nextTheme(themeId).id)
}

// The saved theme is applied by init() (it reads the whole settings object in
// one round trip) — this used to run a second, independent settings read.
let currentPreviewFontId = 'default'

function applyPreviewFont(id: string): void {
  const font = fontById(id)
  currentPreviewFontId = font.id
  document.documentElement.style.setProperty('--preview-font', font.family)
  void window.api.setSettings('previewFont', id)
  // The pane is showing a PDF of the *old* font until it is asked again.
  printPreviewToken = null
  schedulePrintPreview(120)
}

/**
 * Font stack used for the PDF. macOS's sans-serif CJK fallback is PingFang SC,
 * and Chromium cannot embed that font in a PDF — every CJK glyph was silently
 * dropped, so Chinese/Japanese/Korean text vanished from exports while Latin
 * text stayed. Naming an embeddable CJK family before any generic fixes it, and
 * printableStack() does the same job below for the Latin faces (a stack led by
 * San Francisco ships no font at all, so the reader substitutes its own).
 */
function printFontStack(): string {
  const font = fontById(currentPreviewFontId)
  return `${printableStack(font.family)}, 'Arial Unicode MS', 'Songti SC', 'Heiti SC', 'Hiragino Sans GB', serif`
}

/** The type scale the print stylesheet multiplies by (Size: S/M/L…). */
function renderScale(): number {
  return Number(document.documentElement.style.getPropertyValue('--render-font-scale')) || 1
}

// ---- icon picker ----
// Full emoji picker with search (all 1791 stickers).
const emojiPicker = document.getElementById('emoji-picker') as HTMLElement
let emojiGrid: HTMLElement | null = null
let emojiInput: HTMLInputElement | null = null

/** Dismiss the icon picker and give the page its caret back — choosing an icon
 *  leaves the focus nowhere otherwise. */
function closeEmojiPicker(): HTMLElement | null {
  if (emojiPicker.hidden) return null
  emojiPicker.hidden = true
  focusEditorSurface()
  return emojiPicker
}

function pickIcon(icon: string): void {
  if (currentPage) {
    currentPage.icon = icon
    paintPageIcon(icon)
    scheduleSave()
    queueTreeRefresh()
  }
  closeEmojiPicker()
}

let emojiShown = 0
const EMOJI_PAGE = 600

function renderEmojis(): void {
  if (!emojiGrid || !emojiInput) return
  const q = emojiInput.value.trim().toLowerCase()
  let matches = q ? EMOJI_LIST.filter((e) => emojiMatches(e, q)) : EMOJI_LIST
  if (!q && emojiTab !== 'all') {
    const gi = EMOJI_GROUPS.findIndex((g) => g.id === emojiTab)
    matches = matches.filter((e) => e.g === gi)
  }
  emojiShown = emojiShown || EMOJI_PAGE
  emojiShown = Math.min(emojiShown, Math.max(EMOJI_PAGE, matches.length) || EMOJI_PAGE)
  emojiGrid.innerHTML = ''
  const noneBtn = document.createElement('button')
  noneBtn.type = 'button'
  noneBtn.className = 'emoji-none-btn'
  noneBtn.textContent = 'No icon'
  noneBtn.addEventListener('click', () => pickIcon(''))
  emojiGrid.appendChild(noneBtn)
  const shown = matches.slice(0, emojiShown)
  for (const e of shown) {
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.title = e.n
    cell.textContent = e.c
    cell.addEventListener('click', () => pickIcon(e.c))
    emojiGrid.appendChild(cell)
  }
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'emoji-more-btn'
  if (matches.length > emojiShown) {
    more.textContent = `Show more (${matches.length - emojiShown} more)`
    more.addEventListener('click', () => {
      emojiShown = Math.min(emojiShown + EMOJI_PAGE, matches.length || EMOJI_LIST.length)
      renderEmojis()
    })
  } else if (matches.length === 0) {
    more.textContent = 'No emoji match'
    more.disabled = true
  }
  emojiGrid.appendChild(more)
}

const EMOJI_TABS: string[] = ['all', ...EMOJI_GROUPS.map((g) => g.id)]
let emojiTab = 'all'
let emojiTabsEl: HTMLElement | null = null

function emojiMatches(e: { n: string; k: string }, q: string): boolean {
  const hay = (e.n + ' ' + e.k).toLowerCase()
  return q.split(/\s+/).every((tok) => hay.includes(tok))
}

function buildEmojiPicker(): void {
  emojiPicker.innerHTML = ''
  emojiInput = document.createElement('input')
  emojiInput.className = 'emoji-search'
  emojiInput.placeholder = 'Search emoji…'
  emojiTabsEl = document.createElement('div')
  emojiTabsEl.className = 'emoji-tabs'
  for (const id of EMOJI_TABS) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'emoji-tab' + (id === emojiTab ? ' active' : '')
    tab.textContent = id === 'all' ? 'All' : (EMOJI_GROUPS.find((g) => g.id === id)?.label ?? id)
    tab.addEventListener('click', () => {
      emojiTab = id
      emojiShown = 0
      emojiTabsEl?.querySelectorAll('.emoji-tab').forEach((t) => t.classList.toggle('active', t === tab))
      renderEmojis()
    })
    emojiTabsEl.appendChild(tab)
  }
  emojiGrid = document.createElement('div')
  emojiGrid.className = 'emoji-grid'
  emojiPicker.append(emojiInput, emojiTabsEl, emojiGrid)
  emojiInput.addEventListener('input', renderEmojis)
  renderEmojis()
}

pageIconEl.addEventListener('click', () => {
  if (!emojiPicker.hidden) {
    closeEmojiPicker()
    return
  }
  const rect = pageIconEl.getBoundingClientRect()
  if (!emojiGrid) buildEmojiPicker()
  emojiPicker.style.left = rect.left + 'px'
  emojiPicker.style.top = rect.bottom + 6 + 'px'
  anchorFloat(emojiPicker, pageIconEl)
  emojiPicker.hidden = false
  emojiInput?.focus()
})

// ---- Export to PDF ----

// Export options: margins + whether the page title/icon are printed. They live
// in the popover next to the PDF button and are remembered between runs.
//
// The margin buttons and the title/icon switches appear in both that popover and
// the page Display menu, so there is one value behind each of them: the two
// menus are two doors to the same three settings, and both show what the paper
// will do. (The title/icon pair used to be two independent settings — flipping
// Display's "Show title" left the PDF alone, which read as the paper ignoring
// the Display menu.)
type ExportMargin = 'thin' | 'medium' | 'wide'
let exportMargin: ExportMargin = 'medium'

function applyExportMenuState(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.export-seg-btn[data-margin]')) {
    btn.classList.toggle('on', btn.dataset.margin === exportMargin)
  }
  syncDisplayChecks()
}

function closeExportMenu(): HTMLElement | null {
  const menu = document.getElementById('export-menu')
  if (!menu || menu.hidden) return null
  menu.hidden = true
  return menu
}

function toggleExportMenu(): void {
  const menu = document.getElementById('export-menu')
  if (!menu) return
  if (menu.hidden) {
    applyExportMenuState()
    anchorFloat(menu, document.getElementById('export-pdf-btn'))
    menu.hidden = false
  } else {
    closeExportMenu()
  }
}

async function exportPageToPdf(): Promise<void> {
  if (!currentPage) return
  closeExportMenu()
  // The display options travel in the payload; the hidden print host does the
  // rendering, so nothing in this window has to be rearranged first. It used to
  // be put into print styles and back, which the user saw as the whole app
  // redrawing itself.
  setSaveStatus('Exporting PDF…', 'pending')
  try {
    const res = await window.api.exportPagePdf({
      ...printPayload(getActiveBody()),
      // The title is also the file name, so the payload always carries it even
      // when the paper itself is set not to show one.
      title: currentPage.title,
      relPath: currentPage.relPath
    })
    if (res?.path) {
      setSaveStatus(`PDF saved · ${res.pages} page${res.pages === 1 ? '' : 's'}`, 'ok')
      logLine('info', `exported pdf: ${res.pages} pages, margins=${exportMargin}`)
    } else {
      setSaveStatus('Export canceled', 'ok')
    }
  } catch (err) {
    setSaveStatus('PDF export failed', 'error')
    console.error(err)
  }
  window.setTimeout(() => setSaveStatus(''), 4000)
}

let treeRefreshTimer: number | null = null
function queueTreeRefresh(): void {
  if (treeRefreshTimer !== null) window.clearTimeout(treeRefreshTimer)
  treeRefreshTimer = window.setTimeout(() => {
    treeRefreshTimer = null
    void refreshTree()
  }, 700)
}

let crumbPop: HTMLElement | null = null
/** The crumb the open dropdown belongs to, so pressing it again closes. */
let crumbPopAnchor: HTMLElement | null = null
function closeCrumbPop(): HTMLElement | null {
  const el = crumbPop
  if (!el) return null
  el.remove()
  crumbPop = null
  crumbPopAnchor = null
  return el
}

// Notion-style: clicking a crumb opens a dropdown of its siblings (the
// children of its parent), with drill-down chevrons for pages that have kids.
function showCrumbPop(anchor: HTMLElement, node: SidebarNodeLike): void {
  if (crumbPop && crumbPopAnchor === anchor) {
    closeCrumbPop()
    return
  }
  closeCrumbPop()
  if (!lastRoot) return
  const parent = findParentOf(lastRoot, node) ?? lastRoot
  const rows = parent.children ?? []
  crumbPop = document.createElement('div')
  crumbPop.className = 'crumb-pop'
  crumbPopAnchor = anchor
  anchorFloat(crumbPop, anchor)
  const renderRows = (list: SidebarNodeLike[], highlightRel: string | null): void => {
    if (!crumbPop) return
    crumbPop.innerHTML = ''
    for (const child of list) {
      const row = document.createElement('div')
      row.className = 'crumb-pop-item' + (child.relPath === highlightRel ? ' active' : '')
      const icon = document.createElement('span')
      icon.className = 'crumb-pop-icon'
      applyIcon(icon, child.icon, child.kind === 'pdf' ? 'doc' : 'folder', 14)
      const label = document.createElement('span')
      label.className = 'crumb-pop-label'
      label.textContent = child.title ?? child.name
      row.append(icon, label)
      const hasKids = (child.children ?? []).length > 0
      if (hasKids) {
        const chev = document.createElement('button')
        chev.className = 'crumb-pop-chev'
        chev.title = 'Show subpages'
        chev.addEventListener('click', (e) => {
          e.stopPropagation()
          renderRows(child.children ?? [], child.relPath)
        })
        row.appendChild(chev)
      }
      row.addEventListener('click', () => {
        closeCrumbPop()
        if (child.kind === 'pdf') void openPdf(child.relPath)
        else void openPageByRel(child.relPath)
      })
      crumbPop.appendChild(row)
    }
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'crumb-pop-empty'
      empty.textContent = 'No pages here yet'
      crumbPop.appendChild(empty)
    }
  }
  renderRows(rows, node.relPath)
  document.body.appendChild(crumbPop)
  const rect = anchor.getBoundingClientRect()
  crumbPop.style.left = rect.left + 'px'
  crumbPop.style.top = rect.bottom + 6 + 'px'
}

function renderBreadcrumbs(): void {
  if (splitOpen && activePane === 'right' && splitRel) {
    const parts = splitRel.split('/').filter((p) => p !== 'index.md')
    breadcrumbsEl.innerHTML = ''
    parts.forEach((part, i) => {
      const crumb = document.createElement('span')
      crumb.className = 'crumb' + (i === parts.length - 1 ? ' current' : '')
      crumb.textContent = part
      if (i < parts.length - 1) crumb.textContent += ' /'
      breadcrumbsEl.appendChild(crumb)
    })
    return
  }
  breadcrumbsEl.innerHTML = ''
  if (!currentPage || !lastRoot) return
  const dailyKey = dailyKeyOf(currentPage.relPath)
  if (dailyKey) {
    const label = relativeDay(dailyKey) ?? formatDailyDate(dailyKey)
    const btn = document.createElement('button')
    btn.className = 'crumb-btn crumb-relative'
    btn.textContent = label
    btn.title = 'Open today’s daily note'
    btn.addEventListener('click', () => void openDaily(todayKey()))
    breadcrumbsEl.appendChild(btn)
    return
  }
  const weeklyKey = weeklyKeyOf(currentPage.relPath)
  if (weeklyKey) {
    const week = weeklyTitle(weeklyKey)
    const btn = document.createElement('button')
    btn.className = 'crumb-btn crumb-relative'
    btn.textContent = week
    btn.title = 'Open this week’s note'
    btn.addEventListener('click', () => void openWeekly(weekKeyForDate(todayKey())))
    breadcrumbsEl.appendChild(btn)
    return
  }
  // Chain of directories from root to the current page's folder.
  const dirs: string[] = ['']
  if (currentPage.relPath.endsWith('/index.md')) {
    const dir = currentPage.dirRel
    if (dir) {
      const parts = dir.split('/')
      for (let i = 1; i <= parts.length; i++) dirs.push(parts.slice(0, i).join('/'))
    }
  }
  dirs.forEach((dir, i) => {
    const node = findNodeByDirRel(lastRoot!, dir)
    const btn = document.createElement('button')
    btn.className = 'crumb-btn'
    const isCurrentDir = dir === currentPage!.dirRel && currentPage!.relPath.endsWith('/index.md')
    if (node && !(dir === '' && node.kind === 'folder' && !node.title)) {
      btn.textContent = node.title ?? node.name
    } else if (dir === '') {
      btn.textContent = ' / ' + (document.getElementById('workspace-name') as HTMLElement).textContent
    }
    if (isCurrentDir && !currentPage!.relPath.endsWith('/index.md')) btn.classList.add('dim')
    btn.addEventListener('click', () => {
      if (node) showCrumbPop(btn, node)
    })
    breadcrumbsEl.appendChild(btn)
    if (i < dirs.length - 1 || !currentPage!.relPath.endsWith('/index.md')) {
      const sep = document.createElement('span')
      sep.className = 'crumb-sep'
      sep.textContent = '/'
      breadcrumbsEl.appendChild(sep)
    }
  })
  // Loose page: append itself as the final crumb.
  if (!currentPage.relPath.endsWith('/index.md')) {
    const btn = document.createElement('button')
    btn.className = 'crumb-btn current'
    btn.textContent = currentPage.title
    btn.addEventListener('click', () => {
      const node = lastRoot ? findNodeByRel(lastRoot, currentPage!.relPath) : null
      if (node) showCrumbPop(btn, node)
    })
    breadcrumbsEl.appendChild(btn)
  }
}

pageTitleEl.addEventListener('input', () => {
  if (currentPage) {
    currentPage.title = pageTitleEl.value.trim() || 'Untitled'
    refreshActiveTabLabel(currentPage.title, currentPage.icon)
    renderBreadcrumbs()
    scheduleSave()
    // The sidebar row is renamed in place when the save drains (updateTreeLabel)
    // — no workspace scan while typing a title.
  }
})

// ---- menu actions ----
window.api.onMenuAction((action) => {
  switch (action) {
    case 'nav-back':
      goBack()
      break
    case 'nav-forward':
      goForward()
      break
    case 'find':
      if (findBarEl.hidden) openFind()
      else closeFind(true)
      break
    case 'find-workspace':
      openSearch()
      break
    case 'new-page':
      void createNewPage(null)
      break
    case 'new-tab':
      void newTab()
      break
    case 'close-tab':
      closeTab(activeTab)
      break
    case 'reopen-tab':
      void reopenClosedTab()
      break
    case 'next-tab':
      void cycleTab(1)
      break
    case 'prev-tab':
      void cycleTab(-1)
      break
    case 'save':
      void persistNow()
      void flushTextFile()
      break
    case 'open-workspace':
      void openExistingWorkspace()
      break
    case 'reveal-page':
      if (currentPage) void window.api.wsReveal(currentPage.relPath)
      break
    case 'toggle-sidebar': {
      // Must go through setSidebarOpen: the resizer and the persisted setting
      // live there, and the toolbar button reads its state from `hidden`.
      const sb = document.getElementById('sidebar') as HTMLElement
      setSidebarOpen(sb.hidden as boolean, true)
      break
    }
    case 'toggle-agent':
      toggleAgentPanel()
      break
    case 'toggle-source':
      toggleSource()
      break
    case 'cycle-theme':
      cycleTheme()
      break
  }
})

let activeAgentHarness = 'none'

/** Keep the panel honest about which backend is selected. Off hides the panel
 *  and its titlebar switch entirely; ACP and pi show it, but only pi exposes
 *  provider/model controls. */
function applyAgentHarness(harness: string): void {
  activeAgentHarness = harness
  const off = harness === 'none'
  const toggle = document.getElementById('toggle-agent-btn') as HTMLElement | null
  const panel = document.getElementById('agent-panel') as HTMLElement | null
  const resizer = document.getElementById('agent-resizer') as HTMLElement | null
  const offState = document.getElementById('agent-off-state') as HTMLElement | null
  const messages = document.getElementById('agent-messages') as HTMLElement | null
  const form = document.getElementById('agent-form') as HTMLElement | null
  const notice = document.getElementById('agent-session-notice') as HTMLElement | null
  const badge = document.getElementById('agent-harness-badge') as HTMLElement | null
  if (toggle) {
    toggle.hidden = off
    if (off) toggle.classList.remove('active')
    toggle.title = off ? 'AI is off' : 'AI sidebar'
  }
  if (offState) offState.hidden = !off
  if (messages) messages.hidden = off
  if (form) form.hidden = off
  if (notice && off) notice.hidden = true
  if (off && panel && !panel.hidden) {
    panel.hidden = true
    if (resizer) resizer.hidden = true
    agentPanel?.dismissFloats()
    void window.api.setSettings('agentOpen', false)
  }
  if (badge) {
    badge.hidden = off
    if (harness === 'pi') badge.textContent = 'Built-in · pi'
    else if (harness.startsWith('acp:')) {
      const tool = harness.slice(4)
      const label = tool === 'opencode' ? 'OpenCode' : tool === 'claude' ? 'Claude Code' : tool === 'codex' ? 'Codex' : tool
      badge.textContent = `${label} · ACP`
    }
  }
  const pi = harness === 'pi'
  for (const id of ['agent-model-select', 'agent-effort', 'agent-history']) {
    const el = document.getElementById(id) as HTMLElement | null
    if (el) el.hidden = !pi
  }
}

function toggleAgentPanel(): void {
  if (activeAgentHarness === 'none') {
    // The switch is hidden in this mode; this guard covers a stale keyboard
    // shortcut or a menu action from before the harness was turned off.
    return
  }
  const panel = document.getElementById('agent-panel') as HTMLElement
  panel.hidden = !panel.hidden
  ;(document.getElementById('agent-resizer') as HTMLElement).hidden = panel.hidden
  ;(document.getElementById('toggle-agent-btn') as HTMLElement).classList.toggle('active', !panel.hidden)
  // A hidden panel must not leave its popovers behind.
  if (panel.hidden) agentPanel?.dismissFloats()
  void window.api.setSettings('agentOpen', !panel.hidden)
}

async function openExistingWorkspace(): Promise<void> {
  const res = await window.api.wsOpenWorkspace()
  if (res.ok) {
    await initWorkspace()
  } else if (res.error) {
    window.alert(res.error)
  }
}

// Ensure the current page can have children: loose x.md becomes x/index.md.
async function ensureFolderPage(): Promise<string> {
  if (!currentPage) return ''
  // A dated note is a leaf by design (its filename is the calendar key). A new
  // page created while reading it belongs at the root, never inside `Daily/`.
  if (dailyKeyOf(currentPage.relPath) || weeklyKeyOf(currentPage.relPath)) return ''
  if (currentPage.relPath.endsWith('/index.md')) return currentPage.dirRel
  const newRel = await window.api.wsConvertLoose(currentPage.relPath)
  currentPage.relPath = newRel
  currentPage.dirRel = dirOf(newRel)
  await refreshTree()
  return currentPage.dirRel
}

async function createPageNamed(name: string): Promise<string> {
  const parentDir = await ensureFolderPage()
  const page = await window.api.wsCreate({ parentRel: parentDir || null, title: name || 'Untitled' })
  if (page) {
    await refreshTree()
    return page.title
  }
  return name || 'Untitled'
}

async function createNewPage(parentRel: string | null): Promise<void> {
  // No prompt(): Electron doesn't implement it. Create immediately like Notion
  // and focus the title so typing renames the page.
  // '__root__' creates directly in the workspace root; anything else nests
  // under the current page.
  const parentDir = parentRel === '__root__' ? null : await ensureFolderPage()
  const page = await window.api.wsCreate({ parentRel: parentDir || null, title: 'Untitled' })
  if (page) {
    noteRecent({ relPath: page.relPath, kind: 'page', title: page.title, icon: page.icon })
    await refreshTree()
    await openPageByRel(page.relPath)
    requestAnimationFrame(() => {
      pageTitleEl.focus()
      pageTitleEl.select()
    })
  }
}

// Single-flight boot: multiple calls (startup, choose, settings change) must
// not race each other. `bootSeq` invalidates stale continuations.
// ---------------------------------------------------------------------------
// Workspace switcher: a dropdown listing every workspace, plus creation of
// ordinary and private (encrypted) workspaces and the password gate.
// ---------------------------------------------------------------------------
const wsMenuEl = document.getElementById('ws-menu') as HTMLElement
const lockBtn = document.getElementById('lock-ws-btn') as HTMLButtonElement
const wsIconEl = document.getElementById('ws-icon') as HTMLElement

function closeWsMenu(): HTMLElement | null {
  if (wsMenuEl.hidden) return null
  wsMenuEl.hidden = true
  wsMenuEl.innerHTML = ''
  document.getElementById('workspace-switcher')?.classList.remove('open')
  return wsMenuEl
}

async function renderWsMenu(): Promise<void> {
  const list = await window.api.wsList()
  const current = ((await window.api.wsGet()).displayPath ?? null) as string | null
  wsMenuEl.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'ws-menu-head'
  head.textContent = 'Workspaces'
  wsMenuEl.appendChild(head)

  for (const w of list) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'ws-menu-item' + (w.path === current ? ' current' : '')
    const icon = document.createElement('span')
    icon.className = 'ws-menu-icon'
    icon.innerHTML = iconSvg(w.kind === 'private' ? (w.unlocked ? 'unlock' : 'lock') : 'folder', 15)
    const text = document.createElement('span')
    text.className = 'ws-menu-text'
    const name = document.createElement('span')
    name.className = 'ws-menu-name'
    name.textContent = w.name
    const sub = document.createElement('span')
    sub.className = 'ws-menu-path'
    sub.textContent = w.missing ? 'folder is missing' : w.path.replace(/^\/Users\/[^/]+/, '~')
    text.append(name, sub)
    row.append(icon, text)
    if (w.missing) row.classList.add('missing')
    const forget = document.createElement('span')
    forget.className = 'ws-menu-forget'
    forget.textContent = '✕'
    forget.title = 'Remove from this list (keeps the folder)'
    forget.addEventListener('click', (e) => {
      e.stopPropagation()
      void (async () => {
        await window.api.wsForget(w.path)
        await renderWsMenu()
      })()
    })
    row.appendChild(forget)
    row.addEventListener('click', () => {
      void (async () => {
        if (w.path === current) {
          closeWsMenu()
          return
        }
        if (w.kind === 'private') {
          closeWsMenu()
          void openPasswordGate({ mode: 'unlock', path: w.path, name: w.name })
          return
        }
        const res = await window.api.wsSwitch(w.path)
        if (!res.ok && res.private) {
          closeWsMenu()
          void openPasswordGate({ mode: 'unlock', path: w.path, name: w.name })
          return
        }
        closeWsMenu()
        await initWorkspace()
      })()
    })
    wsMenuEl.appendChild(row)
  }

  const sep = document.createElement('div')
  sep.className = 'ws-menu-sep'
  wsMenuEl.appendChild(sep)

  const add = (label: string, ico: IconName, fn: () => void): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ws-menu-action'
    b.innerHTML = iconSvg(ico, 15)
    b.appendChild(document.createTextNode(label))
    b.addEventListener('click', fn)
    wsMenuEl.appendChild(b)
  }
  add('New workspace…', 'plus', () => {
    closeWsMenu()
    const modal = document.getElementById('workspace-modal') as HTMLElement
    modal.hidden = false
    ;(document.getElementById('create-name') as HTMLInputElement).focus()
  })
  add('New private workspace…', 'lock', () => {
    closeWsMenu()
    void openPasswordGate({ mode: 'create' })
  })
  add('Open existing folder…', 'folder', () => {
    closeWsMenu()
    void (async () => {
      const res = await window.api.wsOpenWorkspace()
      if (res && 'private' in res && res.private && res.path) {
        void openPasswordGate({ mode: 'unlock', path: res.path })
        return
      }
      await initWorkspace()
    })()
  })
}

document.getElementById('workspace-switcher')!.addEventListener('click', () => {
  const pill = document.getElementById('workspace-switcher') as HTMLElement
  if (!wsMenuEl.hidden) {
    closeWsMenu()
    return
  }
  void renderWsMenu().then(() => {
    anchorFloat(wsMenuEl, pill)
    wsMenuEl.hidden = false
    pill.classList.add('open')
  })
})

// ---- lock screen (an encrypted workspace that isn't unlocked yet) ----
document.getElementById('locked-unlock')!.addEventListener('click', () => {
  void (async () => {
    const info = await window.api.wsGet()
    if (info.displayPath) openPasswordGate({ mode: 'unlock', path: info.displayPath })
  })()
})
document.getElementById('locked-switch')!.addEventListener('click', () => {
  ;(document.getElementById('locked-view') as HTMLElement).hidden = true
  welcomeEl.hidden = false
})

// ---- password gate (create / unlock a private workspace) ----
/** Returns the element it closed, so the shared dismissal pass (Escape, a
 *  click elsewhere) can close the gate too. */
function closePasswordGate(): HTMLElement | null {
  const modal = document.getElementById('pw-modal')
  if (!modal || modal.hidden) return null
  modal.hidden = true
  return modal
}

interface PasswordGateOpts {
  mode: 'create' | 'unlock'
  path?: string
  name?: string
}

function openPasswordGate(opts: PasswordGateOpts): void {
  const modal = document.getElementById('pw-modal') as HTMLElement
  const title = document.getElementById('pw-title') as HTMLElement
  const sub = document.getElementById('pw-sub') as HTMLElement
  const input = document.getElementById('pw-input') as HTMLInputElement
  const confirm = document.getElementById('pw-confirm') as HTMLInputElement
  const confirmField = document.getElementById('pw-confirm-field') as HTMLElement
  const nameField = document.getElementById('pw-name-field') as HTMLElement
  const nameInput = document.getElementById('pw-name') as HTMLInputElement
  const err = document.getElementById('pw-error') as HTMLElement
  const submit = document.getElementById('pw-submit') as HTMLButtonElement
  const locationRow = document.getElementById('pw-location-row') as HTMLElement | null

  const creating = opts.mode === 'create'
  title.textContent = creating ? 'New private workspace' : 'Unlock private workspace'
  sub.textContent = creating
    ? 'The contents are encrypted with this password. There is no recovery — if you lose it, the files cannot be read.'
    : (opts.name ? opts.name : 'This workspace is encrypted.') + ' Enter its password to open it.'
  confirmField.hidden = !creating
  nameField.hidden = !creating
  if (locationRow) locationRow.hidden = !creating
  err.hidden = true
  input.value = ''
  confirm.value = ''
  nameInput.value = nameInput.value || 'Private notes'
  if (creating && locationRow) {
    const locInput = document.getElementById('pw-location') as HTMLInputElement
    const fromCreate = (document.getElementById('create-location') as HTMLInputElement).value.trim()
    if (!locInput.value) locInput.value = fromCreate
  }
  submit.textContent = creating ? 'Create' : 'Unlock'
  modal.hidden = false
  window.setTimeout(() => input.focus(), 30)

  let inFlight = false
  const submitFn = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    submit.disabled = true
    try {
      await runGate()
    } finally {
      inFlight = false
      submit.disabled = false
    }
  }
  const runGate = async (): Promise<void> => {
    const password = input.value
    if (!password) {
      err.textContent = 'Enter a password.'
      err.hidden = false
      return
    }
    if (creating) {
      if (password !== confirm.value) {
        err.textContent = 'The passwords do not match.'
        err.hidden = false
        return
      }
      const parentDir = (document.getElementById('pw-location') as HTMLInputElement | null)?.value.trim()
      const name = nameInput.value.trim() || 'Private notes'
      if (!parentDir) {
        err.textContent = 'Choose where to keep it.'
        err.hidden = false
        return
      }
      await window.api.wsCreateWorkspace({ name, parentDir, private: true, password })
      modal.hidden = true
      await initWorkspace()
      return
    }
    const res = await window.api.wsUnlock({ path: opts.path as string, password })
    if (!res.ok) {
      err.textContent = res.code === 'wrong-password' ? 'Incorrect password.' : res.message || 'Could not unlock.'
      err.hidden = false
      input.select()
      return
    }
    modal.hidden = true
    await initWorkspace()
    // Files that wouldn't decrypt are skipped, not deleted — say so, or they
    // just look like the vault ate them.
    if (res.warning) window.alert(res.warning)
  }

  submit.onclick = () => void submitFn()
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void submitFn()
    if (e.key === 'Escape') modal.hidden = true
  }
  confirm.onkeydown = (e) => {
    if (e.key === 'Enter') void submitFn()
  }
  ;(document.getElementById('pw-cancel') as HTMLButtonElement).onclick = () => {
    modal.hidden = true
  }
  const chooseLoc = document.getElementById('pw-choose-loc') as HTMLButtonElement | null
  if (chooseLoc) {
    chooseLoc.onclick = () => {
      void (async () => {
        const dir = await window.api.dirChoose()
        if (dir) (document.getElementById('pw-location') as HTMLInputElement).value = dir
      })()
    }
  }
}

lockBtn.addEventListener('click', () => {
  void (async () => {
    await window.api.wsLock()
    await initWorkspace()
  })()
})

// ---------------------------------------------------------------------------
// Renderer diagnostics → userData/meridiem.log (readable from a terminal).
// ---------------------------------------------------------------------------
function logLine(level: 'info' | 'warn' | 'error', message: string): void {
  void window.api.log({ level, message })
}

window.addEventListener('error', (e) => {
  logLine('error', `window error: ${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string } | undefined
  logLine('error', `unhandled rejection: ${r?.message ?? String(e.reason)} ${r?.stack ? `\n${r.stack}` : ''}`)
})

// ---------------------------------------------------------------------------
// Live PDF preview (⌘⇧P / the Preview button).
//
// The old "paged" view drew rules at computed offsets, which was only ever an
// estimate: the print layout differs subtly (widows/orphans, break-avoid on
// images/tables/headings, exact margins). This instead prints the page through
// the real print pipeline and shows the resulting pages with pdf.js, so the
// breaks are the ones the export will actually produce. The editor stays in
// the left pane and the preview refreshes as you type.
//
// The printing itself happens in a hidden second window (see initPrintHost), so
// a refresh never touches this one — it used to run printToPDF against the
// window you were looking at, which laid the whole app out in print media and
// back again several times a second while typing.
// ---------------------------------------------------------------------------
let printPreviewOn = false
let printPreviewTimer: number | null = null
let printPreviewBusy = false
/** When the in-flight render started, so a wedged one can be taken over. */
let printPreviewBusySince = 0
let printPreviewAgain = false
/** Page + margin + body that the pane is currently showing (see refreshPrintPreview). */
let printPreviewToken: string | null = null

// What the page shows while writing, and what the paper shows on export: the
// title and icon can be hidden. The export popover's "Include title/icon" and
// the Display menu's "Show title/icon" are this pair — see syncDisplayChecks.
let showPageTitle = true
let showPageIcon = true

/** Both menus carry a copy of the title/icon switches; point them at the truth. */
function syncDisplayChecks(): void {
  const boxes: [string, boolean][] = [
    ['export-title', showPageTitle],
    ['pv-title', showPageTitle],
    ['export-icon', showPageIcon],
    ['pv-icon', showPageIcon]
  ]
  for (const [id, on] of boxes) {
    const box = document.getElementById(id) as HTMLInputElement | null
    if (box) box.checked = on
  }
}

/** One page, flattened for the print host to render. */
interface PrintPayload {
  markdown: string
  /** Absolute folder the page lives in, so its images resolve in the host. */
  baseDir: string | null
  title: string
  icon: string
  showTitle: boolean
  showIcon: boolean
  font: string
  scale: number
  margins: ExportMargin
  /** What to title the PDF; only an export sets it (see the main process). */
  docTitle?: string
}

function printPayload(markdown: string): PrintPayload {
  return {
    markdown,
    baseDir: currentPage ? currentPage.absolutePath.replace(/\/[^/]*$/, '') : null,
    title: currentPage?.title ?? '',
    icon: currentPage?.icon ?? '',
    showTitle: showPageTitle,
    showIcon: showPageIcon,
    font: printFontStack(),
    scale: renderScale(),
    margins: exportMargin
  }
}

/**
 * Everything that changes what the pane would draw — so an identical refresh
 * can be skipped. The font and the type size belong in here: they are read by
 * the print stylesheet, and leaving them out is why picking a different reading
 * font or size left the old one on screen.
 */
function printToken(): string {
  return [
    currentPage?.relPath ?? '',
    exportMargin,
    currentPreviewFontId,
    String(renderScale()),
    showPageTitle ? '1' : '0',
    showPageIcon ? '1' : '0',
    getActiveBody()
  ].join('\u0000')
}

function applyPageDisplay(): void {
  const view = document.getElementById('page-view')
  if (!view) return
  view.classList.toggle('hide-title', !showPageTitle)
  view.classList.toggle('hide-icon', !showPageIcon)
  view.classList.toggle('no-header', !showPageTitle && !showPageIcon)
  syncDisplayChecks()
  schedulePrintPreview(250)
}

function closePageViewMenu(): HTMLElement | null {
  const menu = document.getElementById('page-view-menu')
  if (!menu || menu.hidden) return null
  menu.hidden = true
  document.getElementById('page-view-btn')?.classList.remove('open')
  return menu
}

function closePagePillMenus(): HTMLElement[] {
  const closed: HTMLElement[] = []
  for (const id of ['page-type-menu', 'page-more-menu']) {
    const menu = document.getElementById(id)
    if (menu && !menu.hidden) {
      menu.hidden = true
      closed.push(menu)
    }
  }
  document.getElementById('page-type-btn')?.classList.remove('open')
  document.getElementById('page-more-btn')?.classList.remove('open')
  closePageViewMenu()
  return closed
}

function togglePagePillMenu(id: 'page-type-menu' | 'page-more-menu'): void {
  const menu = document.getElementById(id)
  const anchor = document.getElementById(id === 'page-type-menu' ? 'page-type-btn' : 'page-more-btn')
  if (!menu || !anchor) return
  const wasHidden = menu.hidden
  closePagePillMenus()
  closeExportMenu()
  if (wasHidden) {
    anchorFloat(menu, anchor)
    menu.hidden = false
    anchor.classList.add('open')
  }
}

/** Render the current page through the print pipeline into the right pane. */
async function refreshPrintPreview(force = false): Promise<void> {
  if (!printPreviewOn || !currentPage) return
  if (splitRightEl.hidden) return
  // printToPDF + a pdf.js render is by far the most expensive thing the editor
  // does, and it used to run on every 700 ms typing pause even when nothing had
  // changed since the last render. printToken() says exactly what is on screen;
  // anything else is a no-op.
  const token = printToken()
  if (!force && token === printPreviewToken) return
  if (printPreviewBusy) {
    // A render that never settles must not disable the preview for the rest of
    // the session (this used to happen for good: an occluded window fires no
    // frames, so the wait before the render never resolved and every later
    // refresh was swallowed here). After this long, take the pane over.
    if (Date.now() - printPreviewBusySince < 20000) {
      printPreviewAgain = true
      return
    }
    logLine('warn', 'print preview: previous render never finished, retrying')
  }
  printPreviewBusy = true
  printPreviewBusySince = Date.now()
  const scrollTop = splitBodyEl.scrollTop
  try {
    // Drop the previous render first: two live pdf.js viewers in one pane fight
    // over the canvas.
    splitPdfHandle?.destroy()
    splitPdfHandle = null
    clearSplitBody()
    splitBodyEl.classList.add('print-preview')
    // The pane's own width decides the page size, so let the cleared layout
    // settle. nextPaint() rather than a bare rAF: these waits used to run
    // against the window being printed, and a hidden or fully-occluded window
    // never fires a frame — which stalled this function mid-await and left
    // printPreviewBusy stuck true, so the preview silently stopped updating for
    // the rest of the session.
    await nextPaint()
    const bytes = await window.api.printPagePdf(printPayload(getActiveBody()))
    if (!printPreviewOn) return
    const handle = await createPdfViewer({
      container: splitBodyEl,
      // fresh copy: the IPC-delivered view can share a larger buffer, which
      // pdf.js transfers to its worker
      bytes: new Uint8Array(bytes),
      onState: (s) => setSplitStatus(`${s.pages} page${s.pages === 1 ? '' : 's'}`)
    })
    splitPdfHandle = handle
    // Belt and braces: re-fit once more after the paint, in case the first
    // measurement happened mid-relayout.
    requestAnimationFrame(() => {
      try {
        handle.fitWidth()
      } catch {
        /* ignore */
      }
    })
    splitBodyEl.scrollTop = scrollTop
    printPreviewToken = token
    logLine('info', `print preview rendered (${bytes.byteLength} bytes)`)
  } catch (err) {
    console.error('[meridiem] print preview failed:', err)
    logLine('error', `print preview failed: ${(err as Error)?.message ?? String(err)}\n${(err as Error)?.stack ?? ''}`)
    setSplitStatus('Preview failed', 'error')
    clearSplitBody()
    const note = document.createElement('div')
    note.className = 'split-note'
    note.textContent = 'Could not render the preview: ' + String((err as Error)?.message ?? err)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'ghost-btn'
    retry.textContent = 'Try again'
    retry.addEventListener('click', () => void refreshPrintPreview())
    note.appendChild(document.createElement('br'))
    note.appendChild(retry)
    splitBodyEl.appendChild(note)
  } finally {
    printPreviewBusy = false
    if (printPreviewAgain) {
      printPreviewAgain = false
      schedulePrintPreview(150)
    }
  }
}

function schedulePrintPreview(delay = 700): void {
  if (!printPreviewOn) return
  if (printPreviewTimer !== null) window.clearTimeout(printPreviewTimer)
  printPreviewTimer = window.setTimeout(() => {
    printPreviewTimer = null
    void refreshPrintPreview()
  }, delay)
}

function openPrintPreview(): void {
  printPreviewOn = true
  // The pane starts empty, so whatever the token says about the last render no
  // longer describes what's on screen.
  printPreviewToken = null
  splitOpen = true
  splitRightEl.hidden = false
  splitResizerEl.hidden = false
  applySplitRatio()
  splitRel = null
  splitKind = 'print'
  splitTitle = 'PDF preview'
  splitTitleEl.textContent = splitTitle
  paintSplitIcon('print')
  clearSplitBody()
  splitBodyEl.classList.add('print-preview')
  setSplitStatus('Rendering…', 'pending')
  setActivePane('right')
  renderTabs()
  void refreshPrintPreview()
}

function closePrintPreview(): void {
  printPreviewOn = false
  printPreviewToken = null
  if (printPreviewTimer !== null) {
    window.clearTimeout(printPreviewTimer)
    printPreviewTimer = null
  }
  closeSplit()
}

function togglePrintPreview(): void {
  if (printPreviewOn) closePrintPreview()
  else openPrintPreview()
}

// ---------------------------------------------------------------------------
// Print host
//
// The window the PDF is actually produced in. It is created hidden, loads this
// same renderer with ?print=1, and is handed one page at a time to lay out and
// print — so the export and the live preview both leave the window you are
// working in alone. Two things fall out of that:
//
//  - printToPDF switches its own window into print media. Against the visible
//    window that meant the sidebar, tabs and agent panel were laid out to
//    nothing and back on every preview refresh: the whole app redrawing itself
//    a few times a second while you typed.
//  - Chromium paints the printed page's canvas in the *window's* background
//    colour, which the main window sets to the theme's --bg. Every export
//    therefore came with a band of the theme in the paper margins — and a dark
//    theme printed a black page. This window is created white.
// ---------------------------------------------------------------------------

/** How the main process hands a page over. Resolves once it is laid out. */
declare global {
  interface Window {
    __yestionPrint?: (json: string) => Promise<void>
  }
}

/** A frame, or a moment — whichever comes first. requestAnimationFrame can be
 *  throttled in a window that is never shown, and the print must not wait on it
 *  forever (or, worse, print a half-laid-out page). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => requestAnimationFrame(finish))
    window.setTimeout(finish, 120)
  })
}

function initPrintHost(): void {
  // Nothing else belongs on this page — and nothing else may leak into the
  // PDF. The page view brings the mounted editor with it.
  document.body.replaceChildren(pageViewEl)
  pageViewEl.hidden = false

  window.__yestionPrint = async (json: string): Promise<void> => {
    const doc = JSON.parse(json) as PrintPayload
    const root = document.documentElement
    root.style.setProperty('--print-font', doc.font)
    root.style.setProperty('--render-font-scale', String(doc.scale))
    root.dataset.printTitle = doc.showTitle ? 'on' : 'off'
    root.dataset.printIcon = doc.showIcon ? 'on' : 'off'
    printHostBaseDir = doc.baseDir
    pageTitleEl.value = doc.title
    paintPageIcon(doc.icon)
    // Chromium writes the PDF's /Title — what Preview and every other viewer
    // show as the document's name — from document.title, and this window
    // inherited the app's own from index.html. Every export was therefore
    // titled "Meridiem" whatever it was called on disk. An export sends the
    // name the file was saved under; the preview, which has no file, uses the
    // page title.
    document.title = (doc.docTitle || doc.title).trim() || 'page'
    programmatic = true
    try {
      richEditor.setContent(doc.markdown)
    } finally {
      programmatic = false
    }
    // The reading font is applied to the page by the @media print rule, so it
    // is never referenced on screen here — and `document.fonts.ready` would
    // resolve without it, leaving printToPDF to fall back to Times. Load the
    // primary family explicitly before printing.
    const primary = doc.font.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    if (primary) {
      await Promise.all([
        document.fonts.load(`16px "${primary}"`),
        document.fonts.load(`bold 16px "${primary}"`),
        document.fonts.load(`italic 16px "${primary}"`),
        document.fonts.load(`bold italic 16px "${primary}"`)
      ]).catch(() => undefined)
    }
    await document.fonts.ready
    await nextPaint()
    // The images are new to this window: printToPDF would leave out any that
    // have not decoded yet, which the visible window never hit (it had been
    // showing them all along).
    await Promise.all(
      Array.from(richEditorEl.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined))
    )
    await nextPaint()
  }
}

// ---------------------------------------------------------------------------
// Split view: two panes side by side. The main pane keeps the normal editor and
// tab machine; the second pane shows another tab (or, with none open, a page
// navigator). Whichever pane is active owns the sidebar, the agent context and
// find — like the focused window on a Mac.
// ---------------------------------------------------------------------------
let splitOpen = false
let splitRel: string | null = null
let splitKind = 'page'
let splitTitle = ''
let activePane: 'left' | 'right' = 'left'
let splitPdfHandle: PdfViewerHandle | null = null
let splitEditor: RichEditor | null = null
let splitRatio = 0.5
// Raw front matter of the split page (kept apart from the header's display
// icon, so saving never writes a fallback emoji into the file).
let splitPageTitle = ''
let splitPageIcon = ''
let splitLoading = false
let splitDirty = false
let splitSaveTimer: number | null = null
let splitSaving = false
let splitSaveQueued = false

const splitRightEl = document.getElementById('split-right') as HTMLElement
const splitBodyEl = document.getElementById('split-body') as HTMLElement
const splitTitleEl = document.getElementById('split-title') as HTMLElement
const splitIconEl = document.getElementById('split-icon') as HTMLElement
const contentLeftEl = document.getElementById('content-left') as HTMLElement
const contentRowEl = document.getElementById('content-row') as HTMLElement
const splitResizerEl = document.getElementById('split-resizer') as HTMLElement

/** A second editor, read-only, so the split pane renders EXACTLY like the main
 *  one: page-link chips, equations, tables, task lists, images — all of it. */
function ensureSplitEditor(): RichEditor {
  if (splitEditor) return splitEditor
  // Same classes as the main editor mount, so the typography is identical.
  const wrap = document.createElement('div')
  wrap.className = 'markdown-body rich-editor split-editor-wrap'
  splitBodyEl.appendChild(wrap)
  splitEditor = createRichEditor(wrap, '', () => {
    if (splitLoading) return
    scheduleSplitSave()
  }, {
    ...pageOpts,
    getBaseDir: () => (splitRel ? splitDirAbs() : null),
    resolvePage: async (name) => {
      const page = await window.api.wsResolveLink(name, splitDirRel())
      return page ? { title: page.title, icon: page.icon } : null
    },
    openPage: async (name) => {
      const page = await window.api.wsResolveLink(name, splitDirRel())
      // Following a link in the split pane replaces what that pane shows.
      if (page) await setSplitTarget(page.relPath, 'page', page.title)
    },
    // Must match the main editor: the factory stores these in module scope, so
    // leaving it out would disable the main editor's save-after-insert.
    afterNewPageLink: () => window.setTimeout(flushSave, 60)
  })
  return splitEditor
}

function setSplitStatus(text: string, kind: 'ok' | 'pending' | 'error' = 'ok'): void {
  const el = document.getElementById('split-status')
  if (!el) return
  el.textContent = text
  el.classList.toggle('ok', kind === 'ok')
  el.classList.toggle('pending', kind === 'pending')
  el.classList.toggle('error', kind === 'error')
}

function scheduleSplitSave(): void {
  if (!splitRel || splitKind !== 'page' || !splitEditor) return
  splitDirty = true
  setSplitStatus('Unsaved…', 'pending')
  if (splitSaveTimer !== null) window.clearTimeout(splitSaveTimer)
  splitSaveTimer = window.setTimeout(() => {
    splitSaveTimer = null
    void saveSplitNow()
  }, 1200)
}

async function saveSplitNow(): Promise<void> {
  if (!splitRel || splitKind !== 'page' || !splitEditor) return
  // A write is already running: remember that another is owed and let the
  // in-flight one trigger it, instead of dropping this one.
  if (splitSaving) {
    splitSaveQueued = true
    return
  }
  splitSaving = true
  let retry = false
  try {
    const body = splitEditor.getMarkdown()
    const ok = await window.api.wsSave({
      relPath: splitRel,
      title: splitPageTitle || splitTitle,
      icon: splitPageIcon,
      body
    })
    if (ok) {
      splitDirty = false
      setSplitStatus(
        'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      )
    } else {
      retry = true
      setSplitStatus('Save failed — retrying', 'error')
    }
  } catch (err) {
    console.error('[meridiem] split save failed:', err)
    retry = true
    setSplitStatus('Save failed — retrying', 'error')
  } finally {
    splitSaving = false
  }
  if (retry) {
    window.setTimeout(() => void saveSplitNow(), 5000)
    return
  }
  // Edits that arrived during the write, or a save deferred behind it, coalesce
  // into one follow-up.
  if (splitSaveQueued || splitDirty) {
    splitSaveQueued = false
    void saveSplitNow()
  }
}

function splitDirRel(): string | undefined {
  const rel = splitRel ?? ''
  const dir = rel.replace(/\/[^/]*$/, '')
  return dir || undefined
}

let splitRootCache: string | null = null
async function refreshSplitRoot(): Promise<void> {
  const info = await window.api.wsGet()
  splitRootCache = info.workspace ?? null
}

function splitDirAbs(): string | null {
  if (!splitRootCache || !splitRel) return null
  const abs = splitRootCache + '/' + splitRel
  return abs.replace(/\/[^/]*$/, '')
}

/** Grid columns keep the user's chosen pane ratio. */
function applySplitRatio(): void {
  contentRowEl.style.gridTemplateColumns = `minmax(0, ${splitRatio}fr) 10px minmax(0, ${1 - splitRatio}fr)`
}

function splitIconName(kind: string): IconName {
  if (kind === 'split') return 'panel'
  if (kind === 'image') return 'image'
  if (kind === 'file' && splitRel) return fileIconName(splitRel)
  return 'doc'
}

/** The split pane's header icon: the page's own emoji, else line art by kind. */
function paintSplitIcon(kind: string, pageIcon?: string): void {
  applyIcon(splitIconEl, pageIcon, splitIconName(kind), 13)
}

function setActivePane(pane: 'left' | 'right'): void {
  if (!splitOpen) pane = 'left'
  activePane = pane
  contentLeftEl.classList.toggle('active', pane === 'left')
  splitRightEl.classList.toggle('active', pane === 'right')
  contentRowEl.classList.toggle('split', splitOpen)
  renderTabs()
  renderBreadcrumbs()
}

/** The page/file the user is working on right now (sidebar, agent, find). */
function activeContext(): { title: string; relPath: string } | null {
  if (splitOpen && activePane === 'right' && splitRel) {
    return { title: splitTitle || splitRel, relPath: splitRel }
  }
  return currentPage ? { title: currentPage.title, relPath: currentPage.relPath } : null
}

function clearSplitBody(): void {
  splitPdfHandle?.destroy()
  splitPdfHandle = null
  // Keep the read-only editor mounted (it is reused); drop anything else.
  for (const child of [...splitBodyEl.children]) {
    if (child.classList.contains('split-editor-wrap')) continue
    child.remove()
  }
  splitBodyEl.scrollTop = 0
}

function closeSplit(): void {
  if (splitDirty) {
    if (splitSaveTimer !== null) {
      window.clearTimeout(splitSaveTimer)
      splitSaveTimer = null
    }
    void saveSplitNow()
  }
  splitOpen = false
  splitRel = null
  splitTitle = ''
  clearSplitBody()
  splitRightEl.hidden = true
  splitResizerEl.hidden = true
  setActivePane('left')
  renderTabs()
}

async function setSplitTarget(rel: string, kind: string, title?: string): Promise<void> {
  // The split pane is a rich-text editor bound to `wsSave`, so a paper put
  // there would be parsed as a page and written back as one. Refused rather
  // than approximated — the main pane is the only place a .qz runs.
  if (kind === 'quiz') {
    console.warn('[meridiem] refusing to split a quiz file:', rel)
    return
  }
  // Picking something else in that pane means leaving the print preview.
  printPreviewOn = false
  splitBodyEl.classList.remove('print-preview')
  // Leaving the current split page: make sure its edits are on disk.
  if (splitDirty) {
    if (splitSaveTimer !== null) {
      window.clearTimeout(splitSaveTimer)
      splitSaveTimer = null
    }
    await saveSplitNow()
  }
  await refreshSplitRoot()
  // Read the page BEFORE rebinding splitRel: while the old page is still the
  // target, a stray save (debounce timer, blur) can't write the old body to the
  // new path.
  const page = kind === 'page' ? await window.api.wsRead(rel) : null
  splitOpen = true
  splitRightEl.hidden = false
  splitRel = rel
  splitKind = kind
  splitTitle = title ?? rel.split('/').filter(Boolean).pop() ?? rel
  splitTitleEl.textContent = splitTitle
  paintSplitIcon(kind)
  clearSplitBody()
  renderTabs()

  if (kind === 'page') {
    if (!page) {
      splitBodyEl.innerHTML = '<div class="split-note">Could not read this page.</div>'
      return
    }
    splitPageTitle = page.title
    splitPageIcon = page.icon
    splitTitle = page.title
    splitTitleEl.textContent = splitTitle
    paintSplitIcon('page', page.icon)
    const editor = ensureSplitEditor()
    splitLoading = true
    try {
      editor.setContent(page.body)
    } finally {
      splitLoading = false
    }
    splitDirty = false
    setSplitStatus('')
    return
  }
  if (kind === 'image') {
    const info = await window.api.wsGet()
    const abs = info.workspace && !rel.startsWith('/') ? info.workspace + '/' + rel : rel
    const img = document.createElement('img')
    img.className = 'split-image'
    img.src = localFileUrl(abs)
    splitBodyEl.appendChild(img)
    return
  }
  if (kind === 'pdf') {
    const info = await window.api.wsGet()
    const abs = info.workspace && !rel.startsWith('/') ? info.workspace + '/' + rel : rel
    const bytes = await window.api.readBytes(abs)
    if (!bytes || bytes.byteLength === 0) {
      splitBodyEl.innerHTML = '<div class="split-note">Could not read this PDF.</div>'
      return
    }
    try {
      splitPdfHandle = await createPdfViewer({ container: splitBodyEl, bytes })
    } catch {
      splitBodyEl.innerHTML = '<div class="split-note">Could not display this PDF.</div>'
    }
    return
  }
  // plain text / other files: show the source
  const file = await window.api.readTextFile(rel)
  const pre = document.createElement('pre')
  pre.className = 'split-text'
  pre.textContent = file?.content ?? '(empty)'
  splitBodyEl.appendChild(pre)
}

/** The menu shown when the pane has nothing in it: other tabs, or a page list. */
function showSplitPicker(): void {
  clearSplitBody()
  splitTitleEl.textContent = 'Split'
  paintSplitIcon('split')

  const wrap = document.createElement('div')
  wrap.className = 'split-picker'

  const others = tabs.filter((t) => t.relPath !== tabs[activeTab]?.relPath)
  if (others.length > 0) {
    const label = document.createElement('div')
    label.className = 'split-picker-label'
    label.textContent = 'Open tabs'
    wrap.appendChild(label)
    for (const t of others) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'split-picker-row'
      const icon = document.createElement('span')
      icon.className = 'split-picker-icon'
      paintTabIcon(icon, t)
      const name = document.createElement('span')
      name.className = 'split-picker-name'
      name.textContent = t.title
      row.append(icon, name)
      row.addEventListener('click', () => void setSplitTarget(t.relPath, t.kind, t.title))
      wrap.appendChild(row)
    }
  }

  const search = document.createElement('input')
  search.className = 'split-picker-search'
  search.placeholder = others.length > 0 ? 'Or search every page…' : 'Search pages to open here…'
  search.spellcheck = false
  wrap.appendChild(search)

  const list = document.createElement('div')
  list.className = 'split-picker-list'
  wrap.appendChild(list)
  splitBodyEl.appendChild(wrap)

  let all: { title: string; icon: string; relPath: string }[] = []
  const draw = (): void => {
    const q = search.value.trim().toLowerCase()
    list.innerHTML = ''
    const matches = (q
      ? all.filter((p) => p.title.toLowerCase().includes(q) || p.relPath.toLowerCase().includes(q))
      : all
    ).slice(0, 60)
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'split-note'
      empty.textContent = q ? 'No pages match.' : 'No pages yet.'
      list.appendChild(empty)
      return
    }
    for (const p of matches) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'split-picker-row'
      const icon = document.createElement('span')
      icon.className = 'split-picker-icon'
      applyIcon(icon, p.icon, 'doc', 13)
      const name = document.createElement('span')
      name.className = 'split-picker-name'
      name.textContent = p.title
      const path = document.createElement('span')
      path.className = 'split-picker-path'
      const parent = p.relPath.includes('/') ? p.relPath.slice(0, p.relPath.lastIndexOf('/')) : ''
      path.textContent = parent
      row.append(icon, name, path)
      row.addEventListener('click', () => void setSplitTarget(p.relPath, 'page', p.title))
      list.appendChild(row)
    }
  }
  search.addEventListener('input', draw)
  void window.api.wsAllPages().then((pages) => {
    all = pages
    draw()
  })
  requestAnimationFrame(() => search.focus())
}

function openSplit(): void {
  splitOpen = true
  splitRightEl.hidden = false
  splitResizerEl.hidden = false
  applySplitRatio()
  setActivePane('right')
  const other = tabs.find((t) => t.relPath !== tabs[activeTab]?.relPath)
  if (other) void setSplitTarget(other.relPath, other.kind, other.title)
  else showSplitPicker()
}

function toggleSplit(): void {
  if (splitOpen) closeSplit()
  else openSplit()
}

splitResizerEl.addEventListener('pointerdown', (down: PointerEvent) => {
  down.preventDefault()
  splitResizerEl.setPointerCapture(down.pointerId)
  document.body.classList.add('resizing-h')
  const rect = contentRowEl.getBoundingClientRect()
  const onMove = (move: PointerEvent): void => {
    const ratio = (move.clientX - rect.left) / Math.max(1, rect.width)
    splitRatio = Math.min(0.8, Math.max(0.2, ratio))
    applySplitRatio()
  }
  const onUp = (): void => {
    splitResizerEl.removeEventListener('pointermove', onMove)
    splitResizerEl.removeEventListener('pointerup', onUp)
    splitResizerEl.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('resizing-h')
    void window.api.setSettings('splitRatio', splitRatio)
  }
  splitResizerEl.addEventListener('pointermove', onMove)
  splitResizerEl.addEventListener('pointerup', onUp)
  splitResizerEl.addEventListener('pointercancel', onUp)
})

document.getElementById('toggle-split-btn')!.addEventListener('click', () => toggleSplit())
document.getElementById('split-close')!.addEventListener('click', () => closeSplit())
document.getElementById('split-change')!.addEventListener('click', () => showSplitPicker())

// Clicking a pane makes it the one the rest of the app acts on.
contentLeftEl.addEventListener('mousedown', () => setActivePane('left'), true)
splitRightEl.addEventListener('mousedown', () => setActivePane('right'), true)

// ---------------------------------------------------------------------------
// Find in page (⌘F): highlights matches in whatever pane is showing — the rich
// editor, the source editor, a text file or the PDF text layer — with a compact
// bar instead of a full-screen dialog. Uses the CSS Custom Highlight API so
// nothing in the document DOM is modified (ProseMirror stays untouched).
// ---------------------------------------------------------------------------
const findBarEl = document.getElementById('find-bar') as HTMLElement
const findInputEl = document.getElementById('find-input') as HTMLInputElement
const findCountEl = document.getElementById('find-count') as HTMLElement
let findRanges: Range[] = []
let findIndex = 0
let findTimer: number | null = null

function findRoots(): HTMLElement[] {
  const roots: HTMLElement[] = []
  // Search whichever pane is active, so matches land where the user is looking.
  if (splitOpen && activePane === 'right') {
    if (splitRel && splitKind === 'page') roots.push(splitBodyEl)
    else if (splitRel && (splitKind === 'file' || splitKind === 'binary')) roots.push(splitBodyEl)
    return roots
  }
  if (!pageViewEl.hidden) {
    // Split view shows both surfaces; search whichever are visible.
    for (const sel of ['.rich-editor .ProseMirror', '.cm-content']) {
      const el = pageViewEl.querySelector(sel) as HTMLElement | null
      if (el && el.offsetParent !== null) roots.push(el)
    }
  }
  if (!pdfPaneEl.hidden) {
    const el = pdfPaneEl.querySelector('.pdf-pages') as HTMLElement | null
    if (el) roots.push(el)
  }
  if (!textPaneEl.hidden) {
    const el = textMountEl.querySelector('.cm-content') as HTMLElement | null
    if (el) roots.push(el)
  }
  return roots
}

const MAX_FIND_MATCHES = 800

function collectFindMatches(query: string): Range[] {
  const q = query.toLowerCase()
  const out: Range[] = []
  if (!q) return out
  for (const root of findRoots()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let text = ''
    let n: Node | null
    while ((n = walker.nextNode())) {
      const t = n as Text
      nodes.push(t)
      text += t.data
    }
    if (!text) continue
    const lower = text.toLowerCase()
    const locate = (index: number): { node: Text; offset: number } | null => {
      let acc = 0
      for (const node of nodes) {
        const len = node.data.length
        if (index <= acc + len) return { node, offset: index - acc }
        acc += len
      }
      const last = nodes[nodes.length - 1]
      return last ? { node: last, offset: last.data.length } : null
    }
    let from = 0
    while (out.length < MAX_FIND_MATCHES) {
      const at = lower.indexOf(q, from)
      if (at < 0) break
      const start = locate(at)
      const end = locate(at + q.length)
      if (start && end) {
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        out.push(range)
      }
      from = at + Math.max(1, q.length)
    }
    if (out.length >= MAX_FIND_MATCHES) break
  }
  return out
}

function paintFindHighlights(): void {
  const anyCss = CSS as unknown as { highlights?: Map<string, unknown> }
  if (!anyCss.highlights) return // older Chromium: search still scrolls, no tint
  const rest = new Highlight()
  const current = new Highlight()
  findRanges.forEach((range, i) => (i === findIndex ? current : rest).add(range))
  anyCss.highlights.set('yestion-find', rest)
  anyCss.highlights.set('yestion-find-current', current)
}

function clearFindHighlights(): void {
  const anyCss = CSS as unknown as { highlights?: Map<string, unknown> }
  anyCss.highlights?.delete('yestion-find')
  anyCss.highlights?.delete('yestion-find-current')
}

function updateFindCount(): void {
  findCountEl.textContent = findRanges.length ? `${findIndex + 1}/${findRanges.length}` : findInputEl.value ? '0/0' : ''
}

function scrollToFindMatch(): void {
  const range = findRanges[findIndex]
  if (!range) return
  const el =
    (range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement)) ?? null
  el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
}

function runFind(resetIndex = true): void {
  findRanges = collectFindMatches(findInputEl.value.trim())
  if (resetIndex || findIndex >= findRanges.length) findIndex = 0
  paintFindHighlights()
  updateFindCount()
  if (findRanges.length) scrollToFindMatch()
}

function stepFind(delta: number): void {
  if (findRanges.length === 0) return
  findIndex = (findIndex + delta + findRanges.length) % findRanges.length
  paintFindHighlights()
  updateFindCount()
  scrollToFindMatch()
}

/** The find bar lives in the breadcrumb card, which sits directly under the
 *  38px titlebar; its offsetParent is that card, so a small inset is all it
 *  needs. (The old code measured the removed command bar's viewport offset.) */
function placeFindBar(): void {
  findBarEl.style.top = '6px'
}

/** Hand focus back to the document. The find bar and search modal steal focus
 *  when they open, so dismissing them used to leave the caret nowhere and the
 *  next keystroke went into the void. */
function focusEditorSurface(): void {
  if (pageViewEl.hidden) return // a PDF / text / image tab is the visible one
  if (viewMode === 'source') codeEditor.view.focus()
  else richEditor.focus()
}

function openFind(): void {
  findBarEl.hidden = false
  placeFindBar()
  findInputEl.focus()
  findInputEl.select()
  if (findInputEl.value.trim()) runFind()
}

/** `restoreFocus` is false when the caller is about to show a different page
 *  anyway (opening one closes the bar as a side effect). */
function closeFind(restoreFocus = false): HTMLElement | null {
  if (findBarEl.hidden) return null
  findBarEl.hidden = true
  findRanges = []
  clearFindHighlights()
  findCountEl.textContent = ''
  if (restoreFocus) focusEditorSurface()
  return findBarEl
}

findInputEl.addEventListener('input', () => {
  if (findTimer !== null) window.clearTimeout(findTimer)
  findTimer = window.setTimeout(() => {
    findTimer = null
    runFind()
  }, 120)
})

findInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    stepFind(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind(true)
  }
})

window.addEventListener('resize', () => {
  if (!findBarEl.hidden) placeFindBar()
})

document.getElementById('find-next')!.addEventListener('click', () => stepFind(1))
document.getElementById('find-prev')!.addEventListener('click', () => stepFind(-1))
document.getElementById('find-close')!.addEventListener('click', () => closeFind(true))

// ---------------------------------------------------------------------------
// Workspace search (⌘⇧F): page titles, file names and markdown content.
// ---------------------------------------------------------------------------
interface SearchHit {
  relPath: string
  title: string
  icon: string
  kind: string
  line: number
  snippet: string
}

const searchModalEl = document.getElementById('search-modal') as HTMLElement
const searchInputEl = document.getElementById('search-input') as HTMLInputElement
const searchResultsEl = document.getElementById('search-results') as HTMLElement
const searchCountEl = document.getElementById('search-count') as HTMLElement
let searchHits: SearchHit[] = []
let searchActive = 0
let searchTimer: number | null = null
let searchSeq = 0

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function searchIconName(hit: SearchHit): IconName {
  if (hit.kind === 'pdf') return 'doc'
  if (hit.kind === 'image') return 'image'
  if (hit.kind === 'file') return fileIconName(hit.relPath)
  if (hit.kind === 'quiz') return 'quiz'
  return 'doc'
}

function renderSearchResults(): void {
  searchResultsEl.innerHTML = ''
  if (searchHits.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'search-empty'
    empty.textContent = searchInputEl.value.trim() ? 'No matches.' : 'Type to search titles, file names and page content.'
    searchResultsEl.appendChild(empty)
    searchCountEl.textContent = ''
    return
  }
  if (searchActive >= searchHits.length) searchActive = 0
  searchCountEl.textContent = `${searchHits.length} result${searchHits.length === 1 ? '' : 's'}`
  const q = searchInputEl.value.trim()
  searchHits.forEach((hit, i) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'search-hit' + (i === searchActive ? ' active' : '')
    const icon = document.createElement('span')
    icon.className = 'search-hit-icon'
    applyIcon(icon, hit.icon, searchIconName(hit), 14)
    const title = document.createElement('span')
    title.className = 'search-hit-title'
    const parent = hit.relPath.includes('/') ? hit.relPath.slice(0, hit.relPath.lastIndexOf('/')) : ''
    title.innerHTML =
      escapeHtml(hit.title) +
      (parent ? ` <span class="search-hit-path">${escapeHtml(parent)}</span>` : '')
    const snippet = document.createElement('span')
    snippet.className = 'search-hit-snippet'
    const text = hit.snippet || ''
    if (text && q) {
      const at = text.toLowerCase().indexOf(q.toLowerCase())
      if (at >= 0) {
        snippet.innerHTML =
          escapeHtml(text.slice(0, at)) +
          '<mark>' +
          escapeHtml(text.slice(at, at + q.length)) +
          '</mark>' +
          escapeHtml(text.slice(at + q.length))
      } else {
        snippet.textContent = text
      }
    } else {
      snippet.textContent = text
    }
    row.append(icon, title, snippet)
    row.addEventListener('mouseover', () => {
      if (searchActive === i) return
      searchActive = i
      // Paint just the highlight — rebuilding every result row on each pointer
      // move made hovering a long result list feel like molasses.
      for (const el of searchResultsEl.querySelectorAll('.search-hit.active')) el.classList.remove('active')
      row.classList.add('active')
    })
    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      openSearchHit(i, e.metaKey || e.ctrlKey)
    })
    if (i === searchActive) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }))
    searchResultsEl.appendChild(row)
  })
}

async function runSearch(): Promise<void> {
  const q = searchInputEl.value.trim()
  const seq = ++searchSeq
  if (!q) {
    searchHits = []
    searchActive = 0
    renderSearchResults()
    return
  }
  const hits = await window.api.wsSearch(q)
  if (seq !== searchSeq) return // a newer query already went out
  searchHits = hits
  searchActive = 0
  renderSearchResults()
}

function openSearchHit(index: number, newTab = false): void {
  const hit = searchHits[index]
  if (!hit) return
  closeSearch()
  const kind = hit.kind === 'page' ? 'page' : hit.kind
  void openRel(hit.relPath, kind, newTab)
}

function openSearch(): void {
  searchModalEl.hidden = false
  searchInputEl.value = ''
  searchHits = []
  searchActive = 0
  renderSearchResults()
  searchInputEl.focus()
}

function closeSearch(restoreFocus = false): HTMLElement | null {
  if (searchModalEl.hidden) return null
  searchModalEl.hidden = true
  if (restoreFocus) focusEditorSurface()
  return searchModalEl
}

searchInputEl.addEventListener('input', () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void runSearch()
  }, 150)
})

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (searchHits.length) {
      searchActive = (searchActive + 1) % searchHits.length
      renderSearchResults()
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (searchHits.length) {
      searchActive = (searchActive - 1 + searchHits.length) % searchHits.length
      renderSearchResults()
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    openSearchHit(searchActive, e.metaKey || e.ctrlKey)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch(true)
  }
})

searchModalEl.addEventListener('mousedown', (e) => {
  if (e.target === searchModalEl) closeSearch(true)
})

// ⌘F / ⌘⇧F are dispatched by the central keybind registry (see keybinds.ts).

// ---------------------------------------------------------------------------
// Top command bar: theme picker, panel toggles. Plus the sidebar's
// Open Editors and Outline sections.
// ---------------------------------------------------------------------------
const themeSelectEl = document.getElementById('theme-select') as HTMLSelectElement | null

function buildThemeSelect(): void {
  if (!themeSelectEl) return
  themeSelectEl.innerHTML = ''
  for (const t of THEMES) {
    const opt = document.createElement('option')
    opt.value = t.id
    opt.textContent = t.label
    themeSelectEl.appendChild(opt)
  }
  syncThemeSelect()
}
themeSelectEl?.addEventListener('change', () => {
  if (themeSelectEl) setTheme(themeSelectEl.value)
})

function setSidebarOpen(open: boolean, persist = true): void {
  ;(document.getElementById('sidebar') as HTMLElement).hidden = !open
  ;(document.getElementById('sidebar-resizer') as HTMLElement).hidden = !open
  document.getElementById('toggle-sidebar-btn')?.classList.toggle('active', open)
  if (persist) void window.api.setSettings('sidebarOpen', open)
}

document.getElementById('page-mode-btn')!.addEventListener('click', () => togglePrintPreview())
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    togglePrintPreview()
  }
})

document.getElementById('nav-back')!.addEventListener('click', () => goBack())
document.getElementById('nav-forward')!.addEventListener('click', () => goForward())
// ⌘[ / ⌘] are dispatched by the keybind registry, so they can be rebound.

document.getElementById('toggle-sidebar-btn')!.addEventListener('click', () => {
  const sb = document.getElementById('sidebar') as HTMLElement
  setSidebarOpen(sb.hidden as boolean)
})

// ---- Octarine titlebar, sidebar views, quick search, focus mode ----
document.getElementById('quick-search-btn')!.addEventListener('click', () => openSearch())
document.getElementById('titlebar-new-note')!.addEventListener('click', () => void createNewPage(null))
document.getElementById('mode-notes')!.addEventListener('click', () => void activateSidebarMode('notes'))
document.getElementById('mode-templates')!.addEventListener('click', () => void activateSidebarMode('templates'))
document.getElementById('mode-views')!.addEventListener('click', () => void activateSidebarMode('views'))
document.getElementById('mode-graph')!.addEventListener('click', () => void activateSidebarMode('graph'))
document.getElementById('mode-inbox')!.addEventListener('click', () => void activateSidebarMode('inbox'))
document.getElementById('mode-tasks')!.addEventListener('click', () => void activateSidebarMode('tasks'))
document.getElementById('mode-media')!.addEventListener('click', () => void activateSidebarMode('media'))
document.getElementById('new-template-btn')?.addEventListener('click', () => void newTemplate())
document.getElementById('pin-note-btn')?.addEventListener('click', () => togglePinCurrent())
document.getElementById('crumb-focus-btn')?.addEventListener('click', () => {
  if (!focusMode) toggleFocusMode()
})

// ⌘K opens the workspace palette (the registry owns the shortcut).

let focusMode = false
let focusRestore: { sidebar: boolean; agent: boolean } | null = null

function toggleFocusMode(): void {
  const sidebar = document.getElementById('sidebar') as HTMLElement
  const sideResizer = document.getElementById('sidebar-resizer') as HTMLElement
  const agent = document.getElementById('agent-panel') as HTMLElement
  const agentResizer = document.getElementById('agent-resizer') as HTMLElement
  focusMode = !focusMode
  if (focusMode) {
    focusRestore = { sidebar: !sidebar.hidden, agent: !agent.hidden }
    sidebar.hidden = true
    sideResizer.hidden = true
    agent.hidden = true
    agentResizer.hidden = true
    agentPanel?.dismissFloats()
  } else if (focusRestore) {
    sidebar.hidden = !focusRestore.sidebar
    sideResizer.hidden = !focusRestore.sidebar
    agent.hidden = !focusRestore.agent
    agentResizer.hidden = !focusRestore.agent
    focusRestore = null
  }
  document.body.classList.toggle('focus-mode', focusMode)
  document.getElementById('focus-mode-btn')!.classList.toggle('active', focusMode)
  document.getElementById('toggle-sidebar-btn')!.classList.toggle('active', !sidebar.hidden)
}
document.getElementById('focus-mode-btn')!.addEventListener('click', () => toggleFocusMode())
window.addEventListener('keydown', (e) => {
  // ⌘. is the Mac "cancel" gesture and should leave focus mode from anywhere.
  if ((e.metaKey || e.ctrlKey) && e.key === '.') {
    e.preventDefault()
    if (focusMode) toggleFocusMode()
  }
})


// ---- Open Editors (mirrors the tab strip) ----
function renderOpenEditors(): void {
  const host = document.getElementById('open-editors')
  if (!host) return
  host.innerHTML = ''
  if (tabs.length === 0) {
    const hint = document.createElement('div')
    hint.className = 'sidebar-empty'
    hint.textContent = 'No open pages'
    host.appendChild(hint)
    return
  }
  tabs.forEach((tab, i) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'oe-row' + (i === activeTab ? ' current' : '')
    const icon = document.createElement('span')
    icon.className = 'oe-icon'
    paintTabIcon(icon, tab)
    const label = document.createElement('span')
    label.className = 'oe-label'
    label.textContent = tab.title
    const close = document.createElement('span')
    close.className = 'oe-close'
    close.textContent = '×'
    close.title = 'Close'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(i)
    })
    row.append(icon, label, close)
    row.addEventListener('click', () => {
      // A blank tab has no file to put in a split pane — always go to it.
      if (tab.kind !== 'new' && splitOpen && activePane === 'right' && tab.relPath !== tabs[activeTab]?.relPath) {
        void setSplitTarget(tab.relPath, tab.kind, tab.title)
        return
      }
      void activateTab(i)
    })
    host.appendChild(row)
  })
}

// ---- Outline (headings of the current page) ----
let outlineTimer: number | null = null

function renderOutline(): void {
  const host = document.getElementById('page-outline') as HTMLElement
  host.innerHTML = ''
  const editor = document.querySelector('.rich-editor .ProseMirror') as HTMLElement | null
  const headings = editor && !pageViewEl.hidden
    ? ([...editor.querySelectorAll('h1, h2, h3, h4')] as HTMLElement[])
    : []
  if (headings.length === 0) {
    const hint = document.createElement('div')
    hint.className = 'sidebar-empty'
    hint.textContent = 'No headings'
    host.appendChild(hint)
    return
  }
  let minLevel = 9
  for (const h of headings) minLevel = Math.min(minLevel, Number(h.tagName[1]))
  // Indent by depth, but never hide by depth. The old "two levels below the
  // page's shallowest heading" rule silently dropped whole sections on a page
  // that mixes habits — a sheet whose body is ###/#### and which later gains a
  // single # showed only that # and the ##s under it.
  for (const h of headings) {
    const level = Number(h.tagName[1])
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'outline-row'
    row.style.paddingLeft = `${10 + (level - minLevel) * 14}px`
    row.textContent = h.textContent?.trim() || '(untitled)'
    row.addEventListener('click', () => {
      if (viewMode !== 'rich') {
        viewMode = 'rich'
        applyViewMode()
      }
      h.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
    host.appendChild(row)
  }
}

function scheduleOutline(delay = 250): void {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null
    renderOutline()
  }, delay)
}

const outlineObserver = new MutationObserver(() => scheduleOutline())

function watchOutline(): void {
  const editor = document.querySelector('.rich-editor .ProseMirror')
  if (editor) outlineObserver.observe(editor, { childList: true, subtree: true })
}

let bootSeq = 0

// Set once the agent panel exists; lets workspace switching reset it without a
// circular reference at module scope.
let restartAgentPanel: (() => Promise<void>) | null = null
/** The live agent panel. Switching workspaces points it at the new root. */
let agentPanel: ReturnType<typeof setupAgentPanel> | null = null

async function initWorkspace(): Promise<void> {
  const seq = ++bootSeq
  const res = await window.api.wsGet()
  if (seq !== bootSeq) return // superseded by a newer boot
  const base = res.workspace
  workspaceRootCache = base
  if (base !== cacheWorkspacePath) {
    // Remember where this workspace was, so coming back to it restores its own
    // tabs. Without this, a switch restored the other workspace's tab list,
    // every entry of which fails to open — leaving a blank window.
    if (cacheWorkspacePath) tabsByWorkspace.set(cacheWorkspacePath, { tabs: tabs.map((t) => ({ ...t })), activeTab })
    // A different workspace may reuse the same relative paths — start clean.
    pageCache.clear()
    cacheWorkspacePath = base
    // The agent panel holds its own copy of the workspace root (session
    // reopen, agentSessionRoot); it must follow us or it keeps pointing at the
    // folder we just left.
    void agentPanel?.setWorkspace(base)
    // "Recent" holds workspace-relative paths, so it starts over with the
    // workspace and is only adopted back when it belongs to this one.
    recentItems = []
  }
  paintSidebarMode('notes')
  refreshPinned()
  if (!base) {
    showOnlyPane(null)
    welcomeEl.hidden = false
    emptyStateEl.hidden = true
    pageLoaderEl.hidden = true
    return
  }
  const info = await window.api.wsGet()
  const storedRecents = (await window.api.getSettings('recentPages')) as
    | { root?: string; items?: NewTabItem[] }
    | undefined
  if (storedRecents?.root === base && Array.isArray(storedRecents.items)) recentItems = storedRecents.items
  if (info.locked && info.displayPath) {
    // Encrypted workspace that hasn't been unlocked in this run.
    pageCache.clear() // never keep decrypted pages resident once locked
    const lockedView = document.getElementById('locked-view') as HTMLElement
    ;(document.getElementById('locked-title') as HTMLElement).textContent = info.displayPath.split('/').pop()?.replace(/^\./, '').replace(/\.yestion$/, '') || 'Private workspace'
    lockedView.hidden = false
    showOnlyPane(null)
    welcomeEl.hidden = true
    emptyStateEl.hidden = true
    pageLoaderEl.hidden = true
    workspaceNameEl.textContent = (info.displayPath.split('/').pop() ?? '').replace(/^\./, '').replace(/\.yestion$/, '')
    return
  }
  ;(document.getElementById('locked-view') as HTMLElement).hidden = true
  const display = info.displayPath ?? base
  const isPrivate = !!info.private
  const name = info.name || display.split('/').pop() || 'Meridiem'
  // The switcher's own icon carries the lock; the name doesn't need to repeat
  // it as a sticker.
  workspaceNameEl.textContent = name
  const sidebarWsName = document.getElementById('sidebar-ws-name')
  if (sidebarWsName) sidebarWsName.textContent = name
  wsIconEl.innerHTML = iconSvg(isPrivate ? 'lock' : 'folder', 16)
  lockBtn.hidden = !isPrivate
  ;(document.getElementById('workspace-switcher') as HTMLButtonElement).title = display
  // The agent can't read an encrypted workspace; make that visible instead of
  // failing on the first prompt.
  const agentToggle = document.getElementById('toggle-agent-btn') as HTMLButtonElement | null
  if (agentToggle) {
    agentToggle.disabled = isPrivate
    agentToggle.title = isPrivate ? 'The agent is unavailable in private workspaces' : 'Toggle agent panel'
  }
  if (isPrivate && !(document.getElementById('agent-panel') as HTMLElement).hidden) {
    ;(document.getElementById('agent-panel') as HTMLElement).hidden = true
    await restartAgentPanel?.()
  }
  welcomeEl.hidden = true
  emptyStateEl.hidden = true
  pageLoaderEl.hidden = false
  try {
    const tree = await window.api.wsTree()
    if (seq !== bootSeq) return
    lastRoot = tree
    setupSidebar(tree, {
      currentRel: currentPage?.relPath ?? null,
      notesOnly: true,
      onOpen: (rel, kind, newTab) => {
        void openRel(rel, kind, newTab === true)
      }
    })
    refreshDailySurfaces()
    const firstRel = findFirstPage(tree)
    const restored = await restoreTabs(tabsByWorkspace.get(base))
    if (!restored && firstRel) {
      // No tabs were open when we last left, so the window opens on Home rather
      // than silently picking a note for the reader.
      showNewTab()
      paintSidebarMode('notes')
    } else if (!restored) {
      showOnlyPane(null)
      emptyStateEl.hidden = false
    }
  } finally {
    if (seq === bootSeq) pageLoaderEl.hidden = true
  }
}

function findFirstPage(node: { kind: string; relPath: string; children?: unknown[] }): string | null {
  if (node.kind === 'page' || node.kind === 'quiz') return node.relPath
  for (const child of (node.children ?? []) as { kind: string; relPath: string; children?: unknown[] }[]) {
    const found = findFirstPage(child)
    if (found) return found
  }
  return null
}

// ---- resizable bars ----
function attachResizer(handleId: string, targetId: string, settingKey: 'sidebarWidth' | 'agentWidth', min: number, max: number): void {
  const handle = document.getElementById(handleId) as HTMLElement
  const target = document.getElementById(targetId) as HTMLElement
  if (!handle || !target) return
  handle.addEventListener('pointerdown', (downEvent) => {
    downEvent.preventDefault()
    handle.setPointerCapture(downEvent.pointerId)
    const startX = downEvent.clientX
    const isSidebar = settingKey === 'sidebarWidth'
    const startWidth = target.getBoundingClientRect().width
    document.body.classList.add('resizing-h')
    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX
      const width = Math.min(max, Math.max(min, isSidebar ? startWidth + dx : startWidth - dx))
      target.style.flexBasis = width + 'px'
      void window.api.setSettings(settingKey, Math.round(width))
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('resizing-h')
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  })
}

// ---- boot ----
async function init(): Promise<void> {
  // One round trip for the workspace info and one for all settings — boot used
  // to await ~20 separate settings:get calls, one after another.
  const [res, settings] = await Promise.all([window.api.wsGet(), window.api.getSettingsAll()])
  const setting = <T,>(key: string, fallback: T): T => {
    const v = settings[key]
    return v === undefined || v === null ? fallback : (v as T)
  }
  const savedTheme = res.theme ?? 'octarineDark'
  setTheme(savedTheme)
  // "Follow macOS System" must follow live, not only at launch.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeId === 'system') setTheme('system')
  })
  applyPreviewFont(res.previewFont ?? 'default')
  applyRenderSize(setting('renderFontSize', 'm'))
  setCountMode(setting<CountMode>('wordCountMode', 'words') === 'asian' ? 'asian' : 'words')
  const previewBtn = document.getElementById('page-mode-btn')
  if (previewBtn) previewBtn.textContent = 'Preview'
  // Older builds stored the paper's title/icon switches separately
  // (exportTitle/exportIcon); fall back to them so an existing settings file
  // keeps the choice it was showing.
  showPageTitle = setting('showPageTitle', setting('exportTitle', true))
  showPageIcon = setting('showPageIcon', setting('exportIcon', true))
  applyPageDisplay()
  exportMargin = setting('exportMargin', 'medium' as ExportMargin)
  applyExportMenuState()

  const wsModal = document.getElementById('workspace-modal') as HTMLElement
  const closeWsModal = (): HTMLElement | null => {
    if (wsModal.hidden) return null
    wsModal.hidden = true
    return wsModal
  }
  registerFloatCloser(closeWsModal)
  const showWsModal = (): void => {
    wsModal.hidden = false
    void (async () => {
      const info = await window.api.wsGet()
      ;(document.getElementById('ws-current') as HTMLElement).textContent = info.workspace ?? 'No workspace'
    })()
    ;(document.getElementById('create-name') as HTMLInputElement).focus()
  }
  // The header switcher opens the workspace dropdown (wired with the dropdown
  // code below); the welcome screen still opens the create/open modal.
  document.getElementById('welcome-create')!.addEventListener('click', showWsModal)
  document.getElementById('welcome-open')!.addEventListener('click', () => void openExistingWorkspace())
  document.getElementById('ws-modal-close')!.addEventListener('click', () => {
    closeWsModal()
  })
  wsModal.addEventListener('mousedown', (e) => {
    if (e.target === wsModal) closeWsModal()
  })
  document.getElementById('ws-open-existing')!.addEventListener('click', () => {
    wsModal.hidden = true
    void openExistingWorkspace()
  })
  document.getElementById('create-choose-loc')!.addEventListener('click', () => {
    void (async () => {
      const dir = await window.api.dirChoose()
      if (dir) (document.getElementById('create-location') as HTMLInputElement).value = dir
    })()
  })
  document.getElementById('create-submit')!.addEventListener('click', () => {
    void (async () => {
      const name = (document.getElementById('create-name') as HTMLInputElement).value.trim()
      const parentDir = (document.getElementById('create-location') as HTMLInputElement).value.trim()
      const isPrivate = (document.getElementById('create-private') as HTMLInputElement).checked
      const err = document.getElementById('create-error') as HTMLElement
      if (!name || !parentDir) {
        err.textContent = 'Give the workspace a name and choose a location.'
        err.hidden = false
        return
      }
      if (isPrivate) {
        wsModal.hidden = true
        openPasswordGate({ mode: 'create' })
        return
      }
      await window.api.wsCreateWorkspace({ name, parentDir })
      wsModal.hidden = true
      await initWorkspace()
    })()
  })
  document.getElementById('create-convert')!.addEventListener('click', () => {
    void (async () => {
      const dir = await window.api.dirChoose()
      if (!dir) return
      await window.api.wsConvertWorkspace({ root: dir })
      wsModal.hidden = true
      await initWorkspace()
    })()
  })
  document.getElementById('open-in-finder')?.addEventListener('click', () => void window.api.wsOpenInFinder())
  const openExternal = (): void => {
    void (async () => {
      if (!currentFile && currentPdfPath) {
        await window.api.openPath(currentPdfPath)
        return
      }
      const rel = currentFile?.relPath ?? (document.getElementById('page-tree') as HTMLElement).dataset.currentRel
      if (!rel) return
      if (currentFile?.absolutePath && !rel.startsWith('/')) {
        await window.api.openPath(currentFile.absolutePath)
        return
      }
      if (rel.startsWith('/')) {
        await window.api.openPath(rel)
        return
      }
      const info = await window.api.wsGet()
      if (info.workspace) await window.api.openPath(info.workspace + '/' + rel)
    })()
  }
  document.getElementById('text-external')!.addEventListener('click', openExternal)
  document.getElementById('pdf-external')!.addEventListener('click', openExternal)
  document.getElementById('image-external')!.addEventListener('click', () => {
    if (currentImagePath) void window.api.openPath(currentImagePath)
  })

  // ---- PDF toolbar ----
  document.getElementById('pdf-zoom-in')!.addEventListener('click', () => pdfHandle?.zoom(0.15))
  document.getElementById('pdf-zoom-out')!.addEventListener('click', () => pdfHandle?.zoom(-0.15))
  document.getElementById('pdf-fit')!.addEventListener('click', () => pdfHandle?.fitWidth())

  // ---- image toolbar ----
  const imageZoomBy = (factor: number): void => {
    imageZoom = Math.max(0.05, Math.min(8, imageZoom * factor))
    applyImageZoom()
  }
  document.getElementById('image-zoom-in')!.addEventListener('click', () => imageZoomBy(1.25))
  document.getElementById('image-zoom-out')!.addEventListener('click', () => imageZoomBy(0.8))
  document.getElementById('image-fit')!.addEventListener('click', () => fitImage())
  document.getElementById('image-actual')!.addEventListener('click', () => {
    imageZoom = 1
    applyImageZoom()
  })
  imageStageEl.addEventListener(
    'wheel',
    (e) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      imageZoomBy(e.deltaY < 0 ? 1.1 : 0.9)
    },
    { passive: false }
  )
  // drag anywhere in the stage to pan a zoomed-in image
  let panning = false
  let panStart = { x: 0, y: 0, left: 0, top: 0 }
  imageStageEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    panning = true
    panStart = { x: e.clientX, y: e.clientY, left: imageStageEl.scrollLeft, top: imageStageEl.scrollTop }
    imageStageEl.classList.add('panning')
  })
  window.addEventListener('mousemove', (e) => {
    if (!panning) return
    imageStageEl.scrollLeft = panStart.left - (e.clientX - panStart.x)
    imageStageEl.scrollTop = panStart.top - (e.clientY - panStart.y)
  })
  window.addEventListener('mouseup', () => {
    if (!panning) return
    panning = false
    imageStageEl.classList.remove('panning')
  })
  document.getElementById('new-root-page')!.addEventListener('click', () => void createNewPage('__root__'))
  const pageTree = document.getElementById('page-tree') as HTMLElement
  pageTree.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest('.tree-item') as HTMLElement | null
    if (row?.dataset.rel) {
      e.preventDefault()
      e.stopPropagation()
      void window.api.showItemMenu({
        relPath: row.dataset.rel,
        kind: row.dataset.kind ?? 'page',
        name: row.querySelector('.tree-label')?.textContent ?? undefined
      })
      return
    }
    if (target.closest('.tree-folder') || target.closest('.tree-branch')) return
    e.preventDefault()
    void createNewPage('__root__')
  })
  document.getElementById('settings-btn')!.addEventListener('click', () => void settingsApi.show())
  document.getElementById('page-type-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePagePillMenu('page-type-menu')
  })
  document.getElementById('page-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePagePillMenu('page-more-menu')
  })
  registerFloatCloser(() => closePagePillMenus())
  document.getElementById('new-page-btn')?.addEventListener('click', () => void createNewPage(null))
  document.getElementById('empty-new-page')!.addEventListener('click', () => void createNewPage(null))
  document.getElementById('toggle-agent-btn')!.addEventListener('click', toggleAgentPanel)
  document.getElementById('agent-close')!.addEventListener('click', toggleAgentPanel)
  toggleSourceBtn.addEventListener('click', toggleSource)
  document.getElementById('export-pdf-btn')!.addEventListener('click', () => {
    toggleExportMenu()
  })
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.export-seg-btn[data-margin]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      exportMargin = (btn.dataset.margin as ExportMargin) ?? 'medium'
      applyExportMenuState()
      schedulePrintPreview(200)
      void window.api.setSettings('exportMargin', exportMargin)
    })
  }
  ;(document.getElementById('export-title') as HTMLInputElement).addEventListener('change', (e) => {
    showPageTitle = (e.target as HTMLInputElement).checked
    void window.api.setSettings('showPageTitle', showPageTitle)
    applyPageDisplay()
  })
  ;(document.getElementById('export-icon') as HTMLInputElement).addEventListener('change', (e) => {
    showPageIcon = (e.target as HTMLInputElement).checked
    void window.api.setSettings('showPageIcon', showPageIcon)
    applyPageDisplay()
  })
  document.getElementById('export-run')!.addEventListener('click', () => void exportPageToPdf())

  // ---- page display options ----
  const pageViewMenu = document.getElementById('page-view-menu') as HTMLElement
  const pageViewBtn = document.getElementById('page-view-btn') as HTMLButtonElement
  pageViewBtn.addEventListener('click', () => {
    applyExportMenuState()
    applyPageDisplay()
    if (pageViewMenu.hidden) anchorFloat(pageViewMenu, pageViewBtn)
    pageViewMenu.hidden = !pageViewMenu.hidden
    pageViewBtn.classList.toggle('open', !pageViewMenu.hidden)
  })
  ;(document.getElementById('pv-title') as HTMLInputElement).addEventListener('change', (e) => {
    showPageTitle = (e.target as HTMLInputElement).checked
    void window.api.setSettings('showPageTitle', showPageTitle)
    applyPageDisplay()
  })
  ;(document.getElementById('pv-icon') as HTMLInputElement).addEventListener('change', (e) => {
    showPageIcon = (e.target as HTMLInputElement).checked
    void window.api.setSettings('showPageIcon', showPageIcon)
    applyPageDisplay()
  })
  const search = document.getElementById('page-search') as HTMLInputElement | null
  // Filtering the tree re-reads the workspace, so debounce so typing a word
  // costs one scan instead of one per keystroke.
  let searchDebounce: number | null = null
  search?.addEventListener('input', () => {
    if (searchDebounce !== null) window.clearTimeout(searchDebounce)
    searchDebounce = window.setTimeout(() => {
      searchDebounce = null
      void refreshTree()
    }, 150)
  })

  const agentApi = setupAgentPanel({
    workspace: res.workspace,
    getContext: () => activeContext(),
    onNeedSettings: () => void settingsApi.show(),
    getAgentSettings: async () => ({
      provider: ((await window.api.getSettings('agentProvider')) as string) || 'anthropic',
      model: ((await window.api.getSettings('agentModel')) as string) || '',
      apiKey: ((await window.api.getSettings('agentApiKey')) as string) || ''
    })
  })
  agentPanel = agentApi

  const sizeSelect = document.getElementById('size-select') as HTMLSelectElement
  for (const s of RENDER_SIZES) {
    const opt = document.createElement('option')
    opt.value = s.id
    opt.textContent = s.label
    sizeSelect.appendChild(opt)
  }
  sizeSelect.value = setting('renderFontSize', 'm')
  applyRenderSize(sizeSelect.value)
  sizeSelect.addEventListener('change', () => {
    applyRenderSize(sizeSelect.value)
    void window.api.setSettings('renderFontSize', sizeSelect.value)
    printPreviewToken = null
    schedulePrintPreview(250)
  })

  const fontSelect = document.getElementById('font-select') as HTMLSelectElement
  fillFontSelect(fontSelect, res.previewFont)
  fontSelect.addEventListener('change', () => applyPreviewFont(fontSelect.value))

  const settingsApi = setupSettings({
    onWorkspaceChanged: () => void initWorkspace(),
    onAgentSettingsChanged: () => void agentApi.restart(),
    onHarnessChanged: (harness) => {
      applyAgentHarness(harness)
      void agentApi.harnessChanged()
    },
    onThemeChange: (id) => setTheme(id),
    onFontChange: (id) => applyPreviewFont(id),
    onCountModeChange: (mode) => setCountMode(mode)
  })
  document.getElementById('agent-off-settings')?.addEventListener('click', () => settingsApi.show())
  // Every navigation/tab/sidebar/focus/daily shortcut goes through one registry
  // so Settings can record and reset them. Menu accelerators remain as a second
  // path (they fire without a renderer key event on macOS).
  keybinds.attach({
    search: () => openSearch(),
    find: () => (findBarEl.hidden ? openFind() : closeFind(true)),
    'find-workspace': () => (searchModalEl.hidden ? openSearch() : closeSearch(true)),
    'nav-back': goBack,
    'nav-forward': goForward,
    'new-tab': () => void newTab(),
    'close-tab': () => closeTab(activeTab),
    'reopen-tab': () => void reopenClosedTab(),
    'next-tab': () => void cycleTab(1),
    'prev-tab': () => void cycleTab(-1),
    'next-tab-bracket': () => void cycleTab(1),
    'prev-tab-bracket': () => void cycleTab(-1),
    'toggle-sidebar': () => {
      const sb = document.getElementById('sidebar')
      setSidebarOpen(sb?.hasAttribute('hidden') ?? false, true)
    },
    'focus-mode': () => toggleFocusMode(),
    'daily-today': () => void openDaily(todayKey()),
    'daily-yesterday': () => void openDaily(shiftDateKey(todayKey(), -1)),
    'daily-tomorrow': () => void openDaily(shiftDateKey(todayKey(), 1)),
    weekly: () => void openWeekly(weekKeyForDate(todayKey())),
    'new-page': () => void createNewPage(null),
    save: () => {
      void persistNow()
      void flushTextFile()
    },
    'toggle-source': () => toggleSource(),
    'export-pdf': () => void exportPageToPdf(),
    'toggle-agent': () => toggleAgentPanel(),
    settings: () => settingsApi.show(),
    'cycle-theme': () => cycleTheme()
  })
  restartAgentPanel = () => agentApi.restart()
  // First run: ask for one endpoint + key + model, then wire the agent to it.
  const onboarding = setupOnboarding({
    onConfigured: () => {
      void agentApi.restart()
      restartAgentPanel?.()
    }
  })
  await onboarding.maybeShow()
  buildThemeSelect()
  paintSidebarMode('notes')
  // The calendar is chrome, not workspace content: draw it even before a folder
  // is open so the sidebar always has its footing.
  refreshDailySurfaces()
  const savedSplitRatio = settings['splitRatio'] as number | undefined
  if (typeof savedSplitRatio === 'number' && savedSplitRatio > 0.2 && savedSplitRatio < 0.8) {
    splitRatio = savedSplitRatio
  }
  applySplitRatio()
  watchOutline()
  setSidebarOpen(setting<boolean>('sidebarOpen', true) !== false, false)
  window.addEventListener('yestion:tree-changed', () => void refreshTree())
  // Actions coming back from the native right-click menu.
  window.api.onItemAction(({ action, relPath, kind }) => {
    void (async () => {
      if (action === 'open') await openRel(relPath, kind, false)
      else if (action === 'new-tab') await openRel(relPath, kind, true)
      else if (action === 'reveal') await window.api.revealPath(relPath)
      else if (action === 'copy-path') await window.api.copyPath(relPath)
      else if (action === 'copy-link') {
        const title =
          kind === 'page' || kind === 'quiz'
            ? (await window.api.wsRead(relPath))?.title ?? relPath
            : relPath
        await navigator.clipboard.writeText('[[' + title + ']]')
      } else if (action === 'close-tab') {
        const i = tabs.findIndex((t) => t.relPath === relPath)
        if (i >= 0) closeTab(i)
      } else if (action === 'close-others') {
        tabs = tabs.filter((t) => t.relPath === relPath)
        activeTab = 0
        renderTabs()
        persistTabs()
        if (tabs[0]) await activateTab(0)
        else await showNothingOpen()
      }
    })()
  })

  // ---- floating surfaces: one dismissal pass for all of them --------------
  // Escape, a click anywhere outside, a scroll, or leaving the window closes
  // whatever is open — including the editor's own menus and the agent's.
  // The find bar and the search palette are things you scroll and alt-tab
  // *while using*; only Escape, an outside click or leaving the page close them.
  registerFloatCloser(() => closeFind(true), { onScroll: false, onBlur: false })
  registerFloatCloser(() => closeSearch(true), { onScroll: false, onBlur: false })
  registerFloatCloser(() => closeWsMenu())
  registerFloatCloser(() => closeExportMenu())
  registerFloatCloser(() => closePageViewMenu())
  registerFloatCloser(() => closeCrumbPop())
  registerFloatCloser(() => closeEmojiPicker())
  registerFloatCloser(() => closePasswordGate())
  registerFloatCloser(() => settingsApi.close())
  registerFloatCloser(() => dismissEditorFloats())
  registerFloatCloser(() => agentApi.dismissFloats())
  installFloatDismissal()

  const sidebarW = settings['sidebarWidth'] as number | undefined
  const agentW = settings['agentWidth'] as number | undefined
  if (typeof sidebarW === 'number') (document.getElementById('sidebar') as HTMLElement).style.flexBasis = sidebarW + 'px'
  if (typeof agentW === 'number') (document.getElementById('agent-panel') as HTMLElement).style.flexBasis = agentW + 'px'
  attachResizer('sidebar-resizer', 'sidebar', 'sidebarWidth', 160, 480)
  attachResizer('agent-resizer', 'agent-panel', 'agentWidth', 260, 640)

  const agentOpen = setting<boolean>('agentOpen', false)
  applyAgentHarness(setting<string>('agentHarness', 'none'))
  const showAgent = agentOpen === true && activeAgentHarness !== 'none'
  ;(document.getElementById('agent-panel') as HTMLElement).hidden = !showAgent
  ;(document.getElementById('agent-resizer') as HTMLElement).hidden = !showAgent
  ;(document.getElementById('toggle-agent-btn') as HTMLElement).classList.toggle('active', showAgent)

  await initWorkspace()
}

// ?print=1 is the hidden print host (see initPrintHost) — the app itself must
// not boot there: no workspace, no watcher, no agent, nothing that writes.
if (new URLSearchParams(location.search).get('print') === '1') initPrintHost()
else void init()
