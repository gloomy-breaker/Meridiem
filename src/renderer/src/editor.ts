import { EditorView } from '@codemirror/view'
import { EditorState, Compartment, Transaction, Annotation } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'

const markdownHighlighting = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: 'var(--md-heading)', fontWeight: 'bold' },
  { tag: t.strong, color: 'var(--md-strong)', fontWeight: 'bold' },
  { tag: t.emphasis, color: 'var(--md-em)', fontStyle: 'italic' },
  { tag: t.strikethrough, color: 'var(--md-meta)' },
  { tag: t.link, color: 'var(--md-link)' },
  { tag: t.url, color: 'var(--md-url)' },
  { tag: t.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--md-code)' },
  { tag: t.list, color: 'var(--md-list)' },
  { tag: t.meta, color: 'var(--md-meta)' },
  { tag: t.keyword, color: 'var(--md-keyword)' },
  { tag: t.contentSeparator, color: 'var(--md-meta)' }
])

function themeExtension(kind: 'light' | 'dark'): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--panel-bg)',
        color: 'var(--text)',
        fontSize: '14px',
        height: '100%'
      },
      '.cm-scroller': {
        fontFamily:
          "'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'Liberation Mono', monospace",
        lineHeight: '1.6'
      },
      '.cm-content': {
        padding: '16px 0',
        caretColor: 'var(--cursor)'
      },
      '.cm-line': {
        padding: '0 16px'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--panel-bg)',
        color: 'var(--muted)',
        border: 'none',
        opacity: 0.7
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--active-line)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--active-line)'
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--selection)'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--cursor)'
      },
      '.cm-matchingBracket': {
        backgroundColor: 'var(--selection)',
        outline: '1px solid var(--border)'
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--panel-bg)',
        border: '1px solid var(--border)',
        color: 'var(--text)'
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--selection)'
      },
      '.cm-searchMatch, .cm-searchMatch .cm-selectionBackground': {
        backgroundColor: 'var(--selection)'
      }
    },
    { dark: kind === 'dark' }
  )
}

/** Marks a write the app made on the user's behalf (rich⇄source sync). The
 *  selection it leaves behind is not a selection the user made, so the count
 *  listener must not report it. */
const externalWrite = Annotation.define<boolean>()

export interface MarkdownEditor {
  view: EditorView
  getContent: () => string
  setContent: (text: string) => void
  setTheme: (kind: 'light' | 'dark') => void
  scrollToLine: (line0: number) => void
  /** Whole editor state, so a tab's caret and undo history survive a switch. */
  getState: () => EditorState
  setState: (state: EditorState) => void
}

export function createEditor(
  parent: HTMLElement,
  initialContent: string,
  kind: 'light' | 'dark',
  onChange: (text: string) => void,
  /**
   * Text and selected slice after any change, for the word count. Separate from
   * `onChange` because the selection moves without the document changing, and a
   * count that only refreshed on typing would go stale the moment you selected a
   * paragraph.
   */
  onState?: (text: string, selected: string) => void
): MarkdownEditor {
  const themeCompartment = new Compartment()

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialContent,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        syntaxHighlighting(markdownHighlighting),
        themeCompartment.of(themeExtension(kind)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString())
          }
          const external = update.transactions.some((tr) => tr.annotation(externalWrite) === true)
          if (onState && !external && (update.docChanged || update.selectionSet)) {
            const state = update.state
            const { from, to } = state.selection.main
            onState(state.doc.toString(), from === to ? '' : state.sliceDoc(from, to))
          }
        })
      ]
    })
  })

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text: string) => {
      const current = view.state.doc.toString()
      if (current === text) return
      // Replace only what actually differs. A full-document replace resets the
      // caret to the end, kills the selection and pollutes the undo history —
      // which made every rich⇄source sync feel like the text jumped.
      let start = 0
      const maxStart = Math.min(current.length, text.length)
      while (start < maxStart && current.charCodeAt(start) === text.charCodeAt(start)) start++
      let endCur = current.length
      let endNew = text.length
      while (endCur > start && endNew > start && current.charCodeAt(endCur - 1) === text.charCodeAt(endNew - 1)) {
        endCur--
        endNew--
      }
      view.dispatch({
        changes: { from: start, to: endCur, insert: text.slice(start, endNew) },
        // Programmatic write: not an undoable user edit, and not a count update.
        annotations: [Transaction.addToHistory.of(false), externalWrite.of(true)]
      })
    },
    setTheme: (nextKind: 'light' | 'dark') => {
      view.dispatch({
        effects: themeCompartment.reconfigure(themeExtension(nextKind))
      })
    },
    scrollToLine: (line0: number) => {
      const doc = view.state.doc
      const lineNum = Math.max(1, Math.min(line0 + 1, doc.lines))
      const pos = doc.line(lineNum).from
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center', yMargin: 40 })
      })
      view.focus()
    },
    getState: () => view.state,
    setState: (state: EditorState) => view.setState(state)
  }
}
