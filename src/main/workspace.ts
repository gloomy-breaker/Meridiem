import { promises as fs } from 'node:fs'
import { dirname, join, basename, relative, extname } from 'node:path'
import { parsePageFile } from './frontmatter'
// (dirname/relative re-exported at bottom for callers; absPath/file helpers below)

export interface PageMeta {
  title: string
  icon: string
  body: string
  frontmatter: Record<string, string>
}

export interface WorkspaceChild {
  name: string
  path: string
  relPath: string // for pages: path to the .md; for folders: the dir
  dirRel?: string // directory containing this node
  kind: 'page' | 'folder' | 'pdf' | 'image' | 'file' | 'binary' | 'quiz'
  title?: string
  icon?: string
  ext?: string
  children?: WorkspaceChild[]
}

export interface WorkspacePage {
  relPath: string
  absolutePath: string
  title: string
  icon: string
  body: string
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.log', '.md', '.markdown', '.qz', '.json', '.jsonc', '.csv', '.tsv',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.py', '.pyw', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift',
  '.php', '.pl', '.lua', '.r', '.m', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.gql', '.html', '.htm', '.xml', '.svg', '.css', '.scss',
  '.sass', '.less', '.vue', '.svelte', '.dxf', '.tex', '.bib', '.rst', '.org',
  '.diff', '.patch', '.gitignore', '.editorconfig'
])

export const QUIZ_ICON = '📝'

function fileIcon(ext: string): string {
  if (ext === '.pdf') return '📕'
  if (ext === '.qz') return QUIZ_ICON
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return '🖼'
  if (['.py', '.js', '.ts', '.tsx', '.jsx', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.sh', '.lua', '.php', '.sql'].includes(ext)) return '⌨️'
  if (['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.csv', '.tsv'].includes(ext)) return '🧾'
  if (['.dxf', '.dwg', '.stl', '.obj'].includes(ext)) return '📐'
  if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) return '🗜'
  return '📄'
}

// NUL-byte sniff of the first 8 KB — good enough to separate text from binary.
async function looksBinary(abs: string): Promise<boolean> {
  const ext = extname(abs).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return false
  try {
    const fh = await fs.open(abs, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const { bytesRead } = await fh.read(buf, 0, 8192, 0)
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true
      return false
    } finally {
      await fh.close()
    }
  } catch {
    return true
  }
}

export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg', '.heic', '.tif', '.tiff'
])

export function isImagePath(absPath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(absPath).toLowerCase())
}

// Classify a file the same way the tree does: PDFs, images, text-like, binary.
export async function fileKind(absPath: string): Promise<'pdf' | 'image' | 'text' | 'binary'> {
  const ext = extname(absPath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return (await looksBinary(absPath)) ? 'binary' : 'text'
}

export async function readTextFile(absPath: string): Promise<string> {
  return fs.readFile(absPath, 'utf-8')
}

export async function writeTextFile(absPath: string, content: string): Promise<void> {
  await fs.writeFile(absPath, content, 'utf-8')
}

function escapeYaml(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Plain YAML scalar unless the value would be ambiguous.
function yamlValue(v: string): string {
  const needsQuote =
    v === '' ||
    /^[\s]|[\s]$/.test(v) ||
    /[:#{}\[\],&*!|>'"%@`]/.test(v) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||
    /^-?[0-9]/.test(v)
  return needsQuote ? `"${escapeYaml(v)}"` : v
}

// Parse a markdown file: YAML front matter (title/icon) + body. The parser
// itself lives in frontmatter.ts — the side-by-side copy that used to be here
// was LF-only, so a CRLF page lost its title and leaked `---` into the body.
export { parsePageFile }

export function serializePageFile(title: string, icon: string, body: string): string {
  let fm = `---\ntitle: ${yamlValue(title)}\n`
  if (icon) fm += `icon: ${yamlValue(icon)}\n`
  return fm + `---\n\n${body}`
}

/**
 * Markdown link/image destinations can't contain raw spaces, but filenames can
 * (`Screenshot 2026-09-18 at 10.16.41 PM.png`). Wrapping such a destination in
 * angle brackets is valid CommonMark and keeps the filename readable, so repair
 * those on read — otherwise the image degrades to literal `![alt](…)` text the
 * next time the page is opened.
 */
export function repairSpaceyDestinations(markdown: string): string {
  return markdown.replace(/\]\(([^)\n]*)\)/g, (whole, inner: string) => {
    const title = /^(.*?)((?:\s+"[^"]*")|(?:\s+'[^']*'))\s*$/.exec(inner)
    const dest = (title ? title[1] : inner).trim()
    if (!dest || !/\s/.test(dest) || /^<.*>$/.test(dest)) return whole
    return `](<${dest}>${title ? title[2] : ''})`
  })
}

export async function readPage(absPath: string, relPath?: string): Promise<WorkspacePage> {
  const content = await fs.readFile(absPath, 'utf-8')
  const fallback = basename(absPath).replace(/\.[^.]+$/, '')
  const parsed = parsePageFile(content, fallback)
  return {
    relPath: relPath ?? absPath,
    absolutePath: absPath,
    title: parsed.title,
    icon: parsed.icon,
    body: repairSpaceyDestinations(parsed.body)
  }
}

// ---- workspace tree ----

const INDEX = 'index.md'

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Every markdown page is a folder with an index.md (Notion-style). Loose .md
// files are still supported as leaf pages for legacy workspaces.
async function buildChildren(root: string, dirRel: string): Promise<WorkspaceChild[]> {
  const abs = dirRel ? join(root, dirRel) : root
  let entries
  try {
    entries = await fs.readdir(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const children: WorkspaceChild[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childRel = dirRel ? `${dirRel}/${e.name}` : e.name
    if (e.isDirectory()) {
      children.push(await buildDirNode(root, childRel))
    } else if (e.isFile() && e.name.toLowerCase() === INDEX) {
      continue // the directory's own page
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
      const parsed = parsePageFile(await fs.readFile(join(abs, e.name), 'utf-8'), e.name.replace(/\.[^.]+$/, ''))
      children.push({ name: e.name, path: join(abs, e.name), relPath: childRel, dirRel, kind: 'page', title: parsed.title, icon: parsed.icon })
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.pdf') {
      children.push({ name: e.name, path: join(abs, e.name), relPath: childRel, dirRel, kind: 'pdf', title: e.name.replace(/\.pdf$/i, ''), icon: '📕', ext: '.pdf' })
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.qz') {
      // A quiz is a leaf like a page — same front matter, so the same parser.
      // This branch must stay above the generic isFile() arm below, which would
      // otherwise file it as a plain 'file' and open it in the text viewer.
      const parsed = parsePageFile(await fs.readFile(join(abs, e.name), 'utf-8'), e.name.replace(/\.[^.]+$/, ''))
      children.push({ name: e.name, path: join(abs, e.name), relPath: childRel, dirRel, kind: 'quiz', title: parsed.title, icon: parsed.icon || QUIZ_ICON, ext: '.qz' })
    } else if (e.isFile()) {
      // Any other file: open text-like files in the built-in plaintext editor,
      // everything else with the system app.
      const ext = extname(e.name).toLowerCase()
      const isImage = IMAGE_EXTENSIONS.has(ext)
      const isBin = isImage ? false : await looksBinary(join(abs, e.name))
      children.push({
        name: e.name,
        path: join(abs, e.name),
        relPath: childRel,
        dirRel,
        kind: isImage ? 'image' : isBin ? 'binary' : 'file',
        title: e.name,
        icon: isImage ? '🖼' : isBin ? '📦' : fileIcon(ext),
        ext
      })
    }
  }
  const rank = (k: WorkspaceChild['kind']): number =>
    k === 'page' || k === 'folder' || k === 'quiz' ? 0 : k === 'file' ? 1 : k === 'pdf' ? 2 : 3
  children.sort((a, b) => {
    const ka = rank(a.kind)
    const kb = rank(b.kind)
    if (ka !== kb) return ka - kb
    return (a.title ?? a.name).localeCompare(b.title ?? b.name)
  })
  return children
}

async function buildDirNode(root: string, dirRel: string): Promise<WorkspaceChild> {
  const abs = join(root, dirRel)
  const indexAbs = join(abs, INDEX)
  if (await exists(indexAbs)) {
    const parsed = parsePageFile(await fs.readFile(indexAbs, 'utf-8'), dirRel.split('/').pop() ?? dirRel)
    return {
      name: dirRel.split('/').pop() ?? dirRel,
      path: indexAbs,
      relPath: `${dirRel}/${INDEX}`,
      dirRel,
      kind: 'page',
      title: parsed.title,
      icon: parsed.icon,
      children: await buildChildren(root, dirRel)
    }
  }
  return {
    name: dirRel.split('/').pop() ?? dirRel,
    path: abs,
    relPath: dirRel,
    dirRel,
    kind: 'folder',
    children: await buildChildren(root, dirRel)
  }
}

export async function listWorkspace(root: string): Promise<WorkspaceChild> {
  return buildDirNode(root, '')
}

// ---- dedicated workspaces ----
// A Meridiem workspace is a folder we created, marked with
// .yestion/workspace.json. Arbitrary folders can't be opened.

export const WORKSPACE_MARKER = '.yestion/workspace.json'

export interface WorkspaceInfo {
  name: string
  createdAt: string
}

export async function createWorkspace(parentDir: string, name: string): Promise<string> {
  const slug =
    name
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'Workspace'
  let dirName = slug
  let n = 2
  while (true) {
    try {
      await fs.access(join(parentDir, dirName))
      dirName = `${slug} ${n}`
      n++
    } catch {
      break
    }
  }
  const root = join(parentDir, dirName)
  await fs.mkdir(join(root, '.yestion'), { recursive: true })
  const info: WorkspaceInfo = { name: slug, createdAt: new Date().toISOString() }
  await fs.writeFile(join(root, WORKSPACE_MARKER), JSON.stringify(info, null, 2), 'utf-8')
  return root
}

export async function validateWorkspace(root: string): Promise<WorkspaceInfo | null> {
  try {
    const raw = await fs.readFile(join(root, WORKSPACE_MARKER), 'utf-8')
    return JSON.parse(raw) as WorkspaceInfo
  } catch {
    return null
  }
}

// Convert an existing folder into a dedicated workspace (explicit opt-in).
export async function convertToWorkspace(root: string, name?: string): Promise<string> {
  await fs.mkdir(join(root, '.yestion'), { recursive: true })
  const info: WorkspaceInfo = { name: name || root.split('/').pop() || 'Workspace', createdAt: new Date().toISOString() }
  await fs.writeFile(join(root, WORKSPACE_MARKER), JSON.stringify(info, null, 2), 'utf-8')
  return root
}

export async function createPage(root: string, parentRel: string | null, title: string): Promise<WorkspacePage> {
  const clean = title.trim() || 'Untitled'
  // Use the real title as the file/folder name (sanitized) so Finder shows
  // exactly what you named the page — English.md, not english.md.
  const slug =
    clean
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\.+$/g, '') || 'page'
  const dir = parentRel ? join(root, parentRel) : root
  let folderName = slug
  let n = 2
  while (await exists(join(dir, folderName))) {
    folderName = `${slug}-${n}`
    n++
  }
  const pageDir = join(dir, folderName)
  await fs.mkdir(pageDir, { recursive: true })
  const absPath = join(pageDir, INDEX)
  await fs.writeFile(absPath, serializePageFile(clean, '', ''), 'utf-8')
  const rel = parentRel ? `${parentRel}/${folderName}/${INDEX}` : `${folderName}/${INDEX}`
  return { relPath: rel, absolutePath: absPath, title: clean, icon: '', body: '' }
}

// Legacy loose page (x.md) -> folder page (x/index.md) so it can have children.
export async function convertLoosePage(root: string, relPath: string): Promise<string> {
  const abs = join(root, relPath)
  const base = relPath.replace(/\.md$/, '')
  const newDir = join(root, base)
  await fs.mkdir(newDir, { recursive: true })
  const newRel = `${base}/${INDEX}`
  await fs.rename(abs, join(root, newRel))
  return newRel
}

export interface SearchHit {
  relPath: string
  title: string
  icon: string
  /** 'page' for markdown pages, otherwise the file kind (pdf, image, file). */
  kind: string
  /** 1-based line number of the content match (0 for title/name matches). */
  line: number
  /** Surrounding text of a content match; empty for title/name matches. */
  snippet: string
}

/**
 * Search the workspace: page titles, file names and markdown content.
 * Content search reads the .md files (front matter stripped) and reports the
 * first matching line, so ⌘F can jump straight to what the user remembers.
 */
export async function searchWorkspace(root: string, query: string, limit = 60): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase()
  if (q.length < 1) return []
  const files: { rel: string; abs: string; name: string }[] = []
  const walk = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
    if (files.length > 4000 || depth > 12) return
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = join(dirAbs, e.name)
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(abs, rel, depth + 1)
      else files.push({ rel, abs, name: e.name })
    }
  }
  await walk(root, '', 0)

  const nameHits: SearchHit[] = []
  const contentHits: SearchHit[] = []

  for (const f of files) {
    const nameMatch = f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q)
    const isMarkdown = /\.(md|markdown)$/i.test(f.name)
    const isQuiz = /\.qz$/i.test(f.name)
    if (!isMarkdown && !isQuiz) {
      if (nameMatch) {
        const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
        // `kind` drives which viewer opens the hit, `icon` what the row shows.
        const kind = ext === 'pdf' ? 'pdf' : IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file'
        nameHits.push({
          relPath: f.rel,
          title: f.name,
          icon: kind === 'pdf' ? '📕' : kind === 'image' ? '🖼' : fileIcon(ext),
          kind,
          line: 0,
          snippet: f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : ''
        })
      }
      continue
    }
    let text = ''
    try {
      const stat = await fs.stat(f.abs)
      if (stat.size > 3_000_000) continue
      text = await fs.readFile(f.abs, 'utf-8')
    } catch {
      continue
    }
    const fallback = basename(f.name).replace(/\.[^.]+$/, '')
    const page = parsePageFile(text, fallback)
    if (isQuiz) {
      // Name and title only. The body holds the answers, so searching it would
      // put them in the ⌘⇧F snippet.
      if (nameMatch || page.title.toLowerCase().includes(q)) {
        nameHits.push({
          relPath: f.rel,
          title: page.title,
          icon: page.icon || QUIZ_ICON,
          kind: 'quiz',
          line: 0,
          snippet: ''
        })
      }
      continue
    }
    if (nameMatch) {
      nameHits.push({ relPath: f.rel, title: page.title, icon: page.icon, kind: 'page', line: 0, snippet: '' })
      continue
    }
    if (page.body.toLowerCase().includes(q)) {
      const lines = page.body.split('\n')
      const idx = lines.findIndex((l) => l.toLowerCase().includes(q))
      const raw = idx >= 0 ? lines[idx] : ''
      contentHits.push({
        relPath: f.rel,
        title: page.title,
        icon: page.icon,
        kind: 'page',
        line: idx + 1,
        snippet: raw.trim().slice(0, 220)
      })
    }
  }
  return [...nameHits, ...contentHits].slice(0, limit)
}

export async function savePage(absPath: string, title: string, icon: string, body: string): Promise<void> {
  await fs.writeFile(absPath, serializePageFile(title, icon, body), 'utf-8')
}

export async function deletePageOrFolder(absPath: string): Promise<void> {
  // A page IS its folder (index.md inside it). Deleting with the file path —
  // which is the page's relPath everywhere in the UI — removed only index.md
  // and left an empty folder behind.
  const target = /[/\\]index\.md$/i.test(absPath) ? dirname(absPath) : absPath
  await fs.rm(target, { recursive: true, force: true })
}


// Resolve [[Name]] against folder-pages, dir names and file basenames.
// When `fromDir` is given, a match inside that directory wins over global
// matches (Page → [[Notes]] picks that page's own Notes, not another one).
export async function resolvePageLink(
  root: string,
  linkText: string,
  fromDir?: string
): Promise<WorkspacePage | null> {
  const norm = linkText.trim().toLowerCase().replace(/\.md$/i, '')
  async function walkScope(dirRel: string): Promise<WorkspacePage | null> {
    const abs = dirRel ? join(root, dirRel) : root
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        const idx = join(abs, e.name, INDEX)
        if (await exists(idx)) {
          const parsed = parsePageFile(await fs.readFile(idx, 'utf-8'), e.name)
          if (parsed.title.toLowerCase() === norm || e.name.toLowerCase() === norm) {
            return { relPath: `${childRel}/${INDEX}`, absolutePath: idx, title: parsed.title, icon: parsed.icon, body: parsed.body }
          }
        }
        const found = await walkScope(childRel)
        if (found) return found
      } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
        const parsed = parsePageFile(await fs.readFile(join(abs, e.name), 'utf-8'), e.name.replace(/\.[^.]+$/, ''))
        if (parsed.title.toLowerCase() === norm || e.name.replace(/\.[^.]+$/, '').toLowerCase() === norm) {
          return { relPath: childRel, absolutePath: join(abs, e.name), title: parsed.title, icon: parsed.icon, body: parsed.body }
        }
      }
    }
    return null
  }
  // Pass 1: only within the current page's directory (immediate children).
  if (fromDir) {
    const scoped = await walkScope(fromDir)
    if (scoped) return scoped
  }
  // Pass 2: global workspace search.
  return walkScope('')
}

export async function listAllPages(root: string): Promise<{ relPath: string; title: string; icon: string }[]> {
  const out: { relPath: string; title: string; icon: string }[] = []
  async function walk(dirRel: string): Promise<void> {
    const abs = dirRel ? join(root, dirRel) : root
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        const idx = join(abs, e.name, INDEX)
        if (await exists(idx)) {
          const parsed = parsePageFile(await fs.readFile(idx, 'utf-8'), e.name)
          out.push({ relPath: `${childRel}/${INDEX}`, title: parsed.title, icon: parsed.icon })
        }
        await walk(childRel)
      } else if (e.isFile() && ['.md', '.qz'].includes(extname(e.name).toLowerCase())) {
        const parsed = parsePageFile(await fs.readFile(join(abs, e.name), 'utf-8'), e.name.replace(/\.[^.]+$/, ''))
        out.push({ relPath: childRel, title: parsed.title, icon: parsed.icon || (extname(e.name).toLowerCase() === '.qz' ? QUIZ_ICON : '') })
      }
    }
  }
  await walk('')
  return out
}

export async function fileForTitle(root: string, title: string): Promise<string | null> {
  const page = await resolvePageLink(root, title)
  return page?.absolutePath ?? null
}

export { dirname, relative }

// ---------------------------------------------------------------------------
// Workspace index, tasks, graph, media and Inbox
// ---------------------------------------------------------------------------
// These are read-mostly projections used by the workspace modes in the
// renderer. They walk the folder directly rather than going through the page
// tree: a view should stay correct when a file is added outside the app, and
// the tree is organised by links rather than by disk layout.

export interface WorkspaceIndexEntry {
  relPath: string
  title: string
  icon: string
  kind: 'page' | 'quiz'
  mtime: number
}

const WALK_SKIP = new Set(['.git', '.yestion', 'node_modules', '.DS_Store'])

async function walkWorkspace(
  root: string,
  visit: (abs: string, rel: string, stat: import('node:fs').Stats) => Promise<void> | void,
  rel = ''
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || WALK_SKIP.has(entry.name)) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const abs = join(root, childRel)
    if (entry.isDirectory()) {
      await walkWorkspace(root, visit, childRel)
      continue
    }
    try {
      await visit(abs, childRel, await fs.stat(abs))
    } catch {
      /* a file that vanished mid-walk is not an error */
    }
  }
}

/** Every markdown page and `.qz` paper, with its disk modification time. */
export async function workspaceIndex(root: string): Promise<WorkspaceIndexEntry[]> {
  const out: WorkspaceIndexEntry[] = []
  await walkWorkspace(root, async (abs, rel, stat) => {
    const ext = extname(rel).toLowerCase()
    if (ext !== '.md' && ext !== '.qz') return
    const isIndex = basename(rel).toLowerCase() === 'index.md'
    const fallback = isIndex
      ? rel.split('/').filter(Boolean).slice(-2, -1)[0] || 'Untitled'
      : basename(rel).replace(/\.[^.]+$/, '')
    const parsed = parsePageFile(await fs.readFile(abs, 'utf-8'), fallback)
    out.push({
      relPath: rel.replace(/\\/g, '/'),
      title: parsed.title,
      icon: parsed.icon || (ext === '.qz' ? QUIZ_ICON : ''),
      kind: ext === '.qz' ? 'quiz' : 'page',
      mtime: stat.mtimeMs
    })
  })
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

export interface WorkspaceTask {
  relPath: string
  title: string
  icon: string
  /** 1-based line number in the file as it exists on disk. */
  line: number
  text: string
  checked: boolean
}

const TASK_LINE = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/
const TASK_SKIP_DIR = /(^|\/)(Templates|Bin)\//i

/** Every `- [ ]` / `- [x]` in the workspace, with its exact source line. */
export async function workspaceTasks(root: string): Promise<WorkspaceTask[]> {
  const index = await workspaceIndex(root)
  const out: WorkspaceTask[] = []
  for (const entry of index) {
    if (entry.kind !== 'page') continue
    if (TASK_SKIP_DIR.test(entry.relPath)) continue
    let raw = ''
    try {
      raw = await fs.readFile(join(root, entry.relPath), 'utf-8')
    } catch {
      continue
    }
    const lines = raw.split(/\r?\n/)
    lines.forEach((line, i) => {
      const m = TASK_LINE.exec(line)
      if (!m) return
      out.push({
        relPath: entry.relPath,
        title: entry.title,
        icon: entry.icon,
        line: i + 1,
        text: m[3].trim(),
        checked: m[2].toLowerCase() === 'x'
      })
    })
  }
  return out
}

/** Flip one task's checkbox without rewriting a single other byte. */
export async function toggleTask(
  root: string,
  relPath: string,
  line: number,
  checked: boolean
): Promise<boolean> {
  const abs = join(root, relPath)
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf-8')
  } catch {
    return false
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const i = line - 1
  if (i < 0 || i >= lines.length || !TASK_LINE.test(lines[i])) return false
  lines[i] = lines[i].replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]')
  await fs.writeFile(abs, lines.join(eol), 'utf-8')
  return true
}

export interface WorkspaceGraphNode {
  id: string
  title: string
  icon: string
  kind: 'page' | 'quiz'
}

export interface WorkspaceGraphEdge {
  source: string
  target: string
}

/** Pages as nodes, `[[wikilinks]]` as edges. Unresolved links are dropped. */
export async function workspaceGraph(root: string): Promise<{
  nodes: WorkspaceGraphNode[]
  edges: WorkspaceGraphEdge[]
}> {
  const index = await workspaceIndex(root)
  const visible = index.filter((e) => !TASK_SKIP_DIR.test(e.relPath))
  const byTitle = new Map<string, string>()
  const byBase = new Map<string, string>()
  for (const entry of visible) {
    byTitle.set(entry.title.trim().toLowerCase(), entry.relPath)
    const base = basename(entry.relPath).replace(/\.(md|qz)$/i, '')
    byBase.set(base.toLowerCase(), entry.relPath)
    const folder = entry.relPath.replace(/\/?index\.md$/i, '').replace(/\.(md|qz)$/i, '')
    byBase.set(folder.split('/').pop()!.toLowerCase(), entry.relPath)
  }
  const resolve = (raw: string): string | null => {
    const target = raw.trim().toLowerCase()
    if (!target) return null
    return byTitle.get(target) ?? byBase.get(target) ?? null
  }

  const nodes: WorkspaceGraphNode[] = visible.map((e) => ({
    id: e.relPath,
    title: e.title,
    icon: e.icon,
    kind: e.kind
  }))
  const edges: WorkspaceGraphEdge[] = []
  const seen = new Set<string>()
  for (const entry of visible) {
    let raw = ''
    try {
      raw = await fs.readFile(join(root, entry.relPath), 'utf-8')
    } catch {
      continue
    }
    const body = parsePageFile(raw, entry.title).body
    for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = resolve(match[1])
      if (!target || target === entry.relPath) continue
      const key = `${entry.relPath}\u0000${target}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: entry.relPath, target })
    }
  }
  return { nodes, edges }
}

export interface WorkspaceMediaEntry {
  relPath: string
  name: string
  kind: 'image' | 'pdf' | 'file'
  mtime: number
  size: number
}

/** Images, PDFs and other files, for the Files & Media mode. */
export async function workspaceMedia(root: string): Promise<WorkspaceMediaEntry[]> {
  const out: WorkspaceMediaEntry[] = []
  await walkWorkspace(root, (_abs, rel, stat) => {
    if (/^Bin\//i.test(rel)) return
    const ext = extname(rel).toLowerCase()
    if (ext === '.md' || ext === '.qz' || ext === '.markdown') return
    const kind = ext === '.pdf' ? 'pdf' : IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file'
    out.push({ relPath: rel, name: basename(rel), kind, mtime: stat.mtimeMs, size: stat.size })
  })
  return out.sort((a, b) => b.mtime - a.mtime)
}

export interface InboxItem {
  /** 1-based line in Inbox.md. */
  line: number
  text: string
  checked: boolean
}

const INBOX_FILE = 'Inbox.md'
const INBOX_SEED = '# Inbox\n\n'

async function readInboxRaw(root: string): Promise<string> {
  const abs = join(root, INBOX_FILE)
  try {
    return await fs.readFile(abs, 'utf-8')
  } catch {
    await fs.writeFile(abs, INBOX_SEED, 'utf-8')
    return INBOX_SEED
  }
}

function parseInbox(raw: string): InboxItem[] {
  const out: InboxItem[] = []
  raw.split(/\r?\n/).forEach((line, i) => {
    const m = TASK_LINE.exec(line)
    if (!m) return
    out.push({ line: i + 1, text: m[3].trim(), checked: m[2].toLowerCase() === 'x' })
  })
  return out
}

export async function readInbox(root: string): Promise<InboxItem[]> {
  return parseInbox(await readInboxRaw(root))
}

export async function addInboxItem(root: string, text: string): Promise<InboxItem[]> {
  const clean = text.trim()
  if (!clean) return readInbox(root)
  const raw = await readInboxRaw(root)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const separator = raw.endsWith(eol) ? '' : eol
  await fs.writeFile(join(root, INBOX_FILE), `${raw}${separator}- [ ] ${clean}${eol}`, 'utf-8')
  return readInbox(root)
}

export async function toggleInboxItem(
  root: string,
  line: number,
  checked: boolean
): Promise<InboxItem[]> {
  const abs = join(root, INBOX_FILE)
  const raw = await readInboxRaw(root)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const i = line - 1
  if (i >= 0 && i < lines.length && TASK_LINE.test(lines[i])) {
    lines[i] = lines[i].replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]')
    await fs.writeFile(abs, lines.join(eol), 'utf-8')
  }
  return readInbox(root)
}

export { INBOX_FILE }
