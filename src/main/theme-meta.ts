import { nativeTheme } from 'electron'

// The themes in src/renderer/src/themes.ts, reduced to the two facts the main
// process needs before the renderer exists: the window background (so a cold
// launch doesn't flash white for dark-theme users) and the light/dark kind for
// nativeTheme. Keep in sync with themes.ts when adding a theme.
const THEME_BG: Record<string, string> = {
  octarineDark: '#141414',
  warmPaperLight: '#f3f1ec',
  midnightSlate: '#12161c',
  sageMist: '#eef1ea',
  solarizedWarmLight: '#f7f1e3',
  // Retired theme ids are still mapped so an old settings.json paints the right
  // colour before the renderer migrates it to the current palette.
  octarineLight: '#f3f1ec',
  light: '#f3f1ec',
  dark: '#141414',
  githubDark: '#141414',
  plainWhite: '#f3f1ec',
  plainBlack: '#141414',
  sepia: '#f3f1ec',
  ocean: '#141414',
  forest: '#f3f1ec'
}

const THEME_KIND: Record<string, 'light' | 'dark'> = {
  octarineDark: 'dark',
  warmPaperLight: 'light',
  midnightSlate: 'dark',
  sageMist: 'light',
  solarizedWarmLight: 'light',
  octarineLight: 'light',
  light: 'light',
  dark: 'dark',
  githubDark: 'dark',
  plainWhite: 'light',
  plainBlack: 'dark',
  sepia: 'light',
  ocean: 'dark',
  forest: 'light'
}

function systemKind(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function themeBackground(id: string | undefined): string {
  if (id === 'system') return systemKind() === 'dark' ? '#141414' : '#f3f1ec'
  return THEME_BG[id ?? 'octarineDark'] ?? THEME_BG.octarineDark
}

export function themeKind(id: string | undefined): 'light' | 'dark' {
  if (id === 'system') return systemKind()
  return THEME_KIND[id ?? 'octarineDark'] ?? 'dark'
}
