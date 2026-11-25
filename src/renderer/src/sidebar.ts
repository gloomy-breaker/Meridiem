import { applyIcon, iconEl, type IconName } from './icons'

// Which branches the user expanded. Everything starts COLLAPSED (folders,
// subfolders, pages with children — every level), and the set survives tree
// re-renders so the user's choices stick while the app runs.
const userExpanded = new Set<string>()

export interface SidebarNode {
  name: string
  relPath: string
  dirRel?: string
  kind: 'page' | 'folder' | 'pdf' | 'image' | 'file' | 'binary' | 'quiz'
  title?: string
  icon?: string
  children?: SidebarNode[]
}

export interface SidebarOpts {
  currentRel: string | null
  onOpen: (rel: string, kind: string, newTab?: boolean) => void
  /** Notes mode hides the folders that have their own surface: Daily and Weekly
   *  notes live on the calendar, Templates has its own mode, and Inbox is a
   *  workspace view. */
  notesOnly?: boolean
}

const ATTACHMENT_FOLDERS = /^(attachments?|assets?|media|files|images)$/i
const HIDDEN_ROOT = /^(Daily|Weekly|Templates)$/i

/** Should this node appear in the Notes list? */
function visibleInNotes(node: SidebarNode): boolean {
  const rel = node.relPath.replace(/\\/g, '/')
  if (/(^|\/)(Daily|Weekly|Templates)\//i.test(rel)) return false
  if (/(^|\/)Inbox\.md$/i.test(rel)) return false
  const parts = rel.split('/')
  if (parts.some((p) => p.startsWith('.') || ATTACHMENT_FOLDERS.test(p))) return false
  // The root-level folders with a dedicated mode are hidden in Notes only.
  if (parts.length === 1 && HIDDEN_ROOT.test(parts[0])) return false
  return true
}

function iconForNode(node: SidebarNode): IconName {
  if (node.kind === 'quiz') return 'quiz'
  if (node.kind === 'folder' || (node.children?.length ?? 0) > 0) return 'folder'
  if (/^Daily\//i.test(node.relPath) || /^Weekly\//i.test(node.relPath)) return 'calendar'
  if (node.kind === 'pdf' || node.kind === 'file' || node.kind === 'binary') return 'doc'
  if (node.kind === 'image') return 'image'
  return 'doc'
}

export function setupSidebar(root: SidebarNode, opts: SidebarOpts): void {
  // The current page's ancestors stay expanded so the user always sees where
  // they are; everything else follows the collapsed-by-default rule.
  const expandAncestorsOf = (node: SidebarNode | null): void => {
    if (!node || !opts.currentRel) return
    for (const child of node.children ?? []) {
      if (opts.currentRel.startsWith(child.relPath + '/')) {
        userExpanded.add(child.relPath)
        expandAncestorsOf(child)
      }
    }
  }
  expandAncestorsOf(root)
  const nav = document.getElementById('page-tree') as HTMLElement
  const search = document.getElementById('page-search') as HTMLInputElement | null
  const query = search?.value.trim().toLowerCase() ?? ''
  nav.innerHTML = ''
  const notesOnly = opts.notesOnly !== false
  const visible = (node: SidebarNode): boolean => !notesOnly || visibleInNotes(node)

  if (query) {
    // Flat filtered list.
    const flat: SidebarNode[] = []
    const walk = (nodes: SidebarNode[]): void => {
      for (const n of nodes) {
        if (!visible(n)) continue
        if (n.kind === 'page' || n.kind === 'pdf' || n.kind === 'image' || n.kind === 'quiz') flat.push(n)
        else if (n.children) walk(n.children)
      }
    }
    walk(root.children ?? [])
    const matches = flat.filter(
      (p) =>
        (p.title ?? p.name).toLowerCase().includes(query) ||
        p.relPath.toLowerCase().includes(query)
    )
    for (const page of matches) {
      nav.appendChild(pageRow(page, opts))
    }
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tree-empty'
      empty.textContent = 'No pages match'
      nav.appendChild(empty)
    }
    return
  }

  // Root page row first, then its children.
  if (root.kind === 'page' && visible(root)) {
    nav.appendChild(pageRow(root, opts, 0))
    for (const child of root.children ?? []) {
      if (visible(child)) nav.appendChild(nodeRow(child, opts, 1))
    }
  } else {
    for (const child of root.children ?? []) {
      if (visible(child)) nav.appendChild(nodeRow(child, opts, 0))
    }
  }
  if (nav.childElementCount === 0) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty'
    empty.textContent = 'No notes yet'
    nav.appendChild(empty)
  }
}

function nodeRow(node: SidebarNode, opts: SidebarOpts, depth: number): HTMLElement {
  // A leaf that falls through to the folder branch renders as an empty
  // collapsible folder with no way to open it, so this list has to name every
  // leaf kind the main process can emit.
  if (node.kind === 'page' || node.kind === 'pdf' || node.kind === 'image' || node.kind === 'file' || node.kind === 'binary' || node.kind === 'quiz') {
    return pageRow(node, opts, depth)
  }
  const details = document.createElement('details')
  details.className = 'tree-folder'
  details.open = userExpanded.has(node.relPath)
  details.addEventListener('toggle', () => {
    if (details.open) userExpanded.add(node.relPath)
    else userExpanded.delete(node.relPath)
  })
  const summary = document.createElement('summary')
  summary.style.paddingLeft = `${depth * 16}px`
  const folderIcon = document.createElement('span')
  folderIcon.className = 'tree-icon'
  folderIcon.append(iconEl('folder', 13))
  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = node.name
  summary.append(folderIcon, label)
  const del = document.createElement('button')
  del.className = 'tree-delete'
  del.title = 'Delete folder and everything inside'
  del.replaceChildren(iconEl('trash', 13))
  del.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void (async () => {
      if (!window.confirm(`Delete folder "${node.name}" and everything inside it? It will move to the macOS Trash.`)) return
      await window.api.wsDelete(node.relPath)
      window.dispatchEvent(new CustomEvent('yestion:tree-changed'))
    })()
  })
  summary.appendChild(del)
  details.appendChild(summary)
  const list = document.createElement('div')
  for (const child of node.children ?? []) {
    list.appendChild(nodeRow(child, opts, depth + 1))
  }
  details.appendChild(list)
  return details
}

function pageRow(
  page: SidebarNode,
  opts: SidebarOpts,
  depth = 0
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tree-item' + (opts.currentRel === page.relPath ? ' active' : '')
  const icon = document.createElement('span')
  icon.className = 'tree-icon'
  applyIcon(icon, null, iconForNode(page), 14)
  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = page.title ?? page.name
  row.append(icon, label)
  if (
    page.kind === 'page' ||
    page.kind === 'pdf' ||
    page.kind === 'image' ||
    page.kind === 'file' ||
    page.kind === 'binary' ||
    page.kind === 'quiz'
  ) {
    const del = document.createElement('button')
    del.className = 'tree-delete'
    del.title = 'Delete page'
    del.replaceChildren(iconEl('trash', 13))
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      void (async () => {
        if (!window.confirm(`Move "${page.title ?? page.name}" to the macOS Trash?`)) return
        await window.api.wsDelete(page.relPath)
        window.dispatchEvent(new CustomEvent('yestion:tree-changed'))
      })()
    })
    row.appendChild(del)
  }
  const hasKids = page.kind === 'page' && (page.children?.length ?? 0) > 0
  // Arrow slot (24px) is reserved for EVERY row. The depth indent goes
  // OUTSIDE the arrow: branch arrows move with their layer, and leaf rows
  // get an empty arrow slot so icons/labels align with branch rows.
  row.style.paddingLeft = `${6 + depth * 16 + (hasKids ? 0 : 24)}px`
  // Used by the right-click menu in main.ts (open in new tab, reveal, …).
  row.dataset.rel = page.relPath
  row.dataset.kind = page.kind
  row.addEventListener('click', (e) => {
    // ⌘/Ctrl-click opens the page in a new tab, like Notion.
    opts.onOpen(page.relPath, page.kind, e.metaKey || e.ctrlKey)
  })
  const ext = document.createElement('span')
  ext.className = 'tree-ext'
  const m = /\.([a-z0-9]+)$/i.exec(page.relPath)
  ext.textContent = m ? '.' + m[1].toLowerCase() : ''
  if (page.kind === 'file' || page.kind === 'binary' || page.kind === 'image' || page.kind === 'quiz') ext.classList.add('tree-ext-always')
  row.appendChild(ext)
  if (page.kind === 'page' && (page.children?.length ?? 0) > 0) {
    // Page with children → collapsible branch (chevron toggles, row still opens).
    const branch = document.createElement('div')
    branch.className = 'tree-branch'
    const line = document.createElement('div')
    line.className = 'tree-branch-line'
    line.style.paddingLeft = `${depth * 16}px`
    const toggle = document.createElement('button')
    toggle.className = 'tree-toggle'
    toggle.title = 'Collapse'
    const expanded = userExpanded.has(page.relPath)
    if (!expanded) toggle.title = 'Expand'
    // The caret itself is drawn by CSS from `data-open` (one shared shape for
    // the whole app — no per-location glyphs to fall out of sync).
    toggle.dataset.open = String(expanded)
    toggle.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const nowExpanded = userExpanded.has(page.relPath)
      if (nowExpanded) userExpanded.delete(page.relPath)
      else userExpanded.add(page.relPath)
      childrenBox.classList.toggle('collapsed', nowExpanded)
      toggle.dataset.open = String(!nowExpanded)
      toggle.title = nowExpanded ? 'Expand' : 'Collapse'
    })
    row.style.paddingLeft = '6px'
    line.append(toggle, row)
    // Grid-wrapped so expand/collapse can animate (0fr → 1fr); `hidden` snaps
    // because display isn't animatable.
    const childrenBox = document.createElement('div')
    childrenBox.className = 'tree-children' + (expanded ? '' : ' collapsed')
    const childrenInner = document.createElement('div')
    childrenInner.className = 'tree-children-inner'
    for (const child of page.children ?? []) {
      childrenInner.appendChild(nodeRow(child, opts, depth + 1))
    }
    childrenBox.appendChild(childrenInner)
    branch.append(line, childrenBox)
    return branch
  }
  return row
}

// The tree is re-rendered by the single `yestion:tree-changed` listener in
// main.ts (which routes opens through the split-pane logic). Listening here too
// meant every structural change rebuilt the tree twice.
