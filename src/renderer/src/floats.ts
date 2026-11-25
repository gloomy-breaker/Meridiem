/**
 * One place that knows how to get rid of anything floating.
 *
 * Each popover used to carry its own idea of when to close: some had an
 * Escape handler, some an outside-mousedown handler, most had neither, and a
 * few closed on `mousedown` only to be reopened by the `click` that followed —
 * which is why a menu could feel like it refused to go away. Surfaces now
 * register a closer here, and one set of gestures runs all of them: Escape, a
 * click anywhere that is not part of a surface, scrolling, and leaving the
 * window.
 *
 * A surface's *anchor* (the button it hangs off) is registered alongside it,
 * so pressing that button isn't "clicking somewhere else": the button's own
 * handler toggles the surface shut, and the dismissal pass stays out of the
 * way. That distinction is what makes a second press close a menu instead of
 * closing and instantly reopening it.
 */

/** A closer returns what it actually closed (nothing open → null/empty). */
type Closer = () => Element | Element[] | null

/** Which gestures a surface opts out of. Text-anchored menus want every
 *  gesture; a find bar you're scrolling the page to search with does not —
 *  losing it mid-scroll would be the stubbornness problem in reverse. */
export interface FloatOptions {
  /** Close when the page scrolls. Default true. */
  onScroll?: boolean
  /** Close when the window loses focus. Default true. */
  onBlur?: boolean
}

type Gesture = 'dismiss' | 'scroll' | 'blur'

const closers = new Map<Closer, FloatOptions>()
/** Float element → the controls that open it. */
const anchors = new Map<HTMLElement, Element[]>()

/** Everything that can be floating on screen. Used to recognise clicks and
 *  scrolls that happen *inside* a surface, which must not dismiss it. */
export const FLOAT_SELECTOR = [
  '.crumb-pop',
  '.ws-menu',
  '.slash-menu',
  '.agent-slash-menu',
  '.emoji-picker',
  '.agent-recent-pop',
  '.export-menu',
  '.page-view-menu',
  '.page-pill-menu',
  '.page-picker',
  '.table-size-picker',
  '.table-toolbar',
  '.highlight-popup',
  '.math-editor-popup',
  '.find-bar',
  '.search-modal',
  '.modal-backdrop'
].join(',')

export function registerFloatCloser(close: Closer, opts: FloatOptions = {}): () => void {
  closers.set(close, opts)
  return () => closers.delete(close)
}

/** Record what a surface hangs off, so pressing it isn't an outside click. */
export function anchorFloat(float: HTMLElement | null, ...controls: (Element | null)[]): void {
  if (!float) return
  anchors.set(
    float,
    controls.filter((c): c is Element => !!c)
  )
}

/** Close whatever is floating. Returns true if anything was actually open. */
export function dismissFloats(gesture: Gesture = 'dismiss'): boolean {
  let closed = false
  for (const [close, opts] of [...closers]) {
    if (gesture === 'scroll' && opts.onScroll === false) continue
    if (gesture === 'blur' && opts.onBlur === false) continue
    let result: Element | Element[] | null = null
    // One bad closer must not strand the others on screen.
    try {
      result = close()
    } catch (err) {
      console.error('float closer failed', err)
    }
    for (const el of result ? (Array.isArray(result) ? result : [result]) : []) {
      anchors.delete(el as HTMLElement)
      closed = true
    }
  }
  // Surfaces closed by their own handlers never came through a closer, so drop
  // their anchors here rather than let a stale one swallow a later click.
  for (const [float] of anchors) {
    if (!float.isConnected || float.hidden) anchors.delete(float)
  }
  return closed
}

function partOfFloat(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el?.closest) return false
  if (el.closest(FLOAT_SELECTOR)) return true
  for (const controls of anchors.values()) {
    for (const control of controls) if (control.contains(el)) return true
  }
  return false
}

/** Wire the gestures. Call once, after the closers are registered. */
export function installFloatDismissal(): void {
  // Capture, so a component that swallows Escape still lets a menu go away,
  // and so this runs before any click handler that might open something.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      dismissFloats('dismiss')
    },
    true
  )

  document.addEventListener(
    'click',
    (e) => {
      if (partOfFloat(e.target)) return
      dismissFloats('dismiss')
    },
    true
  )

  // Scroll does not bubble, so this has to capture. Popovers are positioned
  // once from a bounding rect and would otherwise hang over freshly scrolled
  // content, pointing at nothing.
  document.addEventListener(
    'scroll',
    (e) => {
      if (partOfFloat(e.target)) return // scrolling inside a long menu is fine
      dismissFloats('scroll')
    },
    true
  )

  window.addEventListener('blur', () => dismissFloats('blur'))
}
