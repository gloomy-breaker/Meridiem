# Meridiem

**A local-first, calm academic workspace and active-recall studio for macOS.**
Your notes are plain Markdown files in a folder you choose — with a KaTeX-grade
editor, a timed exam runner, and an in-process AI agent that works on the same
files you do.

[![Platform](https://img.shields.io/badge/platform-macOS%2012%2B-black?logo=apple)](https://github.com/gloomy-breaker/Meridiem)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Upstream: Yestion](https://img.shields.io/badge/upstream-Yestion-6f42c1)](https://github.com/antoniology/yestion)
[![Status: personal fork](https://img.shields.io/badge/status-personal%20fork-orange)](#status)

Meridiem is my personal fork of [Yestion](https://github.com/antoniology/yestion).
It keeps Yestion's files-first foundation and points it at a calmer, more
focused product: command-first navigation, automatic backlinks, inline AI
rewrites, and property views over the same Markdown workspace. It is a working
project, not a finished commercial app.

---

## Attribution and origin

Meridiem stands on two shoulders, and it is important to say so plainly.

### Yestion — the upstream foundation

[Yestion](https://github.com/antoniology/yestion) is the MIT-licensed project
this fork is built from. Most of the code in this repository is Yestion's work,
including:

- the **TipTap + KaTeX academic editor**, with Computer Modern typesetting,
  Markdown source mode, and PDF export;
- the **`.qz` timed exam runner**, covering exams, quizzes, flashcards,
  automatic and model-based marking, passages, and resumable attempts;
- the **in-process `pi` agent architecture**, with bring-your-own-key providers,
  Keychain storage, workspace file access, and resumable conversations.

Meridiem would not exist without it. If you want the original upstream project,
use **Yestion**, not this fork.

### Octarine — the design north star

[Octarine](https://octarine.app) is the inspiration for Meridiem's direction: a
calm, batteries-included local-first workspace where backlinks, inline writing
assistance, YAML properties, table/Kanban views, and Quick Capture feel like one
coherent surface rather than a pile of plugins. Meridiem borrows the philosophy,
not the code.

Meridiem is not affiliated with or endorsed by Yestion or Octarine. Yestion's
MIT `LICENSE` is kept intact in this repository so the upstream attribution
stays compliant.

---

## How Meridiem compares

Meridiem today runs on Yestion's engine; the Meridiem-specific additions are
being built on the `meridiem` branch. The table separates what each app
currently ships from what this fork is aiming for.

| | **Meridiem** | **Yestion** | **Octarine** | **Obsidian** | **Notion** |
| --- | --- | --- | --- | --- | --- |
| **Storage & ownership** | Plain `.md` / `.qz` files in a folder you choose; local-first; optional encrypted workspace | Same files-first model (Meridiem's upstream) | Plain Markdown workspace; local index and cache; offline core | Local Markdown vault; app config and cache live outside the vault | Cloud workspace; export is needed to get files out |
| **Account / cost** | Free, MIT; no account | Free, MIT; no account | Free core; Pro is $79 one-time for 3 devices; AI usage is separate | Free for personal use; paid Sync/Publish; paid commercial licence | Account required; free tier plus paid plans; AI add-on |
| **Editor & math / PDFs** | TipTap rich editor + CodeMirror source; KaTeX; bundled Computer Modern; PDF export | TipTap + KaTeX; Computer Modern; PDF export | Visual Markdown editor; opt-in LaTeX math; Mermaid, tables, code blocks | Live-preview/source Markdown; MathJax; PDF export; large plugin ecosystem | Block editor; KaTeX equations; PDF/print export; databases |
| **Exams & active recall (`.qz`)** | Native `.qz` timed exam/quiz/flashcard runner with automatic + AI marking and saved attempts | Native `.qz` runner (inherited by Meridiem) | No native timed-exam format or runner | No native runner; spaced repetition via community plugins | No native runner; templates and databases only |
| **AI architecture** | In-process `pi` agent with BYOK and file access today; pluggable ACP/OpenCode harness and inline rewrite planned | In-process `pi` agent, BYOK (OpenAI-compatible, Anthropic, Google, Ollama), Keychain | Optional BYOK / CLI / local AI; inline Writing Assistant and Ask Octarine on Pro | No built-in agent; community AI plugins with your own keys | Notion AI subscription, cloud-only; no BYOK local-file agent |
| **Organization** | Folders, `[[links]]`, search and outline today; automatic backlinks and YAML table/Kanban views planned | Folders, `[[links]]`, search and outline; no backlink pane or frontmatter views | Folders, tags, links/backlinks, graph, YAML properties, table/Kanban views, Quick Capture | Folders, wikilinks/backlinks, graph, YAML properties, Bases/Dataview views | Pages/databases, relations, rollups, backlinks; not a folder of files |

If you want a team wiki with live collaboration and permissions, use Notion. If
you want a quiet folder of files you can still read in ten years with any text
editor, Meridiem is pointed at that.

---

## Made for students

The app assumes the things a real school year involves:

- **One workspace per school year** — every subject is a folder, every page a
  Markdown file. The sidebar is the folder tree; there is no separate "import".
- **Physics and maths** — `$inline$` and `$$display$$` equations render with
  KaTeX, and **Computer Modern** is bundled as a reading font for a paper-like
  page.
- **Revision, not just reading** — turn a topic into a quiz, take it under a
  timer, get it marked, and keep the attempt if you close the app.
- **Worksheets** — preserved blank lines, highlights (`<h>…</h>`), tables and
  inline SVG diagrams all survive a save/reload round trip.
- **Search and links** — `[[Page Title]]` links, full-workspace search, and an
  outline of the page you are reading.
- **PDF** — export a page or a paper with the chosen font embedded.

### The exam runner

A quiz, exam or flashcard deck is a single `.qz` file. Open it and it runs:

- timed papers with a start screen and a clock that survives tab switches;
- multiple choice, true/false, fill-in-the-blanks, short and long answers,
  numeric, matching and ordering questions;
- automatic marking for objective questions, model-based marking for prose;
- rule-based scoring for contest papers (e.g. AMC: correct 6, wrong 0,
  blank 1.5);
- answers, flags, marks and the clock autosaved and restored;
- `page = sep` for one question per screen, or `cont` for a scrolling sheet.

The file is plain text with the answers inside it — your paper, your key.
Meridiem keeps the runner read-only with respect to the paper itself: attempts
live beside the workspace, so opening an exam can never rewrite its questions.

### The agent

The agent panel runs [pi](https://github.com/badlogic/pi-mono) in-process. It can
read, write and search the workspace, so you can ask it to summarise a page,
draft revision notes from a past paper, or author a `.qz` file.

- Bring your own provider and API key (OpenAI-compatible, Anthropic, Google, or
  a local Ollama model).
- Keys are stored in the **macOS Keychain**.
- Conversations are resumable, and failed streams are retried instead of
  dropping the task.

Meridiem's planned agent work makes the harness pluggable — including ACP and
OpenCode — while keeping the in-process `pi` experience as the default.

## Privacy

- Notes never leave the folder you choose. There is no Meridiem account and no
  Meridiem server.
- The app watches the folder; edits made by the agent or another editor appear
  live.
- API keys are kept in the Keychain, not in your notes or in this repository.
- Workspaces can optionally be encrypted at rest.

---

## Roadmap and potential features

Meridiem is developed as a fork, so it is useful to separate what already works
from what is still a plan. The second list is directional, not a promise; an
item is shipped only when it is implemented and tested.

### Working today (inherited from Yestion)

- Local-first Markdown workspace with a folder tree, tabs, full-text search,
  `[[Page Title]]` links, and a page outline.
- TipTap rich-text editing plus a CodeMirror Markdown source mode.
- KaTeX inline and display maths, bundled Computer Modern, and PDF export.
- The `.qz` exam / quiz / flashcard runner with timed papers, passages,
  automatic and AI marking, saved attempts, and resumable sessions.
- The in-process `pi` agent with BYOK providers, Keychain key storage, workspace
  tools, and resumable conversations.
- Round-trip fidelity for the syntax the app writes: `<h>…</h>` highlights,
  `$…$` / `$$…$$` maths, blank lines and `\` hard breaks, booktabs-style
  tables, inline SVG diagrams, and raw HTML blocks.
- Optional encrypted workspaces.

### Planned / in progress (Meridiem)

- [ ] **Pluggable ACP / OpenCode harness** — run the agent through a standard
  harness while keeping `pi` as the default in-process path.
- [ ] **`Cmd+K` Command Palette and Focus Mode** — keyboard-first navigation,
  commands, and a distraction-free writing surface. This is Milestone 1
  (`feat/command-palette-and-focus`).
- [ ] **Automatic backlinks** — see which pages link to the one you are reading,
  without hand-maintained indexes.
- [ ] **Inline AI selection rewrite** — select a passage, describe the change,
  review the diff, then accept or undo. Octarine-inspired.
- [ ] **YAML frontmatter table and Kanban views** — use properties already in
  your Markdown for live tables, filters, grouping, and Kanban lanes.
- [ ] **Quick Capture** — a one-keystroke inbox for thoughts that should not
  interrupt the page you are writing.
- [ ] **iPhone QR handwritten exam capture** — scan handwritten answers from a
  phone via a QR handoff and attach them to the matching attempt.

---

## Requirements

- macOS 12 or later (Apple Silicon for the packaged build).
- Node.js 20+ to build from source.

## Build from source

```sh
git clone https://github.com/gloomy-breaker/Meridiem.git
cd Meridiem
git checkout meridiem
npm install --legacy-peer-deps
npm run dev          # run the app in development
npm run typecheck    # both TypeScript projects
npm run build        # renderer + main bundles in out/
npm run package      # packaged app bundle in dist/
npm run dmg          # wrap the packaged app in a DMG
```

`--legacy-peer-deps` is currently required because the committed lockfile pins a
TipTap peer combination that npm's strict resolver rejects; it reproduces the
lockfile rather than changing it.

There is no notarised download yet; a locally built app needs the usual macOS
"Open Anyway" approval on first launch.

## Project layout

```
src/main        Electron main process: workspace, watcher, agent, printing
src/preload     contextBridge API (the renderer compiles against index.d.ts)
src/renderer    UI, TipTap editor, quiz runner, agent panel
resources       icons and entitlements
scripts         packaging helpers
```

## Status

Meridiem is an early, personal fork. Yestion is the stable upstream and a
working daily driver; Meridiem is where the calmer surface, backlinks, inline
AI, and property views are being explored. Expect the shape of the fork to keep
moving. Upstream issues and pull requests belong in
[antoniology/yestion](https://github.com/antoniology/yestion).

## License

MIT — see [LICENSE](LICENSE). This fork preserves Yestion's MIT licence and
attribution. Bundled fonts: CMU Serif is distributed under the SIL Open Font
License; KaTeX ships its own fonts under their respective licences.
