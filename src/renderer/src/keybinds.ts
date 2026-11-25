/**
 * The one keybind registry.
 *
 * Every navigation, tab, sidebar, focus and daily-note shortcut is described
 * here, matched in one capture-phase listener, and edited from Settings. A
 * shortcut is stored as a canonical string (`Meta+Shift+T`, `Ctrl+Tab`) so the
 * same value can be recorded, rendered in a pill, compared for conflicts, and
 * persisted without three separate representations drifting apart.
 */

export interface KeybindDef {
  id: string
  label: string
  group: 'Navigation' | 'Tabs' | 'Sidebar' | 'Focus' | 'Daily notes' | 'Page' | 'App'
  combo: string
  description?: string
}

export type KeybindHandler = () => void
export type KeybindHandlers = Record<string, KeybindHandler>

const STORAGE_KEY = 'meridiem:keybinds:v1'

/** While the Settings recorder is listening, the registry must not fire. */
let recording = false
export function setKeybindRecording(value: boolean): void {
  recording = value
}

export const DEFAULT_KEYBINDS: KeybindDef[] = [
  { id: 'search', label: 'Search workspace', group: 'Navigation', combo: 'Meta+K' },
  { id: 'find', label: 'Find in page', group: 'Navigation', combo: 'Meta+F' },
  { id: 'find-workspace', label: 'Search titles and content', group: 'Navigation', combo: 'Meta+Shift+F' },
  { id: 'nav-back', label: 'Go back', group: 'Navigation', combo: 'Meta+[' },
  { id: 'nav-forward', label: 'Go forward', group: 'Navigation', combo: 'Meta+]' },
  { id: 'new-tab', label: 'New tab', group: 'Tabs', combo: 'Meta+T' },
  { id: 'close-tab', label: 'Close tab', group: 'Tabs', combo: 'Meta+W' },
  { id: 'reopen-tab', label: 'Reopen closed tab', group: 'Tabs', combo: 'Meta+Shift+T' },
  { id: 'next-tab', label: 'Next tab', group: 'Tabs', combo: 'Ctrl+Tab' },
  { id: 'prev-tab', label: 'Previous tab', group: 'Tabs', combo: 'Ctrl+Shift+Tab' },
  { id: 'next-tab-bracket', label: 'Next tab (bracket)', group: 'Tabs', combo: 'Meta+Shift+]' },
  { id: 'prev-tab-bracket', label: 'Previous tab (bracket)', group: 'Tabs', combo: 'Meta+Shift+[' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', group: 'Sidebar', combo: 'Meta+\\' },
  { id: 'focus-mode', label: 'Focus mode', group: 'Focus', combo: 'Meta+Alt+F' },
  { id: 'daily-today', label: 'Today’s daily note', group: 'Daily notes', combo: 'Meta+D' },
  { id: 'daily-yesterday', label: 'Yesterday’s daily note', group: 'Daily notes', combo: 'Meta+Alt+[' },
  { id: 'daily-tomorrow', label: 'Tomorrow’s daily note', group: 'Daily notes', combo: 'Meta+Alt+]' },
  { id: 'weekly', label: 'This week’s note', group: 'Daily notes', combo: 'Meta+Shift+D' },
  { id: 'new-page', label: 'New page', group: 'Page', combo: 'Meta+N' },
  { id: 'save', label: 'Save now', group: 'Page', combo: 'Meta+S' },
  { id: 'toggle-source', label: 'Toggle source view', group: 'Page', combo: 'Meta+Shift+E' },
  { id: 'export-pdf', label: 'Export as PDF', group: 'Page', combo: 'Meta+E' },
  { id: 'toggle-agent', label: 'Toggle AI sidebar', group: 'App', combo: 'Meta+Shift+A' },
  { id: 'settings', label: 'Open settings', group: 'App', combo: 'Meta+,' },
  { id: 'cycle-theme', label: 'Cycle theme', group: 'App', combo: 'Meta+Shift+L' }
]

export interface ParsedCombo {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  del: 'Delete',
  backspace: 'Backspace',
  return: 'Enter',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  semicolon: ';',
  quote: "'",
  minus: '-',
  equal: '=',
  plus: '+'
}

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  if (raw.length === 1) return raw.toUpperCase()
  return raw
}

/** Canonical string for a normalised combo. */
export function formatCombo(parsed: ParsedCombo): string {
  const parts: string[] = []
  if (parsed.meta) parts.push('Meta')
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split('+').filter(Boolean)
  const parsed: ParsedCombo = { meta: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    const token = part.trim()
    const lower = token.toLowerCase()
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') parsed.meta = true
    else if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true
    else if (lower === 'alt' || lower === 'option') parsed.alt = true
    else if (lower === 'shift') parsed.shift = true
    else parsed.key = normalizeKey(token)
  }
  return parsed
}

/** A KeyboardEvent as the registry sees it. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) return null
  // macOS reports letters by the produced character when modifiers are held;
  // `code` is stable across layouts but unreadable. `key` is what a recorder
  // shows and what a user expects to set, so normalise it instead. Punctuation
  // is read from `code`, because ⇧ turns `[` into `{` and the shortcut should
  // still read as ⌘⇧[.
  const punctuation: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '='
  }
  return formatCombo({
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: punctuation[e.code] ?? normalizeKey(e.key)
  })
}

/** Pretty label: ⌘⇧T on macOS, Ctrl+Shift+T elsewhere. */
export function displayCombo(combo: string): string {
  const p = parseCombo(combo)
  const mac = navigator.platform.toLowerCase().includes('mac')
  if (mac) {
    const key = p.key
      .replace('Escape', 'Esc')
      .replace('Enter', '⏎')
      .replace('Backspace', '⌫')
      .replace('Delete', '⌦')
      .replace('ArrowLeft', '←')
      .replace('ArrowRight', '→')
      .replace('ArrowUp', '↑')
      .replace('ArrowDown', '↓')
      .replace('Space', 'Space')
      .replace('Tab', '⇥')
    return (
      (p.ctrl ? '⌃' : '') +
      (p.alt ? '⌥' : '') +
      (p.shift ? '⇧' : '') +
      (p.meta ? '⌘' : '') +
      key
    )
  }
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Meta', p.key]
    .filter(Boolean)
    .join('+')
}

function sameCombo(a: string, b: string): boolean {
  const pa = parseCombo(a)
  const pb = parseCombo(b)
  return (
    pa.meta === pb.meta &&
    pa.ctrl === pb.ctrl &&
    pa.alt === pb.alt &&
    pa.shift === pb.shift &&
    pa.key.toLowerCase() === pb.key.toLowerCase()
  )
}

export class KeybindRegistry {
  private binds: KeybindDef[] = DEFAULT_KEYBINDS.map((b) => ({ ...b }))
  private handlers: KeybindHandlers = {}
  private listening = false

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Record<string, string>
      for (const bind of this.binds) {
        const combo = saved[bind.id]
        if (typeof combo === 'string' && combo.trim()) bind.combo = combo
      }
    } catch {
      /* unreadable storage: defaults are always valid */
    }
  }

  private persist(): void {
    try {
      const map: Record<string, string> = {}
      for (const bind of this.binds) map[bind.id] = bind.combo
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    } catch {
      /* private mode / quota: shortcuts still work for this run */
    }
  }

  list(): KeybindDef[] {
    return this.binds.map((b) => ({ ...b }))
  }

  get(id: string): string {
    return this.binds.find((b) => b.id === id)?.combo ?? ''
  }

  set(id: string, combo: string): { ok: boolean; conflict?: KeybindDef } {
    const bind = this.binds.find((b) => b.id === id)
    if (!bind) return { ok: false }
    const conflict = this.binds.find((b) => b.id !== id && sameCombo(b.combo, combo))
    if (conflict) return { ok: false, conflict: { ...conflict } }
    bind.combo = combo
    this.persist()
    return { ok: true }
  }

  reset(id?: string): void {
    if (id) {
      const bind = this.binds.find((b) => b.id === id)
      const def = DEFAULT_KEYBINDS.find((b) => b.id === id)
      if (bind && def) bind.combo = def.combo
    } else {
      this.binds = DEFAULT_KEYBINDS.map((b) => ({ ...b }))
    }
    this.persist()
  }

  findConflict(combo: string, exceptId?: string): KeybindDef | null {
    return this.binds.find((b) => b.id !== exceptId && sameCombo(b.combo, combo)) ?? null
  }

  /** One capture-phase listener decides whether a keystroke belongs to us. */
  attach(handlers: KeybindHandlers): () => void {
    this.handlers = handlers
    if (this.listening) return () => this.detach()
    this.listening = true
    window.addEventListener('keydown', this.onKeyDown, true)
    return () => this.detach()
  }

  private detach(): void {
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.listening = false
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (recording) return
    if (e.defaultPrevented) return
    const combo = comboFromEvent(e)
    if (!combo) return
    const bind = this.binds.find((b) => sameCombo(b.combo, combo))
    if (!bind) return
    // Tab cycling uses Ctrl on macOS where the system may also intercept it.
    const handler = this.handlers[bind.id]
    if (!handler) return
    e.preventDefault()
    e.stopPropagation()
    handler()
  }
}

/** The app has exactly one registry; importing it anywhere reads the same map. */
export const keybinds = new KeybindRegistry()
