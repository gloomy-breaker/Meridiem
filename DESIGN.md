# Meridiem — visual language and UX principles

Meridiem is a calm, local-first academic workspace and active-recall studio for
macOS. It is a personal fork of [Yestion](https://github.com/antoniology/yestion)
and keeps Yestion's files-first foundation: Markdown pages, `.qz` exam papers, a
KaTeX editor, and an in-process agent. This document describes the visual and
interaction direction for the fork. **Meridiem** is the only branch where the
app is branded Meridiem; upstream and `feat/*` work stays Yestion.

The reference is **Octarine**: warm, quiet, batteries-included, and opinionated
about writing rather than about chrome. The goal is not decoration. It is a
surface that disappears while you read and write, and becomes keyboard-fast when
you need to navigate.

## The brief

A school year is long, and the app is open all day next to a browser. It should
feel like paper and a good desk, not a dashboard:

- **Writing first.** The page is the product. Chrome recedes until called.
- **Warm, not sterile.** Paper is warm off-white; dark mode is soft charcoal,
  never pure black. Hairlines are quiet, not high-contrast rails.
- **One system.** One spacing scale, one type scale, one accent, one border
  treatment. Fewer materials, used consistently.
- **Keyboard-first.** Navigation and commands should never require the mouse.
  `Cmd+K` is the front door to the app; `[[` is the front door to a page.
- **Calm AI.** Help is available where the writing happens, but never edits
  silently and never takes over the page.

## Aesthetic and palette

The material rule is **warm paper, quiet glass, one hairline**. A surface is
either:

- **Paper** — the document and reading surface. Opaque, full-bleed, no shadow,
  no rounded card.
- **Chrome** — sidebar, tabs, toolbars, popovers, command palette. A slightly
  lifted surface with a 1px hairline, generous padding, and a soft edge. No
  heavy blur or stacked shadows; translucency is a hint, not a material.

Avoid harsh `#000` / `#fff` contrast. Ink is a warm near-black; paper is a warm
near-white. In dark mode, charcoal panels separate by luminance and a hairline,
not by pure-black holes.

### Core tokens

Light:

```
--paper          #faf7f1   the page
--surface        #f3eee4   chrome / sidebar
--surface-2      #ece4d6   hover, selected row, field fill
--ink            #2d2823   primary text
--ink-2          #6b6257   secondary text
--ink-3          #9a9084   metadata, placeholder
--hairline       rgba(45, 40, 35, 0.10)
--accent         #a86a4a   terracotta: one accent, used sparingly
--accent-soft    rgba(168, 106, 74, 0.12)
--success        #5f7f67   muted sage
--warning        #a4793f   muted ochre
--danger         #a4574f   muted clay
```

Dark:

```
--paper          #1b1a18
--surface        #23211e
--surface-2      #2b2824
--ink            #ece5d9
--ink-2          #b3a99b
--ink-3          #857b6f
--hairline       rgba(236, 229, 217, 0.12)
--accent         #c58a62
--accent-soft    rgba(197, 138, 98, 0.16)
--success        #89a58d
--warning        #c39a62
--danger         #c47b72
```

Rules:

- **Hairlines are 1px and low contrast.** Use them to separate chrome from
  paper, rows in a list, and the edge of a popover. Do not outline every card.
- **One accent.** Terracotta marks focus, active navigation, links, and the
  primary action. Semantic colours are muted and only used for state.
- **Whitespace is the main hierarchy tool.** Prefer 24/32/48px gaps over
  dividers, boxes, and uppercase labels.
- **Radii are small and functional.** 6–10px for fields and popovers; the page
  and sidebar are square-edged. No pill-shaped chrome.
- **No decorative gradients in the UI.** Gradients belong to the app icon, not
  to buttons, headings, or panels.
- **Shadows only for floating surfaces.** A popover may use one soft shadow;
  the page and sidebar never do.

## Typography and editor experience

- **Chrome:** the platform system UI face (SF Pro on macOS), sentence case.
- **Reading:** a comfortable serif is available for academic reading, with
  **Computer Modern** bundled for maths-heavy pages and PDF export. The default
  remains the system face; the reading face is a choice, not a costume.
- **Maths:** KaTeX everywhere. `$inline$` and `$$display$$` render in the editor,
  in preview, and in exported PDFs. Do not degrade formulas to images.
- **Code:** a mono face only for code and the Markdown source view.

Type scale:

| Role | Size | Weight | Where |
| --- | --- | --- | --- |
| large title | 32 | 650 | page title, welcome |
| title | 24 | 620 | h1 in a document |
| heading | 18 | 600 | h2 |
| body | 15 | 400 | prose, leading 1.65 |
| ui | 13 | 450 | sidebar, buttons, tabs |
| label | 12 | 500 | toolbar, breadcrumb, metadata |
| micro | 11 | 550 | counts, shortcuts |

Rules:

- Sentence case for every label. No uppercase eyebrows or tracked-out all-caps.
- Tighten tracking slightly as type grows; leave body at 0.
- The editor is **distraction-free WYSIWYG** (TipTap). Markdown syntax such as
  `**bold**` becomes formatting as you type; source mode is available when you
  want the bytes.
- **Slash commands** (`/`) are the primary insert surface: heading, list,
  table, maths, image, page break, columns, quiz. The menu should be fast,
  keyboard-navigable, and dismissible with Escape.
- **Focus Mode** dims everything except the current sentence or paragraph.
  It is a reading/writing aid, not a separate document mode; `Cmd+K` and
  navigation still work while it is on.
- **No animation on keyboard-initiated actions.** Tab switching, focus mode,
  command palette opening, and slash-menu navigation must feel instant.
  Transitions are reserved for pointer gestures and surface entrances.

## Navigation and organization

- **`Cmd+K` Command Palette** is the primary navigation surface: pages, commands,
  workspaces, themes, and recently opened files. It opens focused, filters as you
  type, and closes on Escape. It must never require a mouse.
- **Sidebar:** clean, collapsible sections (Open Editors, Workspace tree,
  Outline). One row height scale (24/28/32). Selected rows use a hairline and a
  soft fill, not a saturated block.
- **Folders first, links second.** A workspace is a folder tree of Markdown
  pages, exactly as on disk. `[[Page Title]]` links create a second graph over
  the same files.
- **Automatic Backlinks:** the page shows what links to it, derived from the
  workspace. No hand-maintained index and no hidden database. Backlinks are a
  quiet list, not a social feed.
- **YAML frontmatter views:** properties already present in the Markdown
  (`status`, `subject`, `due`, tags) can drive live Table and Kanban views.
  The file remains the source of truth; a view is a lens, not a second store.
- **Quick Capture:** one shortcut opens a small capture field that writes a
  Markdown page without leaving the current context. It should feel like a
  scratchpad, not a modal workflow.

These are Meridiem's direction. Backlinks, property views, and Quick Capture are
planned; the current app already ships folders, tabs, `[[links]]`, search, and
the page outline.

## AI philosophy

AI is **optional, pluggable, and non-intrusive**.

- **Default:** the in-process `pi` agent in an optional sidebar. It can read,
  write, and search the workspace, and the user can close it entirely.
- **Pluggable harness:** Meridiem should support an ACP / OpenCode harness
  without changing the file model. `pi` remains the default; the harness is a
  choice, not a requirement.
- **Inline selection rewrite:** select a passage, describe the change, and
  review a **diff preview** before accepting. The original text is undoable.
  This is Octarine's writing-assistant model, applied to academic prose.
- **No silent edits.** The agent may propose and write when asked, but the UI
  must show what changed and keep an undo path.
- **Local by default.** Notes stay in the chosen folder. Provider keys stay in
  the macOS Keychain. A local model is a first-class option; a cloud provider
  receives only the prompt and context the user sends.

## Motion

- Durations: 140ms for press/focus feedback, 240ms for popovers, 380ms for
  larger surface changes.
- Easing: `cubic-bezier(.16, 1, .3, 1)`, asymmetric exits.
- Honour `prefers-reduced-motion`.
- **Nothing animates on a keyboard-initiated action.** Keyboard speed is part of
  the design, not an optimisation.

## Technical foundations that must not regress

The visual direction must never compromise the file model or the editor's
round-trip guarantees.

### Electron architecture

```
src/main      Electron main process: workspace filesystem, watcher, agent,
              printing, settings, vault
src/preload   contextBridge API; src/preload/index.d.ts is the renderer contract
src/renderer  UI, TipTap editor, quiz runner, agent panel
```

- `contextIsolation` is on. Renderer code calls `window.api.*` only, never
  `ipcRenderer` directly.
- A new capability needs three pieces: an `ipcMain.handle` in
  `src/main/index.ts`, a forwarder in `src/preload/index.ts`, and its signature
  in `src/preload/index.d.ts`.
- Main → renderer pushes use `webContents.send` plus an `on…` subscriber that
  returns an unsubscribe function.
- Filesystem, dialogs, PDF printing, agent execution, and settings stay in main.
  Rendering, editing, and the save queue stay in the renderer.

### Save path

Saves are debounced and queued in `src/renderer/src/main.ts`
(`enqueueSave` → `drainSaveQueue` → `window.api.wsSave`). An unedited page writes
back the **original loaded Markdown bytes**, so viewing a page never reformats
it. Rich edits use `richEditor.getMarkdown()`; source edits come from CodeMirror.
Main writes through `serializePageFile(title, icon, body)`:

```
---
title: <yaml-escaped title>
icon: <yaml-escaped icon, only if set>
---

<body>
```

`parsePageFile` is the only front-matter parser: CRLF tolerant, tolerant of an
empty block, and it heals legacy double-escaped values.

### TipTap Markdown round-trips

Custom syntax has a parse path and a serialize path. Open an unedited page and
save it: the bytes must be unchanged. Every supported construct must survive a
save → close → reload cycle.

- **Highlights:** `<h>text</h>` is yellow; `<h><g>…</h>`, `<h><b>…</h>`,
  `<h><p>…</h>`, `<h><v>…</h>`, `<h><o>…</h>`, `<h><r>…</h>` are coloured.
  `<h>` must stay an inline tag in the lenient HTML-block rule, or its inner
  Markdown comes back as raw text.
- **Maths:** `$inline$` and `$$display$$`; multiline display math uses
  `$$\n…\n$$`. `\(…\)`, `\[…\]`, and bare LaTeX environments are accepted on
  read. Empty maths serializes as `$\; $` / `$$\;$$` so it does not collapse.
  TeX whitespace is user-authored; do not normalise it.
- **Line structure:** `breaks: true` makes every newline a real break. An empty
  paragraph serializes as a lone `\`, a hard break as `\`, and a trailing break
  in a paragraph emits only `\` (no extra blank line). A document ending in a
  break gets a terminating newline on save. CJK emphasis repair inserts a
  zero-width space in memory and strips it before writing.
- **Tables:** default pipe tables; `repairTables` runs on read only and tolerates
  a trailing `\` after the final pipe and short separator rows. Simple tables
  stay pipes. Styled tables (`borderless`, `latex`/booktabs) and complex cells
  serialize as complete HTML `<table>` with `data-table-style` /
  `data-bold-axis`; never downgrade them to pipes or drop the wrapper.
- **Raw HTML / inline SVG:** diagrams and embeds are atomic `rawHtml` nodes
  whose exact outerHTML is written back verbatim. Do not sanitise, pretty-print,
  re-escape, or reorder them. Cosmetic `<div align>` wrappers around plain
  images are the one narrow exception and become normal image nodes.
- **Images:** relative paths are canonicalised (`%20`, `%28`, `%29`) so
  filenames with spaces or brackets round-trip. Resized/aligned images are raw
  inline `<img width=… data-align=…>`; markdown has no native size syntax.
- **Other HTML-backed blocks:** `<div data-type="page-break">`, columns
  (`<div data-ycols>` / `<div data-ycol>`), and raw HTML blocks each need both
  parse and serialize sides preserved.

### `.qz` exam engine

A `.qz` file is a full exam, quiz, or flashcard deck: YAML front matter, then
descriptor tags and blocks. `src/renderer/src/qz.ts` is pure TypeScript and
`src/renderer/src/quiz-pane.ts` owns the runner.

- Descriptors: `<type = exam|quiz|flashcard>`, `<page = cont|sep>`,
  `<timing = …|individual>`, `<passage = true|false>`.
- Blocks: `<text>`, `<scoring>`, `<passage:id>`, `<q:type …>`; question types
  are `mcq`, `tf`, `blank`, `short`, `long`, `num`, `match`, `order`, `card`,
  `free`.
- Body conventions: `- [x]` options, `{{answer|alternative}}` blanks,
  `left :: right` pairs, numbered ordering items, `<answer>`, `<unit>`,
  `<tolerance>`.
- Unknown types degrade to `free`; malformed descriptors become parse errors;
  every tag is stripped before a Markdown renderer sees a prompt.
- The runner never opens the paper in the page editor and never saves it back
  through `wsSave`. In-flight attempts live under `.yestion/attempts/` (the
  folder name is retained for compatibility) and the `.qz` file is read-only.

### Compatibility identifiers

The rebrand is intentionally **cosmetic where data compatibility is at stake**.
Do not rename these without a migration:

- `.yestion/` workspace markers, vault folders, and `.yestion/attempts/` files.
- `data-type="yestion-*"` DOM markers and other internal parse/serialize tokens.
- Existing `.md` and `.qz` files; the file format is unchanged.
- The `YESTION_*` environment variables used by tests and development tools
  remain accepted as legacy aliases.

New user-facing names, app identity, logs, and build metadata use **Meridiem**.

## Implementation status

| Direction | Status |
| --- | --- |
| Warm paper / charcoal palette, hairlines | Target visual language |
| TipTap WYSIWYG, source mode, KaTeX, PDF | Working |
| Slash commands, Computer Modern | Working |
| `Cmd+K` command palette, Focus Mode | Planned — Milestone 1 |
| Backlinks, YAML Table/Kanban views | Planned |
| Inline AI rewrite with diff preview | Planned |
| Pluggable ACP / OpenCode harness | Planned |
| Quick Capture, iPhone QR exam capture | Planned |

The current CSS still carries some Yestion-era tokens and component names. New
work should move toward the palette and spacing above; do not do a wholesale
visual rewrite in an unrelated change.
