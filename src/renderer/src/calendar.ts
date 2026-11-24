/**
 * The sidebar's mini-calendar and Daily-notes list.
 *
 * A compact month grid that always shows ISO week numbers, marks today with a
 * terracotta pill, and opens (or creates) `Daily/YYYY-MM-DD.md` when a date is
 * clicked. It is deliberately local-state only: the month you are browsing is a
 * view, not a setting, so it resets to the current month on relaunch.
 */

export interface DailyNote {
  /** `YYYY-MM-DD`, parsed from the file name. */
  date: string
  relPath: string
  title: string
}

export interface CalendarNode {
  name: string
  relPath: string
  kind: string
  title?: string
  children?: CalendarNode[]
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Local date as `YYYY-MM-DD` — never `toISOString`, which would shift the day. */
export function todayKey(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function keyFor(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** ISO-8601 week number (weeks start Monday, week 1 contains Jan 4). */
export function isoWeek(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month, day))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/**
 * Every dated note under `Daily/`, newest first. `Daily` is matched at any
 * depth so a workspace that nests it under a subject still works.
 */
export function collectDailyNotes(root: CalendarNode | null): DailyNote[] {
  if (!root) return []
  const out: DailyNote[] = []
  const walk = (node: CalendarNode): void => {
    if (node.kind === 'page' || node.kind === 'quiz') {
      const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\.md)?(?:\/index\.md)?$/i.exec(node.relPath)
      const inDaily = /(^|\/)Daily\//i.test(node.relPath)
      if (m && inDaily) out.push({ date: m[1], relPath: node.relPath, title: node.title ?? m[1] })
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  const seen = new Set<string>()
  return out
    .filter((n) => (seen.has(n.date) ? false : (seen.add(n.date), true)))
    .sort((a, b) => b.date.localeCompare(a.date))
}

export function formatDailyDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

export interface CalendarHandle {
  /** Rebuild the month grid (used when the day rolls over). */
  refresh: () => void
}

export function setupCalendar(
  host: HTMLElement,
  opts: { onPick: (date: string) => void; onToday?: () => void }
): CalendarHandle {
  const now = new Date()
  // The month being browsed. Starts on the current month.
  let viewYear = now.getFullYear()
  let viewMonth = now.getMonth()

  const mount = (): void => {
    const today = todayKey()
    host.innerHTML = ''

    const bar = document.createElement('div')
    bar.className = 'cal-bar'

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'cal-label'
    label.title = 'Back to this month'
    label.textContent = `${MONTHS[viewMonth]} ${viewYear}`
    label.addEventListener('click', () => {
      viewYear = new Date().getFullYear()
      viewMonth = new Date().getMonth()
      mount()
    })

    const nav = document.createElement('div')
    nav.className = 'cal-nav'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'cal-nav-btn'
    prev.title = 'Previous month'
    prev.setAttribute('aria-label', 'Previous month')
    prev.textContent = '‹'
    prev.addEventListener('click', () => {
      viewMonth--
      if (viewMonth < 0) {
        viewMonth = 11
        viewYear--
      }
      mount()
    })
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'cal-nav-btn'
    next.title = 'Next month'
    next.setAttribute('aria-label', 'Next month')
    next.textContent = '›'
    next.addEventListener('click', () => {
      viewMonth++
      if (viewMonth > 11) {
        viewMonth = 0
        viewYear++
      }
      mount()
    })
    nav.append(prev, next)
    bar.append(label, nav)

    const todayBtn = document.createElement('button')
    todayBtn.type = 'button'
    todayBtn.className = 'cal-today'
    todayBtn.textContent = 'Today'
    todayBtn.addEventListener('click', () => {
      viewYear = new Date().getFullYear()
      viewMonth = new Date().getMonth()
      mount()
      opts.onToday?.()
    })
    bar.appendChild(todayBtn)

    const grid = document.createElement('div')
    grid.className = 'cal-grid'

    const wnHead = document.createElement('span')
    wnHead.className = 'cal-wn cal-head'
    wnHead.textContent = 'WN'
    wnHead.title = 'ISO week number'
    grid.appendChild(wnHead)
    for (const wd of WEEKDAYS) {
      const cell = document.createElement('span')
      cell.className = 'cal-weekday'
      cell.textContent = wd
      grid.appendChild(cell)
    }

    // Monday-first grid: walk from the Monday on/before the 1st.
    const first = new Date(viewYear, viewMonth, 1)
    const offset = (first.getDay() + 6) % 7
    const start = new Date(viewYear, viewMonth, 1 - offset)

    for (let row = 0; row < 6; row++) {
      const rowStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + row * 7)
      const wn = document.createElement('span')
      wn.className = 'cal-wn'
      wn.textContent = String(
        isoWeek(rowStart.getFullYear(), rowStart.getMonth(), rowStart.getDate())
      )
      wn.title = `Week ${wn.textContent}`
      grid.appendChild(wn)

      for (let i = 0; i < 7; i++) {
        const d = new Date(rowStart.getFullYear(), rowStart.getMonth(), rowStart.getDate() + i)
        const key = keyFor(d.getFullYear(), d.getMonth(), d.getDate())
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'cal-day'
        btn.textContent = String(d.getDate())
        btn.title = formatDailyDate(key)
        btn.dataset.date = key
        if (d.getMonth() !== viewMonth) btn.classList.add('is-outside')
        if (key === today) btn.classList.add('is-today')
        btn.addEventListener('click', () => opts.onPick(key))
        grid.appendChild(btn)
      }
    }

    // A sixth row is only kept when the month actually spills into it; an empty
    // trailing week makes the calendar look like it has lost a row.
    const lastRow = Array.from(grid.querySelectorAll('.cal-day')).slice(-7)
    if (lastRow.length === 7 && lastRow.every((el) => el.classList.contains('is-outside'))) {
      const cells = Array.from(grid.children).slice(-8)
      for (const cell of cells) cell.remove()
    }

    host.append(bar, grid)
  }

  mount()
  return { refresh: mount }
}

/** The Daily view's list. Rebuilt whenever the workspace tree changes. */
export function renderDailyList(
  host: HTMLElement,
  notes: DailyNote[],
  opts: { onOpen: (note: DailyNote) => void; onCreateToday: () => void }
): void {
  host.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'daily-head'
  const title = document.createElement('span')
  title.textContent = 'Daily notes'
  const todayBtn = document.createElement('button')
  todayBtn.type = 'button'
  todayBtn.className = 'daily-today-btn'
  todayBtn.textContent = 'Today'
  todayBtn.title = 'Open or create today’s note'
  todayBtn.addEventListener('click', opts.onCreateToday)
  head.append(title, todayBtn)
  host.appendChild(head)

  if (notes.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-empty'
    empty.textContent = 'No daily notes yet. Click a date in the calendar.'
    host.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'daily-list'
  for (const note of notes.slice(0, 60)) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'daily-row'
    const date = document.createElement('span')
    date.className = 'daily-date'
    date.textContent = formatDailyDate(note.date)
    row.append(date)
    // Most daily notes are titled with their own date; only show a second
    // column when the author actually gave the day a name.
    if (note.title !== note.date) {
      const name = document.createElement('span')
      name.className = 'daily-name'
      name.textContent = note.title
      row.append(name)
    }
    row.title = note.relPath
    row.addEventListener('click', () => opts.onOpen(note))
    list.appendChild(row)
  }
  host.appendChild(list)
}
