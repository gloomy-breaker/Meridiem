import { Editor, Extension, InputRule, Mark, Node as TipTapNode, getHTMLFromFragment } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Paragraph from '@tiptap/extension-paragraph'
import HardBreak from '@tiptap/extension-hard-break'
import { Markdown } from 'tiptap-markdown'
import { Placeholder } from '@tiptap/extensions'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Table, TableKit } from '@tiptap/extension-table'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { MarkdownSerializerState } from 'prosemirror-markdown'
import type { Node as PMNode } from 'prosemirror-model'
import { Fragment as PMFragment } from 'prosemirror-model'
import { relaxCjkEmphasis, stripCjkMarkers } from './emphasis'
import { anchorFloat } from './floats'
import { repairTables } from './tables'
import type { EditorView } from 'prosemirror-view'
import { applyIcon, iconEl, iconSvg, type IconName } from './icons'

// The mark an inline reference wears in front of its name. A file gets the
// paperclip (its own line-art drawing, not the 📎 it used to wear); a page
// gets its own emoji when it has one and the app's page outline when it
// doesn't — an iconless page used to render with nothing there at all, which
// is what made those references look broken next to the rest.
function refGlyph(icon: string | null | undefined, fallback: IconName, size = 15): HTMLElement {
  const g = document.createElement('span')
  g.className = 'chip-glyph'
  if (icon) {
    g.classList.add('is-emoji')
    g.textContent = icon
  } else {
    g.appendChild(iconEl(fallback, size))
  }
  return g
}

// The name, in its own box: the underline belongs to the words, so it has to
// be a separate element from the chip the mark also lives in.
function refName(text: string): HTMLElement {
  const n = document.createElement('span')
  n.className = 'chip-name'
  n.textContent = text
  return n
}

// Minimal structural type for the markdown-it instance handed to extension
// parse hooks (kept loose so the two markdown-it copies in the tree can't
// mismatch types).
interface MarkdownItLike {
  inline: {
    ruler: {
      before(ruleName: string, newName: string, fn: (state: any, silent: boolean) => boolean): void
    }
  }
  block: {
    ruler: {
      before(
        ruleName: string,
        newName: string,
        fn: (state: any, startLine: number, endLine: number, silent: boolean) => boolean,
        options?: { alt?: string[] }
      ): void
      at?(
        ruleName: string,
        fn: (state: any, startLine: number, endLine: number, silent: boolean) => boolean,
        options?: { alt?: string[] }
      ): void
      __rules__?: {
        name: string
        alt: string[]
        fn: (state: any, startLine: number, endLine: number, silent: boolean) => boolean
      }[]
    }
  }
  renderer: {
    rules: Record<string, (tokens: any[], idx: number) => string>
  }
}

// [[Page Name]] page links: rendered as an icon+title chip in the editor and
// serialized back to plain markdown, so everything stays file-accessible.
const pageLinkRuleMds = new WeakSet<object>()

function installPageLinkRules(md: MarkdownItLike): void {
  if (pageLinkRuleMds.has(md)) return
  pageLinkRuleMds.add(md)

  md.inline.ruler.before('escape', 'yestion_link', (state, silent) => {
    if (!state.src.startsWith('[[', state.pos)) return false
    if (state.pos > 0 && isEscapedAt(state.src, state.pos)) return false
    const end = state.src.indexOf(']]', state.pos + 2)
    if (end < 0 || end >= state.posMax) return false
    const inner = state.src.slice(state.pos + 2, end).trim()
    if (!inner) return false
    const isFile = inner.startsWith('file:')
    if (!silent) {
      const token = state.push(isFile ? 'yestion_file' : 'yestion_page', 'span', 0)
      token.content = inner
      token.attrSet(isFile ? 'data-path' : 'data-name', isFile ? inner.slice(5) : inner)
    }
    state.pos = end + 2
    return true
  })
  md.renderer.rules.yestion_page = (tokens, idx) => {
    const t = tokens[idx]
    return `<span data-type="yestion-page" data-name="${escapeAttr(t.content)}"></span>`
  }
  md.renderer.rules.yestion_file = (tokens, idx) => {
    const t = tokens[idx]
    const p = String(t.content).slice(5)
    return `<span data-type="yestion-file" data-path="${escapeAttr(p)}"></span>`
  }
}

// Does this plain text look like markdown source? Used to decide whether a
// clipboard that also carries HTML should still be parsed as markdown (AI chats
// and editors put the raw source in text/plain and a styled wrapper in
// text/html — the source is what the user wants rendered).
function looksLikeMarkdown(text: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|.*\|)/.test(text) ||
    /(^|\n)\s{0,3}(-{3,}|\*{3,}|_{3,})\s*($|\n)/.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text) ||
    /(^|[^\\$])\$[^$\n]+\$/.test(text) ||
    /\$\$[\s\S]+?\$\$/.test(text) ||
    // LaTeX that arrived without $ fences: an environment, or \( \) / \[ \].
    /\\begin\{[A-Za-z*]+\}/.test(text) ||
    /\\\([\s\S]+?\\\)/.test(text) ||
    /\\\[[\s\S]*?[_^=<>][\s\S]*?\\\]/.test(text) ||
    /!?\[[^\]\n]*\]\([^)\n]*\)/.test(text) ||
    /(^|\n)#{1,6}\s/.test(text)
  )
}

// Genuinely formatted HTML (the paste already made bold/headings/lists for us).
function hasRichFormatting(html: string): boolean {
  return /<(strong|b|em|i|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|img|a|figure|details)\b/i.test(
    html
  )
}

// Our own markdown-it instance for pasting markdown text into the editor.
// It uses the same rules as loading (math, SVG, page links). Created lazily
// because the rule installers reference module-level state defined below.
let clipboardMd: InstanceType<typeof MarkdownIt> | null = null
function getClipboardMd(): InstanceType<typeof MarkdownIt> {
  if (!clipboardMd) {
    // Same surface as loading a file: breaks, math, highlights, page links,
    // trailing backslash breaks — pasted markdown renders exactly like the
    // same text saved to disk and reopened.
    clipboardMd = new MarkdownIt({ html: true, linkify: true, breaks: true })
    installPageLinkRules(clipboardMd as unknown as MarkdownItLike)
    installMathMarkdownRules(clipboardMd as unknown as MarkdownItLike)
    installLenientHtmlBlocks(clipboardMd as unknown as MarkdownItLike)
    installHighlightRules(clipboardMd as unknown as MarkdownItLike)
    installTrailingHardBreak(clipboardMd as unknown as MarkdownItLike)
  }
  return clipboardMd
}

// ---------------------------------------------------------------------------
// Math (LaTeX) support: custom ProseMirror nodes for $...$ and $$...$$, plus a
// markdown-it plugin emitting markup the nodes round-trip through.
// ---------------------------------------------------------------------------

function isEscapedAt(src: string, idx: number): boolean {
  let n = 0
  for (let i = idx - 1; i >= 0 && src.charCodeAt(i) === 92; i--) n++
  return n % 2 === 1 // odd number of backslashes => escaped
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Lenient HTML blocks.
//
// markdown-it opens an HTML block for ANY tag at the start of a line and only
// closes it at a blank line. Pasted worksheet material interleaves tags with
// markdown and often has no blank lines at all, so a single `<br>` line after a
// `---` swallowed the rest of the document: the HTML passed through (that is
// why the <br>s and the inline <svg> still rendered) while every `$…$` and
// `**…**` inside it stayed raw text.
//
// This rule keeps genuine HTML blocks but:
//   * treats inline-only tags (<br>, <span>, <b>, …) as inline HTML, so they
//     never open a block, and
//   * ends a block at the first line that is not HTML, so prose that follows a
//     tag run is parsed as markdown again.
// Comments, doctypes and raw-text elements (script/pre/style/textarea) keep
// markdown-it's own terminator-based handling.
// `h` is Meridiem's highlight tag (`<h>…</h>`), not an HTML heading — without it
// a line that *starts* with `<h>` opened an HTML block and its inner markdown
// (`**bold**`, `$math$`, …) came through as raw text. The `\b` keeps the real
// heading tags `<h1>`…`<h6>` (and `<hr>`, `<html>`) as genuine blocks.
const INLINE_HTML_TAG_RE =
  /^<\/?(?:br|span|b|i|em|strong|u|s|del|ins|sub|sup|mark|code|a|img|font|small|big|kbd|var|q|abbr|cite|time|wbr|ruby|rt|rp|bdi|bdo|data|dfn|meter|output|picture|source|track|template|h)\b/i

const lenientHtmlMds = new WeakSet<object>()

function installLenientHtmlBlocks(md: MarkdownItLike): void {
  if (lenientHtmlMds.has(md)) return
  lenientHtmlMds.add(md)
  const ruler = md.block.ruler
  if (!ruler.at) return
  const existing = ruler.__rules__?.find((r) => r.name === 'html_block')
  const original = existing?.fn
  // The `alt` list is what lets paragraphs/list items terminate at an HTML
  // block. `at()` resets it to [] unless passed along, and without it a
  // paragraph swallowed the <svg> that followed it (which also turned the next
  // `---` into a setext heading over that paragraph).
  const alt = existing?.alt ?? ['paragraph', 'reference', 'blockquote', 'list']
  ruler.at('html_block', (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
    // Indented code wins, exactly like the stock rule.
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    const pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (state.src.charCodeAt(pos) !== 0x3c /* < */) return false
    const first = state.src.slice(pos, max)
    const trimmed = first.trim()
    if (
      /^<(?:script|pre|style|textarea)\b/i.test(trimmed) ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith('<?') ||
      trimmed.startsWith('<!')
    ) {
      return original ? original(state, startLine, endLine, silent) : false
    }
    // Inline-only tags are inline HTML — never a block.
    if (INLINE_HTML_TAG_RE.test(trimmed)) return false
    if (silent) return true
    // Consume the run of lines that each begin with a tag; stop at the first
    // line that does not (or at a blank line).
    let lastLine = startLine
    for (let n = startLine; n < endLine; n++) {
      const lp = state.bMarks[n] + state.tShift[n]
      const lm = state.eMarks[n]
      if (lp >= lm) break
      if (state.src.charCodeAt(lp) !== 0x3c) break
      lastLine = n
    }
    state.line = lastLine + 1
    const token = state.push('html_block', '', 0)
    token.map = [startLine, state.line]
    token.content = state.getLines(startLine, state.line, state.blkIndent, true)
    return true
  }, { alt })
}

const mathRuleMds = new WeakSet<object>()

// Registers markdown-it rules for $…$ / \(…\) inline and $$…$$ / \[…\] block
// math. Idempotent per markdown-it instance (setup runs on every parse).
function installMathMarkdownRules(md: MarkdownItLike): void {
  if (mathRuleMds.has(md)) return
  mathRuleMds.add(md)

  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const src = state.src
    const start = state.pos
    let close = ''

    if (src.charCodeAt(start) === 36 /* $ */) {
      if (src.charCodeAt(start + 1) === 36) return false // $$ is block math
      close = '$'
    } else if (src.startsWith('\\(', start)) {
      close = '\\)'
    } else if (src.startsWith('\\[', start)) {
      // Inline \[…\] — same delimiters as display math, so only when the body
      // actually looks like maths (\[1\] is a citation label, not an equation).
      close = '\\]'
    } else {
      return false
    }

    if (start > 0 && isEscapedAt(src, start)) return false

    // Find the unescaped closing delimiter.
    let end = -1
    let i = start + close.length
    while (i < state.posMax) {
      const hits = close === '$' ? src.charCodeAt(i) === 36 && !isEscapedAt(src, i) : src.startsWith(close, i) && !isEscapedAt(src, i)
      if (hits) {
        end = i
        break
      }
      i++
    }
    if (end < 0) return false
    const content = src.slice(start + close.length, end)
    if (!content.trim()) return false
    if (close === '\\]' && !looksLikeMathSource(content)) return false
    if (!silent) {
      const token = state.push('math_inline', 'span', 0)
      token.content = content
      token.attrSet('data-type', 'math-inline')
      token.attrSet('data-tex', content)
      token.markup = close
    }
    state.pos = end + close.length
    return true
  })

  md.block.ruler.before(
    'fence',
    'math_block',
    (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const line = state.src.slice(start, max)

    // Single-line display math: $$…$$ or \[…\] on one line — and the fenced
    // multi-line form. Both are what the preview's texmath accepts.
    if (line.startsWith('$$')) {
      if (silent) return /^\$\$/.test(line)
      const single = /^\$\$([\s\S]+?)\$\$\s*$/.exec(line)
      if (single) {
        const token = state.push('math_block', 'div', 0)
        token.content = single[1]
        token.block = true
        token.map = [startLine, startLine + 1]
        token.attrSet('data-type', 'math-block')
        token.attrSet('data-tex', single[1])
        state.line = startLine + 1
        return true
      }
      if (!/^\$\$\s*$/.test(line)) return false
    } else if (line.startsWith('\\[')) {
      if (silent) return /^\\\[/.test(line)
      const single = /^\\\[([\s\S]+?)\\\]\s*$/.exec(line)
      if (single) {
        // Same guard as inline: `\[1\]` alone on a line is a label.
        if (!looksLikeMathSource(single[1])) return false
        const token = state.push('math_block', 'div', 0)
        token.content = single[1]
        token.block = true
        token.map = [startLine, startLine + 1]
        token.attrSet('data-type', 'math-block')
        token.attrSet('data-tex', single[1])
        state.line = startLine + 1
        return true
      }
      if (!/^\\\[\s*$/.test(line)) return false
    } else {
      return false
    }

    const closeRe = line.startsWith('$$') ? /^\$\$\s*$/ : /^\\\]\s*$/
    let next = startLine + 1
    while (next < endLine) {
      const s = state.bMarks[next] + state.tShift[next]
      const e = state.eMarks[next]
      if (closeRe.test(state.src.slice(s, e))) break
      next++
    }

    const content = state.getLines(startLine + 1, next, state.sCount[startLine], false)
    if (line.startsWith('\\[') && !looksLikeMathSource(content)) return false
    const token = state.push('math_block', 'div', 0)
    token.content = content
    token.block = true
    token.markup = line.startsWith('$$') ? '$$' : '\\['
    token.map = [startLine, next + 1]
    token.attrSet('data-type', 'math-block')
    token.attrSet('data-tex', content)
    state.line = next + 1
    return true
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  )

  // A bare LaTeX environment — \begin{aligned} … \end{aligned} with no $$ / \[
  // fence around it — is display math. Without this it stayed ordinary text,
  // had its newlines turned into hard breaks ("\" everywhere) and its
  // backslashes escaped, which destroyed the equation rather than pausing it.
  md.block.ruler.before(
    'fence',
    'math_environment',
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine]
      const line = state.src.slice(start, state.eMarks[startLine])
      const open = /^\\begin\{([A-Za-z*]+)\}/.exec(line)
      if (!open) return false
      if (silent) return true
      const env = open[1].replace(/[*]/g, '\\*')
      const closeRe = new RegExp('\\\\end\\{' + env + '\\}')
      let next = startLine
      while (next < endLine) {
        const s = state.bMarks[next] + state.tShift[next]
        if (closeRe.test(state.src.slice(s, state.eMarks[next]))) break
        next++
      }
      // Unterminated environment: leave it alone rather than eating the file.
      if (next >= endLine) return false
      const content = state.getLines(startLine, next + 1, state.sCount[startLine], false).trim()
      const token = state.push('math_block', 'div', 0)
      token.content = content
      token.block = true
      token.map = [startLine, next + 1]
      token.attrSet('data-type', 'math-block')
      token.attrSet('data-tex', content)
      state.line = next + 1
      return true
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  )

  md.renderer.rules.math_inline = (tokens, idx) => {
    const t = tokens[idx]
    return `<span data-type="math-inline" data-tex="${escapeAttr(t.content)}"></span>`
  }
  md.renderer.rules.math_block = (tokens, idx) => {
    const t = tokens[idx]
    return `<div data-type="math-block" data-tex="${escapeAttr(t.content)}"></div>`
  }
}

/**
 * Does this text look like maths rather than prose? Used before treating `\[…\]`
 * as display math: reference labels such as `\[1\]`, `\[40min\]` or `\[ \]` are
 * normal writing and must stay text.
 */
function looksLikeMathSource(tex: string): boolean {
  return /\\[A-Za-z]+|[_^]|[=<>]|\d\s*[-+*/]\s*\d/.test(tex)
}

// Leftover half-typed token cache used to auto-open the composer on freshly
// inserted math nodes (the "$$ " input rule / slash menu insert an empty node
// that should immediately be ready for typing).
let pendingMathCompose = false
// Math node view: the document line always shows only the *rendered* formula.
// Editing happens in a separate plaintext popup that floats under the line
// (Notion-style) — type LaTeX there and the formula above updates live.
let mathPopup: HTMLElement | null = null
let mathPopupTarget: { editor: Editor; pos: number; initialTex: string; wasEmpty: boolean } | null = null

function closeMathPopup(cancel: boolean): void {
  const target = mathPopupTarget
  const popup = mathPopup
  mathPopup = null
  mathPopupTarget = null
  if (popup) popup.remove()
  if (target && cancel) {
    const node = target.editor.state.doc.nodeAt(target.pos)
    if (node && node.type.name.startsWith('math')) {
      if (target.wasEmpty && !target.initialTex) {
        // Cancelled a brand-new equation → remove the empty node.
        target.editor.view.dispatch(
          target.editor.state.tr.delete(target.pos, target.pos + node.nodeSize)
        )
      } else {
        target.editor.view.dispatch(
          target.editor.state.tr.setNodeMarkup(target.pos, undefined, {
            ...node.attrs,
            tex: target.initialTex
          })
        )
      }
    }
  }
  if (target) target.editor.commands.focus()
}

function openMathEditor(editor: Editor, pos: number, onClose?: () => void): void {
  closeMathPopup(false)
  const node = editor.state.doc.nodeAt(pos)
  if (!node || !node.type.name.startsWith('math')) return
  const initialTex = String(node.attrs.tex ?? '')

  const popup = document.createElement('div')
  popup.className = 'math-editor-popup'
  const input = document.createElement('input')
  input.className = 'math-editor-input'
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = 'LaTeX  e.g. \\frac{1}{2}'
  input.value = initialTex
  popup.appendChild(input)
  document.body.appendChild(popup)
  // Same click trap as the highlight popup: the editor opens on mousedown and
  // the `click` that follows is seen by the shared dismissal pass as a click
  // outside the popup, closing it instantly. Anchor it to the equation.
  const nodeDom = editor.view.nodeDOM(pos)
  anchorFloat(popup, nodeDom instanceof HTMLElement ? nodeDom : null)

  const place = (): void => {
    try {
      const coords = editor.view.coordsAtPos(pos)
      popup.style.left = Math.round(coords.left) + 'px'
      popup.style.top = Math.round(coords.bottom + 6) + 'px'
    } catch {
      /* node may be momentarily unmapped */
    }
  }
  place()

  mathPopup = popup
  mathPopupTarget = { editor, pos, initialTex, wasEmpty: !initialTex }

  const apply = (tex: string): void => {
    const cur = editor.state.doc.nodeAt(pos)
    if (!cur || cur.type.name !== node.type.name) return
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, tex })
    )
    place()
  }

  input.addEventListener('input', () => apply(input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const tex = input.value.trim()
      if (tex) apply(tex)
      closeMathPopup(false)
      onClose?.()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeMathPopup(true)
      onClose?.()
    }
    e.stopPropagation()
  })
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (mathPopup === popup) {
        closeMathPopup(false)
        onClose?.()
      }
    }, 120)
  })

  input.focus()
  input.select()
}

// Turn the math node next to the caret back into plain $…$ / $$…$$ text.
function derenderAdjacentMath(view: EditorView, dir: 'before' | 'after'): boolean {
  const { state } = view
  const sel = state.selection
  if (!sel.empty) return false
  const $pos = sel.$from
  const node = dir === 'before' ? $pos.nodeBefore : $pos.nodeAfter
  if (!node) return false
  const name = node.type.name
  if (name !== 'mathInline' && name !== 'mathBlock') return false
  const tex = String(node.attrs.tex ?? '')
  const raw = name === 'mathInline' ? `$${tex}$` : `$$${tex}$$`
  const from = dir === 'before' ? $pos.pos - node.nodeSize : $pos.pos
  const to = from + node.nodeSize
  const tr = state.tr.replaceWith(from, to, state.schema.text(raw))
  const caret = dir === 'before' ? from + raw.length : from + raw.length
  tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)))
  view.dispatch(tr)
  return true
}

interface MathNodeViewProps {
  node: PMNode
  editor: Editor
  getPos: () => number | undefined
}

function mathNodeView(inline: boolean) {
  return (props: MathNodeViewProps) => {
    const { node, editor, getPos } = props
    const dom = document.createElement(inline ? 'span' : 'div')
    dom.className = 'math-node ' + (inline ? 'math-inline-node' : 'math-block-node')
    let current = node

    const renderStatic = (): void => {
      dom.classList.toggle('is-empty', !current.attrs.tex)
      dom.innerHTML = ''
      if (current.attrs.tex) {
        katex.render(String(current.attrs.tex), dom, {
          displayMode: !inline,
          throwOnError: false,
          strict: false
        })
      } else {
        dom.textContent = inline ? '\u22ef' : '\u2211'
      }
    }

    const edit = (): void => {
      const pos = getPos()
      if (pos == null) return
      editor.commands.setNodeSelection(pos)
      openMathEditor(editor, pos)
    }

    dom.addEventListener('mousedown', (e) => {
      // Single click opens the popup editor (like Notion's inline equations).
      e.preventDefault()
      e.stopPropagation()
      edit()
    })

    if (!current.attrs.tex && pendingMathCompose) {
      pendingMathCompose = false
      window.setTimeout(edit, 0)
    } else {
      renderStatic()
    }

    return {
      dom,
      update: (updated) => {
        if (updated.type !== current.type) return false
        if (updated.attrs.tex !== current.attrs.tex) {
          current = updated
          renderStatic()
        }
        return true
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Raw HTML blocks (SVG diagrams, centered wrapper divs, etc.) that appear in
// markdown. ProseMirror has no node for arbitrary HTML, so keep the raw HTML
// string as an attribute and render it uneditable between blocks.
// ---------------------------------------------------------------------------

const RawHtmlBlock = TipTapNode.create({
  name: 'rawHtml',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return { html: { default: '' } }
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="raw-html"]', getAttrs: (el) => ({ html: (el as HTMLElement).getAttribute('data-html') ?? '' }) },
      { tag: 'svg', getAttrs: (el) => ({ html: (el as HTMLElement).outerHTML }) }
    ]
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'raw-html', 'data-html': node.attrs.html }]
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'raw-html-node'
      let current = node
      const render = (): void => {
        dom.innerHTML = String(current.attrs.html ?? '')
      }
      render()
      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false
          if (updated.attrs.html !== current.attrs.html) {
            current = updated
            render()
          }
          return true
        }
      }
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.ensureNewLine()
          state.write(String(node.attrs.html ?? ''))
          state.closeBlock(node)
        },
        parse: {
          // Before ProseMirror parses the rendered HTML, wrap raw block-level
          // HTML (SVG diagrams, centered wrappers, embeds) into a marker div
          // this node can pick up — otherwise it degrades to plain text.
          updateDOM(element: HTMLElement): void {
            // Cosmetic <div align> wrappers around plain images would swallow
            // them into raw HTML (with relative srcs that can't resolve).
            // Unwrap them so the <img> parses as an image node instead.
            element.querySelectorAll('div[align]').forEach((el) => {
              if (el.querySelector('img') && !el.querySelector('svg, iframe, embed, object, video, audio')) {
                while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
                el.remove()
              }
            })
            // Wrap remaining raw block-level HTML (SVG diagrams, embeds) into a
            // marker div this node can pick up — otherwise it degrades to text.
            const selector = 'svg, iframe, embed, object, video, audio'
            element.querySelectorAll(selector).forEach((el) => {
              if (el.closest('[data-type="raw-html"]')) return
              const wrap = document.createElement('div')
              wrap.setAttribute('data-type', 'raw-html')
              wrap.setAttribute('data-html', (el as HTMLElement).outerHTML)
              el.replaceWith(wrap)
              wrap.appendChild(el)
            })
          }
        }
      }
    }
  }
})

// A hard page break, for exports (slash → Page break). Kept in the markdown as
// a raw HTML block, so the file stays plain text and other tools just ignore it.
const PageBreak = TipTapNode.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }]
  },

  renderHTML() {
    return ['div', { 'data-type': 'page-break', class: 'page-break page-break-node' }]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.ensureNewLine()
          state.write('<div data-type="page-break"></div>')
          state.closeBlock(node)
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Columns (slash → "2 columns" / "3 columns"). A `columnList` holds 2–3
// `column`s; each column is an ordinary editable stack of blocks. On disk it is
// stored as nested divs with markdown inside:
//
//     <div data-ycols="2">
//
//     <div data-ycol>
//
//     Left column text
//
//     </div>
//     <div data-ycol>
//
//     Right column text
//
//     </div>
//     </div>
//
// The app's lenient html-block rule ends an HTML block at the first non-`<`
// line, so the markdown between the tags parses normally on the way back in —
// that's what keeps the column content editable (and readable) as markdown.
// ---------------------------------------------------------------------------
const MAX_COLUMNS = 3
const COLUMN_MIN = 2

const Column = TipTapNode.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-ycol]' }]
  },

  renderHTML() {
    return ['div', { 'data-ycol': '' }, 0]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.ensureNewLine()
          state.write('<div data-ycol>')
          state.closeBlock(node)
          state.renderContent(node)
          state.ensureNewLine()
          state.write('</div>')
          state.closeBlock(node)
        }
      }
    }
  }
})

const ColumnList = TipTapNode.create({
  name: 'columnList',
  group: 'block',
  content: 'column column+',
  isolating: true,
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-ycols]' }]
  },

  renderHTML({ node }) {
    // The count is derived from the content, so `data-ycols` is always right.
    return ['div', { 'data-ycols': String(node.childCount), class: 'yestion-columns' }, 0]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.ensureNewLine()
          state.write(`<div data-ycols="${node.childCount}">`)
          state.closeBlock(node)
          state.renderContent(node)
          state.ensureNewLine()
          state.write('</div>')
          state.closeBlock(node)
        }
      }
    }
  }
})

function mathSerializeAsInline(state: MarkdownSerializerState, node: PMNode): void {
  const tex = String(node.attrs.tex ?? '')
  state.write(tex ? '$' + tex + '$' : '$\; $')
}

function mathSerializeAsBlock(state: MarkdownSerializerState, node: PMNode): void {
  const tex = String(node.attrs.tex ?? '')
  if (tex.includes('\n')) {
    state.ensureNewLine()
    state.write('$$\n' + tex + '\n$$')
  } else {
    state.write(tex ? '$$' + tex + '$$' : '$$\;$$')
  }
  state.closeBlock(node)
}

// tiptap-markdown adds a `tight` attribute to bulletList/orderedList to keep
// list items on adjacent lines, but not to taskList. Give taskList one too so
// to-do items serialize as `- [ ] a\n- [ ] b` instead of with blank lines.
const RichTaskList = TaskList.extend({
  addAttributes() {
    return { tight: { default: true } }
  },

  addInputRules() {
    return [
      // `- [ ] ` / `- [x] ` (also * and +) becomes a to-do item, like Notion.
      new InputRule({
        find: /^\s*([-*+])\s\[([ xX])\]\s$/,
        handler: ({ range, chain, match, state }) => {
          const checked = match[2].toLowerCase() === 'x'
          chain().deleteRange(range).toggleTaskList().run()
          if (checked) {
            // The item now exists at the caret — tick it.
            const { $from } = state.selection
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d)
              if (node.type.name === 'taskItem') {
                chain().updateAttributes('taskItem', { checked: true }).run()
                break
              }
            }
          }
        }
      })
    ]
  },

  addKeyboardShortcuts() {
    return {
      // Notion-style to-do shortcut.
      'Mod-Shift-9': () => this.editor.chain().focus().toggleTaskList().run()
    }
  }
})

// To-do items have three states, cycled by clicking the box:
//   [ ] empty  →  [/] in progress (orange)  →  [x] done (green)  →  empty
// `checked` is kept in sync for compatibility with other markdown tools.
type TodoStatus = 'todo' | 'doing' | 'done'
const TODO_CYCLE: Record<TodoStatus, TodoStatus> = { todo: 'doing', doing: 'done', done: 'todo' }

export function todoStatusOf(attrs: { status?: string; checked?: boolean }): TodoStatus {
  const s = attrs.status
  if (s === 'doing' || s === 'done' || s === 'todo') return s
  return attrs.checked ? 'done' : 'todo'
}

// markdown-it-task-lists only recognises `[ ]` and `[x]`, so a `[/]` marker
// arrives as plain list text. Normalise every marker form into task items.
function convertTaskMarkers(element: HTMLElement): void {
  const lists = element.querySelectorAll('ul, ol')
  for (const list of lists) {
    const items = Array.from(list.children).filter((c): c is HTMLElement => c.tagName === 'LI')
    if (items.length === 0) continue
    const markers = items.map((li) => /^\s*\[([ xX\/])\]\s/.exec(li.textContent ?? '')?.[1] ?? null)
    const anyTask =
      markers.some((m) => m !== null) || items.some((li) => li.classList.contains('task-list-item'))
    if (!anyTask) continue
    list.setAttribute('data-type', 'taskList')
    items.forEach((li, i) => {
      const marker = markers[i]
      const converted = li.classList.contains('task-list-item')
      let status: TodoStatus = 'todo'
      if (marker) {
        status = marker.toLowerCase() === 'x' ? 'done' : marker === '/' ? 'doing' : 'todo'
      } else {
        // `[ ]`/`[x]` items were consumed by markdown-it-task-lists, which
        // leaves a checkbox input behind — read its state (this hook replaces
        // tiptap-markdown's own conversion).
        const input = li.querySelector('input[type=checkbox]') as HTMLInputElement | null
        if (input?.checked || li.getAttribute('data-checked') === 'true') status = 'done'
      }
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-status', status)
      li.setAttribute('data-checked', String(status === 'done'))
      li.classList.remove('task-list-item')
      li.querySelectorAll('input[type=checkbox]').forEach((n) => n.remove())
      if (marker && !converted) {
        // Strip the marker text we just interpreted.
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
        const first = walker.nextNode()
        if (first?.nodeValue) first.nodeValue = first.nodeValue.replace(/^\s*\[[ xX\/]\]\s/, '')
      }
    })
  }
}

const RichTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      checked: {
        default: false,
        parseHTML: (el) => {
          const status = (el as HTMLElement).getAttribute('data-status')
          if (status) return status === 'done'
          return (el as HTMLElement).getAttribute('data-checked') === 'true'
        },
        renderHTML: (attrs) => ({ 'data-checked': String(Boolean(attrs.checked)) })
      },
      status: {
        default: 'todo',
        parseHTML: (el) => {
          const el2 = el as HTMLElement
          const s = el2.getAttribute('data-status')
          if (s === 'doing' || s === 'done' || s === 'todo') return s
          return el2.getAttribute('data-checked') === 'true' ? 'done' : 'todo'
        },
        renderHTML: (attrs) => ({ 'data-status': attrs.status ?? 'todo' })
      }
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const li = document.createElement('li')
      li.className = 'todo-item'
      const box = document.createElement('span')
      box.className = 'todo-box'
      box.contentEditable = 'false'
      box.title = 'Click to cycle: empty → in progress → done'
      const content = document.createElement('div')
      content.className = 'todo-content'
      li.append(box, content)

      const apply = (): void => {
        const status = todoStatusOf(current.attrs)
        li.setAttribute('data-status', status)
        li.setAttribute('data-checked', String(status === 'done'))
        box.setAttribute('data-status', status)
        box.textContent = status === 'done' ? '✓' : status === 'doing' ? '●' : ''
      }

      const stop = (e: Event): void => {
        e.preventDefault()
        e.stopPropagation()
      }
      box.addEventListener('mousedown', stop)
      box.addEventListener('click', (e) => {
        stop(e)
        const pos = typeof getPos === 'function' ? getPos() : null
        if (pos == null) return
        const next = TODO_CYCLE[todoStatusOf(current.attrs)]
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            status: next,
            checked: next === 'done'
          })
        )
      })

      apply()
      return {
        dom: li,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== current.type) return false
          current = updated
          apply()
          return true
        }
      }
    }
  },

  addInputRules() {
    return [
      // `- [ ] `, `- [/] `, `- [x] ` (also * and +) all create to-do items.
      new InputRule({
        find: /^\s*([-*+])\s\[([ xX\/])\]\s$/,
        handler: ({ range, chain, match }) => {
          const marker = match[2].toLowerCase()
          const status: TodoStatus = marker === 'x' ? 'done' : marker === '/' ? 'doing' : 'todo'
          // Two steps: the task item only exists once the first transaction is
          // dispatched, and a chained command that cannot run aborts the chain.
          chain().deleteRange(range).toggleTaskList().run()
          chain().updateAttributes('taskItem', { status, checked: status === 'done' }).run()
        }
      })
    ]
  },

  addStorage() {
    return {
      // tiptap-markdown merges this over its own taskItem spec, so these are
      // authoritative: write the three marker forms, and normalise `[/]` on
      // parse (markdown-it-task-lists only understands `[ ]` and `[x]`).
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          const status = todoStatusOf(node.attrs)
          const mark = status === 'done' ? '[x]' : status === 'doing' ? '[/]' : '[ ]'
          state.write(mark + ' ')
          state.renderContent(node)
        },
        parse: {
          updateDOM(element: HTMLElement): void {
            convertTaskMarkers(element)
          }
        }
      }
    }
  }
})

// Markdown pipe tables. tiptap-markdown's own table serializer skips any cell
// whose *text* is empty — which silently dropped cells holding only an atom
// (an equation, an image). Check the cell's node content instead, and fall back
// to HTML for tables pipes can't express (spans, multi-paragraph cells).
const RichTable = Table.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      /** Standard pipe table, borderless, or the booktabs/LaTeX look. */
      tableStyle: {
        default: 'standard',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-table-style') || 'standard',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-table-style': String(attrs.tableStyle ?? 'standard')
        })
      },
      /** Which axis carries the weight: the header row (default) or the first column. */
      boldAxis: {
        default: 'row',
        parseHTML: (el: HTMLElement) =>
          el.getAttribute('data-bold-axis') === 'column' ? 'column' : 'row',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-bold-axis': String(attrs.boldAxis ?? 'row')
        })
      }
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize(this: { editor: Editor }, state: MarkdownSerializerState, node: PMNode): void {
          const st = state as MarkdownSerializerState & { inTable?: boolean }
          const rows: PMNode[] = []
          node.forEach((row) => rows.push(row))
          const cellsOf = (row: PMNode): PMNode[] => {
            const cells: PMNode[] = []
            row.forEach((cell) => cells.push(cell))
            return cells
          }
          const complexCell = (cell: PMNode, header: boolean): boolean =>
            (header ? cell.type.name !== 'tableHeader' : cell.type.name === 'tableHeader') ||
            Number(cell.attrs.colspan ?? 1) > 1 ||
            Number(cell.attrs.rowspan ?? 1) > 1 ||
            cell.childCount > 1
          const pipeSafe =
            rows.length > 0 &&
            cellsOf(rows[0]).every((c) => !complexCell(c, true)) &&
            rows.slice(1).every((r) => cellsOf(r).every((c) => !complexCell(c, false)))
          // Pipe tables cannot carry a style or a bold-axis choice, so a styled
          // table is written as its HTML form — which the loader parses back.
          const styled =
            String(node.attrs.tableStyle ?? 'standard') !== 'standard' ||
            String(node.attrs.boldAxis ?? 'row') !== 'row'
          if (!pipeSafe || styled) {
            // Keep the <table> wrapper: serializing node.content alone wrote bare
            // <tr>/<th> elements, which stopped being a table on the next load —
            // its images then spilled out of the cells as loose blocks.
            st.write(getHTMLFromFragment(PMFragment.from(node), this.editor.schema))
            st.closeBlock(node)
            return
          }
          st.inTable = true
          rows.forEach((row, i) => {
            st.write('| ')
            cellsOf(row).forEach((cell, j) => {
              if (j) st.write(' | ')
              const content = cell.firstChild
              // content.size covers inline atoms (equations/images) that have no text
              if (content && content.content.size > 0) st.renderInline(content)
            })
            st.write(' |')
            st.ensureNewLine()
            if (i === 0) {
              st.write('| ' + cellsOf(row).map(() => '---').join(' | ') + ' |')
              st.ensureNewLine()
            }
          })
          st.closeBlock(node)
          st.inTable = false
        }
      }
    }
  }
})

/**
 * Headings behave the way people expect from Notion/Docs rather than the way
 * tiptap ships them:
 *
 *   Enter        at the end of a heading starts a PARAGRAPH. Stock tiptap splits
 *                the heading into two headings, so "# Title ⏎" left you typing
 *                another heading. Splitting in the middle still keeps both
 *                halves as headings.
 *   Backspace    at the very start of a heading turns it into a paragraph when
 *                merging would trap you: the heading is empty, it is the first
 *                block, or the block above is another heading (stock behaviour
 *                merged it into that heading, so the next Enter made yet
 *                another heading and it felt like backspace did nothing).
 *
 * A paragraph above is left to ProseMirror: merging a heading into it is what
 * you want there.
 */
/**
 * Put the table's style and bold-axis choices on its DOM element.
 *
 * The attributes round-trip through markdown (the serializer writes the HTML
 * form) but ProseMirror rebuilds a table's DOM from cells and does not carry
 * them onto the element, so the CSS never saw the choice. Node decorations
 * cannot help either: prosemirror-tables supplies the first `decorations` prop
 * (the column-resize handles) and only one plugin's decorations are used.
 *
 * A view plugin walks the document's tables and the DOM's tables — both in
 * document order — and stamps the attributes on after every update.
 */
const TableStyleDecoration = Extension.create({
  name: 'yestionTableStyle',
  addProseMirrorPlugins() {
    const sync = (view: EditorView): void => {
      const tables: { node: PMNode; pos: number }[] = []
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'table') tables.push({ node, pos })
      })
      const elements = [...view.dom.querySelectorAll('table')].filter(
        (el) => !el.closest('[data-type="raw-html"]')
      )
      // Which table holds the caret? That one gets the editing guides; the
      // guides themselves are only visible while the editor has focus.
      const $from = view.state.selection.$from
      let activePos = -1
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
          activePos = $from.before(d)
          break
        }
      }
      tables.forEach(({ node, pos }, index) => {
        const el = elements[index]
        if (!el) return
        el.setAttribute('data-table-style', String(node.attrs.tableStyle ?? 'standard'))
        el.setAttribute('data-bold-axis', node.attrs.boldAxis === 'column' ? 'column' : 'row')
        el.setAttribute('data-editing', pos === activePos ? 'true' : 'false')
      })
    }
    return [
      new Plugin({
        view: (view) => {
          sync(view)
          return { update: (updated) => sync(updated) }
        }
      })
    ]
  }
})

const HeadingBehaviour = Extension.create({
  name: 'yestionHeadingBehaviour',
  priority: 1000,

  addKeyboardShortcuts() {
    const headingAtCaret = (): { node: PMNode; depth: number } | null => {
      const { $from, empty } = this.editor.state.selection
      if (!empty) return null
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth)
        if (node.type.name === 'heading') return { node, depth }
        if (node.isTextblock) break
      }
      return null
    }

    /** Retype the heading at `depth` as a paragraph, in place. */
    const toParagraph = (depth: number): boolean => {
      const { state, view } = this.editor
      const paragraph = state.schema.nodes.paragraph
      if (!paragraph) return false
      const $from = state.selection.$from
      view.dispatch(state.tr.setNodeMarkup($from.before(depth), paragraph))
      return true
    }

    /** Insert one empty paragraph after the heading and put the caret in it. */
    const paragraphBelow = (depth: number): boolean => {
      const { state, view } = this.editor
      const paragraph = state.schema.nodes.paragraph
      const node = paragraph?.createAndFill()
      if (!paragraph || !node) return false
      const at = state.selection.$from.after(depth)
      const tr = state.tr.insert(at, node)
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1), 1))
      view.dispatch(tr)
      return true
    }

    return {
      Enter: () => {
        const hit = headingAtCaret()
        if (!hit) return false
        // An empty heading becomes a paragraph where it stands.
        if (hit.node.content.size === 0) return toParagraph(hit.depth)
        const { $from } = this.editor.state.selection
        // Splitting mid-heading is left to the default: both halves stay headings.
        if ($from.parentOffset !== $from.parent.content.size) return false
        return paragraphBelow(hit.depth)
      },

      Backspace: () => {
        const hit = headingAtCaret()
        if (!hit) return false
        const { $from } = this.editor.state.selection
        if ($from.parentOffset !== 0) return false
        const parent = $from.node(hit.depth - 1)
        const index = $from.index(hit.depth - 1)
        const above = index > 0 ? parent.child(index - 1) : null
        const wouldTrap = hit.node.content.size === 0 || above === null || above.type.name === 'heading'
        if (!wouldTrap) return false
        return toParagraph(hit.depth)
      }
    }
  }
})

const MathInline = TipTapNode.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { tex: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="math-inline"]',
        getAttrs: (el) => ({ tex: (el as HTMLElement).getAttribute('data-tex') ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    return ['span', { 'data-type': 'math-inline', 'data-tex': node.attrs.tex, class: 'math-node' }]
  },

  addNodeView() {
    return mathNodeView(true)
  },

  addInputRules() {
    // Type $x^2$ and it converts into a rendered equation, like Notion.
    return [
      new InputRule({
        find: /\$([^$\n]+)\$$/,
        handler: ({ state, range, match, chain }) => {
          if (state.selection.$from.parent.type.name === 'codeBlock') return
          if (state.selection.$from.marks().some((m) => m.type.name === 'code')) return
          chain().deleteRange(range).insertContentAt(range.from, { type: this.name, attrs: { tex: match[1] } })
        }
      })
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize: mathSerializeAsInline,
        parse: {
          setup(markdownit: MarkdownItLike): void {
            installMathMarkdownRules(markdownit)
            installLenientHtmlBlocks(markdownit)
          }
        }
      }
    }
  }
})

const MathBlock = TipTapNode.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return { tex: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="math-block"]',
        getAttrs: (el) => ({ tex: (el as HTMLElement).getAttribute('data-tex') ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'math-block', 'data-tex': node.attrs.tex, class: 'math-node' }]
  },

  addNodeView() {
    return mathNodeView(false)
  },

  addInputRules() {
    // Type $$ + space at the start of a line to create a display math block,
    // like Notion's equation shortcut. The composer opens immediately.
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ range, chain }) => {
          pendingMathCompose = true
          chain().deleteRange(range).insertContent({ type: this.name, attrs: { tex: '' } })
        }
      })
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize: mathSerializeAsBlock,
        parse: {
          setup(markdownit: MarkdownItLike): void {
            installMathMarkdownRules(markdownit)
            installLenientHtmlBlocks(markdownit)
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Page links: [[Page Name]] — rendered as an icon+title chip, clickable.
// ---------------------------------------------------------------------------

const PageLink = TipTapNode.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { name: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="yestion-page"]',
        getAttrs: (el) => ({ name: (el as HTMLElement).getAttribute('data-name') ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    return ['span', { 'data-type': 'yestion-page', 'data-name': node.attrs.name, class: 'page-link-chip' }]
  },

  addNodeView() {
    return ({ node, editor }) => {
      const chip = document.createElement('span')
      chip.className = 'page-link-chip'
      chip.contentEditable = 'false'
      let current = node
      const pageOpts = (editor as unknown as { yestion?: MeridiemPageOpts }).yestion
      const render = (): void => {
        const name = String(current.attrs.name ?? '')
        // Until the target resolves, the chip shows the name it was written
        // with and nothing else — no mark, so there is no flash of the wrong
        // one when it turns out the page has an emoji of its own.
        chip.replaceChildren(refName(name))
        chip.classList.add('page-link-pending')
        void (pageOpts?.resolvePage(name) ?? Promise.resolve(null)).then((info) => {
          if (info && chip.isConnected) {
            chip.replaceChildren(refGlyph(info.icon, 'doc', 14), refName(info.title))
            chip.classList.remove('page-link-pending')
          }
        })
      }
      chip.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        void pageOpts?.openPage(String(current.attrs.name ?? ''))
      })
      render()
      return {
        dom: chip,
        update: (updated) => {
          if (updated.type !== current.type) return false
          if (updated.attrs.name !== current.attrs.name) {
            current = updated
            render()
          }
          return true
        }
      }
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.write('[[' + String(node.attrs.name ?? '') + ']]')
        },
        parse: {
          setup(markdownit: MarkdownItLike): void {
            installPageLinkRules(markdownit)
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Page picker (slash → "New page" / "Link to page").
//
// The old version just dumped every page in the workspace into a list, so it
// read as a random column: no hint of what it did, no way to tell two pages
// with the same title apart, and no explicit "create this" row. This one has a
// title, a search field, rows that show where each page lives, and a clear
// create row.
// ---------------------------------------------------------------------------
interface PickerPage {
  title: string
  icon: string
  relPath: string
}

type PickerRow = { kind: 'page'; page: PickerPage } | { kind: 'create'; name: string }

/** The link/create picker is a full-screen overlay that lives only while it is
 *  open. The handle lets the shared dismissal pass close it like any other
 *  floating surface. */
let pagePickerOverlay: HTMLElement | null = null

function openPagePicker(
  editor: Editor,
  getPages: () => Promise<PickerPage[]>,
  createPage: (name: string) => Promise<string>,
  mode: 'link' | 'create' = 'link',
  afterInsert?: () => void
): void {
  const overlay = document.createElement('div')
  overlay.className = 'page-picker'
  pagePickerOverlay = overlay
  const closePicker = (): void => {
    overlay.remove()
    if (pagePickerOverlay === overlay) pagePickerOverlay = null
  }

  const head = document.createElement('div')
  head.className = 'page-picker-head'
  const headIcon = document.createElement('span')
  headIcon.className = 'page-picker-head-icon'
  headIcon.innerHTML = iconSvg(mode === 'create' ? 'doc' : 'link', 15, 1.8)
  const headText = document.createElement('span')
  headText.textContent = mode === 'create' ? 'New page' : 'Link to page'
  head.append(headIcon, headText)

  const input = document.createElement('input')
  input.className = 'page-picker-input'
  input.placeholder = 'Search pages or type a new name…'
  input.spellcheck = false

  const list = document.createElement('div')
  list.className = 'page-picker-list'

  const hint = document.createElement('div')
  hint.className = 'page-picker-hint'
  hint.textContent =
    mode === 'create'
      ? 'Type a name and press Enter to create · or pick a page to link to'
      : '↑↓ move · Enter link · Esc close'

  overlay.append(head, input, list, hint)
  document.body.appendChild(overlay)

  let pages: PickerPage[] = []
  let rows: PickerRow[] = []
  let active = 0
  let navigated = false
  const MAX_ROWS = 40

  // "Math/Practice (AI)/InverseTrig1/index.md" -> "Math / Practice (AI)"
  const parentLabel = (relPath: string): string => {
    const parts = relPath.split('/')
    if (parts[parts.length - 1] === 'index.md') parts.pop()
    parts.pop()
    return parts.join(' / ')
  }

  const buildRows = (): PickerRow[] => {
    const q = input.value.trim()
    const ql = q.toLowerCase()
    const matched = (q
      ? pages.filter((p) => p.title.toLowerCase().includes(ql) || p.relPath.toLowerCase().includes(ql))
      : pages.slice()
    ).sort((a, b) => {
      const aStart = ql && a.title.toLowerCase().startsWith(ql) ? 0 : 1
      const bStart = ql && b.title.toLowerCase().startsWith(ql) ? 0 : 1
      return aStart - bStart || a.title.localeCompare(b.title) || a.relPath.localeCompare(b.relPath)
    })
    const out: PickerRow[] = matched.slice(0, MAX_ROWS).map((page) => ({ kind: 'page' as const, page }))
    const exact = q.length > 0 && pages.some((p) => p.title.trim().toLowerCase() === ql)
    if (q.length > 0 && !exact) out.push({ kind: 'create', name: q })
    return out
  }

  const createAndInsert = (name: string): void => {
    void (async () => {
      const title = await createPage(name || 'Untitled')
      closePicker()
      editor.chain().focus().insertContent({ type: 'pageLink', attrs: { name: title } }).run()
      afterInsert?.()
    })()
  }

  const choose = (index: number): void => {
    const row = rows[index]
    if (!row) return
    if (row.kind === 'create') {
      createAndInsert(row.name)
      return
    }
    closePicker()
    editor.chain().focus().insertContent({ type: 'pageLink', attrs: { name: row.page.title } }).run()
    afterInsert?.()
  }

  const draw = (resetActive = false): void => {
    rows = buildRows()
    if (resetActive || active >= rows.length) {
      navigated = false
      if (mode === 'create') {
        const createIdx = rows.findIndex((r) => r.kind === 'create')
        active = createIdx >= 0 ? createIdx : 0
      } else {
        active = 0
      }
    }
    list.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'page-picker-empty'
      empty.textContent = pages.length === 0 ? 'No pages yet — type a name to create one.' : 'No matching page — keep typing to create one.'
      list.appendChild(empty)
      return
    }
    rows.forEach((row, i) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className =
        'page-picker-item' +
        (i === active ? ' active' : '') +
        (row.kind === 'create' ? ' page-picker-create' : '')
      const icon = document.createElement('span')
      icon.className = 'page-picker-item-icon'
      const title = document.createElement('span')
      title.className = 'page-picker-item-title'
      if (row.kind === 'page') {
        applyIcon(icon, row.page.icon, 'doc', 15)
        title.textContent = row.page.title
        el.append(icon, title)
        const parent = parentLabel(row.page.relPath)
        if (parent) {
          const path = document.createElement('span')
          path.className = 'page-picker-item-path'
          path.textContent = parent
          el.appendChild(path)
        }
      } else {
        icon.innerHTML = iconSvg('plus', 15, 1.8)
        title.textContent = `Create page “${row.name}”`
        el.append(icon, title)
      }
      el.addEventListener('mousemove', () => {
        if (active !== i) {
          active = i
          navigated = true
          draw()
        }
      })
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        choose(i)
      })
      if (i === active) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }))
      list.appendChild(el)
    })
    if (pages.length > MAX_ROWS && input.value.trim() === '') {
      const more = document.createElement('div')
      more.className = 'page-picker-more'
      more.textContent = `Showing ${MAX_ROWS} of ${pages.length} — type to narrow`
      list.appendChild(more)
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (rows.length === 0) return
      active = (active + 1) % rows.length
      navigated = true
      draw()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      active = (active - 1 + rows.length) % rows.length
      navigated = true
      draw()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const name = input.value.trim()
      // "New page" always creates the typed name, unless the user deliberately
      // moved onto one of the listed pages.
      if (mode === 'create' && name && !navigated) {
        createAndInsert(name)
        return
      }
      if (rows.length === 0) {
        if (name) createAndInsert(name)
        return
      }
      choose(active)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
      editor.commands.focus()
    }
  }

  input.addEventListener('keydown', onKey)
  input.addEventListener('input', () => draw(true))
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      closePicker()
      editor.commands.focus()
    }
  })

  void getPages().then((all) => {
    // Same page can show up twice in the tree lookup; keep one row per file.
    const seen = new Set<string>()
    pages = all.filter((p) => {
      if (seen.has(p.relPath)) return false
      seen.add(p.relPath)
      return true
    })
    draw(true)
  })
  requestAnimationFrame(() => input.focus())
}

// ---------------------------------------------------------------------------
// File links: [[file:path]] — a chip that opens any file (PDF, image, …)
// with the system app. Paths are workspace-relative when possible.
// ---------------------------------------------------------------------------

const FileLink = TipTapNode.create({
  name: 'fileLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { path: { default: '' } }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="yestion-file"]',
        getAttrs: (el) => ({ path: (el as HTMLElement).getAttribute('data-path') ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    return ['span', { 'data-type': 'yestion-file', 'data-path': node.attrs.path, class: 'file-link-chip' }]
  },

  addNodeView() {
    return ({ node, editor }) => {
      const chip = document.createElement('span')
      chip.className = 'file-link-chip'
      chip.contentEditable = 'false'
      let current = node
      const pageOpts = (editor as unknown as { yestion?: MeridiemPageOpts }).yestion
      const render = (): void => {
        const p = String(current.attrs.path ?? '')
        const name = p.split('/').pop() ?? p
        chip.replaceChildren(refGlyph(null, 'paperclip', 14), refName(name))
        chip.title = p
      }
      chip.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const p = String(current.attrs.path ?? '')
        const resolved = p.startsWith('/') ? p : ((pageOpts?.getBaseDir() ?? '') + '/' + p).replace(/\/+/g, '/')
        if (pageOpts?.openFileRef) pageOpts.openFileRef(resolved)
        else void window.api.openPath(resolved)
      })
      render()
      return {
        dom: chip,
        update: (updated) => {
          if (updated.type !== current.type) return false
          if (updated.attrs.path !== current.attrs.path) {
            current = updated
            render()
          }
          return true
        }
      }
    }
  },

  addInputRules() {
    // Type [[file:path]] and it converts into an attachment chip.
    return [
      new InputRule({
        find: /\[\[file:([^\]]*)\]\]$/,
        handler: ({ range, match, chain }) => {
          chain().deleteRange(range).insertContent({ type: this.name, attrs: { path: match[1] } })
        }
      })
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode): void {
          state.write('[[' + 'file:' + String(node.attrs.path ?? '') + ']]')
        },
        parse: {
          setup(markdownit: MarkdownItLike): void {
            installPageLinkRules(markdownit)
          }
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Highlight marks: <h>text</h> (yellow) or <h><g>text</h> (green), ⌘H wraps a
// selection, click a highlight to change its color.
// ---------------------------------------------------------------------------

export const HIGHLIGHT_COLORS: Record<string, { bg: string; name: string }> = {
  y: { bg: '#fdf1c8', name: 'Yellow' },
  g: { bg: '#d9f0dc', name: 'Green' },
  b: { bg: '#d6ecfa', name: 'Blue' },
  p: { bg: '#fbe0ec', name: 'Pink' },
  v: { bg: '#efe3f7', name: 'Purple' },
  o: { bg: '#fee5cd', name: 'Orange' },
  r: { bg: '#ffd9d6', name: 'Red' }
}

// ---- color popup ----
let highlightPopupEl: HTMLElement | null = null
let highlightPopupOutside: ((e: MouseEvent) => void) | null = null
let highlightPopupKey: ((e: KeyboardEvent) => void) | null = null

function closeHighlightPopup(): HTMLElement | null {
  const el = highlightPopupEl
  if (el) el.remove()
  highlightPopupEl = null
  if (highlightPopupOutside) document.removeEventListener('mousedown', highlightPopupOutside)
  if (highlightPopupKey) document.removeEventListener('keydown', highlightPopupKey)
  highlightPopupOutside = null
  highlightPopupKey = null
  return el
}

function openHighlightPopup(
  anchor: { left: number; top: number },
  current: string,
  onPick: (color: string) => void,
  onCancel?: () => void,
  anchorEl?: Element | null
): void {
  closeHighlightPopup()
  const pop = document.createElement('div')
  pop.className = 'highlight-popup'
  for (const [key, def] of Object.entries(HIGHLIGHT_COLORS)) {
    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = 'highlight-swatch' + (key === current ? ' active' : '')
    swatch.style.background = def.bg
    swatch.title = def.name
    swatch.textContent = key.toUpperCase()
    swatch.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onPick(key)
      closeHighlightPopup()
    })
    pop.appendChild(swatch)
  }
  pop.style.left = anchor.left + 'px'
  pop.style.top = anchor.top + 'px'
  document.body.appendChild(pop)
  // The click that opened this popup is still in flight: ProseMirror handles
  // it on mouseup, and the shared dismissal pass then sees a capture-phase
  // `click` on the highlight — not on the popup — and closes it instantly.
  // Anchoring the popup to the highlighted text marks that click as "part of
  // the surface", so it survives.
  anchorFloat(pop, anchorEl ?? null)
  highlightPopupEl = pop
  highlightPopupOutside = (e) => {
    if (highlightPopupEl && !highlightPopupEl.contains(e.target as Node)) {
      closeHighlightPopup()
      onCancel?.()
    }
  }
  highlightPopupKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeHighlightPopup()
      onCancel?.()
    }
  }
  window.setTimeout(() => {
    document.addEventListener('mousedown', highlightPopupOutside!)
    document.addEventListener('keydown', highlightPopupKey!)
  }, 0)
}

// ---- markdown rules: <h> / <h><g> … </h> ----
const highlightRulesInstalled = new WeakSet<MarkdownItLike>()

function installHighlightRules(md: MarkdownItLike): void {
  if (highlightRulesInstalled.has(md)) return
  highlightRulesInstalled.add(md)
  md.inline.ruler.before('emphasis', 'yestion_highlight', (state, silent) => {
    const src = state.src
    if (src.startsWith('</h>', state.pos)) {
      if (state.pos > 0 && isEscapedAt(src, state.pos)) return false
      if (!silent) state.push('highlight_close', 'span', -1)
      state.pos += 4
      return true
    }
    if (src.startsWith('<h>', state.pos)) {
      if (state.pos > 0 && isEscapedAt(src, state.pos)) return false
      let pos = state.pos + 3
      let color = 'y'
      const cm = /^<([ygbrpvo])>/.exec(src.slice(pos, pos + 3))
      if (cm) {
        color = cm[1]
        pos += 3
      }
      if (!silent) {
        const t = state.push('highlight_open', 'span', 1)
        t.attrSet('data-color', color)
      }
      state.pos = pos
      return true
    }
    return false
  })
  md.renderer.rules.highlight_open = (tokens, idx) => {
    const color = tokens[idx].attrGet('data-color') ?? 'y'
    return `<span data-type="yestion-highlight" data-color="${escapeAttr(color)}">`
  }
  md.renderer.rules.highlight_close = () => '</span>'
}

// A backslash at the very end of a paragraph is also a line break.
//
// markdown-it only treats `\` + newline as a hard break when a newline follows
// inside the inline content; on the last line the block parser has already eaten
// that newline, so the backslash became a literal character. Worksheet-style
// notes use runs of `\` lines as blank answer space, and the trailing one was
// rendered as a stray backslash (and lost a line) when viewed in rich mode.
const trailingBreakInstalled = new WeakSet<MarkdownItLike>()

function installTrailingHardBreak(md: MarkdownItLike): void {
  if (trailingBreakInstalled.has(md)) return
  trailingBreakInstalled.add(md)
  md.inline.ruler.before('escape', 'yestion_trailing_break', (state, silent) => {
    if (state.pos + 1 !== state.posMax) return false
    if (state.src.charCodeAt(state.pos) !== 0x5c /* \ */) return false
    if (!silent) {
      const token = state.push('hardbreak', 'br', 0)
      token.map = []
    }
    state.pos = state.posMax
    return true
  })
}

const HighlightMark = Mark.create({
  name: 'highlight',

  addAttributes() {
    return {
      color: {
        default: 'y'
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="yestion-highlight"]',
        getAttrs: (el) => ({
          color: (el as HTMLElement).getAttribute('data-color') ?? 'y'
        })
      }
    ]
  },

  renderHTML({ mark }) {
    return [
      'span',
      {
        'data-type': 'yestion-highlight',
        'data-color': mark.attrs.color,
        class: 'highlight-mark highlight-' + mark.attrs.color
      },
      0
    ]
  },

  addInputRules() {
    return [
      // <h> → default yellow, typed text gets the mark.
      new InputRule({
        find: /<h>$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setMark('highlight', { color: 'y' }).run()
        }
      }),
      // Typing < while a highlight mark is active (right after <h>) opens the
      // color picker — pick a color, keep typing highlighted.
      new InputRule({
        find: /<$/,
        handler: ({ state, range, chain }) => {
          const stored = state.storedMarks ?? state.selection.$from.marks()
          const hm = stored?.find((m) => m.type.name === 'highlight')
          if (!hm) return
          chain().deleteRange(range).run()
          const sel = window.getSelection()
          const rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
          const anchor = rect ? { left: rect.left, top: rect.bottom + 6 } : { left: 200, top: 200 }
          const editor = activeEditor()
          openHighlightPopup(
            anchor,
            String(hm.attrs.color ?? 'y'),
            (color) => {
              editor?.chain().focus().setMark('highlight', { color }).run()
            },
            () => {
              editor?.chain().focus().insertContent('<').run()
            }
          )
        }
      }),
      // </h> → stop highlighting.
      new InputRule({
        find: /<\/h>$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).unsetMark('highlight').run()
        }
      })
    ]
  },

  addKeyboardShortcuts() {
    return {
      'Mod-h': () => {
        if (this.editor.isActive('highlight')) {
          this.editor.chain().unsetMark('highlight').run()
          return true
        }
        const { empty } = this.editor.state.selection
        if (empty) return false
        this.editor.chain().setMark('highlight', { color: 'y' }).run()
        return true
      }
    }
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state: MarkdownSerializerState, mark: { attrs?: { color?: string } } | null): string => {
            const color = mark?.attrs?.color ?? 'y'
            return color === 'y' ? '<h>' : `<h><${color}>`
          },
          close: '</h>'
        },
        parse: {
          setup(markdownit: MarkdownItLike): void {
            installHighlightRules(markdownit)
            installTrailingHardBreak(markdownit)
          }
        }
      }
    }
  }
})

// The most recently created editor — used by input rules that open popups.
let currentEditorRef: Editor | null = null
function activeEditor(): Editor | null {
  return currentEditorRef
}

// Click a highlight → popup to change its color.
function handleHighlightClick(view: EditorView, pos: number, event?: MouseEvent): boolean {
  const markType = view.state.schema.marks.highlight
  if (!markType) return false
  const $pos = view.state.doc.resolve(pos)
  const hm = $pos.marks().find((m) => m.type === markType)
  if (!hm) return false
  // Expand to the full run of adjacent same-color highlight text.
  let start = pos
  let end = pos
  const blockStart = $pos.start()
  $pos.parent.forEach((node, offset) => {
    if (node.isText && node.marks.some((m) => m.eq(hm))) {
      const absStart = blockStart + offset
      const absEnd = absStart + node.nodeSize
      start = Math.min(start, absStart)
      end = Math.max(end, absEnd)
    }
  })
  if (end <= start) return false
  const coords = view.coordsAtPos(pos)
  const clicked = (event?.target as Element | null)?.closest?.(
    '[data-type="yestion-highlight"]'
  )
  openHighlightPopup(
    { left: coords.left, top: coords.bottom + 6 },
    hm.attrs.color,
    (color) => {
      const tr = view.state.tr
      tr.addMark(start, end, markType.create({ color }))
      view.dispatch(tr)
    },
    undefined,
    clicked ?? null
  )
  return true
}

// ---------------------------------------------------------------------------
// Tables: a Notion-style size picker (slash → Table) plus a contextual toolbar
// for adding/removing rows and columns, so any size is reachable.
// ---------------------------------------------------------------------------

const TABLE_PICKER_MAX = 8

function closeTablePicker(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>('.table-size-picker')
  el?.remove()
  document.removeEventListener('mousedown', closeTablePickerOnOutside, true)
  return el
}
function closeTablePickerOnOutside(e: MouseEvent): void {
  const el = document.querySelector('.table-size-picker')
  if (el && !el.contains(e.target as Node)) closeTablePicker()
}

function openTableSizePicker(editor: Editor, anchor: { left: number; top: number }): void {
  closeTablePicker()
  const pop = document.createElement('div')
  pop.className = 'table-size-picker'
  const grid = document.createElement('div')
  grid.className = 'table-size-grid'
  const label = document.createElement('div')
  label.className = 'table-size-label'
  label.textContent = 'Drag to choose a size'
  let rows = 3
  let cols = 3
  const cells: HTMLElement[] = []
  const paint = (): void => {
    cells.forEach((cell, i) => {
      const r = Math.floor(i / TABLE_PICKER_MAX) + 1
      const c = (i % TABLE_PICKER_MAX) + 1
      cell.classList.toggle('on', r <= rows && c <= cols)
    })
    label.textContent = `${rows} × ${cols}${rows === 1 ? ' (header + rows)' : ''}`
  }
  for (let r = 0; r < TABLE_PICKER_MAX; r++) {
    for (let c = 0; c < TABLE_PICKER_MAX; c++) {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'table-size-cell'
      cell.addEventListener('mouseenter', () => {
        rows = r + 1
        cols = c + 1
        paint()
      })
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const rr = r + 1
        const cc = c + 1
        closeTablePicker()
        editor.chain().focus().insertTable({ rows: rr, cols: cc, withHeaderRow: true }).run()
      })
      cells.push(cell)
      grid.appendChild(cell)
    }
  }
  pop.append(grid, label)
  pop.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - 220)) + 'px'
  pop.style.top = anchor.top + 'px'
  document.body.appendChild(pop)
  paint()
  window.setTimeout(() => document.addEventListener('mousedown', closeTablePickerOnOutside, true), 0)
}

// ---- contextual toolbar: visible whenever the caret is inside a table ----
let tableToolbar: HTMLElement | null = null
let tableStyleSelect: HTMLSelectElement | null = null
let tableBoldAxisSelect: HTMLSelectElement | null = null

function tableToolbarEl(): HTMLElement {
  if (tableToolbar) return tableToolbar
  const bar = document.createElement('div')
  bar.className = 'table-toolbar'
  bar.hidden = true
  const btn = (label: string, title: string, run: (editor: Editor) => void, svg?: IconName): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'table-tool-btn'
    if (svg) b.replaceChildren(iconEl(svg, 13))
    else b.textContent = label
    b.title = title
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const editor = currentEditorRef
      if (editor) run(editor)
    })
    bar.appendChild(b)
  }
  btn('↥', 'Add row above', (e) => void e.chain().focus().addRowBefore().run())
  btn('↧', 'Add row below', (e) => void e.chain().focus().addRowAfter().run())
  btn('⇤', 'Add column left', (e) => void e.chain().focus().addColumnBefore().run())
  btn('⇥', 'Add column right', (e) => void e.chain().focus().addColumnAfter().run())
  const sep = document.createElement('span')
  sep.className = 'table-tool-sep'
  bar.appendChild(sep)
  btn('– row', 'Delete row', (e) => void e.chain().focus().deleteRow().run())
  btn('– col', 'Delete column', (e) => void e.chain().focus().deleteColumn().run())
  btn('', 'Delete table', (e) => void e.chain().focus().deleteTable().run(), 'trash')

  const styleSep = document.createElement('span')
  styleSep.className = 'table-tool-sep'
  bar.appendChild(styleSep)

  const select = (
    title: string,
    options: [string, string][],
    apply: (editor: Editor, value: string) => void
  ): HTMLSelectElement => {
    const el = document.createElement('select')
    el.className = 'table-tool-select'
    el.title = title
    for (const [value, label] of options) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      el.appendChild(opt)
    }
    el.addEventListener('change', () => {
      const editor = currentEditorRef
      if (editor) apply(editor, el.value)
    })
    bar.appendChild(el)
    return el
  }

  tableStyleSelect = select(
    'Table style',
    [
      ['standard', 'Standard'],
      ['borderless', 'Borderless'],
      ['latex', 'LaTeX']
    ],
    (editor, value) =>
      void editor.chain().focus().updateAttributes('table', { tableStyle: value }).run()
  )
  tableBoldAxisSelect = select(
    'Bold axis',
    [
      ['row', 'Bold top row'],
      ['column', 'Bold left column']
    ],
    (editor, value) =>
      void editor.chain().focus().updateAttributes('table', { boldAxis: value }).run()
  )

  document.body.appendChild(bar)
  tableToolbar = bar
  return bar
}

function updateTableToolbar(editor: Editor): void {
  const bar = tableToolbarEl()
  if (!editor.isActive('table')) {
    bar.hidden = true
    return
  }
  // Position above the table the caret sits in.
  const sel = window.getSelection()
  const node = sel?.anchorNode
  const el = node instanceof HTMLElement ? node : node?.parentElement
  const table = el?.closest('table')
  if (!table) {
    bar.hidden = true
    return
  }
  const rect = table.getBoundingClientRect()
  bar.hidden = false
  const attrs = editor.getAttributes('table') as { tableStyle?: string; boldAxis?: string }
  if (tableStyleSelect) tableStyleSelect.value = String(attrs.tableStyle ?? 'standard')
  if (tableBoldAxisSelect) tableBoldAxisSelect.value = attrs.boldAxis === 'column' ? 'column' : 'row'
  const width = bar.offsetWidth || 260
  bar.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)) + 'px'
  bar.style.top = Math.max(6, rect.top - bar.offsetHeight - 6) + 'px'
}

// ---- image alignment toolbar: shown while an image node is selected ---------
function selectedImage(editor: Editor): { pos: number; node: PMNode } | null {
  const sel = editor.state.selection
  if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
    return { pos: sel.from, node: sel.node }
  }
  return null
}

function setImageAttrs(editor: Editor, patch: Record<string, unknown>): void {
  const found = selectedImage(editor)
  if (!found) return
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, ...patch })
  )
}

let imageToolbar: HTMLElement | null = null

function imageToolbarEl(): HTMLElement {
  if (imageToolbar) return imageToolbar
  const bar = document.createElement('div')
  bar.className = 'table-toolbar image-toolbar'
  bar.hidden = true
  const btn = (label: string, title: string, run: (editor: Editor) => void): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'table-tool-btn'
    b.textContent = label
    b.title = title
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const editor = currentEditorRef
      if (editor) run(editor)
    })
    bar.appendChild(b)
  }
  btn('Left', 'Align image to the left (on its own line)', (e) => setImageAttrs(e, { align: 'left' }))
  btn('Center', 'Center the image on its own line', (e) => setImageAttrs(e, { align: 'center' }))
  btn('Right', 'Align image to the right (on its own line)', (e) => setImageAttrs(e, { align: 'right' }))
  const sep = document.createElement('span')
  sep.className = 'table-tool-sep'
  bar.appendChild(sep)
  btn('Reset', 'Reset size and alignment', (e) => setImageAttrs(e, { align: null, width: null }))
  document.body.appendChild(bar)
  imageToolbar = bar
  return bar
}

// ---- columns: helpers + contextual toolbar ----------------------------------
function findColumnList(editor: Editor): { node: PMNode; pos: number } | null {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'columnList') return { node, pos: $from.before(d) }
  }
  return null
}

/**
 * Snap a drop coordinate to a position that can actually hold an inline image.
 *
 * Images are inline nodes, but a drop can land between blocks — above all in
 * the gap between two columns or just past the last one, where the position
 * sits directly inside the `columnList`. Inserting inline content there makes
 * ProseMirror wrap it in a fresh block, which inside a columnList means a
 * brand-new column. So walk to the nearest textblock instead, confined to the
 * column the drop landed in (pasting never hit this because it inserts at the
 * caret, which is always inside a textblock).
 */
function snapImageDropPos(doc: PMNode, pos: number): number | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size))
  const $pos = doc.resolve(clamped)
  if ($pos.parent.isTextblock) return clamped

  // The column we are in — an ancestor, or, when the point sits directly in
  // the column list, the nearest sibling column.
  let column: PMNode | null = null
  let contentStart = -1
  if ($pos.parent.type.name === 'columnList') {
    const off = $pos.parentOffset
    const base = $pos.start()
    let bestDist = Infinity
    $pos.parent.forEach((child, childOff) => {
      if (child.type.name !== 'column') return
      const start = childOff
      const end = childOff + child.nodeSize
      const dist = off < start ? start - off : off > end ? off - end : 0
      if (dist < bestDist) {
        bestDist = dist
        column = child
        contentStart = base + childOff + 1
      }
    })
  } else {
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === 'column') {
        column = $pos.node(d)
        contentStart = $pos.start(d)
        break
      }
    }
  }

  if (column) {
    let best: number | null = null
    let bestDist = Infinity
    column.descendants((node, offset) => {
      if (!node.isTextblock) return true
      const inside = contentStart + offset + 1
      const dist = Math.abs(inside - clamped)
      if (dist < bestDist) {
        bestDist = dist
        best = inside
      }
      return false
    })
    if (best != null) return best
    return contentStart
  }

  // Outside any column: fall back to the nearest text position anywhere.
  const near = TextSelection.near($pos, 1)
  return near ? near.from : null
}

function insertColumns(editor: Editor, count: number): void {
  const n = Math.min(MAX_COLUMNS, Math.max(COLUMN_MIN, count))
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'columnList',
      content: Array.from({ length: n }, () => ({ type: 'column', content: [{ type: 'paragraph' }] }))
    })
    .run()
}

function addColumn(editor: Editor): void {
  const found = findColumnList(editor)
  if (!found || found.node.childCount >= MAX_COLUMNS) return
  const col = editor.schema.nodes.column.createAndFill()
  if (!col) return
  editor.view.dispatch(editor.state.tr.insert(found.pos + found.node.nodeSize - 1, col))
}

/** Remove the last column, folding its blocks into the previous one. */
function removeColumn(editor: Editor): void {
  const found = findColumnList(editor)
  if (!found || found.node.childCount <= COLUMN_MIN) return
  const { node, pos } = found
  const n = node.childCount
  const last = node.child(n - 1)
  let offset = 0
  for (let i = 0; i < n - 1; i++) offset += node.child(i).nodeSize
  const lastStart = pos + 1 + offset
  const tr = editor.state.tr
  // Append the last column's blocks to the end of the previous column, then
  // delete the (now empty) last column — nothing is lost.
  tr.insert(lastStart - 1, last.content)
  const shifted = lastStart + last.content.size
  tr.delete(shifted, shifted + last.nodeSize)
  editor.view.dispatch(tr)
}

/** Turn the columns back into ordinary stacked blocks (all content kept). */
function dissolveColumns(editor: Editor): void {
  const found = findColumnList(editor)
  if (!found) return
  const { node, pos } = found
  const blocks: PMNode[] = []
  node.forEach((col) => col.forEach((b) => blocks.push(b)))
  editor.view.dispatch(
    editor.state.tr.replaceWith(pos, pos + node.nodeSize, PMFragment.fromArray(blocks))
  )
}

let columnToolbar: HTMLElement | null = null

function columnToolbarEl(): HTMLElement {
  if (columnToolbar) return columnToolbar
  const bar = document.createElement('div')
  bar.className = 'table-toolbar column-toolbar'
  bar.hidden = true
  const btn = (label: string, title: string, run: (editor: Editor) => void): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'table-tool-btn'
    b.textContent = label
    b.title = title
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const editor = currentEditorRef
      if (editor) run(editor)
    })
    bar.appendChild(b)
  }
  btn('+ Column', 'Add a column (up to 3)', (e) => addColumn(e))
  btn('− Column', 'Remove the last column, keeping its content', (e) => removeColumn(e))
  const sep = document.createElement('span')
  sep.className = 'table-tool-sep'
  bar.appendChild(sep)
  btn('Unstack', 'Turn the columns back into stacked blocks', (e) => dissolveColumns(e))
  document.body.appendChild(bar)
  columnToolbar = bar
  return bar
}

function positionToolbar(bar: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const width = bar.offsetWidth || 200
  bar.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)) + 'px'
  bar.style.top = Math.max(6, rect.top - bar.offsetHeight - 6) + 'px'
}

/** Show exactly one contextual toolbar for the current selection, if any. */
function updateContextToolbars(editor: Editor): void {
  const tb = tableToolbarEl()
  const cb = columnToolbarEl()
  const ib = imageToolbarEl()
  tb.hidden = true
  cb.hidden = true
  ib.hidden = true

  const img = selectedImage(editor)
  if (img) {
    const dom = editor.view.nodeDOM(img.pos)
    if (dom instanceof HTMLElement) {
      ib.hidden = false
      positionToolbar(ib, dom)
    }
    return
  }
  if (editor.isActive('table')) {
    updateTableToolbar(editor)
    return
  }
  const cols = findColumnList(editor)
  if (cols) {
    const dom = editor.view.nodeDOM(cols.pos)
    if (dom instanceof HTMLElement) {
      cb.hidden = false
      positionToolbar(cb, dom)
    }
  }
}

function hideContextToolbars(): HTMLElement[] {
  const closed: HTMLElement[] = []
  for (const el of [tableToolbarEl(), columnToolbarEl(), imageToolbarEl()]) {
    if (!el.hidden) closed.push(el)
    el.hidden = true
  }
  return closed
}

// ---------------------------------------------------------------------------
// Slash command menu ("/" like Notion)
// ---------------------------------------------------------------------------

interface SlashCommand {
  /** Short text glyph ('H1', '{ }', '—'). Most commands are their own label. */
  icon: string
  /** Drawn instead of `icon` where a text glyph wouldn't say anything. */
  svg?: IconName
  title: string
  keywords: string
  run: (editor: Editor) => void
}

// Set by createRichEditor so slash commands can reach the page list.
let pageGetter: () => Promise<{ title: string; icon: string; relPath: string }[]> = async () => []
let afterNewPageLink: (() => void) | null = null
let pageCreator: (name: string) => Promise<string> = async (n) => n

const SLASH_COMMANDS: SlashCommand[] = [
  { icon: 'H1', title: 'Heading 1', keywords: 'h1 heading title', run: (e) => void e.chain().setHeading({ level: 1 }).run() },
  { icon: 'H2', title: 'Heading 2', keywords: 'h2 heading', run: (e) => void e.chain().setHeading({ level: 2 }).run() },
  { icon: 'H3', title: 'Heading 3', keywords: 'h3 heading', run: (e) => void e.chain().setHeading({ level: 3 }).run() },
  { icon: '•', title: 'Bullet list', keywords: 'bullet list ul unordered', run: (e) => void e.chain().toggleBulletList().run() },
  { icon: '1.', title: 'Numbered list', keywords: 'numbered list ol ordered', run: (e) => void e.chain().toggleOrderedList().run() },
  { icon: '☐', title: 'To-do list', keywords: 'todo task checkbox', run: (e) => void e.chain().toggleTaskList().run() },
  { icon: '❝', title: 'Quote', keywords: 'quote blockquote', run: (e) => void e.chain().toggleBlockquote().run() },
  { icon: '{ }', title: 'Code block', keywords: 'code fence codeblock', run: (e) => void e.chain().toggleCodeBlock().run() },
  {
    icon: '∑',
    title: 'Math inline',
    keywords: 'math latex equation inline',
    run: (e) => {
      pendingMathCompose = true
      void e.chain().insertContent({ type: 'mathInline', attrs: { tex: '' } }).run()
    }
  },
  {
    icon: '∑',
    title: 'Math block',
    keywords: 'math latex equation block display',
    run: (e) => {
      pendingMathCompose = true
      void e.chain().insertContent({ type: 'mathBlock', attrs: { tex: '' } }).run()
    }
  },
  {
    icon: '',
    svg: 'doc',
    title: 'New page…',
    keywords: 'page new create subpage',
    run: (e) => openPagePicker(e, pageGetter, pageCreator, 'create', afterNewPageLink ?? undefined)
  },
  {
    icon: '',
    svg: 'paperclip',
    title: 'File link',
    keywords: 'file pdf attach link',
    run: (e) => {
      void (async () => {
        const picked = await window.api.filePick()
        if (!picked) return
        e.chain().focus().insertContent({ type: 'fileLink', attrs: { path: picked.path } }).run()
      })()
    }
  },
  {
    icon: '',
    svg: 'link',
    title: 'Link to page…',
    keywords: 'page link mention wiki connect',
    run: (e) => openPagePicker(e, pageGetter, pageCreator, 'link', afterNewPageLink ?? undefined)
  },
  { icon: '—', title: 'Horizontal rule', keywords: 'hr divider rule line', run: (e) => void e.chain().setHorizontalRule().run() },
  {
    icon: '⤓',
    title: 'Page break',
    keywords: 'page break newpage pagination export pdf',
    run: (e) => void e.chain().focus().insertContent({ type: 'pageBreak' }).run()
  },
  {
    icon: '▥',
    title: '2 columns',
    keywords: 'columns two layout side by side split grid',
    run: (e) => insertColumns(e, 2)
  },
  {
    icon: '▤',
    title: '3 columns',
    keywords: 'columns three layout side by side split grid',
    run: (e) => insertColumns(e, 3)
  },
  {
    icon: '▦',
    title: 'Table',
    keywords: 'table grid rows columns',
    run: (e) => {
      const pos = e.view.coordsAtPos(e.state.selection.from)
      openTableSizePicker(e, { left: pos.left, top: pos.bottom + 6 })
    }
  }
]

interface SlashTrigger {
  start: number // doc position of the "/"
  end: number // doc position of the cursor
  query: string
}

function detectSlashTrigger(editor: Editor): SlashTrigger | null {
  const { $from } = editor.state.selection
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.name === 'codeBlock') return null
  const text = parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  // A line may begin with preserved blank answer lines \u2014 hard breaks, which
  // textBetween surfaces as \ufffc. Those used to stop the slash trigger from
  // matching, so "/" did nothing on the line after a list or a blank gap.
  const m = /^((?:\s|\ufffc)*)\/([a-zA-Z0-9-]*)$/.exec(text)
  if (!m) return null
  const slashOffset = m[1].length // index of "/" within the block text
  return {
    start: $from.pos - (text.length - slashOffset),
    end: $from.pos,
    query: m[2].toLowerCase()
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface MeridiemPageOpts { afterNewPageLink?: () => void
  openFileRef?: (absolutePath: string) => void
  getBaseDir: () => string | null
  resolvePage: (name: string) => Promise<{ title: string; icon: string } | null>
  openPage: (name: string) => Promise<void> | void
  getPages: () => Promise<{ title: string; icon: string; relPath: string }[]>
  createPage: (name: string) => Promise<string>
}

export interface RichEditor {
  view: Editor['view']
  getMarkdown: () => string
  setContent: (markdown: string) => void
  focus: () => void
  /** Read-only mirrors (the split pane) turn off editing but keep rendering. */
  setEditable: (editable: boolean) => void
}

/**
 * Plain text and the selected slice, for the word count. The selection is ''
 * when the caret is collapsed, so callers can tell "nothing selected" from
 * "an empty selection".
 */
export interface EditorCounts {
  text: string
  selected: string
}

/** The subscription carries the editor's ProseMirror view, which is the one
 *  identity both the TipTap instance and its public `RichEditor` share. */
type CountHandler = (view: Editor['view'], counts: EditorCounts) => void
const countHandlers = new Set<CountHandler>()

/**
 * Subscribe to text/selection changes in any rich editor.
 *
 * The count is a read of editor state, so it belongs here rather than being
 * reconstructed in main from DOM events: `selectionchange` fires for the title
 * input and the sidebar too, and the markdown below the editor is not the text
 * being written.
 */
export function onEditorCountChange(handler: CountHandler): () => void {
  countHandlers.add(handler)
  return () => countHandlers.delete(handler)
}

export function readCounts(editor: Pick<RichEditor, 'view'>): EditorCounts {
  const { doc, selection } = editor.view.state
  // Leaf nodes (images, math) have no text; passing '' keeps a picture from
  // contributing a stray separator to the count.
  const text = doc.textBetween(0, doc.content.size, '\n', '')
  const selected =
    selection.from === selection.to ? '' : doc.textBetween(selection.from, selection.to, '\n', '')
  return { text, selected }
}

function notifyCounts(editor: Editor): void {
  if (countHandlers.size === 0) return
  const counts = readCounts(editor)
  for (const handler of countHandlers) handler(editor.view, counts)
}

/** Slash menus, one per live editor (the main pane and the split pane). */
const slashMenus = new Set<{ el: HTMLElement; hide: () => void }>()

/**
 * Close everything the editors can leave floating: slash menus, the page
 * picker, the highlight swatch bar, the table size picker, an equation editor
 * and the contextual table/image toolbars. Returns the elements it closed.
 */
export function dismissEditorFloats(): HTMLElement[] {
  const closed: HTMLElement[] = []
  for (const menu of [...slashMenus]) {
    if (!menu.el.isConnected) {
      slashMenus.delete(menu)
      continue
    }
    if (menu.el.hidden) continue
    menu.hide()
    closed.push(menu.el)
  }
  if (pagePickerOverlay) {
    closed.push(pagePickerOverlay)
    pagePickerOverlay.remove()
    pagePickerOverlay = null
  }
  const swatches = closeHighlightPopup()
  if (swatches) closed.push(swatches)
  const picker = closeTablePicker()
  if (picker) closed.push(picker)
  if (mathPopup) {
    const popup = mathPopup
    closeMathPopup(true)
    closed.push(popup)
  }
  closed.push(...hideContextToolbars())
  return closed
}

export function createRichEditor(
  element: HTMLElement,
  initialMarkdown: string,
  onChange: () => void,
  opts: MeridiemPageOpts
): RichEditor {
  const getBaseDir = opts.getBaseDir
  const resolvePage = opts.resolvePage
  const openPage = opts.openPage
  pageGetter = opts.getPages
  pageCreator = opts.createPage
  afterNewPageLink = opts.afterNewPageLink ?? null
  const getPages = opts.getPages
  // --- slash menu DOM ---
  const menuEl = document.createElement('div')
  menuEl.className = 'slash-menu'
  menuEl.hidden = true
  document.body.appendChild(menuEl)

  let trigger: SlashTrigger | null = null
  let filtered: SlashCommand[] = []
  let activeIndex = 0

  function hideMenu(): void {
    trigger = null
    menuEl.hidden = true
    menuEl.innerHTML = ''
  }

  // Every live editor's slash menu, so the shared dismissal pass can close the
  // one that's open without each editor keeping its own document listener.
  slashMenus.add({ el: menuEl, hide: hideMenu })

  function commitSlash(cmd: SlashCommand | null): void {
    const t = trigger
    hideMenu()
    if (!t) return
    editor.chain().focus().deleteRange({ from: t.start, to: t.end }).run()
    if (cmd) cmd.run(editor)
  }

  function updateSlashMenu(): void {
    const det = detectSlashTrigger(editor)
    if (!det) {
      hideMenu()
      return
    }
    trigger = det
    filtered = SLASH_COMMANDS.filter((c) => {
      if (!det.query) return true
      const hay = (c.title + ' ' + c.keywords).toLowerCase()
      // Allow queries without spaces ("mathb" still finds "Math block").
      return hay.includes(det.query) || hay.replace(/ /g, '').includes(det.query)
    })
    if (activeIndex >= filtered.length) activeIndex = 0
    menuEl.innerHTML = ''
    filtered.forEach((cmd, i) => {
      const item = document.createElement('div')
      item.className = 'slash-item' + (i === activeIndex ? ' active' : '')
      const icon = document.createElement('span')
      icon.className = 'slash-item-icon'
      if (cmd.svg) icon.innerHTML = iconSvg(cmd.svg, 16, 1.7)
      else icon.textContent = cmd.icon
      const title = document.createElement('span')
      title.className = 'slash-item-title'
      title.textContent = cmd.title
      item.append(icon, title)
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        commitSlash(cmd)
      })
      menuEl.appendChild(item)
    })
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'slash-item slash-empty'
      empty.textContent = 'No results'
      menuEl.appendChild(empty)
    }
    menuEl.hidden = false

    const coords = editor.view.coordsAtPos(Math.min(det.end, editor.state.doc.content.size))
    menuEl.style.left = coords.left + 'px'
    menuEl.style.top = coords.bottom + 6 + 'px'
    // Keep the menu inside the window.
    const rect = menuEl.getBoundingClientRect()
    if (rect.right > window.innerWidth - 8) menuEl.style.left = window.innerWidth - rect.width - 8 + 'px'
    if (rect.bottom > window.innerHeight - 8) menuEl.style.top = coords.top - rect.height - 6 + 'px'
  }

  // --- editor ---
  const editor = new Editor({
    element,
    content: initialMarkdown,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { openOnClick: false, autolink: true },
        // Replaced below with versions whose markdown serializers preserve
        // line structure. (tiptap extension storage is a fresh getter copy,
        // so monkey-patching storage.markdown at runtime never stuck.)
        paragraph: false,
        hardBreak: false
      }),
      // Empty paragraph → a `\` line: pressing Enter twice for spacing must
      // survive the save (the serializer otherwise drops empty paragraphs and
      // the gap vanished on reload). Re-parses to a break-only paragraph.
      Paragraph.extend({
        addStorage() {
          return {
            markdown: {
              serialize(state: MarkdownSerializerState, node: PMNode): void {
                if (node.content.size === 0) {
                  state.write('\\')
                  state.closeBlock(node)
                  return
                }
                state.renderInline(node)
                state.closeBlock(node)
              }
            }
          }
        }
      }),
      // tiptap-markdown's default hard-break serializer only emits a break
      // when a different node type follows, so trailing breaks (Shift+Enter at
      // a paragraph's end, break-only answer lines) were dropped on save.
      HardBreak.extend({
        addStorage() {
          return {
            markdown: {
              serialize(state: MarkdownSerializerState, _node: PMNode, parent: PMNode, index: number): void {
                // A trailing break needs only the backslash: the enclosing
                // block already writes the newline; emitting one here added a
                // blank line on every round trip.
                state.write(index === parent.childCount - 1 ? '\\' : '\\\n')
              }
            }
          }
        }
      }),
      PageBreak,
      RichTaskList,
      RichTaskItem.configure({ nested: true }),
      // Keep relative image paths as-written in the markdown while displaying
      // them resolved against the working file's directory. Re-resolve when the
      // file (and so its directory) changes.
      Image.extend({
        // Paths must survive a save/load round trip untouched. A screenshot
        // called "desmos-graph (59).png" was being rewritten to
        // "desmos-graph%20\(59).png" — a file that does not exist — so the
        // image vanished from the page after the next reload. Undo the
        // markdown/URL escaping here and re-escape only when writing.
        addAttributes() {
          const parent = this.parent?.() ?? {}
          return {
            ...parent,
            src: {
              default: null,
              parseHTML: (el: HTMLElement) => normalizeImagePath(el.getAttribute('src') ?? ''),
              renderHTML: (attrs: { src?: string }) => (attrs.src ? { src: attrs.src } : {})
            },
            // Rendered width in px, set by the corner drag handle. `null` means
            // the image keeps its natural size. Markdown has no image-size
            // syntax, so a resized image is written back as raw inline HTML
            // (`<img … width="320">`) — see the serializer — and parsed from
            // that same `width` attribute here.
            width: {
              default: null,
              parseHTML: (el: HTMLElement) => {
                const raw = el.getAttribute('width')
                if (!raw) return null
                const px = Math.round(parseFloat(raw))
                return Number.isFinite(px) && px > 0 ? px : null
              },
              renderHTML: (attrs: { width?: number | null }) =>
                attrs.width ? { width: String(attrs.width) } : {}
            },
            // Horizontal placement: `null` (inline where it sits), or `left` /
            // `center` / `right` to push the image to that edge on its own line
            // (no text wrapping). A resized/aligned image is written as raw
            // inline HTML — see the serializer — and read back from `data-align`
            // (or a matching `style`, so hand-written HTML also works).
            align: {
              default: null,
              parseHTML: (el: HTMLElement) => {
                const a = el.getAttribute('data-align')
                if (a === 'left' || a === 'center' || a === 'right') return a
                const style = (el.getAttribute('style') ?? '').toLowerCase()
                const mlAuto = /margin-left\s*:\s*auto/.test(style)
                const mrAuto = /margin-right\s*:\s*auto/.test(style)
                if (mlAuto && mrAuto) return 'center'
                if (mlAuto) return 'right'
                if (mrAuto) return 'left'
                if (/float\s*:\s*left/.test(style)) return 'left'
                if (/float\s*:\s*right/.test(style)) return 'right'
                return null
              },
              renderHTML: (attrs: { align?: string | null }) =>
                attrs.align === 'left' || attrs.align === 'center' || attrs.align === 'right'
                  ? { 'data-align': attrs.align, style: imageAlignStyle(attrs.align) }
                  : {}
            }
          }
        },
        addNodeView() {
          return ({ node, getPos, view }) => {
            // The <img> sits inside an inline-block wrapper so the resize handle
            // can be pinned to its corner without disturbing the surrounding
            // text (images are inline nodes here).
            const wrap = document.createElement('span')
            wrap.className = 'rich-image-wrap'
            const img = document.createElement('img')
            img.className = 'rich-image'
            const handle = document.createElement('span')
            handle.className = 'rich-image-handle'
            handle.setAttribute('contenteditable', 'false')
            handle.title = 'Drag to resize'
            wrap.append(img, handle)

            let current = node
            const render = (attrs: {
              src?: string
              alt?: string
              title?: string | null
              width?: number | null
              align?: string | null
            }): void => {
              const raw = attrs.src ?? ''
              img.classList.remove('img-missing')
              img.alt = attrs.alt ?? ''
              img.title = attrs.title ?? ''
              // If the file is genuinely missing, fall back to the alt text.
              img.onerror = () => {
                img.classList.add('img-missing')
                img.removeAttribute('src') // browser displays alt text
              }
              img.src = resolveImageSrc(raw, getBaseDir())
              if (attrs.width) img.style.width = attrs.width + 'px'
              else img.style.removeProperty('width')
              wrap.classList.remove('align-left', 'align-center', 'align-right')
              const align = attrs.align
              if (align === 'left' || align === 'center' || align === 'right') {
                wrap.classList.add('align-' + align)
              }
            }
            render(node.attrs)
            const onDirChange = (): void => render(current.attrs)
            window.addEventListener('md-base-dir-changed', onDirChange)

            // ---- drag to resize ------------------------------------------
            // Live-resize the <img> during the drag; commit the final pixel
            // width onto the node on pointerup, which the autosave then writes
            // out as <img width="…">.
            let startX = 0
            let startW = 0
            let dragging = false
            const onMove = (e: PointerEvent): void => {
              if (!dragging) return
              const host = wrap.closest('.ProseMirror') as HTMLElement | null
              const maxW = host ? host.clientWidth : 4000
              const w = Math.max(40, Math.min(startW + (e.clientX - startX), maxW))
              img.style.width = Math.round(w) + 'px'
            }
            const onUp = (e: PointerEvent): void => {
              if (!dragging) return
              dragging = false
              wrap.classList.remove('resizing')
              try {
                handle.releasePointerCapture(e.pointerId)
              } catch {
                /* capture already lost */
              }
              document.removeEventListener('pointermove', onMove)
              document.removeEventListener('pointerup', onUp)
              const pos = typeof getPos === 'function' ? getPos() : null
              if (pos == null) return
              const width = Math.round(img.getBoundingClientRect().width)
              view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width }))
            }
            handle.addEventListener('pointerdown', (e) => {
              e.preventDefault()
              e.stopPropagation()
              dragging = true
              startX = e.clientX
              startW = img.getBoundingClientRect().width
              wrap.classList.add('resizing')
              try {
                handle.setPointerCapture(e.pointerId)
              } catch {
                /* capture unavailable */
              }
              document.addEventListener('pointermove', onMove)
              document.addEventListener('pointerup', onUp)
            })

            return {
              dom: wrap,
              update: (updated) => {
                if (updated.type !== node.type) return false
                current = updated
                render(updated.attrs)
                return true
              },
              destroy: () => {
                document.removeEventListener('pointermove', onMove)
                document.removeEventListener('pointerup', onUp)
                window.removeEventListener('md-base-dir-changed', onDirChange)
              }
            }
          }
        },
      // tiptap v3 defaults `image` to a BLOCK node. Markdown images are inline:
      // as blocks, `hello ![](a.jpg) world` split into three blocks and a
      // trailing image serialized without a block break, so the next block was
      // glued onto it (`![](a.jpg)- item`).
      //
      // Also: attributes parsed out of markdown can arrive as numbers —
      // `![2](img.jpg)` produced `alt: 2`, and the stock serializer fed that to
      // `state.esc()`, throwing "str.replace is not a function" and failing the
      // whole save. Coerce everything to a string here.
      addStorage() {
        return {
          markdown: {
            serialize(state: MarkdownSerializerState, node: PMNode): void {
              const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
              const alt = asText(node.attrs.alt)
              const src = normalizeImagePath(asText(node.attrs.src))
              const title = asText(node.attrs.title)
              const width = Number(node.attrs.width)
              const align = node.attrs.align
              const hasAlign = align === 'left' || align === 'center' || align === 'right'
              // A resized or aligned image is written as raw inline HTML, since
              // markdown has no image-size/placement syntax. `<img>` is treated
              // as inline HTML on the way back in (see INLINE_HTML_TAG_RE), so it
              // stays inline and round-trips through plain markdown files.
              if ((Number.isFinite(width) && width > 0) || hasAlign) {
                const esc = (s: string): string =>
                  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                let html = `<img src="${esc(src)}"`
                if (alt) html += ` alt="${esc(alt)}"`
                if (title) html += ` title="${esc(title)}"`
                if (Number.isFinite(width) && width > 0) html += ` width="${Math.round(width)}"`
                if (hasAlign) html += ` data-align="${align}" style="${imageAlignStyle(align)}"`
                html += '>'
                state.write(html)
                return
              }
              // A destination with spaces (screenshot filenames!) must be wrapped
              // in angle brackets, otherwise markdown ends the URL at the first
              // space and the image turns into literal text on the next load.
              const dest = /\s/.test(src) ? `<${src}>` : src.replace(/[()]/g, '\\$&')
              state.write(
                `![${state.esc(alt)}](${dest}${title ? ' "' + title.replace(/"/g, '\\"') + '"' : ''})`
              )
            }
          }
        }
      }
      }).configure({ inline: true }),
      TableKit.configure({ table: false }),
      RichTable.configure({ resizable: true }),
      TableStyleDecoration,
      Column,
      ColumnList,
      HeadingBehaviour,
      RawHtmlBlock,
      MathInline,
      MathBlock,
      PageLink,
      FileLink,
      HighlightMark,
      Placeholder.configure({
        placeholder: "Type '/' for commands, or '# ' for a heading"
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: true,
        // breaks: a single newline in the source is a real line break (what
        // users expect), not a CommonMark "soft break" that renders as a
        // space and merged lines on every save.
        breaks: true,
        transformPastedText: true,
        transformCopiedText: false
      })
    ],
    editorProps: {
      attributes: { spellcheck: 'false' },
      handleClick: (view, pos, event) => {
        return handleHighlightClick(view, pos, event)
      },
      handleDOMEvents: {
        click: (_view, event) => {
          const anchor = (event.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null
          if (!anchor) return false
          const href = anchor.getAttribute('href') ?? ''
          if (!href) return false
          if (/^(https?:|mailto:)/i.test(href)) {
            event.preventDefault()
            window.open(href)
            return true
          }
          if (href.startsWith('#') || href.startsWith('data:')) return false
          // Local file link → open in the built-in viewer (PDF pane / text editor).
          event.preventDefault()
          const base = getBaseDir() ?? ''
          const resolved = href.startsWith('/') ? href : (base + '/' + decodeURI(href)).replace(/\/+/g, '/')
          opts.openFileRef?.(resolved)
          return true
        }
      },
      // Paste markdown text (e.g. a whole .md file or from VS Code) and render
      // it instead of dumping raw text — the core "paste works" fix.
      handlePaste: (view, event) => {
        const dt = event.clipboardData
        if (!dt) return false
        // Inside a code block, pasted text stays literal source.
        if (view.state.selection.$from.parent.type.name === 'codeBlock') return false
        const text = dt.getData('text/plain')
        if (!text) return false
        if (dt.types.includes('text/html')) {
          // Copying a markdown CODEBLOCK out of an AI chat (or an editor with
          // syntax-highlight copy) carries the raw source as text/plain AND a
          // styled wrapper as text/html. The user is dropping in markdown —
          // parse the source; don't let ProseMirror swallow raw markdown text.
          const html = dt.getData('text/html')
          const codeWrapper = /<pre[\s>]/i.test(html) || /<code[\s>]/i.test(html)
          if (!codeWrapper) {
            // No code wrapper: only override the HTML when the text really is
            // markdown AND the HTML brings no formatting of its own.
            if (hasRichFormatting(html) || !looksLikeMarkdown(text)) {
              // The HTML wins here, but any $…$ inside it must still render —
              // otherwise the equations arrive as literal text.
              if (!text.includes('$') && !html.includes('$')) return false
              const wrap = document.createElement('div')
              wrap.innerHTML = html
              if (!convertDollarMathInDom(wrap)) return false
              event.preventDefault()
              const slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(wrap, {
                preserveWhitespace: true,
                context: view.state.selection.$from
              })
              view.dispatch(view.state.tr.replaceSelection(slice))
              return true
            }
          }
        }
        event.preventDefault()
        const html = getClipboardMd().render(repairTables(relaxCjkEmphasis(text)))
        const wrap = document.createElement('div')
        wrap.innerHTML = html // runs our math/svg/page-link rules
        const slice = PMDOMParser.fromSchema(view.state.schema).parseSlice(wrap, {
          preserveWhitespace: true,
          context: view.state.selection.$from
        })
        view.dispatch(view.state.tr.replaceSelection(slice))
        return true
      },
      handleKeyDown: (view, event) => {
        // Backspacing (or forward-deleting) into an equation first "derenders"
        // it back to its raw $…$ / $$…$$ source instead of removing it.
        if (menuEl.hidden && (event.key === 'Backspace' || event.key === 'Delete')) {
          if (derenderAdjacentMath(view, event.key === 'Backspace' ? 'before' : 'after')) {
            event.preventDefault()
            return true
          }
        }
        if (menuEl.hidden) return false
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          activeIndex = (activeIndex + 1) % filtered.length
          updateSlashMenu()
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          activeIndex = (activeIndex - 1 + filtered.length) % filtered.length
          updateSlashMenu()
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          commitSlash(filtered[activeIndex] ?? null)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          hideMenu()
          return true
        }
        return false
      }
    },
    onFocus: () => {
      // Two editors can be mounted at once (split view): the focused one is the
      // one popups, the table toolbar and input rules should act on.
      currentEditorRef = editor
      notifyCounts(editor)
    },
    onUpdate: () => {
      onChange()
      updateSlashMenu()
      updateContextToolbars(editor)
      notifyCounts(editor)
    },
    onSelectionUpdate: () => {
      updateSlashMenu()
      updateContextToolbars(editor)
      notifyCounts(editor)
    },
    onBlur: () => {
      // Clicking a control inside a contextual toolbar (the table style or
      // bold-axis <select>) blurs the editor. Hiding the toolbar there closed
      // the very dropdown being opened, so let focus settle and check where it
      // went before hiding anything.
      window.setTimeout(() => {
        const active = document.activeElement
        if (active?.closest('.table-toolbar, .image-toolbar, .column-toolbar')) return
        hideMenu()
        hideContextToolbars()
      }, 0)
    }
  })

  // Links with spaces in the URL (`[x](My File.pdf)`) have the same problem as
  // images: wrap the href in angle brackets so it survives a reload.
  const linkExt = editor.extensionManager.extensions.find((ext) => ext.name === 'link') as
    | { storage?: { markdown?: { serialize?: { close?: (...args: unknown[]) => unknown } } } }
    | undefined
  const linkSpec = linkExt?.storage?.markdown?.serialize
  if (linkSpec && typeof linkSpec.close === 'function') {
    const originalClose = linkSpec.close
    linkSpec.close = function (this: unknown, ...args: unknown[]): unknown {
      const [state, mark] = args as [MarkdownSerializerState, { attrs?: Record<string, unknown> }]
      const href = typeof mark?.attrs?.href === 'string' ? mark.attrs.href : ''
      if (!href || !/\s/.test(href) || /^<.*>$/.test(href)) {
        return originalClose.apply(this, args)
      }
      const shadow = { attrs: { ...mark.attrs, href: `<${href}>` } }
      return originalClose.apply(this, [state, shadow, ...args.slice(2)])
    }
  }

  // The first editor created is the default tool target; focus moves it from
  // then on (set in onFocus above). Assigning unconditionally here meant that
  // merely creating the split-pane editor pointed the table/image toolbars at
  // the hidden pane.
  if (!currentEditorRef) currentEditorRef = editor

  // ---- drag & drop / paste images straight into the page ----------------
  // The file is written next to the page (as a plain file, or into the vault for
  // private workspaces) and referenced by its relative name, so pages keep
  // working outside the app.
  async function insertImageFiles(files: File[], pos?: number): Promise<void> {
    const baseDir = getBaseDir()
    if (!baseDir) return
    // In private (encrypted) workspaces assets are copied in so they're covered
    // by the vault; elsewhere the original file is referenced by absolute path,
    // which is what the user sees in the markdown.
    const inVault = !!(await window.api.wsGet()).private
    let at = pos
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      const realPath = inVault ? '' : window.api.getPathForFile(file)
      const alt = file.name.replace(/\.[^.]+$/, '')
      if (realPath) {
        const node = { type: 'image', attrs: { src: realPath, alt, title: null } }
        if (typeof at === 'number') {
          editor.chain().focus().insertContentAt(at, node).run()
          at += 1
        } else {
          editor.chain().focus().insertContent(node).run()
        }
        continue
      }
      const data = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : '')
        }
        reader.onerror = () => resolve('')
        reader.readAsDataURL(file)
      })
      if (!data) continue
      const saved = await window.api.importImage({
        dir: baseDir,
        name: file.name || 'pasted-image.png',
        mimeType: file.type,
        data
      })
      if (!saved) continue
      const node = { type: 'image', attrs: { src: saved.name, alt, title: null } }
      if (typeof at === 'number') {
        editor.chain().focus().insertContentAt(at, node).run()
        at += 1
      } else {
        editor.chain().focus().insertContent(node).run()
      }
    }
  }

  const dom = editor.view.dom as HTMLElement
  dom.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer
    if (!dt) return
    if (Array.from(dt.items ?? []).some((i) => i.kind === 'file')) {
      e.preventDefault()
      dt.dropEffect = 'copy'
    }
  })
  dom.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    // Insert where the pointer is, and stop the browser/Electron from
    // navigating to the dropped file.
    e.preventDefault()
    e.stopPropagation()
    const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
    const at = coords ? snapImageDropPos(editor.state.doc, coords.pos) : null
    void insertImageFiles(files, at ?? undefined)
  })
  dom.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (items.length === 0) return
    e.preventDefault()
    void insertImageFiles(items)
  })

;(editor as unknown as { yestion: MeridiemPageOpts }).yestion = {
    getBaseDir,
    resolvePage,
    openPage,
    getPages,
    createPage: opts.createPage,
    afterNewPageLink: opts.afterNewPageLink,
    openFileRef: opts.openFileRef
  }

  return {
    view: editor.view,
    setEditable: (editable: boolean) => editor.setEditable(editable),
    getMarkdown: () => {
      const store = editor.storage as unknown as { markdown: { getMarkdown: () => string } }
      // The CJK emphasis repair is an in-memory aid (see emphasis.ts); strip
      // the markers so the file keeps exactly the text the user typed.
      const md = stripCjkMarkers(store.markdown.getMarkdown())
      // A hard break at the very end of the document would sit at EOF with no
      // newline; markdown then reads the backslash as a literal character and
      // the break grows on every save/load round trip. Terminate it.
      return md.endsWith('\\') ? md + '\n' : md
    },
    setContent: (markdown: string) => {
      hideMenu()
      editor.commands.setContent(repairTables(relaxCjkEmphasis(markdown)), { emitUpdate: false })
    },
    focus: () => editor.commands.focus()
  }
}

/**
 * Undo every escaping layer an image path can arrive with, then re-encode it in
 * one canonical form.
 *
 * A file literally called `desmos-graph (59).png` shows up in markdown as
 * `desmos-graph%20(59).png`, `desmos-graph\ (59).png` or inside `<...>`, and a
 * table cell can HTML-escape the angle brackets on top of that. Decoding and
 * re-encoding once means the path is identical after every save, and because the
 * canonical form contains no space or parenthesis the writer never has to escape
 * it (which is what kept corrupting the filename).
 */
function decodeImagePath(src: string): string {
  let out = src
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, '&')
  out = out.replace(/\\([()<>\[\]{}#!*_`~\\ ])/g, '$1')
  try {
    out = decodeURIComponent(out)
  } catch {
    // A literal `%` (e.g. "100%-done.png") is not valid percent-encoding.
  }
  return out
}

/** Canonical form: safe to write into a markdown destination unquoted. */
function encodeImagePath(path: string): string {
  return path
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
}

function normalizeImagePath(src: string): string {
  if (!src) return src
  // Remote/data/file URLs are already canonical; leave them untouched.
  if (/^(https?:|data:|blob:|mailto:|file:)/i.test(src)) return src
  return encodeImagePath(decodeImagePath(src))
}

/**
 * CSS that places an aligned image at the given edge on its own line. Written
 * verbatim into the markdown as an inline `style` so the file still renders the
 * way the app shows it when opened in a browser or another markdown tool.
 */
function imageAlignStyle(align: 'left' | 'center' | 'right'): string {
  if (align === 'left') return 'display:block;margin-right:auto'
  if (align === 'right') return 'display:block;margin-left:auto'
  return 'display:block;margin-left:auto;margin-right:auto'
}

/**
 * Turn `$…$` / `$$…$$` inside pasted HTML into the elements our math nodes
 * parse from.
 *
 * Clipboard HTML that carries any formatting (a chat reply with bold text, a
 * bulleted list, a web page) is pasted as HTML — so the dollars used to arrive
 * as literal text and the equation only appeared after deleting and retyping a
 * `$`. Returns true when something was converted.
 */
function convertDollarMathInDom(root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.nodeValue ?? ''
    if (!text.includes('$')) continue
    // Code samples keep their dollars.
    if (node.parentElement?.closest('code, pre')) continue
    targets.push(node)
  }
  let changed = false
  for (const node of targets) {
    const text = node.nodeValue ?? ''
    const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
    let match: RegExpExecArray | null
    let last = 0
    let nodeChanged = false
    const frag = document.createDocumentFragment()
    while ((match = re.exec(text))) {
      if (match.index > 0 && text[match.index - 1] === '\\') continue
      const display = match[1] !== undefined
      const tex = (display ? match[1] : match[2]).trim()
      if (!tex) continue
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)))
      const el = document.createElement(display ? 'div' : 'span')
      el.setAttribute('data-type', display ? 'math-block' : 'math-inline')
      el.setAttribute('data-tex', tex)
      frag.appendChild(el)
      last = match.index + match[0].length
      nodeChanged = true
    }
    if (!nodeChanged) continue
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode?.replaceChild(frag, node)
    changed = true
  }
  return changed
}

/** file:// URL for a local path, tolerating spaces and existing %-escapes. */
export function localFileUrl(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    /* not percent-encoded — use as-is */
  }
  return 'file://' + decoded.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

export function resolveImageSrc(src: string, baseDir: string | null): string {
  if (!src) return src
  if (/^(https?:|data:|file:|blob:|mailto:)/i.test(src)) return src
  // Absolute paths (how dropped/pasted image files are referenced) resolve on
  // their own, wherever the page happens to live.
  if (src.startsWith('/')) return localFileUrl(src)
  if (!baseDir) return src
  if (src.startsWith('//')) return src
  try {
    return localFileUrl(baseDir + '/' + src)
  } catch {
    return src
  }
}
