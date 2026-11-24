---
name: yestion
description: Meridiem workspace conventions (READ FIRST) — page/folder layout, front matter, [[Page]] links, $math$, image paths, the line-break convention, and how to author .qz quiz, exam and flashcard papers. Load this before creating or editing any page, and before writing a quiz.
---

# Meridiem workspace — how to work here

## What this place is
A Meridiem workspace: a plain folder of markdown files, opened in the **Meridiem** app.
Everything you write is a real file the user can also open in Finder or an editor.
The user is usually watching the app while you work — your edits appear in the open
page by themselves within about a second (the app watches the folder). Never tell
the user to reload, refresh or re-open anything.

## Layout
- **Every page is a FOLDER containing `index.md`.** Nested folders are its subpages.
- Loose `*.md` files are also pages — leaf pages that cannot have children.
- Front matter is mandatory and must always be preserved:
  ```
  ---
  title: Page Title
  icon: 📄
  ---
  ```
  `title:` is the page's name in the app's sidebar. `icon:` is a single emoji and is
  optional. **Never repeat the title as a heading in the body.**
- PDFs, images and other attachments live in the folder of the page they belong to.
- Dotfolders (`.pi/`, `.yestion/`) are app/config internals — never treat them as pages.

## Markdown conventions (this app is picky)
- **Math**: inline `$…$`, display `$$…$$` (KaTeX). Both render live. Don't add extra escapes.
- **Page links**: `[[Exact Page Title]]` — the app turns them into clickable chips.
  A folder name works too. Prefer these over file paths when pointing at another page.
- **Images**: reference the file by **absolute path**.
  If the path contains spaces, wrap the destination in angle brackets:
  `![](</Users/me/Pictures/diagram 1.png>)`.
- **Line breaks**: a single newline *is* a real line break in this workspace. When the
  app saves, it writes those as a trailing backslash (`\`) at the end of the line, and a
  blank line as `\` on a line of its own. That is the normal on-disk form — keep it,
  don't "fix" it into blank lines, and don't collapse runs of them (the user uses them
  as answer space on worksheets).
- **Highlights**: the app's own tag syntax — `<h>text</h>` is yellow, and a colour
  letter makes it green `<h><g>…</h>`, blue `<h><b>…</h>`, pink `<h><p>…</h>`, purple
  `<h><v>…</h>`, orange `<h><o>…</h>` or red `<h><r>…</h>`. Use these, never HTML
  `<mark>` or a `<span style="background:…">` — the app only renders its own tags.
- **Blockquotes**: the marker is `> ` at the very start of the line. Write the
  quoted text after it, with italics *inside* the quote: `> *text*`. Never write
  `*> text` — that is a literal asterisk then a `>`, and it renders as `*>`.
- Also supported as-is: `- [ ]` task lists, pipe tables, blockquotes, fenced code with a
  language tag, inline `<svg>` diagrams (keep them self-contained, no external refs).
- **Tables are the one exception to the backslash convention.** Never put the
  line-break `\` at the end of a table row — it sits after the final pipe and the
  whole table stops being a table. Rows end with `|`, and the separator row must
  have exactly one `---` per column (`| a | b |` needs `| --- | --- |`). Every
  row needs the same number of cells, each one closed by `|` — never continue a
  table by writing the next cell on a new line.
- **Keep the user's existing style.** Don't reflow, re-wrap or reformat paragraphs you
  were not asked to change, don't add headings or emoji they didn't have, and don't
  "tidy" their spacing.

## Quiz papers (`.qz`)
A quiz, exam or flashcard deck is **one `.qz` file**, not a folder. Write
`Forces Quiz.qz` at the workspace root or beside the pages it belongs to — never
wrap it in a folder with `index.md`. Opening it in the app runs it as a paper:
timed papers show a start screen, answers are entered on screen, and the app
marks it. The file is plain text and **contains the answers**, so treat it like
an answer key: don't paste it into chat unless the user asks.

The structure is front matter, then descriptor tags (one per line), then blocks:

```
---
title: Forces Quiz
icon: 📝
---

<type = quiz>
<page = cont>
<timing = total:15m>

<text>
# Instructions
Answer **all** questions. Use $g = 9.81\ \mathrm{m/s^2}$.
</text>

<q:mcq marks=2>
Which of these is a vector quantity?
- [ ] Speed
- [x] Velocity
- [ ] Distance
- [ ] Time
</q>

<q:blank marks=2>
The SI unit of force is {{newton|N}}, measured with a {{newton meter}}.
</q>
```

### Descriptor tags
One tag per line, all before the first block; unknown tags are ignored.

| Tag | Values | Meaning |
| --- | --- | --- |
| `<type = …>` | `exam` \| `quiz` \| `flashcard` | `exam` is normally timed; `quiz` is untimed practice; `flashcard` flips cards |
| `<page = …>` | `cont` \| `sep` | `cont` = one scrolling sheet; `sep` = one question per screen |
| `<timing = …>` | `total:90m` \| `individual` | one countdown for the paper, or per-question `time=`; omit for untimed |
| `<passage = true>` | `true` \| `false` | declares that the paper uses passages |

Durations are `90m`, `45s`, `1h30m` (no bare "90 minutes").

### Blocks
- `<text>…</text>` — intro and instructions, rendered above the questions.
- `<passage:P1>…</passage>` — a shared text (markdown, math). Attach it to any
  question with `passage=P1`; it is rendered once.
- `<q:TYPE attrs>…</q>` — one question. Marks default to 1.

Attributes: `marks=3`, `time=4m` (only used when `<timing = individual>`),
`passage=P1`, and `grade=auto|ai|self|none` to override marking.

### Diagrams and images
A question, passage or intro can carry a diagram — useful for circuits,
graphs and labelled figures.

- **Inline SVG** is rendered as a real diagram. Keep it self-contained (no
  external references, scripts or event handlers); `viewBox` + `width="100%"`
  scales it to the paper.
- **Images** work as markdown `![](diagram.png)` or as `<img src="diagram.png"
  alt="…" width="420">`. Relative paths resolve against the **`.qz` file's own
  folder**; absolute paths work anywhere.

```
<q:mcq marks=2>
Which lamp is in parallel with the resistor?
![](circuit.png)
- [ ] A
- [x] B
</q>
```

### Question types
**mcq** — task-list lines; `[x]` marks the correct one. Two or more `[x]` makes
it multi-select. At least two options, and one must be correct.
```
<q:mcq marks=2>
Which statements are true?
- [x] Force is a vector.
- [x] Mass is a scalar.
- [ ] Weight is a scalar.
</q>
```

**tf** — true/false, answer in a child tag.
```
<q:tf marks=1>
Acceleration due to gravity is greater at the equator than at the poles.
<answer>false</answer>
</q>
```

**blank** — `{{…}}` is a gap; `|` separates accepted answers. Gaps are numbered
in the app.
```
<q:blank marks=2>
The SI unit of force is {{newton|N}} and of energy is {{joule|J}}.
</q>
```

**short** — a sentence or two, marked by the model against `<answer>`.
```
<q:short marks=3>
State Newton's second law.
<answer>The resultant force is proportional to the rate of change of momentum, in the direction of the force: $F=ma$.</answer>
</q>
```

**long** — extended writing. `<answer>` is the marking scheme (bullets work best).
```
<q:long marks=6 time=10m>
Discuss how the writer builds tension.
<answer>
- short sentences in the second paragraph
- the tense shifting to present
- withheld information about the narrator
</answer>
</q>
```

**num** — numeric answer, optional unit and tolerance.
```
<q:num marks=2>
A 2 kg mass accelerates at 3 m/s². Find the force.
<answer>6</answer>
<unit>N</unit>
<tolerance>0.1</tolerance>
</q>
```

**match** — pair each left item with one right item; the app shuffles the right
column. At least two pairs.
```
<q:match marks=4>
- Force :: N
- Energy :: J
- Power :: W
</q>
```

**order** — a numbered list *is* the correct order; the app shuffles it.
```
<q:order marks=3>
1. Define the problem
2. Collect the data
3. Analyse the results
4. State a conclusion
</q>
```

**card** — flashcard: the body is the front, `<answer>` is the back.
```
<q:card>
What does $\Delta$ mean?
<answer>Change in — final value minus initial.</answer>
</q>
```

**free** — any other content, answered in a text box and marked by the model.
An unrecognised type name also degrades to `free` (with a warning), so a typo
never loses the question.

### Marking
`mcq`, `tf`, `blank`, `num`, `match` and `order` are marked automatically.
`short`, `long` and `free` are sent to the model; `card` is unscored. Override
one question with `grade=self` (you mark it in review) or `grade=none`.

### Rule-based scoring (contest papers)
For papers scored by a rule rather than by question marks — AMC, UKMT, olympiad
multiple choice — declare a `<scoring>` block once, before the questions:

```
<scoring>
correct = 6
wrong = 0
blank = 1.5
</scoring>
```

Every objective answer then pays `correct` when fully right, `wrong` when
anything else, and `blank` when nothing was entered (no option ticked, no value
typed, no pair chosen). Negative values are allowed. `correct` is the question's
maximum, and questions without their own `marks=` use it.

Override one question by putting the same keys on the question tag:

```
<q:mcq marks=6 correct=5 wrong=-1 blank=1.5>
```

Rule scoring applies only to the objective types above; prose questions are
marked against their rubric and keep their own `marks`. In an AMC 25-question
mock with `correct=6 / wrong=0 / blank=1.5`, a candidate with 20 right, 3 wrong
and 2 blank scores `20×6 + 2×1.5 = 123 / 150`.

### Rules that keep a paper working
- Close every `<q:…>` with `</q>` and every `<text>`/`<passage>` block too.
- One question per `<q>` block; don't nest blocks.
- Use the `.qz` extension exactly, and put the title in the front matter — do
  not repeat it as a heading in the body.
- If the workspace tree is in **links** mode, add `[[Forces Quiz]]` to a page
  so the new paper appears in the sidebar.

## How to do the common jobs
- **Create a page**: make the folder and write `index.md` with front matter —
  e.g. for a subpage of the page currently open, create it *inside that page's folder*.
  `mkdir -p "<parent>/<New Title>"` then write `<parent>/<New Title>/index.md`.
- **Rename a page**: change `title:` in its `index.md`. Leave the folder name alone
  unless the user asks for the file path to change too, and update any `[[…]]` links
  that used the old title.
- **Move or delete**: plain `mv` / `rm` is fine — say what you moved or removed, and ask
  before deleting anything with real content in it.
- **Diagrams**: inline `<svg>` is rendered as a real diagram in the page.
- **Make a quiz / test / flashcards**: write a single `.qz` file using the format
  above — not a page, not a folder. Pick `type`, `page` and `timing` deliberately:
  an exam gets a total countdown, practice stays untimed.
- **Answering**: concise, structured, and cite the file paths you touched.

## Boundaries
- You may **read** anywhere on the machine. Only write outside the workspace root when the
  user explicitly asks.
- When the user says "this page", "here", "my notes", they mean the page the app says it is
  viewing — the message starts with a `[User is viewing the page "…" (path) …]` line.
  **That is the file in front of them: read it before editing, and edit that one.**
- Don't run destructive git or filesystem operations, and don't commit unless asked.
