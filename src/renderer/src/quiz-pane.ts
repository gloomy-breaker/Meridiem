/**
 * quiz-pane.ts — the surface a `.qz` paper runs on.
 *
 * It owns the whole pane: header, paper, clock, results, and the attempt state
 * behind them. That is deliberate. A `.qz` is not a document the page editor can
 * round-trip — the editor's save path writes `---title---` plus a markdown body
 * (`workspace.ts:117-121`), which would replace the question blocks with whatever
 * the editor could see. So no mount point from the page editor appears in this
 * pane, and this module has no access to `wsSave` at all.
 *
 * The source of truth is the raw body plus its parse: the runner is a pure
 * function of `parseQz(body)`, so a re-render is "parse again".
 */
import { renderAgentMarkdown } from './agent-markdown'
import { iconEl } from './icons'
import { resolveImageSrc } from './wysiwyg'
import { gradeAnswer, type Grading } from './quiz-grade'
import {
  formatDuration,
  parseQz,
  resolveScoring,
  stripQzTags,
  type QzDoc,
  type QzParseError,
  type QzPassage,
  type QzQuestion
} from './qz'

export interface QuizRenderInput {
  relPath: string
  title: string
  /** Emoji set by the author in front matter; '' when there is none. */
  icon: string
  /** The raw file body, front matter excluded. */
  body: string
  doc: QzDoc
  /** Absolute folder of the `.qz`, so relative image paths resolve beside it. */
  baseDir?: string | null
}

export interface QuizPaneHandle {
  readonly el: HTMLElement
  render(input: QuizRenderInput): void
  clear(): void
  /** Stop the clock and drop the attempt, e.g. when the tab closes. */
  abandon(): void
}

/**
 * A stand-in for a numbered gap that survives a markdown pass.
 *
 * `renderAgentMarkdown` runs with `html: false`, so a `<span>` written into the
 * source would be escaped into visible text. A bare token passes through
 * untouched and is swapped for the real element once the markup exists.
 */
const gapToken = (n: number): string => `@@qzgap${n}@@`
const GAP_TOKEN_RE = /@@qzgap(\d+)@@/

function replaceGapTokens(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const hits: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.nodeValue?.includes('@@qzgap')) hits.push(node)
  }
  for (const node of hits) {
    const frag = document.createDocumentFragment()
    // split() with a capture group keeps the numbers, at odd indexes.
    const pieces = (node.nodeValue ?? '').split(new RegExp(GAP_TOKEN_RE.source, 'g'))
    pieces.forEach((piece, i) => {
      if (i % 2 === 1) {
        const gap = document.createElement('span')
        gap.className = 'qz-gap'
        gap.textContent = piece
        frag.appendChild(gap)
      } else if (piece) {
        frag.appendChild(document.createTextNode(piece))
      }
    })
    node.parentNode?.replaceChild(frag, node)
  }
}

// ---------------------------------------------------------------------------
// Inline media in a paper
//
// `.qz` bodies go through `stripQzTags` before markdown rendering, which
// removes every tag — including the `<svg>` an author put in a question. Media
// is therefore lifted out first, replaced by a bare token that markdown passes
// through untouched, and put back once the markup exists. `html: false` stays
// on for everything else: a paper's text is not a place for arbitrary HTML.
// ---------------------------------------------------------------------------

const SVG_BLOCK_RE = /<svg\b[\s\S]*?<\/svg\s*>/gi
const IMG_TAG_RE = /<img\b[^>]*?\/?>/gi
const MEDIA_TOKEN_RE = /@@qzmedia(\d+)@@/

/**
 * An inline SVG with its scripting surfaces removed.
 *
 * Parsed through an HTML template, not an XML document: the HTML parser puts
 * `<svg>` in the SVG namespace *and* in this document, so it gets the normal
 * element behaviour (CSS sizing, `style`) and lays out like any other diagram.
 */
function safeSvg(raw: string): Element | null {
  const t = document.createElement('template')
  t.innerHTML = raw
  const svg = t.content.firstElementChild
  if (!svg || svg.localName.toLowerCase() !== 'svg') return null
  svg.querySelectorAll('script, foreignObject').forEach((el) => el.remove())
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (
        /^(href|xlink:href)$/i.test(attr.name) &&
        /^\s*javascript:/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name)
      }
    }
  }
  return svg
}

/** An `<img>` tag reduced to the attributes a diagram needs. */
function safeImg(raw: string): HTMLImageElement | null {
  const t = document.createElement('template')
  t.innerHTML = raw
  const source = t.content.firstElementChild
  if (!source || source.localName.toLowerCase() !== 'img') return null
  const img = document.createElement('img')
  for (const name of ['src', 'alt', 'width', 'height', 'title']) {
    const value = source.getAttribute(name)
    if (value !== null) img.setAttribute(name, value)
  }
  return img
}

/** Replace the image sources markdown produced with resolved file:// URLs. */
function resolveImagesIn(host: HTMLElement, baseDir: string | null): void {
  host.querySelectorAll('img').forEach((img) => {
    const raw = img.getAttribute('src')
    if (raw) img.src = resolveImageSrc(raw, baseDir)
  })
}

function replaceMediaTokens(host: HTMLElement, media: Element[]): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const hits: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.nodeValue?.includes('@@qzmedia')) hits.push(node)
  }
  for (const node of hits) {
    const frag = document.createDocumentFragment()
    const pieces = (node.nodeValue ?? '').split(new RegExp(MEDIA_TOKEN_RE.source, 'g'))
    pieces.forEach((piece, i) => {
      if (i % 2 === 1) {
        const el = media[Number(piece)]
        if (el) frag.appendChild(el.cloneNode(true))
      } else if (piece) {
        frag.appendChild(document.createTextNode(piece))
      }
    })
    node.parentNode?.replaceChild(frag, node)
  }
}

const PAPER_LABEL: Record<QzDoc['paperType'], string> = {
  exam: 'Exam',
  quiz: 'Quiz',
  flashcards: 'Flashcards',
  flashcard: 'Flashcards'
} as unknown as Record<QzDoc['paperType'], string>

function paperLabel(doc: QzDoc): string {
  return PAPER_LABEL[doc.paperType] ?? 'Paper'
}

/** A question's maximum award: the rule's `correct`, or its own marks. */
function paperMarks(doc: QzDoc): number {
  return doc.questions.reduce(
    (sum, q) => sum + (resolveScoring(doc, q)?.correct ?? q.marks),
    0
  )
}

function describePaper(doc: QzDoc): string {
  const parts: string[] = [paperLabel(doc)]
  parts.push(doc.pageMode === 'sep' ? 'one question per page' : 'continuous')
  if (doc.timing === 'total' && doc.totalMs !== null) parts.push(formatDuration(doc.totalMs))
  else if (doc.timing === 'individual') parts.push('timed per question')
  const marks = paperMarks(doc)
  parts.push(`${doc.questions.length} question${doc.questions.length === 1 ? '' : 's'}`)
  if (marks > 0) parts.push(`${marks} mark${marks === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function errorBanner(errors: QzParseError[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'qz-errors'
  const head = document.createElement('div')
  head.className = 'qz-errors-head'
  head.textContent =
    errors.length === 1 ? '1 problem in this file' : `${errors.length} problems in this file`
  wrap.appendChild(head)
  const list = document.createElement('ul')
  list.className = 'qz-errors-list'
  for (const e of errors.slice(0, 12)) {
    const li = document.createElement('li')
    const where = document.createElement('span')
    where.className = 'qz-errors-line'
    where.textContent = `line ${e.line}`
    li.append(where, document.createTextNode(' ' + e.message))
    list.appendChild(li)
  }
  if (errors.length > 12) {
    const li = document.createElement('li')
    li.textContent = `…and ${errors.length - 12} more`
    list.appendChild(li)
  }
  wrap.appendChild(list)
  return wrap
}

// ---------------------------------------------------------------------------
// Answer state
// ---------------------------------------------------------------------------

/**
 * One question's answer, in whatever shape the question's type needs. Kept as a
 * loose union rather than one field per type so the renderers can write whatever
 * they collect and the marker can read it back without a shared vocabulary.
 */
type Answer =
  | { kind: 'choice'; picked: number[] }
  | { kind: 'tf'; value: boolean | null }
  | { kind: 'blanks'; values: string[] }
  | { kind: 'text'; value: string }
  | { kind: 'num'; value: string }
  | { kind: 'pair'; chosen: number[] }
  | { kind: 'order'; order: number[] }

function emptyAnswer(q: QzQuestion): Answer {
  switch (q.type) {
    case 'mcq':
      return { kind: 'choice', picked: [] }
    case 'tf':
      return { kind: 'tf', value: null }
    case 'blank':
      return { kind: 'blanks', values: (q.blanks ?? []).map(() => '') }
    case 'num':
      return { kind: 'num', value: '' }
    case 'match':
      return { kind: 'pair', chosen: (q.pairs ?? []).map(() => -1) }
    case 'order':
      return { kind: 'order', order: shuffledIndexes(q.items?.length ?? 0, q.id) }
    default:
      return { kind: 'text', value: '' }
  }
}

/** A stable shuffle, so re-rendering the pane does not reshuffle the options. */
function shuffledIndexes(n: number, seed: string): number[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const out = Array.from({ length: n }, (_, i) => i)
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    const j = Math.abs(h ^ (h >>> 16)) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ---------------------------------------------------------------------------
// An attempt in flight
// ---------------------------------------------------------------------------

interface Attempt {
  fingerprint: string
  answers: Map<string, Answer>
  startedAt: number
  /** Banked pause, excluding the pause currently running. */
  pausedMs: number
  /** When the current pause began, or null. */
  pauseStartedAt: number | null
  phase: 'intro' | 'running' | 'grading' | 'results'
  gradings: Map<string, Grading>
  /** Manual marks for `self` questions, question id → marks. */
  selfMarks: Map<string, number>
  /** Question ids the candidate marked to come back to. */
  flagged: Set<string>
  /** True once the clock has run out, so the header stops shouting. */
  expired: boolean
}

/**
 * Attempts in flight, keyed by file. This is what stops a tab switch from
 * wiping an exam — the pane is re-rendered whenever its tab is activated.
 *
 * It is a cache, not the storage: every change is also written to
 * `.yestion/attempts/<quiz>.json` by the pane, because this map dies with the
 * renderer. An answer sheet that only exists in memory survives a tab switch
 * and nothing else.
 */
const attempts = new Map<string, Attempt>()

/** The on-disk shape of an attempt. Versioned so a future change can migrate. */
interface StoredAttempt {
  version: 1
  fingerprint: string
  answers: [string, Answer][]
  startedAt: number
  pausedMs: number
  phase: Attempt['phase']
  gradings: [string, Grading][]
  selfMarks: [string, number][]
  flagged: string[]
  expired: boolean
  savedAt: number
}

function serializeAttempt(a: Attempt): string {
  const stored: StoredAttempt = {
    version: 1,
    fingerprint: a.fingerprint,
    answers: [...a.answers],
    startedAt: a.startedAt,
    pausedMs: a.pausedMs,
    phase: a.phase,
    gradings: [...a.gradings],
    selfMarks: [...a.selfMarks],
    flagged: [...a.flagged],
    expired: a.expired,
    savedAt: Date.now()
  }
  return JSON.stringify(stored)
}

/** Cheap content fingerprint, so editing the paper invalidates the attempt. */
function fingerprint(body: string): string {
  let h = 5381
  for (let i = 0; i < body.length; i++) h = (h * 33) ^ body.charCodeAt(i)
  return (h >>> 0).toString(36) + ':' + body.length
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** Round to the nearest half mark — the granularity school marking uses. */
const half = (n: number): number => Math.round(n * 2) / 2

/** Auto-marked questions, or null when the answer needs a person or a model. */
function autoMark(q: QzQuestion, a: Answer | undefined): number | null {
  if (!a) return q.type === 'mcq' || q.type === 'tf' || q.type === 'blank' || q.type === 'num' ? 0 : null

  if (q.type === 'mcq' && a.kind === 'choice') {
    const correct = (q.options ?? []).map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0)
    if (correct.length === 0) return null
    const picked = new Set(a.picked)
    const hits = correct.filter((i) => picked.has(i)).length
    const wrong = a.picked.filter((i) => !correct.includes(i)).length
    if (correct.length === 1) return hits === 1 && wrong === 0 ? q.marks : 0
    // Multi-select: credit for the right ones, debit for the wrong ones. All or
    // nothing would make a 3-of-4 answer score the same as a blank one.
    return half(Math.max(0, Math.min(q.marks, (q.marks * (hits - wrong)) / correct.length)))
  }

  if (q.type === 'tf' && a.kind === 'tf') {
    if (q.tfAnswer === null || q.tfAnswer === undefined) return null
    return a.value === q.tfAnswer ? q.marks : 0
  }

  if (q.type === 'blank' && a.kind === 'blanks') {
    const blanks = q.blanks ?? []
    if (blanks.length === 0) return null
    const per = q.marks / blanks.length
    let scored = 0
    blanks.forEach((alts, i) => {
      const given = norm(a.values[i] ?? '')
      if (given && alts.some((alt) => norm(alt) === given)) scored += per
    })
    return half(scored)
  }

  if (q.type === 'num' && a.kind === 'num') {
    if (q.numAnswer === null || q.numAnswer === undefined) return null
    const value = Number(a.value.trim())
    if (!Number.isFinite(value)) return 0
    return Math.abs(value - q.numAnswer) <= (q.numTolerance ?? 0) + 1e-9 ? q.marks : 0
  }

  return null
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function createQuizPane(): QuizPaneHandle {
  const el = document.getElementById('quiz-pane') as HTMLElement

  let current: QuizRenderInput | null = null
  let attempt: Attempt | null = null
  let ticker: number | null = null
  let clockEl: HTMLElement | null = null
  /** Set while results are on screen, so the clock is not re-armed. */
  let finished = false
  let saveTimer: number | null = null

  /**
   * Write the attempt through to disk. Debounced, but short: the whole point is
   * that an app that dies 200 ms after a keystroke still has that keystroke.
   * The path and payload are captured at schedule time, so a tab switch cannot
   * redirect an older timer at the newly opened paper.
   */
  function scheduleAttemptSave(): void {
    if (!current || !attempt) return
    const relPath = current.relPath
    const payload = serializeAttempt(attempt)
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      void window.api.quizAttemptSave(relPath, payload)
    }, 200)
  }

  function flushAttemptSave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    if (current && attempt) {
      void window.api.quizAttemptSave(current.relPath, serializeAttempt(attempt))
    }
  }

  /**
   * Bring back the attempt a previous run left on disk. Ignored when the paper's
   * bytes changed (the fingerprint no longer matches) or when the user has
   * already started interacting with the fresh attempt.
   *
   * The clock is honoured the way a candidate expects: time with the app closed
   * is paused, not counted against a timed paper.
   */
  async function restoreAttempt(input: QuizRenderInput, print: string, fresh: Attempt): Promise<void> {
    let raw: string | null = null
    try {
      raw = await window.api.quizAttemptLoad(input.relPath)
    } catch {
      return
    }
    if (!raw) return
    let stored: StoredAttempt
    try {
      stored = JSON.parse(raw) as StoredAttempt
    } catch {
      return
    }
    if (!stored || stored.version !== 1) return
    if (stored.fingerprint !== print) {
      // The paper was edited; the old answers no longer line up with it.
      void window.api.quizAttemptClear(input.relPath)
      return
    }
    // The pane may have moved on while this was loading.
    if (attempt !== fresh || current?.relPath !== input.relPath) return

    const restored: Attempt = {
      fingerprint: stored.fingerprint,
      answers: new Map(stored.answers ?? []),
      startedAt: Number(stored.startedAt) || 0,
      pausedMs: Number(stored.pausedMs) || 0,
      pauseStartedAt: null,
      // An interrupted grading run is resumable as a paper that can be submitted
      // again; the marks already given are kept.
      phase: stored.phase === 'grading' ? 'running' : stored.phase,
      gradings: new Map(stored.gradings ?? []),
      selfMarks: new Map(stored.selfMarks ?? []),
      flagged: new Set(stored.flagged ?? []),
      expired: Boolean(stored.expired)
    }
    if (restored.startedAt > 0 && restored.phase !== 'results') {
      restored.pausedMs += Math.max(0, Date.now() - (Number(stored.savedAt) || Date.now()))
    }
    attempts.set(input.relPath, restored)
    attempt = restored
    finished = restored.phase === 'results'
    paint()
  }

  // Last line of defence for a quit that arrives between debounce ticks.
  window.addEventListener('beforeunload', flushAttemptSave)

  function clear(): void {
    stopClock()
    el.replaceChildren()
  }

  function abandon(): void {
    if (current && attempt) attempts.delete(current.relPath)
    attempt = null
    finished = false
    clear()
  }

  function stopClock(): void {
    if (ticker !== null) {
      window.clearInterval(ticker)
      ticker = null
    }
    clockEl = null
  }

  /** Bank the pause in progress, so a pause that never ends still accrues. */
  function pause(): void {
    if (!attempt || attempt.pauseStartedAt !== null) return
    attempt.pauseStartedAt = Date.now()
    paintClock()
  }

  /** Total paused time, counting the pause in progress. */
  function pausedTotal(a: Attempt): number {
    return a.pausedMs + (a.pauseStartedAt === null ? 0 : Date.now() - a.pauseStartedAt)
  }

  function remainingMs(a: Attempt): number | null {
    if (a.startedAt === 0 || current?.doc.timing !== 'total' || current.doc.totalMs === null) return null
    // Derived from an absolute deadline, not a decrementing counter: a timer that
    // counts down drifts when the window is unfocused or the machine sleeps, and
    // a 25-minute paper quietly gaining time is worse than no timer at all.
    return a.startedAt + current.doc.totalMs + pausedTotal(a) - Date.now()
  }

  function paintClock(): void {
    if (!clockEl || !attempt) return
    const left = remainingMs(attempt)
    if (left === null) {
      clockEl.textContent = ''
      clockEl.hidden = true
      return
    }
    clockEl.hidden = false
    const paused = attempt.pauseStartedAt !== null
    const secs = Math.max(0, Math.ceil(left / 1000))
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    const pad = (n: number): string => String(n).padStart(2, '0')
    clockEl.textContent = (paused ? '⏸ ' : '') + (h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`)
    clockEl.classList.toggle('qz-clock-low', !paused && left <= 60_000)
    clockEl.classList.toggle('qz-clock-paused', paused)
    clockEl.title = paused ? 'Paused while the paper is marked' : 'Time remaining'
  }

  function startClock(): void {
    stopClock()
    if (!current || current.doc.timing !== 'total' || current.doc.totalMs === null) return
    // Idempotent: several paths call this in a row (start, then the render it
    // triggers), and without this each one leaves another clock in the bar.
    for (const stale of Array.from(el.querySelectorAll('.qz-clock'))) stale.remove()
    clockEl = document.createElement('div')
    clockEl.className = 'qz-clock'
    const bar = el.querySelector('.qz-bar')
    if (bar) bar.appendChild(clockEl)
    else el.appendChild(clockEl)
    paintClock()
    ticker = window.setInterval(() => {
      paintClock()
      if (attempt && remainingMs(attempt) !== null && (remainingMs(attempt) ?? 1) <= 0 && !attempt.expired) {
        attempt.expired = true
        submit()
      }
    }, 250)
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Parse problems, shown at the top of every phase. A file with a typo in it
   * still has to run: the banner says what was not understood, and the paper
   * carries on with whatever parsed.
   */
  function errorsFor(): HTMLElement | null {
    if (!current || current.doc.errors.length === 0) return null
    return errorBanner(current.doc.errors)
  }

  function passageFor(q: QzQuestion): QzPassage | undefined {
    if (!q.passageId || !current) return undefined
    return current.doc.passages.find((p) => p.id.toLowerCase() === q.passageId!.toLowerCase())
  }

  /**
   * Render markdown into `host`.
   *
   * `.markdown-body` is the whole-page column — an 880px measure, centred, with
   * 88px of side padding and 160px of bottom padding. Reusing it inside a
   * question is what produced the canyon between the prompt and the answer box,
   * so `qz-md` cancels the column and each surface keeps its own type.
   */
  /**
   * Render one piece of paper markdown.
   *
   * Inline `<svg>` and `<img>` tags are lifted out before `stripQzTags` (which
   * removes every tag), passed through the markdown as bare tokens, and put
   * back once the markup exists. Images are resolved against the `.qz` file's
   * own folder, so `![](diagram.png)` works exactly like it does on a page.
   */
  function renderPaperMarkdown(host: HTMLElement, source: string, gaps = false): void {
    const media: Element[] = []
    let marked = source
      .replace(SVG_BLOCK_RE, (raw) => {
        const el = safeSvg(raw)
        if (!el) return ''
        media.push(el)
        return `@@qzmedia${media.length - 1}@@`
      })
      .replace(IMG_TAG_RE, (raw) => {
        const el = safeImg(raw)
        if (!el) return ''
        media.push(el)
        return `@@qzmedia${media.length - 1}@@`
      })
    marked = stripQzTags(marked)
    if (gaps) {
      let withGaps = ''
      marked.split(/\{\{[^}]*\}\}/).forEach((part, i) => {
        if (i > 0) withGaps += gapToken(i)
        withGaps += part
      })
      marked = withGaps
    }
    host.classList.add('markdown-body', 'qz-md')
    host.innerHTML = renderAgentMarkdown(marked)
    replaceMediaTokens(host, media)
    if (gaps) replaceGapTokens(host)
    resolveImagesIn(host, current?.baseDir ?? null)
  }

  function markdownInto(host: HTMLElement, source: string): void {
    renderPaperMarkdown(host, source)
  }

  /**
   * The prompt for a fill-in-the-blank question, with each `{{…}}` replaced by a
   * numbered gap. The number is what ties a gap to its box below: without it the
   * sentence reads as prose and the boxes are just a list.
   *
   * The gaps cannot be built by splitting the sentence and rendering each piece,
   * because markdown wraps every piece in its own `<p>` and the gaps end up on
   * their own lines. Rendering the sentence once and substituting afterwards is
   * what keeps the gaps *in* the sentence.
   */
  function markdownWithGaps(host: HTMLElement, source: string): void {
    renderPaperMarkdown(host, source, true)
  }

  /** Which renderer a question's prompt needs. */
  function promptInto(host: HTMLElement, q: QzQuestion): void {
    if (q.type === 'blank' && (q.blanks?.length ?? 0) > 0) markdownWithGaps(host, q.prompt)
    else markdownInto(host, q.prompt)
  }

  function bar(title: string, meta: string, icon: string, actions: HTMLElement[]): HTMLElement {
    const b = document.createElement('div')
    b.className = 'qz-bar'
    const iconWrap = document.createElement('span')
    iconWrap.className = 'qz-icon'
    if (icon) iconWrap.textContent = icon
    else iconWrap.appendChild(iconEl('quiz', 20))
    const titles = document.createElement('div')
    titles.className = 'qz-titles'
    const h1 = document.createElement('h1')
    h1.className = 'qz-title'
    h1.textContent = title
    const m = document.createElement('p')
    m.className = 'qz-meta'
    m.textContent = meta
    titles.append(h1, m)
    const spacer = document.createElement('div')
    spacer.className = 'qz-bar-spacer'
    const act = document.createElement('div')
    act.className = 'qz-bar-actions'
    act.append(...actions)
    b.append(iconWrap, titles, spacer, act)
    return b
  }

  function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'qz-btn ' + cls
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function renderIntro(): void {
    if (!current || !attempt) return
    const scroll = document.createElement('div')
    scroll.className = 'qz-scroll'
    scroll.appendChild(
      bar(current.title, describePaper(current.doc), current.icon, [
        button('Start', 'qz-btn-primary', () => begin())
      ])
    )
    const body = document.createElement('div')
    body.className = 'qz-intro'
    const problems = errorsFor()
    if (problems) body.appendChild(problems)
    if (current.doc.intro.trim()) markdownInto(body, current.doc.intro)
    const facts = document.createElement('dl')
    facts.className = 'qz-facts'
    const rows: [string, string][] = [
      ['Questions', String(current.doc.questions.length)],
      ['Marks', String(paperMarks(current.doc))]
    ]
    if (current.doc.timing === 'total' && current.doc.totalMs !== null) {
      rows.push(['Time', formatDuration(current.doc.totalMs)])
    } else if (current.doc.timing === 'individual') {
      rows.push(['Time', 'Per question'])
    }
    for (const [k, v] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      facts.append(dt, dd)
    }
    body.appendChild(facts)
    const note = document.createElement('p')
    note.className = 'qz-note'
    note.textContent =
      'The clock starts when you press Start and keeps running if you switch tabs. It pauses while answers are being marked.'
    body.appendChild(note)
    scroll.appendChild(body)
    el.replaceChildren(scroll)
  }

  function begin(): void {
    if (!attempt) return
    attempt.phase = 'running'
    attempt.startedAt = Date.now()
    scheduleAttemptSave()
    paint()
    startClock()
  }

  function questionCard(q: QzQuestion, index: number, forResults: boolean): HTMLElement {
    const card = document.createElement('section')
    card.className = 'qz-q'
    card.dataset.qid = q.id

    const head = document.createElement('div')
    head.className = 'qz-q-head'
    const num = document.createElement('span')
    num.className = 'qz-q-num'
    num.textContent = String(index + 1)
    const marks = document.createElement('span')
    marks.className = 'qz-q-marks'
    const worth = maxAward(q)
    marks.textContent = worth === 1 ? '1 mark' : `${worth} marks`
    head.append(num, marks)

    // Running view only: a flag is a note to self, not part of the paper.
    if (!forResults && attempt) {
      const flagged = attempt.flagged.has(q.id)
      const flagBtn = document.createElement('button')
      flagBtn.type = 'button'
      flagBtn.className = 'qz-flag' + (flagged ? ' is-flagged' : '')
      flagBtn.title = flagged ? 'Remove flag' : 'Flag for review'
      flagBtn.setAttribute('aria-label', flagBtn.title)
      flagBtn.setAttribute('aria-pressed', String(flagged))
      flagBtn.appendChild(iconEl('flag', 14))
      card.classList.toggle('is-flagged', flagged)
      flagBtn.addEventListener('click', () => {
        const on = !attempt!.flagged.has(q.id)
        if (on) attempt!.flagged.add(q.id)
        else attempt!.flagged.delete(q.id)
        card.classList.toggle('is-flagged', on)
        flagBtn.classList.toggle('is-flagged', on)
        flagBtn.title = on ? 'Remove flag' : 'Flag for review'
        flagBtn.setAttribute('aria-label', flagBtn.title)
        flagBtn.setAttribute('aria-pressed', String(on))
        paintProgress()
        scheduleAttemptSave()
      })
      head.appendChild(flagBtn)
    }

    if (forResults && attempt) {
      const g = attempt.gradings.get(q.id)
      const auto = awardMark(q, attempt.answers.get(q.id))
      const self = attempt.selfMarks.get(q.id)
      const score = g && !g.ungraded ? g.mark : self !== undefined ? self : auto
      const of = maxAward(q)
      if (score !== null && score !== undefined) {
        const badge = document.createElement('span')
        const got = score
        badge.className = 'qz-q-score' + (got >= of ? ' is-full' : got <= 0 ? ' is-zero' : '')
        badge.textContent = `${got} / ${of}`
        head.appendChild(badge)
      }
    }
    card.appendChild(head)

    const passage = passageFor(q)
    if (passage) {
      const p = document.createElement('blockquote')
      p.className = 'qz-passage'
      markdownInto(p, passage.body)
      card.appendChild(p)
    }

    const prompt = document.createElement('div')
    prompt.className = 'qz-q-prompt'
    promptInto(prompt, q)
    card.appendChild(prompt)

    card.appendChild(forResults ? answerReview(q) : answerInput(q))
    if (forResults) card.appendChild(answerKey(q))
    return card
  }

  /** The controls a candidate answers with. */
  function answerInput(q: QzQuestion): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qz-input'
    const a = attempt?.answers.get(q.id) ?? emptyAnswer(q)
    if (!attempt) return wrap
    const set = (next: Answer): void => {
      attempt!.answers.set(q.id, next)
      paintProgress()
      scheduleAttemptSave()
    }

    if (q.type === 'mcq' && a.kind === 'choice') {
      const multi = q.multi === true
      ;(q.options ?? []).forEach((opt, i) => {
        const row = document.createElement('label')
        row.className = 'qz-opt'
        const input = document.createElement('input')
        input.type = multi ? 'checkbox' : 'radio'
        input.name = 'q-' + q.id
        input.checked = a.picked.includes(i)
        input.addEventListener('change', () => {
          const picked = multi
            ? input.checked
              ? [...a.picked, i]
              : a.picked.filter((p) => p !== i)
            : [i]
          set({ kind: 'choice', picked })
        })
        const text = document.createElement('span')
        text.className = 'qz-opt-text'
        text.innerHTML = renderAgentMarkdown(stripQzTags(opt.text)).replace(/^<p>|<\/p>\s*$/g, '')
        resolveImagesIn(text, current?.baseDir ?? null)
        row.append(input, text)
        wrap.appendChild(row)
      })
      if (multi) {
        const hint = document.createElement('p')
        hint.className = 'qz-hint'
        hint.textContent = 'Select all that apply.'
        wrap.appendChild(hint)
      }
      return wrap
    }

    if (q.type === 'tf' && a.kind === 'tf') {
      const group = document.createElement('div')
      group.className = 'qz-tf'
      for (const value of [true, false]) {
        const row = document.createElement('label')
        row.className = 'qz-opt'
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = 'q-' + q.id
        input.checked = a.value === value
        input.addEventListener('change', () => set({ kind: 'tf', value }))
        const text = document.createElement('span')
        text.className = 'qz-opt-text'
        text.textContent = value ? 'True' : 'False'
        row.append(input, text)
        group.appendChild(row)
      }
      wrap.appendChild(group)
      return wrap
    }

    if (q.type === 'blank' && a.kind === 'blanks') {
      const blanks = q.blanks ?? []
      // The prompt already carries the sentence with the gaps in it; this is the
      // list of boxes, numbered the way the prompt numbers them.
      const list = document.createElement('div')
      list.className = 'qz-blanks'
      blanks.forEach((_, i) => {
        const row = document.createElement('label')
        row.className = 'qz-blank'
        const tag = document.createElement('span')
        tag.className = 'qz-blank-num'
        tag.textContent = String(i + 1)
        const input = document.createElement('input')
        input.type = 'text'
        input.value = a.values[i] ?? ''
        input.placeholder = 'answer'
        input.addEventListener('input', () => {
          const values = [...a.values]
          values[i] = input.value
          set({ kind: 'blanks', values })
        })
        row.append(tag, input)
        list.appendChild(row)
      })
      wrap.appendChild(list)
      return wrap
    }

    if (q.type === 'num' && a.kind === 'num') {
      const row = document.createElement('div')
      row.className = 'qz-num'
      const input = document.createElement('input')
      input.type = 'text'
      input.inputMode = 'decimal'
      input.value = a.value
      input.placeholder = 'value'
      input.addEventListener('input', () => set({ kind: 'num', value: input.value }))
      row.appendChild(input)
      if (q.numUnit) {
        const unit = document.createElement('span')
        unit.className = 'qz-unit'
        unit.textContent = q.numUnit
        row.appendChild(unit)
      }
      wrap.appendChild(row)
      return wrap
    }

    if (q.type === 'match' && a.kind === 'pair') {
      const rights = shuffledIndexes(q.pairs?.length ?? 0, q.id + ':right')
      const table = document.createElement('div')
      table.className = 'qz-match'
      ;(q.pairs ?? []).forEach((pair, i) => {
        const row = document.createElement('div')
        row.className = 'qz-match-row'
        const left = document.createElement('span')
        left.className = 'qz-match-left'
        left.textContent = pair.left
        const sel = document.createElement('select')
        const blank = document.createElement('option')
        blank.value = '-1'
        blank.textContent = '—'
        sel.appendChild(blank)
        for (const r of rights) {
          const option = document.createElement('option')
          option.value = String(r)
          option.textContent = q.pairs![r].right
          sel.appendChild(option)
        }
        sel.value = String(a.chosen[i] ?? -1)
        sel.addEventListener('change', () => {
          const chosen = [...a.chosen]
          chosen[i] = Number(sel.value)
          set({ kind: 'pair', chosen })
        })
        row.append(left, sel)
        table.appendChild(row)
      })
      wrap.appendChild(table)
      return wrap
    }

    if (q.type === 'order' && a.kind === 'order') {
      const list = document.createElement('ol')
      list.className = 'qz-order'
      const render = (): void => {
        list.replaceChildren()
        a.order.forEach((itemIndex, slot) => {
          const li = document.createElement('li')
          const text = document.createElement('span')
          text.textContent = (q.items ?? [])[itemIndex] ?? ''
          const up = button('↑', 'qz-nudge', () => move(slot, -1))
          const down = button('↓', 'qz-nudge', () => move(slot, 1))
          up.disabled = slot === 0
          down.disabled = slot === a.order.length - 1
          li.append(text, up, down)
          list.appendChild(li)
        })
      }
      const move = (slot: number, delta: number): void => {
        const next = [...a.order]
        const target = slot + delta
        if (target < 0 || target >= next.length) return
        ;[next[slot], next[target]] = [next[target], next[slot]]
        set({ kind: 'order', order: next })
        render()
      }
      render()
      wrap.appendChild(list)
      return wrap
    }

    if (q.type === 'card') {
      // A flashcard has no answer to give; the flip is the whole interaction,
      // and it happens in review so the front is what the candidate sees first.
      const note = document.createElement('p')
      note.className = 'qz-hint'
      note.textContent = 'Look at the prompt, then reveal the back in review.'
      wrap.appendChild(note)
      return wrap
    }

    // Free text: short, long, free, and anything unrecognised.
    const lines = q.type === 'short' ? 3 : 6
    const input = document.createElement('textarea')
    input.className = 'qz-textarea'
    input.rows = lines
    input.placeholder = 'Your answer…'
    input.value = a.kind === 'text' ? a.value : ''
    input.addEventListener('input', () => set({ kind: 'text', value: input.value }))
    wrap.appendChild(input)
    return wrap
  }

  /** What the candidate actually wrote, shown read-only after submission. */
  function answerReview(q: QzQuestion): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qz-input qz-review'
    const a = attempt?.answers.get(q.id)
    const line = (label: string, value: string): void => {
      const p = document.createElement('p')
      p.className = 'qz-review-line'
      const strong = document.createElement('strong')
      strong.textContent = label + ': '
      p.append(strong, document.createTextNode(value))
      wrap.appendChild(p)
    }

    if (!a || (a.kind === 'choice' && a.picked.length === 0) || (a.kind === 'text' && !a.value.trim()) ||
        (a.kind === 'tf' && a.value === null) || (a.kind === 'num' && !a.value.trim()) ||
        (a.kind === 'blanks' && a.values.every((v) => !v.trim()))) {
      const p = document.createElement('p')
      p.className = 'qz-review-blank'
      p.textContent = 'No answer given.'
      wrap.appendChild(p)
      return wrap
    }

    if (a.kind === 'choice') {
      const picked = a.picked.map((i) => q.options?.[i]?.text ?? '').filter(Boolean)
      line('You chose', picked.join(', '))
    } else if (a.kind === 'tf') {
      line('You answered', a.value ? 'True' : 'False')
    } else if (a.kind === 'num') {
      line('You answered', a.value + (q.numUnit ? ' ' + q.numUnit : ''))
    } else if (a.kind === 'blanks') {
      a.values.forEach((v, i) => line(`Blank ${i + 1}`, v.trim() || '(empty)'))
    } else if (a.kind === 'text') {
      const p = document.createElement('p')
      p.className = 'qz-review-text'
      p.textContent = a.value
      wrap.appendChild(p)
    }
    return wrap
  }

  /** The model answer, the scheme, and — for `self` questions — a way to mark it. */
  function answerKey(q: QzQuestion): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'qz-key'

    const g = attempt?.gradings.get(q.id)
    if (g) {
      if (g.ungraded) {
        const warn = document.createElement('p')
        warn.className = 'qz-key-note'
        warn.textContent = `Not marked automatically — ${g.note ?? 'the grader was unavailable'}. Mark it yourself against the answer below.`
        wrap.appendChild(warn)
      } else {
        if (g.feedback) {
          const fb = document.createElement('p')
          fb.className = 'qz-feedback'
          fb.textContent = g.feedback
          wrap.appendChild(fb)
        }
        if (g.criteria.length > 0) {
          const ul = document.createElement('ul')
          ul.className = 'qz-criteria'
          for (const c of g.criteria) {
            const li = document.createElement('li')
            li.className = c.met ? 'met' : 'unmet'
            li.textContent = c.text
            ul.appendChild(li)
          }
          wrap.appendChild(ul)
        }
      }
    }

    if (q.type === 'mcq') {
      const correct = (q.options ?? []).filter((o) => o.correct).map((o) => o.text)
      if (correct.length > 0) {
        const p = document.createElement('p')
        p.className = 'qz-key-line'
        const strong = document.createElement('strong')
        strong.textContent = 'Correct: '
        p.append(strong, document.createTextNode(correct.join(', ')))
        wrap.appendChild(p)
      }
    } else if (q.type === 'tf' && q.tfAnswer !== null && q.tfAnswer !== undefined) {
      const p = document.createElement('p')
      p.className = 'qz-key-line'
      const strong = document.createElement('strong')
      strong.textContent = 'Correct: '
      p.append(strong, document.createTextNode(q.tfAnswer ? 'True' : 'False'))
      wrap.appendChild(p)
    } else if (q.type === 'blank') {
      const p = document.createElement('p')
      p.className = 'qz-key-line'
      const strong = document.createElement('strong')
      strong.textContent = 'Accepted: '
      p.append(strong, document.createTextNode((q.blanks ?? []).map((alts, i) => `${i + 1}. ${alts.join(' / ')}`).join('   ')))
      wrap.appendChild(p)
    } else if (q.type === 'num' && q.numAnswer !== null && q.numAnswer !== undefined) {
      const p = document.createElement('p')
      p.className = 'qz-key-line'
      const strong = document.createElement('strong')
      strong.textContent = 'Correct: '
      const tol = q.numTolerance ? ` (±${q.numTolerance})` : ''
      p.append(strong, document.createTextNode(`${q.numAnswer}${tol}${q.numUnit ? ' ' + q.numUnit : ''}`))
      wrap.appendChild(p)
    } else if (q.type === 'match' && q.pairs) {
      const p = document.createElement('p')
      p.className = 'qz-key-line'
      const strong = document.createElement('strong')
      strong.textContent = 'Correct: '
      p.append(strong, document.createTextNode(q.pairs.map((x) => `${x.left} → ${x.right}`).join('   ')))
      wrap.appendChild(p)
    } else if (q.type === 'order' && q.items) {
      const p = document.createElement('p')
      p.className = 'qz-key-line'
      const strong = document.createElement('strong')
      strong.textContent = 'Correct: '
      p.append(strong, document.createTextNode(q.items.join(' → ')))
      wrap.appendChild(p)
    }

    const answer = q.rubric?.trim() || q.answer?.trim()
    if (answer) {
      const details = document.createElement('details')
      details.className = 'qz-model-answer'
      const summary = document.createElement('summary')
      summary.textContent = q.rubric?.trim() ? 'Marking scheme' : 'Model answer'
      const body = document.createElement('div')
      body.className = 'qz-answer-body'
      markdownInto(body, answer)
      details.append(summary, body)
      // Long answers are the ones the candidate most needs to compare against,
      // so they start open; everything else stays folded.
      details.open = q.type === 'long' || Boolean(q.rubric?.trim())
      wrap.appendChild(details)
    }

    // `self` questions are the ones where the candidate is the marker. An AI
    // question whose grader is unavailable (including "Off") becomes one too:
    // the official scheme is right there, and the paper must stay finishable.
    if ((q.grade === 'self' || (q.grade === 'ai' && g?.ungraded)) && attempt) {
      const row = document.createElement('div')
      row.className = 'qz-selfmark'
      const label = document.createElement('span')
      label.textContent = 'Award yourself:'
      row.appendChild(label)
      for (let m = 0; m <= q.marks; m++) {
        const b = button(String(m), 'qz-selfmark-btn', () => {
          attempt!.selfMarks.set(q.id, m)
          scheduleAttemptSave()
          paint()
        })
        if (attempt.selfMarks.get(q.id) === m) b.classList.add('is-picked')
        row.appendChild(b)
      }
      wrap.appendChild(row)
    }
    return wrap
  }

  /** The question's ceiling under the paper's rule (or its own marks). */
  function maxAward(q: QzQuestion): number {
    return (current && resolveScoring(current.doc, q)?.correct) ?? q.marks
  }

  /** Nothing entered: no box ticked, no value typed, no pair chosen. */
  function isBlankAnswer(a: Answer | undefined): boolean {
    if (!a) return true
    switch (a.kind) {
      case 'choice': return a.picked.length === 0
      case 'tf': return a.value === null
      case 'num': return a.value.trim() === ''
      case 'blanks': return a.values.every((v) => v.trim() === '')
      case 'pair': return a.chosen.every((c) => c < 0)
      case 'text': return a.value.trim() === ''
      case 'order': return false
    }
  }

  /**
   * Marks for an objective answer. With a scoring rule the outcome is
   * three-way — full, wrong, or blank — which is how contests like the AMC work
   * (6 / 0 / 1.5). Without one, the question's partial credit is used as-is.
   */
  function awardMark(q: QzQuestion, a: Answer | undefined): number | null {
    const auto = autoMark(q, a)
    if (auto === null || !current) return auto
    const rule = resolveScoring(current.doc, q)
    if (!rule) return auto
    if (isBlankAnswer(a)) return rule.blank
    return auto >= q.marks - 1e-9 ? rule.correct : rule.wrong
  }

  function totalMarks(): { got: number; of: number; pending: boolean } {
    let got = 0
    let of = 0
    let pending = false
    for (const q of current!.doc.questions) {
      of += maxAward(q)
      const g = attempt!.gradings.get(q.id)
      const self = attempt!.selfMarks.get(q.id)
      const auto = awardMark(q, attempt!.answers.get(q.id))
      if (g && !g.ungraded) got += g.mark
      else if (self !== undefined) got += self
      else if (auto !== null) got += auto
      else if (q.grade === 'ai') pending = true
    }
    return { got: half(got), of, pending }
  }

  function renderRunning(): void {
    if (!current || !attempt) return
    const scroll = document.createElement('div')
    scroll.className = 'qz-scroll'
    // How far through the paper they are, next to the button that ends it: the
    // one thing a candidate wants to know before submitting.
    const progress = document.createElement('span')
    progress.className = 'qz-progress-count'
    const submitBtn = button('Submit paper', 'qz-btn-primary', () => submit())
    scroll.appendChild(bar(current.title, describePaper(current.doc), current.icon, [progress, submitBtn]))

    const body = document.createElement('div')
    body.className = 'qz-body'
    const problems = errorsFor()
    if (problems) body.appendChild(problems)
    if (current.doc.intro.trim()) {
      const intro = document.createElement('div')
      intro.className = 'qz-intro-inline'
      markdownInto(intro, current.doc.intro)
      body.appendChild(intro)
    }
    current.doc.questions.forEach((q, i) => body.appendChild(questionCard(q, i, false)))
    scroll.appendChild(body)
    el.replaceChildren(scroll)
    paintProgress()
    startClock()
  }

  function paintProgress(): void {
    const bar = el.querySelector('.qz-progress-count')
    if (bar && current && attempt) {
      const done = current.doc.questions.filter((q) => {
        const a = attempt!.answers.get(q.id)
        if (!a) return false
        if (a.kind === 'choice') return a.picked.length > 0
        if (a.kind === 'text') return a.value.trim().length > 0
        if (a.kind === 'tf') return a.value !== null
        if (a.kind === 'num') return a.value.trim().length > 0
        if (a.kind === 'blanks') return a.values.some((v) => v.trim())
        if (a.kind === 'pair') return a.chosen.some((c) => c >= 0)
        return true
      }).length
      const flagged = attempt.flagged.size
      bar.textContent =
        `${done} of ${current.doc.questions.length} answered` +
        (flagged > 0 ? ` · ${flagged} flagged` : '')
    }
  }

  async function submit(): Promise<void> {
    if (!current || !attempt || attempt.phase === 'grading' || attempt.phase === 'results') return
    attempt.phase = 'grading'
    attempt.expired = false
    // The clock stops here and the pause is banked, so time spent waiting on the
    // model is not taken out of the candidate's paper.
    pause()
    scheduleAttemptSave()
    renderGrading()
    const aiQs = current.doc.questions.filter((q) => q.grade === 'ai')
    for (let i = 0; i < aiQs.length; i++) {
      const q = aiQs[i]
      if (attempt.expired) break
      updateGradingProgress(i, aiQs.length, q)
      const a = attempt.answers.get(q.id)
      const response = a && a.kind === 'text' ? a.value : describeAnswerForGrader(q, a)
      const g = await gradeAnswer({
        relPath: current.relPath,
        question: q,
        response,
        passage: passageFor(q)?.body,
        intro: current.doc.intro,
        paperTitle: current.title
      })
      attempt.gradings.set(q.id, g)
      // Each mark survives a quit in the middle of the grading pass.
      scheduleAttemptSave()
    }
    attempt.phase = 'results'
    finished = true
    stopClock()
    scheduleAttemptSave()
    paint()
  }

  /** A non-text answer turned into something a grader can read. */
  function describeAnswerForGrader(q: QzQuestion, a: Answer | undefined): string {
    if (!a) return ''
    if (a.kind === 'choice') return a.picked.map((i) => q.options?.[i]?.text ?? '').join('; ')
    if (a.kind === 'tf') return a.value === null ? '' : a.value ? 'True' : 'False'
    if (a.kind === 'num') return a.value
    if (a.kind === 'blanks') return a.values.join('; ')
    if (a.kind === 'pair') return a.chosen.map((c, i) => `${q.pairs?.[i]?.left} → ${c >= 0 ? q.pairs?.[c]?.right : '—'}`).join('; ')
    if (a.kind === 'order') return a.order.map((i) => q.items?.[i] ?? '').join(' → ')
    return ''
  }

  function renderGrading(): void {
    if (!current || !attempt) return
    const scroll = document.createElement('div')
    scroll.className = 'qz-scroll'
    scroll.appendChild(bar(current.title, 'Marking…', current.icon, []))
    const body = document.createElement('div')
    body.className = 'qz-grading'
    const spin = document.createElement('div')
    spin.className = 'qz-spinner'
    const head = document.createElement('p')
    head.className = 'qz-grading-head'
    head.textContent = 'Marking your answers'
    const sub = document.createElement('p')
    sub.className = 'qz-grading-sub qz-grading-progress'
    sub.textContent = 'Starting…'
    const note = document.createElement('p')
    note.className = 'qz-note'
    note.textContent = 'The clock is paused while this runs.'
    body.append(spin, head, sub, note)
    scroll.appendChild(body)
    el.replaceChildren(scroll)
    // The bar was rebuilt, so the clock element is gone; re-attach and keep the
    // last painted value so the pause is visible.
    startClock()
    paintClock()
  }

  function updateGradingProgress(done: number, total: number, q: QzQuestion): void {
    const p = el.querySelector('.qz-grading-progress')
    if (p) {
      const label = q.prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
      p.textContent = `Question ${done + 1} of ${total}${label ? ` — ${label}${q.prompt.length > 60 ? '…' : ''}` : ''}`
    }
  }

  function renderResults(): void {
    if (!current || !attempt) return
    const scroll = document.createElement('div')
    scroll.className = 'qz-scroll'
    const totals = totalMarks()
    const actions: HTMLElement[] = [
      button('Try again', 'qz-btn', () => {
        attempts.delete(current!.relPath)
        // The previous run's answers are deliberately discarded, so clear the
        // copy on disk before the fresh attempt starts writing over it.
        void window.api.quizAttemptClear(current!.relPath)
        attempt = createAttempt(current!, current!.body)
        attempts.set(current!.relPath, attempt)
        finished = false
        attempt.phase = current!.doc.timing === 'none' ? 'running' : 'intro'
        if (attempt.phase === 'running') {
          attempt.startedAt = Date.now()
          scheduleAttemptSave()
          paint()
          startClock()
        } else {
          scheduleAttemptSave()
          paint()
        }
      })
    ]
    scroll.appendChild(bar(current.title, describePaper(current.doc), current.icon, actions))

    const body = document.createElement('div')
    body.className = 'qz-body'
    const problems = errorsFor()
    if (problems) body.appendChild(problems)
    const score = document.createElement('div')
    score.className = 'qz-score'
    const big = document.createElement('div')
    big.className = 'qz-score-big'
    big.textContent = `${totals.got} / ${totals.of}`
    const pct = totals.of > 0 ? Math.round((totals.got / totals.of) * 100) : 0
    const sub = document.createElement('p')
    sub.className = 'qz-score-sub'
    sub.textContent = `${pct}%${totals.pending ? ' — some answers still need marking' : ''}`
    score.append(big, sub)
    if (attempt.expired) {
      const out = document.createElement('p')
      out.className = 'qz-key-note'
      out.textContent = 'Time ran out — the paper was submitted for you.'
      score.appendChild(out)
    }
    body.appendChild(score)

    current.doc.questions.forEach((q, i) => body.appendChild(questionCard(q, i, true)))
    scroll.appendChild(body)
    el.replaceChildren(scroll)
  }

  function paint(): void {
    if (!current || !attempt) return
    const wasResults = el.querySelector('.qz-body') !== null && finished
    if (attempt.phase === 'intro') {
      stopClock()
      renderIntro()
    } else if (attempt.phase === 'running') {
      renderRunning()
    } else if (attempt.phase === 'grading') {
      renderGrading()
    } else {
      // Results are expensive to build and re-entered on every self-mark click;
      // only rebuild when something structural changed.
      if (!wasResults) renderResults()
      else refreshScores()
    }
  }

  /** Re-paint just the marks and the total, for a self-mark click. */
  function refreshScores(): void {
    if (!current || !attempt) return
    const totals = totalMarks()
    const big = el.querySelector('.qz-score-big')
    if (big) big.textContent = `${totals.got} / ${totals.of}`
    const sub = el.querySelector('.qz-score-sub')
    if (sub) {
      const pct = totals.of > 0 ? Math.round((totals.got / totals.of) * 100) : 0
      sub.textContent = `${pct}%${totals.pending ? ' — some answers still need marking' : ''}`
    }
    for (const q of current.doc.questions) {
      const card = el.querySelector(`.qz-q[data-qid="${q.id}"]`)
      const badge = card?.querySelector('.qz-q-score') as HTMLElement | null
      if (!badge) continue
      const g = attempt.gradings.get(q.id)
      const self = attempt.selfMarks.get(q.id)
      const auto = awardMark(q, attempt.answers.get(q.id))
      const got = g && !g.ungraded ? g.mark : self !== undefined ? self : auto
      const of = maxAward(q)
      if (got === null || got === undefined) continue
      badge.textContent = `${got} / ${of}`
      badge.classList.toggle('is-full', got >= of)
      badge.classList.toggle('is-zero', got <= 0)
    }
  }

  function render(input: QuizRenderInput): void {
    current = input
    const key = input.relPath
    const print = fingerprint(input.body)
    const existing = attempts.get(key)
    if (existing && existing.fingerprint === print) {
      // Same paper, same bytes: keep the attempt, including a running clock.
      attempt = existing
    } else {
      const fresh = createAttempt(input, input.body)
      attempt = fresh
      attempts.set(key, fresh)
      // A previous run may have left answers on disk. Paint the fresh sheet
      // first; the restore repaints if there is anything to bring back.
      void restoreAttempt(input, print, fresh)
    }
    finished = attempt.phase === 'results'
    paint()
  }

  function createAttempt(input: QuizRenderInput, body: string): Attempt {
    const answers = new Map<string, Answer>()
    for (const q of input.doc.questions) answers.set(q.id, emptyAnswer(q))
    // An untimed paper has nothing to start, so it opens straight in. A timed one
    // gets a start screen: the clock must not begin while the tab is loading.
    const timed = input.doc.timing !== 'none' && input.doc.totalMs !== null
    return {
      fingerprint: fingerprint(body),
      answers,
      startedAt: 0,
      pausedMs: 0,
      pauseStartedAt: null,
      phase: timed ? 'intro' : 'running',
      gradings: new Map(),
      selfMarks: new Map(),
      flagged: new Set(),
      expired: false
    }
  }

  return { el, render, clear, abandon }
}

/** Re-parse after an edit. Exported so callers never hold a stale doc. */
export function reparse(body: string): QzDoc {
  return parseQz(body)
}
