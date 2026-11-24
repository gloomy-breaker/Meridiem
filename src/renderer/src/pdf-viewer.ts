// ---------------------------------------------------------------------------
// In-app PDF viewer built on pdf.js.
//
// The old implementation used an Electron <webview>, which spawned a whole
// guest renderer per document (memory hog, and a guest crash took the window
// down with it). pdf.js runs in this renderer with a blob worker and paints
// each page to a canvas, so opening a PDF costs a fraction of that.
//
// Painting is driven by explicit geometry (getBoundingClientRect along the
// scroller) rather than IntersectionObserver: Electron throttles observer
// delivery for occluded windows, which left pages blank until the window was
// focused. Pages far off screen are un-painted so memory stays bounded.
// ---------------------------------------------------------------------------
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

export interface PdfViewerState {
  page: number
  pages: number
  scale: number
}

export interface PdfViewerHandle {
  destroy(): void
  setScale(scale: number): void
  getScale(): number
  zoom(delta: number): void
  fitWidth(): void
  goToPage(page: number): void
}

let workerReady = false

function ensureWorker(): void {
  if (workerReady) return
  // Blob worker: the packaged app is served from file://, where module workers
  // loaded by URL are blocked, but blob: URLs are fine (the CSP allows them).
  //
  // A workerSrc URL (not a shared workerPort!): with a shared port, pdf.js
  // terminates that single worker as soon as any document is destroyed, so the
  // NEXT getDocument — the live preview's second render, or any PDF opened
  // after closing one — failed with "Worker was destroyed". Letting pdf.js own
  // a worker per document fixes that.
  const blob = new Blob([workerSource], { type: 'text/javascript' })
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
  workerReady = true
}

interface PageSlot {
  wrapper: HTMLElement
  canvas: HTMLCanvasElement
  textDiv: HTMLElement
  pageNumber: number
  rendered: boolean
  rendering: boolean
  baseWidth: number
  baseHeight: number
}

// Keep at most this much canvas around; pages further than this from the
// viewport are released and repainted when scrolled back into range.
const KEEP_PX = 2600
const PRELOAD_PX = 700
const GAP = 18
const PAD_TOP = 18

export async function createPdfViewer(opts: {
  container: HTMLElement
  bytes: Uint8Array
  onState?: (state: PdfViewerState) => void
  initialScale?: number
}): Promise<PdfViewerHandle> {
  ensureWorker()
  const { container } = opts
  const loadingTask = pdfjsLib.getDocument({ data: opts.bytes, isEvalSupported: false })
  const doc = await loadingTask.promise

  container.innerHTML = ''
  const pagesEl = document.createElement('div')
  pagesEl.className = 'pdf-pages'
  container.appendChild(pagesEl)

  let scale = opts.initialScale ?? 1
  let destroyed = false
  let currentPage = 1
  const slots: PageSlot[] = []

  const firstPage = await doc.getPage(1)
  const firstViewport = firstPage.getViewport({ scale: 1 })
  const available = Math.max(320, container.clientWidth - 48)
  const fitScale = Math.min(1.5, available / firstViewport.width)

  // Placeholders for every page first (cheap), then paint on demand.
  for (let n = 1; n <= doc.numPages; n++) {
    const page = n === 1 ? firstPage : await doc.getPage(n)
    const base = page.getViewport({ scale: 1 })
    const wrapper = document.createElement('div')
    wrapper.className = 'pdf-page'
    wrapper.dataset.page = String(n)
    const canvas = document.createElement('canvas')
    const textDiv = document.createElement('div')
    textDiv.className = 'textLayer'
    wrapper.append(canvas, textDiv)
    pagesEl.appendChild(wrapper)
    const slot: PageSlot = {
      wrapper,
      canvas,
      textDiv,
      pageNumber: n,
      rendered: false,
      rendering: false,
      baseWidth: base.width,
      baseHeight: base.height
    }
    slots.push(slot)
    sizeSlot(slot, scale)
  }

  // Render at the display's devicePixelRatio so text stays crisp on Retina,
  // but bound the backing store by megapixels (≈4 bytes/px) so extreme zoom on
  // a huge page can't balloon memory.
  const MAX_CANVAS_MP = 14
  function pixelRatio(slot: PageSlot): number {
    const want = Math.min(window.devicePixelRatio || 1, 2)
    const px = slot.baseWidth * scale * slot.baseHeight * scale
    if (px * want * want <= MAX_CANVAS_MP * 1e6) return want
    return Math.max(1, Math.sqrt((MAX_CANVAS_MP * 1e6) / px))
  }

  function sizeSlot(slot: PageSlot, s: number): void {
    const w = Math.floor(slot.baseWidth * s)
    const h = Math.floor(slot.baseHeight * s)
    slot.wrapper.style.width = w + 'px'
    slot.canvas.style.width = w + 'px'
    slot.canvas.style.height = h + 'px'
  }

  async function paint(slot: PageSlot): Promise<void> {
    if (slot.rendered || slot.rendering || destroyed) return
    slot.rendering = true
    try {
      const page = await doc.getPage(slot.pageNumber)
      const dpr = pixelRatio(slot)
      const viewport = page.getViewport({ scale: scale * dpr })
      slot.canvas.width = Math.max(1, Math.floor(viewport.width))
      slot.canvas.height = Math.max(1, Math.floor(viewport.height))
      const ctx = slot.canvas.getContext('2d')
      if (!ctx) return
      await page.render({ canvasContext: ctx, viewport }).promise
      slot.rendered = true
      slot.wrapper.classList.add('painted')
      // Invisible text layer over the canvas → selectable/searchable/copyable.
      // Positioning is driven by --total-scale-factor (see styles.css).
      try {
        slot.textDiv.innerHTML = ''
        slot.textDiv.style.setProperty('--scale-factor', String(scale))
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: slot.textDiv,
          viewport: page.getViewport({ scale })
        })
        await textLayer.render()
      } catch {
        /* no selectable text for this page (scanned image etc.) */
      }
    } catch {
      /* page failed to paint — leave the placeholder */
    } finally {
      slot.rendering = false
    }
  }

  function release(slot: PageSlot): void {
    if (!slot.rendered || slot.rendering) return
    slot.canvas.width = 1
    slot.canvas.height = 1
    slot.rendered = false
    slot.wrapper.classList.remove('painted')
    slot.textDiv.innerHTML = ''
  }

  function emit(): void {
    opts.onState?.({ page: currentPage, pages: doc.numPages, scale })
  }

  // Page offsets are computed from the known page heights rather than measured
  // with getBoundingClientRect: the rects of a flex column inside a scroller are
  // affected by padding/scrollbar quirks and made the "which page is visible"
  // test unreliable right after a jump or when the pane was re-shown.
  let offsets: number[] = []
  function layout(): void {
    let y = PAD_TOP
    offsets = slots.map((slot) => {
      const top = y
      y += Math.floor(slot.baseHeight * scale) + GAP
      return top
    })
  }
  function pageAt(scrollTop: number): number {
    const probe = scrollTop + container.clientHeight * 0.3
    let n = 1
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= probe) n = i + 1
      else break
    }
    return n
  }

  function update(): void {
    if (destroyed) return
    const scrollTop = container.scrollTop
    const viewTop = scrollTop - PAD_TOP
    const viewBottom = scrollTop + container.clientHeight - PAD_TOP
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      const top = offsets[i]
      const bottom = top + Math.floor(slot.baseHeight * scale)
      if (bottom > viewTop - PRELOAD_PX && top < viewBottom + PRELOAD_PX) void paint(slot)
      else if (bottom < viewTop - KEEP_PX || top > viewBottom + KEEP_PX) release(slot)
    }
    const nearest = pageAt(scrollTop)
    if (nearest !== currentPage) {
      currentPage = nearest
      emit()
    }
  }

  let updateTimer: number | null = null
  function scheduleUpdate(): void {
    if (updateTimer !== null) return
    updateTimer = window.setTimeout(() => {
      updateTimer = null
      update()
    }, 90)
  }

  function setScale(next: number, anchorPage?: number): void {
    const clamped = Math.max(0.35, Math.min(4, next))
    if (Math.abs(clamped - scale) < 0.001) return
    const keep = anchorPage ?? currentPage
    scale = clamped
    for (const slot of slots) {
      sizeSlot(slot, scale)
      release(slot)
    }
    layout()
    update()
    requestAnimationFrame(() => goToPage(keep))
    emit()
  }

  function goToPage(page: number): void {
    const i = Math.max(0, Math.min(slots.length - 1, page - 1))
    container.scrollTop = Math.max(0, offsets[i] - PAD_TOP - 16)
    update()
  }

  // ⌘/Ctrl + wheel zooms, plain wheel scrolls (the container already scrolls).
  const onWheel = (e: WheelEvent): void => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    setScale(scale * (e.deltaY < 0 ? 1.1 : 0.9))
  }
  container.addEventListener('wheel', onWheel, { passive: false })
  const onScroll = (): void => scheduleUpdate()
  container.addEventListener('scroll', onScroll, { passive: true })
  const onResize = (): void => scheduleUpdate()
  window.addEventListener('resize', onResize)
  // Chromium throttles rendering for hidden/occluded windows, so a page that
  // was mid-render when the window went away is repainted on return.
  const onVisible = (): void => scheduleUpdate()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)

  scale = fitScale
  for (const slot of slots) sizeSlot(slot, scale)
  layout()
  container.scrollTop = 0
  update()
  emit()
  // Late layout (fonts, scrollbar appearing) can shift page offsets; re-check.
  window.setTimeout(() => scheduleUpdate(), 400)
  window.setTimeout(() => scheduleUpdate(), 1200)

  return {
    destroy(): void {
      destroyed = true
      if (updateTimer !== null) window.clearTimeout(updateTimer)
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      for (const slot of slots) release(slot)
      // pdf.js v6: the loading task owns destroy() (it terminates the worker),
      // while PDFDocumentProxy only has cleanup(). Calling doc.destroy() — which
      // this used to do — threw "doc.destroy is not a function" and aborted the
      // caller, breaking the live preview's refresh and closing any PDF pane.
      try {
        const task = loadingTask as unknown as { destroy?: () => Promise<void> }
        const d = doc as unknown as { cleanup?: () => Promise<void>; destroy?: () => Promise<void> }
        if (typeof task.destroy === 'function') void task.destroy()
        else if (typeof d.destroy === 'function') void d.destroy()
        else if (typeof d.cleanup === 'function') void d.cleanup()
      } catch (err) {
        console.warn('[meridiem] pdf teardown failed:', err)
      }
      container.innerHTML = ''
    },
    setScale: (s: number) => setScale(s),
    getScale: () => scale,
    zoom: (delta: number) => setScale(scale + delta),
    fitWidth: () => {
      const width = Math.max(320, container.clientWidth - 48)
      setScale(Math.min(1.5, width / slots[0].baseWidth), 1)
    },
    goToPage
  }
}
