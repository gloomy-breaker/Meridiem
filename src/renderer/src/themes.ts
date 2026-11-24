export interface ThemeDef {
  id: string
  label: string
  kind: 'light' | 'dark'
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

/**
 * Octarine — the app's visual system.
 *
 * Two themes only, both warm and low-contrast: a dark room lit by one amber
 * lamp, and the same room in daylight on paper. The palette is deliberately
 * narrow. Structure comes from three neutral surfaces (sidebar, canvas,
 * elevated) and one hairline; the single saturated colour is terracotta and it
 * is reserved for things you can act on. Nothing here is pure black or pure
 * white.
 */
export const THEMES: ThemeDef[] = [
  {
    id: 'octarineDark',
    label: 'Octarine Dark',
    kind: 'dark',
    vars: {
      // Surfaces
      '--bg': '#141414',
      '--panel-bg': '#191919',
      '--sidebar-bg': '#141414',
      '--agent-bg': '#141414',
      '--surface-elevated': '#242424',
      '--paper': '#191919',
      '--card-bg': '#191919',
      '--canvas': '#191919',
      '--elevated': '#242424',
      '--app-bg': '#141414',
      '--control-bg': '#242424',
      '--control-hover': '#2b2a27',
      '--control-text': '#e6e5e3',
      '--field-bg': '#222120',
      '--field-line': '#2c2a27',
      '--glass': 'rgba(30, 29, 27, 0.86)',

      // Text
      '--text': '#e6e5e3',
      '--text-2': '#d4d2cd',
      '--muted': '#8a8986',
      '--muted-2': '#a6a49f',
      '--muted-3': '#6b6a66',

      // Accent & status — one warm colour, softly used
      '--accent': '#d97742',
      '--accent-soft': 'rgba(217, 119, 66, 0.13)',
      '--accent-soft-2': 'rgba(217, 119, 66, 0.22)',
      '--accent-ink': '#1b1310',
      '--ok': '#7fa06a',
      '--warn': '#d8a14a',
      '--danger': '#cf6f5c',
      '--user-bubble': '#2b2723',

      // Lines & fills
      '--border': '#282828',
      '--border-strong': '#343434',
      '--hairline': '#282828',
      '--code-bg': '#201f1e',
      '--code-text': '#e6e5e3',
      '--hover-bg': 'rgba(230, 229, 227, 0.055)',
      '--active-bg': 'rgba(230, 229, 227, 0.085)',
      '--selected-bg': 'rgba(217, 119, 66, 0.2)',

      // Editor
      '--selection': 'rgba(217, 119, 66, 0.26)',
      '--cursor': '#e6e5e3',
      '--md-heading': '#efece7',
      '--md-strong': '#f2efea',
      '--md-em': '#e6e5e3',
      '--md-link': '#d97742',
      '--md-url': '#c99566',
      '--md-quote': '#a6a49f',
      '--md-list': '#e6e5e3',
      '--md-meta': '#8a8986',
      '--md-keyword': '#d97742',
      '--md-code': '#d9a06b',
      '--quote-bg': '#1d1c1b',
      '--quote-border': '#33312e',
      '--divider-bg': '#282828',
      ...DARK_SHADOWS
    }
  },
  {
    id: 'octarineLight',
    label: 'Octarine Light',
    kind: 'light',
    vars: {
      // Surfaces
      '--bg': '#f3f1ec',
      '--panel-bg': '#faf9f6',
      '--sidebar-bg': '#f3f1ec',
      '--agent-bg': '#f3f1ec',
      '--surface-elevated': '#eae7e0',
      '--paper': '#faf9f6',
      '--card-bg': '#faf9f6',
      '--canvas': '#faf9f6',
      '--elevated': '#eae7e0',
      '--app-bg': '#f3f1ec',
      '--control-bg': '#eae7e0',
      '--control-hover': '#e3dfd7',
      '--control-text': '#1f1f1e',
      '--field-bg': '#f0ede7',
      '--field-line': '#e4e1da',
      '--glass': 'rgba(250, 249, 246, 0.86)',

      // Text
      '--text': '#1f1f1e',
      '--text-2': '#35342f',
      '--muted': '#787671',
      '--muted-2': '#5f5d58',
      '--muted-3': '#a8a49b',

      // Accent & status
      '--accent': '#c86432',
      '--accent-soft': 'rgba(200, 100, 50, 0.1)',
      '--accent-soft-2': 'rgba(200, 100, 50, 0.18)',
      '--accent-ink': '#fffaf5',
      '--ok': '#5c8a4c',
      '--warn': '#b47d24',
      '--danger': '#b85442',
      '--user-bubble': '#2b2723',

      // Lines & fills
      '--border': '#e4e1da',
      '--border-strong': '#d9d5cc',
      '--hairline': '#e4e1da',
      '--code-bg': '#efede6',
      '--code-text': '#2b2a26',
      '--hover-bg': 'rgba(31, 31, 30, 0.05)',
      '--active-bg': 'rgba(31, 31, 30, 0.085)',
      '--selected-bg': 'rgba(200, 100, 50, 0.15)',

      // Editor
      '--selection': 'rgba(200, 100, 50, 0.2)',
      '--cursor': '#1f1f1e',
      '--md-heading': '#1f1f1e',
      '--md-strong': '#151514',
      '--md-em': '#1f1f1e',
      '--md-link': '#c86432',
      '--md-url': '#a05a35',
      '--md-quote': '#5f5d58',
      '--md-list': '#1f1f1e',
      '--md-meta': '#787671',
      '--md-keyword': '#c86432',
      '--md-code': '#a9552b',
      '--quote-bg': '#f4f1ea',
      '--quote-border': '#e0dcd3',
      '--divider-bg': '#e4e1da',
      ...LIGHT_SHADOWS
    }
  }
]

export const DEFAULT_THEME = 'octarineDark'

export function getTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!
}

export function nextTheme(currentId: string): ThemeDef {
  const idx = THEMES.findIndex((t) => t.id === currentId)
  return THEMES[(idx + 1) % THEMES.length]
}

// ---- derived tokens -------------------------------------------------------
// Themes define the palette; these tokens are computed so any future theme gets
// the same hierarchy for free. Anything a theme states explicitly wins, which is
// how Octarine pins its three surfaces exactly.
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
    // The navigator and the agent panel are one material. They share a surface
    // with the window's own background so the document feels like the only
    // object in the room.
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

export function applyTheme(id: string): ThemeDef {
  const theme = getTheme(id)
  const root = document.documentElement
  root.style.colorScheme = theme.kind === 'dark' ? 'dark' : 'light'
  const all = { ...deriveTokens(theme.vars), ...theme.vars }
  for (const [key, value] of Object.entries(all)) {
    root.style.setProperty(key, value)
  }
  root.dataset.theme = theme.id
  root.dataset.themeKind = theme.kind
  return theme
}
