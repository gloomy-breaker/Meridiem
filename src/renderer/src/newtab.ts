/**
 * The landing page a blank tab shows.
 *
 * A new tab used to be a popover: a list of pages, positioned against the "+"
 * button, dismissed by the first click anywhere else, and gone for good once
 * it closed — so "new tab" was really "search for a page, or else". Now ⌘T (or
 * "+") opens a real tab, and this is what the tab holds. Every destination a
 * new tab plausibly has is on it, in the order you would reach for it: search
 * for a page by name, start a new one, open a file from disk, search the whole
 * workspace by content, or resume one of the last few things you had open.
 *
 * The list is drawn here rather than in main.ts because it is the one part of
 * the app whose whole job is to be scanned: it owns its own keyboard cursor
 * (↑/↓/Enter), its own filtering, and its own entrance.
 */

import { applyIcon, type IconName } from './icons'

export interface NewTabItem {
  relPath: string
  kind: string
  title: string
  icon?: string
}

export interface NewTabDeps {
  /** Every page in the workspace, for the search box and "Recent" pruning. */
  allPages: () => Promise<{ relPath: string; title: string; icon?: string }[]>
  /** Pages and files opened most recently, newest first. */
  recent: () => NewTabItem[]
  /** Show an item in the active tab. */
  open: (item: NewTabItem) => void
  /** Create a page and open it in the active tab. */
  createPage: () => void
  /** Open (or create) today's Daily note. */
  openDaily: () => void
  /** Native file picker → the matching built-in viewer. */
  openFile: () => void
  /** Switch to another workspace folder. */
  openWorkspace: () => void
  /** The workspace-wide content search modal. */
  searchWorkspace: () => void
}

export interface NewTabPane {
  el: HTMLElement
  /** What actually scrolls in here, for the tab's scroll memory. */
  scrollEl: HTMLElement
  /** Reveal the pane. `focusSearch` puts the caret in the search box — right
   *  for a tab the user just asked for, wrong for tabs restored at launch. */
  show: (opts?: { focusSearch?: boolean }) => void
  hide: () => void
  focusSearch: () => void
}

const ICON_FOR_KIND: Record<string, IconName> = {
  page: 'doc',
  pdf: 'doc',
  image: 'image',
  file: 'doc',
  binary: 'doc',
  quiz: 'quiz',
  view: 'table',
  graph: 'network'
}

const MAX_ROWS = 40

export function createNewTabPane(deps: NewTabDeps): NewTabPane {
  const el = document.getElementById('newtab-pane') as HTMLElement
  const scrollEl = el.querySelector('.newtab-scroll') as HTMLElement
  const searchInput = document.getElementById('newtab-search') as HTMLInputElement
  const searchHint = document.getElementById('newtab-search-hint') as HTMLElement
  const listEl = document.getElementById('newtab-list') as HTMLElement
  const labelEl = document.getElementById('newtab-list-label') as HTMLElement
  const countEl = document.getElementById('newtab-list-count') as HTMLElement
  const emptyEl = document.getElementById('newtab-list-empty') as HTMLElement

  let pages: { relPath: string; title: string; icon?: string }[] = []
  let pagesLoaded = false
  let pagesSignature = ''
  let query = ''
  let rows: NewTabItem[] = []
  /** Keyboard cursor into `rows` (−1 = nothing highlighted yet). */
  let activeIndex = -1
  /** The next draw plays the entrance; later draws (typing, reloads) do not. */
  let animateNextDraw = false
  let animatingTimer: number | null = null
  /** What the list currently on screen is showing, so an identical draw can be
   *  skipped entirely. */
  let drawnSignature = ''

  const iconFor = (item: NewTabItem): IconName => {
    if (item.kind === 'page' && (/^Daily\//.test(item.relPath) || /^Weekly\//.test(item.relPath))) return 'calendar'
    return ICON_FOR_KIND[item.kind] ?? 'doc'
  }

  /** Pages are shown without the /index.md they live in. */
  const pathFor = (item: NewTabItem): string =>
    item.kind === 'page' ? item.relPath.replace(/\/?index\.md$/, '') || item.relPath : item.relPath

  function matches(item: { title: string; relPath: string }): boolean {
    if (!query) return true
    return item.title.toLowerCase().includes(query) || item.relPath.toLowerCase().includes(query)
  }

  function draw(rebuild = false): void {
    const searching = query.length > 0
    // A page that was deleted should not linger in "Recent" — but only prune
    // once the page list has actually loaded, or the first draw would empty it.
    const live = pagesLoaded ? new Set(pages.map((p) => p.relPath)) : null
    rows = (
      searching
        ? pages.filter(matches).map((p) => ({ relPath: p.relPath, kind: 'page', title: p.title, icon: p.icon }))
        : deps.recent().filter((it) => it.kind !== 'page' || !live || live.has(it.relPath))
    ).slice(0, MAX_ROWS)
    if (activeIndex >= rows.length) activeIndex = rows.length - 1

    labelEl.textContent = searching ? 'Pages' : 'Recently viewed'
    countEl.textContent = rows.length > 1 ? String(rows.length) : ''
    emptyEl.hidden = rows.length > 0
    emptyEl.textContent = searching
      ? `No pages match “${query}”`
      : 'Pages you open will appear here, newest first.'

    // Rebuilding the list is what makes it flicker: rows are re-created, the
    // entrance restarts, and the list twitches under the caret while typing.
    // Only touch the DOM when the rows themselves actually changed.
    const signature = (searching ? 'q:' : 'r:') + rows.map((r) => r.relPath).join('|')
    if (!rebuild && signature === drawnSignature) {
      paintActive()
      return
    }
    drawnSignature = signature

    if (animateNextDraw) {
      listEl.classList.add('animating')
      animateNextDraw = false
      // The wave is for the entrance only: a list rebuilt mid-wave (the page
      // list arrives a moment after the first paint) must not re-animate.
      if (animatingTimer !== null) window.clearTimeout(animatingTimer)
      animatingTimer = window.setTimeout(() => listEl.classList.remove('animating'), 700)
    }
    listEl.innerHTML = ''
    rows.forEach((item, i) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'newtab-row'
      // Stagger is per-row, so a list of forty arrives as one gesture rather
      // than forty taps.
      row.style.setProperty('--i', String(Math.min(i, 12)))
      const icon = document.createElement('span')
      icon.className = 'newtab-row-icon'
      applyIcon(icon, item.icon, iconFor(item), 15)
      const text = document.createElement('span')
      text.className = 'newtab-row-text'
      const title = document.createElement('span')
      title.className = 'newtab-row-title'
      title.textContent = item.title
      const path = pathFor(item)
      text.append(title)
      // A page at the workspace root has nothing to say beyond its title.
      if (path && path !== item.title) {
        const sub = document.createElement('span')
        sub.className = 'newtab-row-path'
        sub.textContent = path
        text.append(sub)
      }
      row.append(icon, text)
      row.addEventListener('click', () => openRow(i))
      listEl.appendChild(row)
    })
    paintActive()
  }

  /** Move the keyboard cursor without rebuilding the list. */
  function paintActive(): void {
    Array.from(listEl.children).forEach((row, i) => {
      row.classList.toggle('active', i === activeIndex)
    })
  }

  function openRow(i: number): void {
    const item = rows[i]
    if (!item) return
    deps.open(item)
  }

  async function loadPages(): Promise<void> {
    try {
      const list = await deps.allPages()
      if (el.hidden) return
      const signature = list.map((p) => p.relPath).join('|')
      pages = list
      pagesLoaded = true
      if (signature === pagesSignature) return // nothing changed → keep the drawn rows
      pagesSignature = signature
      draw()
    } catch (err) {
      console.warn('new tab: could not list pages', err)
    }
  }

  function focusSearch(): void {
    searchInput.focus()
    searchInput.select()
  }

  function show(opts: { focusSearch?: boolean } = {}): void {
    // A tab is being (re)entered: the entrance is worth replaying, the query is
    // not worth keeping.
    const first = !!el.hidden || query !== ''
    el.hidden = false
    if (first) {
      query = ''
      searchInput.value = ''
      activeIndex = -1
      animateNextDraw = true
    }
    draw(first) // a fresh arrival replays the entrance even for the same rows
    void loadPages()
    if (opts.focusSearch) focusSearch()
  }

  function hide(): void {
    el.hidden = true
    searchHint.hidden = true
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase()
    activeIndex = rows.length > 0 ? 0 : -1
    searchHint.hidden = query === ''
    draw()
  })

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      activeIndex = activeIndex < 0 ? (step > 0 ? 0 : rows.length - 1) : (activeIndex + step + rows.length) % rows.length
      paintActive()
      listEl.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      openRow(activeIndex >= 0 ? activeIndex : 0)
      return
    }
    if (e.key === 'Escape') {
      // Escape clears the query first and only then leaves the field, so one
      // press never costs the whole search.
      e.stopPropagation()
      if (query) {
        query = ''
        searchInput.value = ''
        activeIndex = -1
        searchHint.hidden = true
        draw()
      } else {
        searchInput.blur()
      }
    }
  })

  document.getElementById('newtab-new-page')?.addEventListener('click', () => deps.createPage())
  document.getElementById('newtab-daily')?.addEventListener('click', () => deps.openDaily())
  document.getElementById('newtab-open-folder')?.addEventListener('click', () => deps.openWorkspace())
  document.getElementById('newtab-open-file')?.addEventListener('click', () => deps.openFile())
  document.getElementById('newtab-search-ws')?.addEventListener('click', () => deps.searchWorkspace())

  // The pane is shown and hidden by the tab machinery; start from hidden so a
  // restored blank tab doesn't flash before its tab is activated.
  hide()

  return { el, scrollEl, show, hide, focusSearch }
}
