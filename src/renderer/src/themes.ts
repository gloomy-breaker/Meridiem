export interface ThemeDef {
  id: string
  label: string
  /** `system` follows macOS and resolves to light/dark at apply time. */
  kind: 'light' | 'dark' | 'system'
  vars: Record<string, string>
}

/** Shared warm shadows: never a cold blue-grey, always a breath of brown. */
const DARK_SHADOWS = {
  '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.18)',
  '--shadow-md': '0 4px 14px rgba(0, 0, 0, 0.34), 0 1px 4px rgba(0, 0, 0, 0.22)',
  '--shadow-lg': '0 20px 56px rgba(0, 0, 0, 0.52), 0 6px 18px rgba(0, 0, 0, 0.3)',
  '--shadow-popover': '0 14px 38px rgba(0, 0, 0, 0.46), 0 3px 10px rgba(0, 0, 0, 0.26)',
  '--shadow-focus': '0 0 0 2.5px rgba(217, 119, 66, 0.32)'
}

const LIGHT_SHADOWS = {
  '--shadow-sm': '0 1px 2px rgba(62, 48, 34, 0.05), 0 1px 3px rgba(62, 48, 34, 0.04)',
  '--shadow-md': '0 4px 14px rgba(62, 48, 34, 0.09), 0 1px 4px rgba(62, 48, 34, 0.05)',
  '--shadow-lg': '0 20px 56px rgba(62, 48, 34, 0.18), 0 6px 18px rgba(62, 48, 34, 0.08)',
  '--shadow-popover': '0 14px 38px rgba(62, 48, 34, 0.16), 0 3px 10px rgba(62, 48, 34, 0.07)',
  '--shadow-focus': '0 0 0 2.5px rgba(200, 100, 50, 0.22)'
}

interface Palette {
  bg: string
  panel: string
  text: string
  muted: string
  accent: string
  border: string
  /** Editor/body tint, usually a step off the panel. */
  code: string
  quote: string
  isDark: boolean
}

/**
 * Every named preset is a complete palette, not a partial one. The renderer
 * reads these tokens directly, and a missing editor token used to fall back to
 * the browser's default colour (usually black on a dark paper).
 */
function paletteVars(p: Palette): Record<string, string> {
  const { isDark } = p
  return {
    // Surfaces
    '--bg': p.bg,
    '--panel-bg': p.panel,
    '--sidebar-bg': p.bg,
    '--agent-bg': p.bg,
    '--surface-elevated': p.panel,
    '--paper': p.panel,
    '--card-bg': p.panel,
    '--canvas': p.panel,
    '--elevated': p.panel,
    '--app-bg': p.bg,
    '--control-bg': isDark ? mixHex(p.panel, p.text, 0.07) : mixHex(p.bg, p.panel, 0.62),
    '--control-hover': isDark ? mixHex(p.panel, p.text, 0.12) : mixHex(p.bg, p.panel, 0.82),
    '--control-text': isDark ? p.text : mixHex(p.text, p.panel, 0.12),
    '--field-bg': isDark ? mixHex(p.panel, p.text, 0.05) : mixHex(p.panel, p.bg, 0.5),
    '--field-line': isDark ? mixHex(p.border, p.text, 0.1) : mixHex(p.border, p.bg, 0.4),
    '--glass': rgba(p.panel, isDark ? 0.86 : 0.9),

    // Text
    '--text': p.text,
    '--text-2': isDark ? mixHex(p.text, p.muted, 0.35) : mixHex(p.text, p.bg, 0.1),
    '--muted': p.muted,
    '--muted-2': isDark ? mixHex(p.muted, p.text, 0.3) : mixHex(p.muted, p.text, 0.2),
    '--muted-3': isDark ? mixHex(p.muted, p.panel, 0.4) : mixHex(p.muted, p.panel, 0.45),

    // Accent & status
    '--accent': p.accent,
    '--accent-soft': rgba(p.accent, 0.13),
    '--accent-soft-2': rgba(p.accent, 0.22),
    '--accent-ink': isDark ? '#1b1310' : '#fffaf5',
    '--ok': isDark ? '#7fa06a' : '#5c8a4c',
    '--warn': isDark ? '#d8a14a' : '#b47d24',
    '--danger': isDark ? '#cf6f5c' : '#b85442',
    '--user-bubble': isDark ? mixHex(p.panel, p.text, 0.16) : mixHex(p.panel, p.text, 0.1),

    // Lines & fills
    '--border': p.border,
    '--border-strong': mixHex(p.border, p.text, isDark ? 0.18 : 0.12),
    '--hairline': p.border,
    '--code-bg': p.code,
    '--code-text': p.text,
    '--hover-bg': rgba(p.text, isDark ? 0.055 : 0.05),
    '--active-bg': rgba(p.text, isDark ? 0.085 : 0.085),
    '--selected-bg': rgba(p.accent, 0.18),

    // Editor
    '--selection': rgba(p.accent, isDark ? 0.26 : 0.2),
    '--cursor': p.text,
    '--md-heading': isDark ? mixHex(p.text, '#ffffff', 0.18) : mixHex(p.text, '#000000', 0.15),
    '--md-strong': isDark ? mixHex(p.text, '#ffffff', 0.3) : '#121110',
    '--md-em': p.text,
    '--md-link': p.accent,
    '--md-url': isDark ? mixHex(p.accent, p.text, 0.25) : mixHex(p.accent, '#000000', 0.18),
    '--md-quote': p.muted,
    '--md-list': p.text,
    '--md-meta': p.muted,
    '--md-keyword': p.accent,
    '--md-code': isDark ? mixHex(p.accent, p.text, 0.35) : mixHex(p.accent, '#000000', 0.28),
    '--quote-bg': p.quote,
    '--quote-border': p.border,
    '--divider-bg': p.border,
    ...(isDark ? DARK_SHADOWS : LIGHT_SHADOWS)
  }
}

/**
 * Octarine — the app's visual system.
 *
 * Follow the system, or pick one of five low-contrast presets. Structure comes
 * from neutral surfaces and one hairline; the single saturated colour is the
 * accent and it is reserved for things you can act on. Nothing is pure black or
 * pure white.
 */
export const THEMES: ThemeDef[] = [
  {
    id: 'system',
    label: 'Follow macOS System',
    kind: 'system',
    vars: {}
  },
  {
    id: 'octarineDark',
    label: 'Octarine Dark',
    kind: 'dark',
    vars: paletteVars({
      bg: '#141414',
      panel: '#191919',
      text: '#e6e5e3',
      muted: '#8a8986',
      accent: '#d97742',
      border: '#282828',
      code: '#201f1e',
      quote: '#1d1c1b',
      isDark: true
    })
  },
  {
    id: 'warmPaperLight',
    label: 'Warm Paper Light',
    kind: 'light',
    vars: paletteVars({
      bg: '#f3f1ec',
      panel: '#faf9f6',
      text: '#1f1f1e',
      muted: '#787671',
      accent: '#c86432',
      border: '#e4e1da',
      code: '#efede6',
      quote: '#f4f1ea',
      isDark: false
    })
  },
  {
    id: 'midnightSlate',
    label: 'Midnight Slate',
    kind: 'dark',
    vars: paletteVars({
      bg: '#12161c',
      panel: '#171c24',
      text: '#dfe4ea',
      muted: '#7d8794',
      accent: '#7f9cc4',
      border: '#242c37',
      code: '#1b222b',
      quote: '#1a212a',
      isDark: true
    })
  },
  {
    id: 'sageMist',
    label: 'Sage Mist',
    kind: 'light',
    vars: paletteVars({
      bg: '#eef1ea',
      panel: '#f7f8f3',
      text: '#232a22',
      muted: '#6f786c',
      accent: '#6f8f63',
      border: '#dde2d6',
      code: '#e9ede4',
      quote: '#f0f3ea',
      isDark: false
    })
  },
  {
    id: 'solarizedWarmLight',
    label: 'Solarized Warm Light',
    kind: 'light',
    vars: paletteVars({
      bg: '#f7f1e3',
      panel: '#fdf8ec',
      text: '#3b3226',
      muted: '#8a7a63',
      accent: '#b58900',
      border: '#e8ddc6',
      code: '#f2ead8',
      quote: '#f6efdf',
      isDark: false
    })
  }
]

export const DEFAULT_THEME = 'octarineDark'

export type ResolvedTheme = ThemeDef & { kind: 'light' | 'dark' }

/** Older ids stay readable so a saved theme never resets unexpectedly. */
const LEGACY_IDS: Record<string, string> = {
  octarineLight: 'warmPaperLight'
}

export function getTheme(id: string): ThemeDef {
  const resolved = LEGACY_IDS[id] ?? id
  return THEMES.find((t) => t.id === resolved) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}

export function nextTheme(currentId: string): ThemeDef {
  const idx = THEMES.findIndex((t) => t.id === getTheme(currentId).id)
  return THEMES[(idx + 1) % THEMES.length]
}

/** The concrete light/dark palette a theme id means right now. */
export function resolveTheme(id: string): ResolvedTheme {
  const theme = getTheme(id)
  if (theme.kind !== 'system') return theme as ResolvedTheme
  const dark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  return getTheme(dark ? 'octarineDark' : 'warmPaperLight') as ResolvedTheme
}

// ---- derived tokens -------------------------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * t)
  const to2 = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${to2(mix(r1, r2))}${to2(mix(g1, g2))}${to2(mix(b1, b2))}`
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function deriveTokens(v: Record<string, string>): Record<string, string> {
  const bg = v['--bg'] ?? '#141414'
  const panel = v['--panel-bg'] ?? '#191919'
  const text = v['--text'] ?? '#e6e5e3'
  const muted = v['--muted'] ?? '#8a8986'
  const accent = v['--accent'] ?? '#d97742'
  const border = v['--border'] ?? '#282828'
  const codeBg = v['--code-bg'] ?? panel
  const isDark = luminance(bg) < 0.5
  const backdrop = isDark ? mixHex(bg, '#000000', 0.4) : mixHex(bg, '#000000', 0.055)
  const clear = (color: string): string => {
    const [r1, g1, b1] = hexToRgb(color)
    const [r2, g2, b2] = hexToRgb(backdrop)
    const far = Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2))
    return far >= 15 ? color : mixHex(backdrop, text, 0.06)
  }
  return {
    '--text-2': text,
    '--muted-2': muted,
    '--muted-3': mixHex(muted, panel, 0.45),
    '--sidebar-bg': bg,
    '--agent-bg': bg,
    '--surface-elevated': panel,
    '--canvas': panel,
    '--paper': isDark ? clear(panel) : panel,
    '--card-bg': panel,
    '--elevated': mixHex(panel, text, isDark ? 0.09 : 0.06),
    '--app-bg': backdrop,
    '--hover-bg': rgba(text, isDark ? 0.055 : 0.045),
    '--active-bg': rgba(text, isDark ? 0.085 : 0.075),
    '--accent-soft': rgba(accent, 0.12),
    '--accent-soft-2': rgba(accent, 0.2),
    '--accent-ink': isDark ? '#1b1310' : '#fffaf5',
    '--user-bubble': isDark ? mixHex(panel, text, 0.16) : text,
    '--selected-bg': v['--selection'] ?? rgba(accent, 0.15),
    '--border-strong': mixHex(border, text, 0.22),
    '--hairline': border,
    '--code-bg-elevated': codeBg,
    '--glass': rgba(panel, isDark ? 0.82 : 0.84),
    '--control-bg': isDark ? mixHex(panel, text, 0.07) : mixHex(bg, panel, 0.62),
    '--control-hover': isDark ? mixHex(panel, text, 0.12) : mixHex(bg, panel, 0.82),
    '--control-text': isDark ? text : mixHex(text, panel, 0.12),
    '--field-bg': rgba(text, isDark ? 0.06 : 0.035),
    '--field-line': rgba(text, isDark ? 0.12 : 0.075)
  }
}

export function applyTheme(id: string): ResolvedTheme {
  const theme = resolveTheme(id)
  const root = document.documentElement
  root.style.colorScheme = theme.kind === 'dark' ? 'dark' : 'light'
  const all = { ...deriveTokens(theme.vars), ...theme.vars }
  for (const [key, value] of Object.entries(all)) {
    root.style.setProperty(key, value)
  }
  // Keep the user's choice (`system` included) as the identity, but publish the
  // resolved palette so every descendant can branch on the real appearance.
  root.dataset.theme = getTheme(id).id
  root.dataset.themeKind = theme.kind
  return theme
}
