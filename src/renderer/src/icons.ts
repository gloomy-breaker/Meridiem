/**
 * The app's chrome icons, as inline SVG.
 *
 * The app used to draw its own interface with emoji (🗂️ 📕 🔍 ⚙ ✨ …). Emoji
 * are full-colour, fixed-artwork, different on every OS, and sit on their own
 * baseline — so no matter how good the rest of the type and spacing got, the
 * shell read as a toy. Everything the app draws for itself is now one weight
 * of line art at one optical size, inheriting `currentColor`.
 *
 * Emoji the *user* chose are a different thing and are not drawn here: a page's
 * front-matter `icon:` still renders as the emoji it is (see `applyIcon`, which
 * prefers it and only falls back to a glyph). The sidebar tree, the page title
 * and the tab strip keep showing those.
 *
 * Every glyph is drawn on a 24×24 grid with a 2px stroke on the same nine
 * coordinates as the ones already inlined in index.html, so a new icon needs no
 * new CSS — see `.ic` in styles.css.
 */

export type IconName =
  | 'plus'
  | 'sliders'
  | 'folder'
  | 'lock'
  | 'unlock'
  | 'search'
  | 'doc'
  | 'quiz'
  | 'image'
  | 'code'
  | 'table'
  | 'ruler'
  | 'sparkle'
  | 'clock'
  | 'stop'
  | 'arrowUp'
  | 'x'
  | 'trash'
  | 'paperclip'
  | 'link'
  | 'download'
  | 'list'
  | 'book'
  | 'help'
  | 'panel'
  | 'flag'
  | 'calendar'
  | 'network'
  | 'tray'
  | 'check'
  | 'template'
  | 'home'

/** Glyph interiors. Stroked unless the name appears in FILLED. */
const GLYPHS: Record<IconName, string> = {
  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  // Settings reads as sliders rather than a gear: a gear at 14px is a smudge,
  // and three rails with knobs is legible at any size.
  sliders:
    '<path d="M4 7.5h7"/><path d="M16.5 7.5H20"/><circle cx="13.8" cy="7.5" r="2.2"/>' +
    '<path d="M4 16.5h3.5"/><path d="M12 16.5h8"/><circle cx="9.8" cy="16.5" r="2.2"/>',
  folder:
    '<path d="M3.2 7.1A1.9 1.9 0 0 1 5.1 5.2h3.4a1 1 0 0 1 .8.4l1.3 1.7h8.3a1.9 1.9 0 0 1 1.9 1.9v7.7a1.9 1.9 0 0 1-1.9 1.9H5.1a1.9 1.9 0 0 1-1.9-1.9z"/>',
  lock:
    '<rect x="4.3" y="10.4" width="15.4" height="9.8" rx="2.1"/>' +
    '<path d="M7.9 10.4V7.8a4.1 4.1 0 0 1 8.2 0v2.6"/>',
  unlock:
    '<rect x="4.3" y="10.4" width="15.4" height="9.8" rx="2.1"/>' +
    '<path d="M7.9 10.4V7.8a4.1 4.1 0 0 1 7.7-1.9"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.5 20.5"/>',
  // A sheet with a folded corner and two rules — the shape every reader
  // already knows means "file", and the one inline file references use.
  doc:
    '<path d="M14.3 3.2H7.4a1.9 1.9 0 0 0-1.9 1.9v13.8a1.9 1.9 0 0 0 1.9 1.9h9.2a1.9 1.9 0 0 0 1.9-1.9V7.5z"/>' +
    '<path d="M14.3 3.2v4.3h4.2"/><path d="M9.3 13.7h5.4"/><path d="M9.3 17.1h3.5"/>',
  image:
    '<rect x="3.4" y="5" width="17.2" height="14" rx="2.1"/>' +
    '<circle cx="9" cy="10" r="1.7"/>' +
    '<path d="M4.6 17.6l5.2-5a1.4 1.4 0 0 1 1.9 0l7.7 7.3"/>',
  // The doc sheet with its rules replaced by a tick — a paper you answer rather
  // than read. Deliberately the same silhouette as `doc` so the two read as
  // siblings at 13px, where a wholly different shape would look like a mistake.
  quiz:
    '<path d="M14.3 3.2H7.4a1.9 1.9 0 0 0-1.9 1.9v13.8a1.9 1.9 0 0 0 1.9 1.9h9.2a1.9 1.9 0 0 0 1.9-1.9V7.5z"/>' +
    '<path d="M14.3 3.2v4.3h4.2"/><path d="M8.9 14.2l2.2 2.2 4.1-4.3"/>',
  code: '<path d="M9.1 7 4.3 12l4.8 5"/><path d="M14.9 7 19.7 12l-4.8 5"/>',
  table:
    '<rect x="3.4" y="4.9" width="17.2" height="14.2" rx="2.1"/>' +
    '<path d="M3.4 9.8h17.2"/><path d="M9.9 9.8v9.3"/>',
  ruler:
    '<rect x="2.6" y="8.3" width="18.8" height="7.4" rx="1.7"/>' +
    '<path d="M7.2 8.3v2.7"/><path d="M11 8.3v3.8"/><path d="M14.8 8.3v2.7"/><path d="M18.6 8.3v3.8"/>',
  sparkle:
    '<path d="M12 3.4l1.85 5.35a1.6 1.6 0 0 0 1 1.02l5.35 1.85-5.35 1.85a1.6 1.6 0 0 0-1 1.02L12 19.84l-1.85-5.35a1.6 1.6 0 0 0-1-1.02L3.8 11.62l5.35-1.85a1.6 1.6 0 0 0 1-1.02z"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.3 2.1"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.4"/>',
  arrowUp: '<path d="M12 19.2V5"/><path d="M5.9 11.1 12 5l6.1 6.1"/>',
  x: '<path d="M6.2 6.2 17.8 17.8"/><path d="M17.8 6.2 6.2 17.8"/>',
  trash:
    '<path d="M4.3 6.9h15.4"/><path d="M9.6 6.9V5.5a1.5 1.5 0 0 1 1.5-1.5h1.8a1.5 1.5 0 0 1 1.5 1.5v1.4"/>' +
    '<path d="M6.3 6.9l.84 12.3a1.8 1.8 0 0 0 1.8 1.7h6.1a1.8 1.8 0 0 0 1.8-1.7l.85-12.3"/>',
  paperclip:
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  link:
    '<path d="M10.1 13.9a3.7 3.7 0 0 0 5.2 0l3.1-3.1a3.7 3.7 0 0 0-5.2-5.2l-1.4 1.4"/>' +
    '<path d="M13.9 10.1a3.7 3.7 0 0 0-5.2 0l-3.1 3.1a3.7 3.7 0 0 0 5.2 5.2l1.4-1.4"/>',
  download:
    '<path d="M12 3.8v11.4"/><path d="M7.5 10.7 12 15.2l4.5-4.5"/><path d="M4.6 19.6h14.8"/>',
  list:
    '<path d="M8.8 6.5h10.6"/><path d="M8.8 12h10.6"/><path d="M8.8 17.5h10.6"/>' +
    '<path d="M4.6 6.5h.01"/><path d="M4.6 12h.01"/><path d="M4.6 17.5h.01"/>',
  book:
    '<path d="M12 6.9C10.4 5.4 8.3 4.8 4.4 4.8v12.6c3.9 0 6 .6 7.6 2.1 1.6-1.5 3.7-2.1 7.6-2.1V4.8c-3.9 0-6 .6-7.6 2.1z"/>' +
    '<path d="M12 6.9v12.6"/>',
  help:
    '<circle cx="12" cy="12" r="8.6"/>' +
    '<path d="M9.5 9.4a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.3"/>' +
    '<path d="M12 17h.01"/>',
  // The empty-split placeholder: a second pane beside the first.
  panel:
    '<rect x="3.4" y="4.9" width="17.2" height="14.2" rx="2.1"/><path d="M13.6 4.9v14.2"/>',
  // A pennant on a mast: the one mark a candidate already knows means "come
  // back to this one".
  flag:
    '<path d="M6.2 21V3.6"/><path d="M6.2 4.4c3.5-1.9 6.4-1.9 9.9 0 1 .5 2.1.5 3.1-.1v9c-1 .6-2.1.6-3.1.1-3.5-1.9-6.4-1.9-9.9 0z"/>',
  calendar:
    '<rect x="3.6" y="5.2" width="16.8" height="15" rx="2.2"/><path d="M3.6 9.6h16.8"/><path d="M8 3.6v3"/><path d="M16 3.6v3"/>',
  network:
    '<circle cx="6.2" cy="7.1" r="2.1"/><circle cx="17.6" cy="6.4" r="2.1"/><circle cx="12.3" cy="17.4" r="2.1"/>' +
    '<path d="M8.2 7.9l7.4-.9"/><path d="M7.4 8.9l3.9 6.6"/><path d="M16.7 8.2l-3.3 7.2"/>',
  tray:
    '<path d="M4.1 12.6 6.3 5.8a1.8 1.8 0 0 1 1.7-1.2h8a1.8 1.8 0 0 1 1.7 1.2l2.2 6.8v4.7a1.8 1.8 0 0 1-1.8 1.8H5.9a1.8 1.8 0 0 1-1.8-1.8z"/>' +
    '<path d="M4.1 12.6h4.2l1 2h5.4l1-2h4.2"/>',
  check:
    '<rect x="3.9" y="3.9" width="16.2" height="16.2" rx="3.2"/><path d="M7.8 12.3l2.5 2.5 5.3-5.6"/>',
  template:
    '<path d="M13.7 3.6H7.2a1.9 1.9 0 0 0-1.9 1.9v13a1.9 1.9 0 0 0 1.9 1.9h7.1"/>' +
    '<path d="M13.7 3.6v4.1h4.2"/><path d="M17.2 14.4v5.2"/><path d="M14.6 17h5.2"/>',
  home:
    '<path d="M3.9 10.4 12 3.7l8.1 6.7v9.2a1.4 1.4 0 0 1-1.4 1.4H5.3a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M9.4 21v-6.4h5.2V21"/>'
}

/** Drawn solid instead of stroked. */
const FILLED = new Set<IconName>(['sparkle'])

/**
 * `<svg>` markup for one icon. Use where the target is `innerHTML`; use
 * `iconEl` when you have an element to put it in.
 */
export function iconSvg(name: IconName, size = 15, strokeWidth = 1.8): string {
  return FILLED.has(name)
    ? `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${GLYPHS[name]}</svg>`
    : `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`
}

/** The icon as a detached `<svg>` element, ready to append. */
export function iconEl(name: IconName, size = 15, strokeWidth = 1.8): SVGSVGElement {
  const t = document.createElement('template')
  t.innerHTML = iconSvg(name, size, strokeWidth)
  return t.content.firstElementChild as SVGSVGElement
}

/**
 * Fill an icon slot with the app's line art. Emojis are never drawn in chrome:
 * a page's front-matter icon is still preserved on disk, but the UI stays one
 * stroke weight and one optical size everywhere. `fallback` is chosen by the
 * caller from the item's kind.
 */
export function applyIcon(
  el: HTMLElement,
  _emoji: string | null | undefined,
  fallback: IconName,
  size = 14
): void {
  el.classList.remove('is-emoji')
  el.replaceChildren(iconEl(fallback, size))
}
