/**
 * The whole-canvas workspace modes: Views, Graph, Inbox, Tasks and
 * Files & Media.
 *
 * One module owns all five because they share a shell (title, subtitle,
 * actions, scroll area) and because they are read-mostly projections over the
 * same workspace walk. The sidebar chooses a mode; this module paints it.
 * Nothing here touches the page editor or the save queue — opening a result
 * goes through the ordinary `openRel` router.
 */

import { applyIcon, iconEl, type IconName } from './icons'
import { localFileUrl } from './wysiwyg'

export type WorkspaceViewId = 'recent' | 'pending' | 'exams' | 'all'
export type WorkspaceModeId = WorkspaceViewId | 'graph' | 'inbox' | 'tasks' | 'media'

export interface ModeDeps {
  open: (relPath: string, kind: string) => void
  notify: (text: string) => void
  /** Re-read the page tree after a write that changes page content. */
  afterChange?: () => void
  openInboxNote?: () => void
  /** Keep the sidebar's summary line in step with an in-pane refresh. */
  summary?: (count: number) => void
}

interface IndexEntry {
  relPath: string
  title: string
  icon: string
  kind: 'page' | 'quiz'
  mtime: number
}

interface TaskEntry {
  relPath: string
  title: string
  icon: string
  line: number
  text: string
  checked: boolean
}

interface MediaEntry {
  relPath: string
  name: string
  kind: 'image' | 'pdf' | 'file'
  mtime: number
  size: number
}

interface InboxEntry {
  line: number
  text: string
  checked: boolean
}

interface GraphNode {
  id: string
  title: string
  icon: string
  kind: 'page' | 'quiz'
}

interface GraphEdge {
  source: string
  target: string
}

const VIEW_TITLES: Record<WorkspaceViewId, { title: string; sub: string }> = {
  recent: { title: 'Recently written', sub: 'The notes and papers you touched most recently.' },
  pending: { title: 'Pending tasks', sub: 'Every unchecked box across the workspace, by note.' },
  exams: { title: 'Exam papers', sub: 'Every .qz paper in this workspace.' },
  all: { title: 'All notes', sub: 'Every markdown page and exam paper, newest first.' }
}

const TYPE_LABEL: Record<string, string> = {
  page: 'Note',
  quiz: 'Exam'
}

function modeParts(mode: WorkspaceModeId): { title: string; sub: string; kind: string } {
  if (mode === 'graph') return { title: 'Graph', sub: 'Every note and every [[wikilink]] between them.', kind: 'Graph' }
  if (mode === 'inbox') return { title: 'Inbox', sub: 'Capture first, triage later. Backed by Inbox.md.', kind: 'Inbox' }
  if (mode === 'tasks') return { title: 'Tasks', sub: 'Every checkbox in the workspace, live from the source files.', kind: 'Tasks' }
  if (mode === 'media') return { title: 'Files & media', sub: 'Images, handwritten scans and PDFs in this workspace.', kind: 'Media' }
  return { ...VIEW_TITLES[mode], kind: 'View' }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function clearHost(host: HTMLElement): void {
  host.replaceChildren()
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((today - day) / 86_400_000)
  if (diff === 0) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function folderOf(relPath: string): string {
  const clean = relPath.replace(/\/?index\.md$/i, '').replace(/\/?index\.qz$/i, '')
  const parts = clean.split('/')
  parts.pop()
  return parts.join(' / ') || 'Workspace'
}

function typeOf(entry: { relPath: string; kind: string }): string {
  if (entry.kind === 'quiz') return 'Exam'
  if (/^Daily\//.test(entry.relPath)) return 'Daily'
  if (/^Weekly\//.test(entry.relPath)) return 'Weekly'
  if (/^Templates\//.test(entry.relPath)) return 'Template'
  return TYPE_LABEL[entry.kind] ?? 'Note'
}

function iconFor(entry: { relPath: string; icon?: string; kind: string }): IconName {
  if (entry.kind === 'quiz') return 'quiz'
  if (/^Daily\//.test(entry.relPath) || /^Weekly\//.test(entry.relPath)) return 'calendar'
  return 'doc'
}

function emptyState(title: string, sub: string): HTMLElement {
  const box = el('div', 'wm-empty')
  const icon = el('div', 'wm-empty-icon')
  icon.append(iconEl('sparkle', 24, 1.5))
  const h = el('h3'); h.textContent = title
  const p = el('p'); p.textContent = sub
  box.append(icon, h, p)
  return box
}

function loadingState(label = 'Reading the workspace…'): HTMLElement {
  const box = el('div', 'wm-loading')
  const dot = el('span', 'wm-spinner')
  const text = el('span'); text.textContent = label
  box.append(dot, text)
  return box
}

function toolbar(): HTMLElement {
  return el('div', 'wm-toolbar')
}

// ---------------------------------------------------------------------------
// Views — one table, four filters
// ---------------------------------------------------------------------------

async function renderView(host: HTMLElement, view: WorkspaceViewId, deps: ModeDeps): Promise<string> {
  host.replaceChildren(loadingState())
  let rows: { entry: IndexEntry; meta: string; note: string }[] = []

  if (view === 'pending') {
    const tasks = (await window.api.wsTasks()) as TaskEntry[]
    const open = tasks.filter((t) => !t.checked)
    const byFile = new Map<string, TaskEntry[]>()
    for (const task of open) {
      const list = byFile.get(task.relPath) ?? []
      list.push(task)
      byFile.set(task.relPath, list)
    }
    rows = [...byFile.entries()].map(([relPath, list]) => ({
      entry: {
        relPath,
        title: list[0].title,
        icon: list[0].icon,
        kind: relPath.endsWith('.qz') ? 'quiz' : 'page',
        mtime: 0
      },
      meta: `${list.length} open`,
      note: folderOf(relPath)
    }))
  } else {
    const index = (await window.api.wsIndex()) as IndexEntry[]
    const content = index.filter((e) => !/^Bin\//i.test(e.relPath))
    let list = content
    if (view === 'exams') list = content.filter((e) => e.kind === 'quiz' && !/^Templates\//i.test(e.relPath))
    if (view === 'all') list = content.filter((e) => !/^Templates\//i.test(e.relPath))
    if (view === 'recent') list = content.filter((e) => !/^Templates\//i.test(e.relPath))
    list = list.slice().sort((a, b) => b.mtime - a.mtime)
    rows = list.map((entry) => ({
      entry,
      meta: formatDate(entry.mtime),
      note: folderOf(entry.relPath)
    }))
  }

  clearHost(host)
  if (rows.length === 0) {
    deps.summary?.(0)
    host.append(
      emptyState(
        view === 'exams' ? 'No exam papers yet' : view === 'pending' ? 'Nothing pending' : 'No notes yet',
        view === 'exams'
          ? 'A .qz file in this folder will appear here.'
          : view === 'pending'
            ? 'Every task you tick off stays in its source note.'
            : 'Create a note from the Notes mode or the Home screen.'
      )
    )
    return '0'
  }

  const bar = toolbar()
  const search = el('input', 'wm-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'Filter…'
  search.spellcheck = false
  const count = el('span', 'wm-count')
  bar.append(search, count)
  host.appendChild(bar)

  const table = el('table', 'wm-table')
  const thead = el('thead')
  const hr = el('tr')
  for (const label of ['Name', 'Folder', 'Type', 'Updated']) {
    const th = el('th'); th.textContent = label; hr.appendChild(th)
  }
  thead.appendChild(hr)
  const tbody = el('tbody')
  table.append(thead, tbody)
  host.appendChild(table)

  const draw = (): void => {
    const q = search.value.trim().toLowerCase()
    const filtered = rows.filter(
      (r) =>
        !q ||
        r.entry.title.toLowerCase().includes(q) ||
        r.entry.relPath.toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q) ||
        (r.entry.kind === 'quiz' && 'exam'.includes(q))
    )
    count.textContent = `${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ''}`
    tbody.replaceChildren()
    for (const row of filtered) {
      const tr = el('tr', 'wm-row')
      const nameCell = el('td', 'wm-name-cell')
      const icon = el('span', 'wm-row-icon')
      applyIcon(icon, row.entry.icon, iconFor(row.entry), 14)
      const name = el('span', 'wm-name')
      name.textContent = row.entry.title
      nameCell.append(icon, name)
      const folder = el('td', 'wm-muted')
      folder.textContent = row.note || folderOf(row.entry.relPath)
      const type = el('td')
      const badge = el('span', `wm-badge wm-badge-${row.entry.kind}`)
      badge.textContent = view === 'pending' ? 'Tasks' : typeOf(row.entry)
      type.appendChild(badge)
      const updated = el('td', 'wm-muted')
      updated.textContent = row.meta
      tr.append(nameCell, folder, type, updated)
      tr.title = row.entry.relPath
      tr.addEventListener('click', () => deps.open(row.entry.relPath, row.entry.kind))
      tbody.appendChild(tr)
    }
    if (filtered.length === 0) {
      const tr = el('tr')
      const td = el('td', 'wm-no-match')
      td.colSpan = 4
      td.textContent = `Nothing matches “${search.value.trim()}”.`
      tr.appendChild(td)
      tbody.appendChild(tr)
    }
  }

  search.addEventListener('input', draw)
  deps.summary?.(rows.length)
  draw()
  return String(rows.length)
}

// ---------------------------------------------------------------------------
// Graph — a small deterministic force layout with drag + hover
// ---------------------------------------------------------------------------

async function renderGraph(host: HTMLElement, deps: ModeDeps): Promise<string> {
  host.replaceChildren(loadingState('Laying out the graph…'))
  const data = await window.api.wsGraph()
  const nodes: GraphNode[] = data.nodes.slice(0, 260)
  const ids = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target))

  clearHost(host)
  const bar = toolbar()
  const legend = el('span', 'wm-legend')
  legend.textContent = `${nodes.length} notes · ${edges.length} links${data.nodes.length > nodes.length ? ' · largest 260 shown' : ''}`
  deps.summary?.(nodes.length)
  const refresh = el('button', 'wm-btn')
  refresh.type = 'button'
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => void renderGraph(host, deps))
  bar.append(legend, refresh)
  host.appendChild(bar)

  if (nodes.length === 0) {
    host.append(emptyState('Nothing to map yet', 'Write a [[wikilink]] in a note and it will appear here.'))
    return '0'
  }

  const W = 1000
  const H = 660
  const cx = W / 2
  const cy = H / 2

  interface SimNode extends GraphNode {
    x: number
    y: number
    vx: number
    vy: number
    degree: number
  }

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }

  const sim: SimNode[] = nodes.map((node, i) => {
    const angle = (i / nodes.length) * Math.PI * 2
    const radius = Math.min(W, H) * 0.34
    return {
      ...node,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: degree.get(node.id) ?? 0
    }
  })
  const byId = new Map(sim.map((n) => [n.id, n]))
  const simEdges = edges
    .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)! }))
    .filter((e) => e.source && e.target)

  // Repulsion + springs. A fixed number of ticks keeps it deterministic and
  // avoids a background animation loop for a view that is mostly static.
  for (let tick = 0; tick < 280; tick++) {
    for (let i = 0; i < sim.length; i++) {
      const a = sim[i]
      for (let j = i + 1; j < sim.length; j++) {
        const b = sim[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.01) {
          dx = (i - j) * 0.5
          dy = 0.5
          d2 = dx * dx + dy * dy
        }
        const d = Math.sqrt(d2)
        const force = 6500 / d2
        const fx = (dx / d) * force
        const fy = (dy / d) * force
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    for (const e of simEdges) {
      const dx = e.target.x - e.source.x
      const dy = e.target.y - e.source.y
      const d = Math.hypot(dx, dy) || 1
      const force = (d - 165) * 0.01
      const fx = (dx / d) * force
      const fy = (dy / d) * force
      e.source.vx += fx
      e.source.vy += fy
      e.target.vx -= fx
      e.target.vy -= fy
    }
    for (const n of sim) {
      n.vx += (cx - n.x) * 0.0012
      n.vy += (cy - n.y) * 0.0012
      n.vx *= 0.82
      n.vy *= 0.82
      n.x = Math.max(36, Math.min(W - 36, n.x + n.vx))
      n.y = Math.max(32, Math.min(H - 32, n.y + n.vy))
    }
  }

  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('class', 'wm-graph')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  const edgeLayer = document.createElementNS(ns, 'g')
  const nodeLayer = document.createElementNS(ns, 'g')
  svg.append(edgeLayer, nodeLayer)

  const adjacency = new Map<string, Set<string>>()
  for (const e of simEdges) {
    if (!adjacency.has(e.source.id)) adjacency.set(e.source.id, new Set())
    if (!adjacency.has(e.target.id)) adjacency.set(e.target.id, new Set())
    adjacency.get(e.source.id)!.add(e.target.id)
    adjacency.get(e.target.id)!.add(e.source.id)
  }

  const edgeEls: { el: SVGLineElement; source: SimNode; target: SimNode }[] = []
  for (const e of simEdges) {
    const line = document.createElementNS(ns, 'line')
    line.setAttribute('class', 'wm-edge')
    line.setAttribute('x1', String(e.source.x))
    line.setAttribute('y1', String(e.source.y))
    line.setAttribute('x2', String(e.target.x))
    line.setAttribute('y2', String(e.target.y))
    line.dataset.source = e.source.id
    line.dataset.target = e.target.id
    edgeLayer.appendChild(line)
    edgeEls.push({ el: line, source: e.source, target: e.target })
  }

  const nodeEls = new Map<string, SVGGElement>()
  for (const n of sim) {
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('class', 'wm-node' + (n.degree === 0 ? ' is-orphan' : ''))
    g.dataset.id = n.id
    g.dataset.degree = String(n.degree)
    const r = Math.min(15, 5 + Math.sqrt(n.degree) * 2.4)
    const circle = document.createElementNS(ns, 'circle')
    circle.setAttribute('cx', String(n.x))
    circle.setAttribute('cy', String(n.y))
    circle.setAttribute('r', String(r))
    const label = document.createElementNS(ns, 'text')
    label.setAttribute('x', String(n.x))
    label.setAttribute('y', String(n.y + r + 11))
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('class', 'wm-node-label')
    label.textContent = n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title
    g.append(circle, label)
    g.addEventListener('mouseenter', () => {
      const linked = adjacency.get(n.id)
      for (const item of edgeEls) {
        const on = item.source.id === n.id || item.target.id === n.id
        item.el.classList.toggle('is-lit', !!on)
      }
      for (const [id, other] of nodeEls) {
        const linkedNode = id === n.id || !!linked?.has(id)
        other.classList.toggle('is-dimmed', !linkedNode && sim.length > 1)
      }
    })
    g.addEventListener('mouseleave', () => {
      for (const item of edgeEls) item.el.classList.remove('is-lit')
      for (const other of nodeEls.values()) other.classList.remove('is-dimmed')
    })
    nodeLayer.appendChild(g)
    nodeEls.set(n.id, g)
  }

  // Drag, with a click threshold so moving a node does not open its note.
  let drag: { node: SimNode; group: SVGGElement; startX: number; startY: number; moved: boolean } | null = null
  const toSvg = (ev: PointerEvent): { x: number; y: number } => {
    const rect = svg.getBoundingClientRect()
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H
    }
  }
  svg.addEventListener('pointerdown', (ev) => {
    const target = (ev.target as Element).closest('.wm-node') as SVGGElement | null
    if (!target) return
    const node = byId.get(target.dataset.id ?? '')
    if (!node) return
    const p = toSvg(ev)
    drag = { node, group: target, startX: p.x, startY: p.y, moved: false }
    svg.setPointerCapture(ev.pointerId)
  })
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return
    const p = toSvg(ev)
    if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 3) drag.moved = true
    drag.node.x = p.x
    drag.node.y = p.y
    const circle = drag.group.querySelector('circle')
    const label = drag.group.querySelector('text')
    circle?.setAttribute('cx', String(p.x))
    circle?.setAttribute('cy', String(p.y))
    label?.setAttribute('x', String(p.x))
    label?.setAttribute('y', String(p.y + 24))
    for (const item of edgeEls) {
      if (item.source.id === drag.node.id) {
        item.el.setAttribute('x1', String(p.x))
        item.el.setAttribute('y1', String(p.y))
      }
      if (item.target.id === drag.node.id) {
        item.el.setAttribute('x2', String(p.x))
        item.el.setAttribute('y2', String(p.y))
      }
    }
  })
  svg.addEventListener('pointerup', (ev) => {
    if (!drag) return
    const moved = drag.moved
    const node = drag.node
    drag = null
    try {
      svg.releasePointerCapture(ev.pointerId)
    } catch {
      /* pointer already released */
    }
    if (!moved) deps.open(node.id, node.kind)
  })

  host.appendChild(svg)
  return String(nodes.length)
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

async function renderInbox(host: HTMLElement, deps: ModeDeps, tab: 'active' | 'done' = 'active'): Promise<string> {
  const items = (await window.api.wsInbox()) as InboxEntry[]
  clearHost(host)
  const bar = toolbar()
  const tabs = el('div', 'wm-tabs')
  const activeCount = items.filter((i) => !i.checked).length
  deps.summary?.(activeCount)
  for (const [id, label, count] of [
    ['active', 'Active', activeCount],
    ['done', 'Done', items.length - activeCount]
  ] as const) {
    const btn = el('button', 'wm-tab' + (tab === id ? ' is-active' : ''))
    btn.type = 'button'
    btn.textContent = `${label} ${count}`
    btn.addEventListener('click', () => void renderInbox(host, deps, id))
    tabs.appendChild(btn)
  }
  const openNote = el('button', 'wm-btn')
  openNote.type = 'button'
  openNote.textContent = 'Open Inbox.md'
  openNote.addEventListener('click', () => deps.openInboxNote?.())
  bar.append(tabs, openNote)
  host.appendChild(bar)

  const form = el('form', 'wm-capture')
  const input = el('input', 'wm-capture-input') as HTMLInputElement
  input.placeholder = 'Capture a thought…'
  input.autocomplete = 'off'
  const add = el('button', 'wm-btn wm-btn-accent')
  add.type = 'submit'
  add.textContent = '+ New capture'
  form.append(input, add)
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    void (async () => {
      await window.api.wsInboxAdd(text)
      deps.notify('Captured to Inbox')
      await renderInbox(host, deps, 'active')
    })()
  })
  host.appendChild(form)

  const visible = items.filter((i) => (tab === 'active' ? !i.checked : i.checked))
  if (visible.length === 0) {
    host.append(
      emptyState(
        tab === 'active' ? 'Inbox zero' : 'Nothing done yet',
        tab === 'active' ? 'New captures land here, ready for a quiet triage.' : 'Captures you finish move here.'
      )
    )
    return String(activeCount)
  }

  const list = el('div', 'wm-inbox-list')
  for (const item of visible) {
    const row = el('div', 'wm-inbox-row' + (item.checked ? ' is-done' : ''))
    const box = el('button', 'wm-check' + (item.checked ? ' is-checked' : ''))
    box.type = 'button'
    box.title = item.checked ? 'Mark active' : 'Mark done'
    box.addEventListener('click', () => {
      void (async () => {
        await window.api.wsInboxToggle({ line: item.line, checked: !item.checked })
        await renderInbox(host, deps, tab)
      })()
    })
    const text = el('span', 'wm-inbox-text')
    text.textContent = item.text
    row.append(box, text)
    list.appendChild(row)
  }
  host.appendChild(list)
  return String(activeCount)
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function renderTasks(host: HTMLElement, deps: ModeDeps, tab: 'open' | 'done' | 'all' = 'open'): Promise<string> {
  const tasks = (await window.api.wsTasks()) as TaskEntry[]
  clearHost(host)

  const bar = toolbar()
  const tabs = el('div', 'wm-tabs')
  for (const [id, label] of [
    ['open', 'Open'],
    ['done', 'Done'],
    ['all', 'All']
  ] as const) {
    const count = tasks.filter((t) => (id === 'all' ? true : id === 'done' ? t.checked : !t.checked)).length
    const btn = el('button', 'wm-tab' + (tab === id ? ' is-active' : ''))
    btn.type = 'button'
    btn.textContent = `${label} ${count}`
    btn.addEventListener('click', () => void renderTasks(host, deps, id))
    tabs.appendChild(btn)
  }
  const search = el('input', 'wm-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'Filter tasks…'
  const refresh = el('button', 'wm-btn')
  refresh.type = 'button'
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => void renderTasks(host, deps, tab))
  bar.append(tabs, search, refresh)
  host.appendChild(bar)

  const filtered = tasks.filter((t) => (tab === 'all' ? true : tab === 'done' ? t.checked : !t.checked))
  deps.summary?.(filtered.length)
  const groups = new Map<string, TaskEntry[]>()
  for (const task of filtered) {
    const list = groups.get(task.relPath) ?? []
    list.push(task)
    groups.set(task.relPath, list)
  }

  if (groups.size === 0) {
    host.append(emptyState(tab === 'done' ? 'Nothing finished yet' : 'No open tasks', 'Write `- [ ] something` in any note and it appears here.'))
    return '0'
  }

  const draw = (): void => {
    const q = search.value.trim().toLowerCase()
    for (const node of Array.from(host.querySelectorAll('.wm-task-group'))) node.remove()
    for (const node of Array.from(host.querySelectorAll('.wm-empty'))) node.remove()
    let shown = 0
    for (const [relPath, list] of groups) {
      const matching = list.filter((t) => !q || t.text.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      if (matching.length === 0) continue
      shown += matching.length
      const group = el('section', 'wm-task-group')
      const head = el('button', 'wm-task-head')
      head.type = 'button'
      const icon = el('span')
      applyIcon(icon, list[0].icon, 'doc', 14)
      const title = el('span'); title.textContent = list[0].title
      const count = el('span', 'wm-count'); count.textContent = String(matching.length)
      head.append(icon, title, count)
      head.addEventListener('click', () => deps.open(relPath, relPath.endsWith('.qz') ? 'quiz' : 'page'))
      const rows = el('div', 'wm-task-rows')
      for (const task of matching) {
        const row = el('div', 'wm-task-row' + (task.checked ? ' is-done' : ''))
        const box = el('button', 'wm-check' + (task.checked ? ' is-checked' : ''))
        box.type = 'button'
        box.title = task.checked ? 'Mark open' : 'Mark done'
        box.addEventListener('click', (ev) => {
          ev.stopPropagation()
          void (async () => {
            await window.api.wsToggleTask({ relPath, line: task.line, checked: !task.checked })
            deps.afterChange?.()
            await renderTasks(host, deps, tab)
          })()
        })
        const text = el('span', 'wm-task-text'); text.textContent = task.text
        row.append(box, text)
        rows.appendChild(row)
      }
      group.append(head, rows)
      host.appendChild(group)
    }
    if (shown === 0) {
      const empty = emptyState('No matching tasks', q ? `Nothing matches “${search.value.trim()}”.` : 'Nothing here yet.')
      host.appendChild(empty)
    }
  }
  search.addEventListener('input', draw)
  draw()
  return String(filtered.length)
}

// ---------------------------------------------------------------------------
// Files & media
// ---------------------------------------------------------------------------

async function renderMedia(host: HTMLElement, deps: ModeDeps, tab: 'media' | 'files' = 'media'): Promise<string> {
  const entries = (await window.api.wsMedia()) as MediaEntry[]
  const info = await window.api.wsGet()
  const root = info.workspace
  clearHost(host)

  const bar = toolbar()
  const tabs = el('div', 'wm-tabs')
  const mediaCount = entries.filter((e) => e.kind === 'image' || e.kind === 'pdf').length
  for (const [id, label, count] of [
    ['media', 'Media', mediaCount],
    ['files', 'Files', entries.length - mediaCount]
  ] as const) {
    const btn = el('button', 'wm-tab' + (tab === id ? ' is-active' : ''))
    btn.type = 'button'
    btn.textContent = `${label} ${count}`
    btn.addEventListener('click', () => void renderMedia(host, deps, id))
    tabs.appendChild(btn)
  }
  const search = el('input', 'wm-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'Filter files…'
  bar.append(tabs, search)
  host.appendChild(bar)

  const visible = entries.filter((e) =>
    tab === 'media' ? e.kind === 'image' || e.kind === 'pdf' : e.kind === 'file'
  )
  deps.summary?.(visible.length)
  if (visible.length === 0) {
    host.append(
      emptyState(
        tab === 'media' ? 'No media yet' : 'No other files',
        tab === 'media' ? 'Images and PDFs in this workspace will appear here.' : 'Text files, data files and other documents appear here.'
      )
    )
    return '0'
  }

  const grid = el('div', 'wm-media-grid')
  const draw = (): void => {
    const q = search.value.trim().toLowerCase()
    grid.replaceChildren()
    for (const entry of visible.filter((e) => !q || e.name.toLowerCase().includes(q) || e.relPath.toLowerCase().includes(q))) {
      const card = el('button', 'wm-media-card')
      card.type = 'button'
      card.title = entry.relPath
      const thumb = el('div', 'wm-media-thumb')
      if (entry.kind === 'image' && root) {
        const img = el('img') as HTMLImageElement
        img.loading = 'lazy'
        img.alt = entry.name
        img.src = localFileUrl(`${root}/${entry.relPath}`)
        thumb.appendChild(img)
      } else {
        const icon = el('span', 'wm-media-icon')
        icon.append(iconEl(entry.kind === 'pdf' ? 'doc' : 'code', 24, 1.5))
        thumb.appendChild(icon)
      }
      const name = el('span', 'wm-media-name'); name.textContent = entry.name
      const meta = el('span', 'wm-media-meta')
      meta.textContent = `${entry.kind === 'pdf' ? 'PDF' : entry.name.split('.').pop()?.toUpperCase() ?? 'FILE'} · ${formatSize(entry.size)} · ${formatDate(entry.mtime)}`
      card.append(thumb, name, meta)
      card.addEventListener('click', () => {
        const kind = entry.kind === 'image' ? 'image' : entry.kind === 'pdf' ? 'pdf' : 'file'
        deps.open(entry.relPath, kind)
      })
      grid.appendChild(card)
    }
    if (grid.childElementCount === 0) {
      grid.append(emptyState('Nothing matches', `No file matches “${search.value.trim()}”.`))
    }
  }
  search.addEventListener('input', draw)
  host.appendChild(grid)
  draw()
  return String(visible.length)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function renderWorkspaceMode(
  host: HTMLElement,
  mode: WorkspaceModeId,
  deps: ModeDeps
): Promise<string> {
  const titleEl = document.getElementById('mode-title')
  const subEl = document.getElementById('mode-sub')
  const actions = document.getElementById('mode-actions')
  const parts = modeParts(mode)
  if (titleEl) titleEl.textContent = parts.title
  if (subEl) subEl.textContent = parts.sub
  if (actions) {
    actions.replaceChildren()
    if (mode !== 'graph' && mode !== 'inbox') {
      const reveal = el('button', 'wm-btn')
      reveal.type = 'button'
      reveal.textContent = 'Open folder'
      reveal.addEventListener('click', () => void window.api.wsOpenInFinder())
      actions.appendChild(reveal)
    }
  }

  try {
    if (mode === 'graph') return await renderGraph(host, deps)
    if (mode === 'inbox') return await renderInbox(host, deps)
    if (mode === 'tasks') return await renderTasks(host, deps)
    if (mode === 'media') return await renderMedia(host, deps)
    return await renderView(host, mode, deps)
  } catch (err) {
    console.error('[meridiem] workspace mode failed', err)
    host.replaceChildren(emptyState('Could not read this view', 'The workspace may still be loading. Try again in a moment.'))
    return '0'
  }
}
