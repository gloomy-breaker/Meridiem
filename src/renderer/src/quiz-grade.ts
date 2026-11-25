/**
 * AI marking for `.qz` answers that have no fixed correct form.
 *
 * The transport is `agent:gradeQuiz`: it sends the marking request back to the
 * conversation that wrote the paper when that conversation is still attached,
 * and otherwise falls back to `agent:oneshot` — a throwaway in-memory session
 * with no tools. This module is everything on top of either — what to ask, and
 * what to do with what comes back.
 *
 * The reply handling is deliberately forgiving, because a grader is a language
 * model and language models do not reliably emit JSON. A measured round trip
 * against a local 3B model produced a full-width `，` where a comma belonged,
 * which is not a property of that model — every small model does some version of
 * this. So: pull the JSON out of whatever prose or fence surrounds it, repair the
 * punctuation that silently breaks `JSON.parse`, and clamp the mark to the marks
 * that actually exist on the question. A grader that returns 7/6 must read as
 * 6/6, not corrupt the paper's total.
 */

import { stripQzTags, type QzDoc, type QzQuestion } from './qz'

export interface GradingCriterion {
  met: boolean
  text: string
}

export interface Grading {
  /** Marks awarded, already clamped to `[0, of]`. */
  mark: number
  /** Marks available, already reconciled with the question. */
  of: number
  feedback: string
  criteria: GradingCriterion[]
  /** True when the model could not be used and this is a self-mark placeholder. */
  ungraded?: boolean
  /** Why it is ungraded, shown to the user. */
  note?: string
  /** Wall-clock ms the round trip took, for the caller's pause accounting. */
  elapsedMs: number
}

/** The parts of a question the grader needs, plus what the candidate wrote. */
export interface GradingRequest {
  /** Workspace-relative path of the `.qz`, used to find the conversation that
   *  created it. Omitted only by callers that have no file (never the runner). */
  relPath?: string
  question: QzQuestion
  /** The candidate's answer, as typed. */
  response: string
  /** The passage this question refers to, already resolved. */
  passage?: string
  /** The paper's `<text>` intro, given as context. */
  intro?: string
  /** The paper's title, so the grader knows what it is marking. */
  paperTitle?: string
}

const GRADING_SYSTEM = `You are marking one answer on a school paper. You will be given the paper, the question, the marks available, the marking scheme, and the candidate's answer.

Reply with strict JSON only — no prose, no explanation, no code fence:
{"mark": <number>, "of": <number>, "feedback": "<one or two sentences>", "criteria": [{"met": <bool>, "text": "<criterion>"}]}

Rules:
- "of" must equal the marks available as given to you. Never change it.
- "mark" must be a number between 0 and "of" inclusive. Whole numbers or halves only.
- "feedback" is addressed to the candidate, in the second person, and says what earned marks and what did not.
- "criteria" lists exactly the criteria from the marking scheme, in order, each with "met" set to whether the candidate satisfied it. Do not add criteria the scheme does not contain.
- Judge only against the supplied marking scheme. Do not reward things it does not ask for, and do not penalise the candidate for style or length unless the scheme mentions them.
- If the candidate wrote nothing, mark 0 and say so.`

/** Build the single user turn for one question. */
export function buildGradingPrompt(req: GradingRequest): string {
  const { question } = req
  const parts: string[] = []
  // A question may carry an inline diagram; the grader gets the prose, not a
  // wall of `<svg>` markup.
  const text = (source: string | undefined): string => stripQzTags(source ?? '').trim()

  if (req.paperTitle) parts.push(`Paper: ${req.paperTitle}`)
  if (text(req.intro)) {
    parts.push(`Instructions given to the candidate:\n${text(req.intro)}`)
  }
  if (text(req.passage)) {
    parts.push(`Passage the question refers to:\n${text(req.passage)}`)
  }
  parts.push(`Question:\n${text(question.prompt)}`)
  parts.push(`Marks available: ${question.marks}`)
  if (text(question.rubric)) {
    parts.push(`Marking scheme:\n${text(question.rubric)}`)
  } else if (text(question.answer)) {
    parts.push(`Model answer:\n${text(question.answer)}`)
  } else {
    parts.push('Marking scheme: none supplied. Judge the answer on its merits against the question and the marks available.')
  }
  parts.push(
    req.response.trim()
      ? `Candidate's answer:\n${req.response.trim()}`
      : "Candidate's answer: (left blank)"
  )
  parts.push('Mark it.')
  return parts.join('\n\n')
}

/**
 * Repair the punctuation that a model reaches for when it is writing JSON by
 * hand, but that `JSON.parse` rejects outright.
 *
 * Only characters that are *never* valid outside a JSON string are touched, so
 * this cannot corrupt legitimately-quoted text. Full-width punctuation inside a
 * quoted feedback sentence is left alone — it is only a problem when it appears
 * where the grammar expects a delimiter, and swapping it there is always right.
 */
function repairPunctuation(json: string): string {
  return (
    json
      // Delimiters only. A model that writes `"a"，"b"` or `}{` with full-width
      // forms has broken the grammar, not asked for a full-width character.
      .replace(/([}\]"0-9])\s*[，､]\s*(?=["{[\w])/g, '$1,')
      .replace(/([}\]"])\s*[：]\s*(?=["{[\w])/g, '$1:')
      .replace(/[“”]/g, '"')
      // A trailing comma before a closing brace, which some models emit.
      .replace(/,(\s*[}\]])/g, '$1')
  )
}

/**
 * Escape the quotation marks a model left unescaped *inside* a string value.
 *
 * This is the single most common way a hand-written JSON reply breaks, and it is
 * indistinguishable from valid JSON without knowing where strings end. The trick
 * is that a closing quote is always followed by a delimiter — `,`, `:`, `}` or
 * `]` — while an inner quote is followed by more prose. So: a quote followed by
 * anything else is content, and gets escaped.
 *
 * A real reply this was written against:
 *   "text": "Uses clear language to define literary elements (e.g., 'short
 *            sentences lead to 'urgency'").
 * The quote before `)` is followed by `)`, so it is content; the one after `(`
 * in an earlier reply, `...could link "withhold" example...`, is followed by
 * `w`, so it is content too. Both of those replies defeated every per-field
 * heuristic; both fall out of this rule.
 */
function escapeInnerQuotes(json: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (ch === '\\') {
      out += ch + (json[i + 1] ?? '')
      i++
      continue
    }
    if (ch !== '"') {
      out += ch
      continue
    }
    if (!inString) {
      inString = true
      out += ch
      continue
    }
    // A quote while inside a string: closing only if a delimiter follows.
    let j = i + 1
    while (j < json.length && /\s/.test(json[j])) j++
    const next = json[j]
    const isCloser = next === undefined || next === ',' || next === ':' || next === '}' || next === ']'
    if (isCloser) {
      inString = false
      out += ch
    } else {
      out += '\\"'
    }
  }
  return out
}

/** Everything a reply might need before it will parse. */
function normalizeReply(text: string): string {
  // Inner quotes first: once string boundaries are right, the punctuation rules
  // below are working on a shape they can actually reason about.
  return repairPunctuation(escapeInnerQuotes(text))
}

/** The first balanced `{…}` in a string, ignoring braces inside strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Last resort: read the mark straight out of the text when the object will not
 * parse at all.
 *
 * This is not hypothetical — a local model marking a real answer produced
 * `...could link "withhold" example...` inside the `feedback` string, with the
 * inner quotes unescaped. That reply has a perfectly good `"mark": 5` in it and
 * no amount of punctuation repair will make the object parse. Throwing the mark
 * away and scoring the answer zero would be worse than reading the number the
 * model actually wrote.
 */
function salvageMark(text: string): number | null {
  const m = /"mark"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const value = Number(m[1])
  return Number.isFinite(value) ? value : null
}

/** The `feedback` string, for a reply that will not parse even after repair. */
function salvageFeedback(text: string): string {
  const start = /"feedback"\s*:\s*"/.exec(text)
  if (!start) return ''
  const rest = text.slice(start.index + start[0].length)
  // A closing quote is one followed by a delimiter; anything else is content.
  let end = rest.length
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '"' || rest[i - 1] === '\\') continue
    let j = i + 1
    while (j < rest.length && /\s/.test(rest[j])) j++
    const next = rest[j]
    if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
      end = i
      break
    }
  }
  return rest
    .slice(0, end)
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Turn a model's reply into a `Grading`, or `null` if there is no mark in it at
 * all. A `null` here is not a failure to report loudly — callers fall back to
 * self-marking, which is what they do for a missing provider too.
 */
export function parseGradingReply(text: string, question: QzQuestion): Grading | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // The question's marks are the authority, not the grader's — a model that
  // returns `of: 8` on a 6-mark question has misread the paper, and letting that
  // through would corrupt the total.
  const of = question.marks
  const clamp = (value: number): number => Math.max(0, Math.min(of, Math.round(value * 2) / 2))

  // Strip a fence if the model wrapped the object in one.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const normalized = normalizeReply(unfenced)
  const candidates = [unfenced, firstJsonObject(unfenced), normalized, firstJsonObject(normalized)]

  let parsed: unknown = null
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {
      /* try the next shape */
    }
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { mark?: unknown; of?: unknown; feedback?: unknown; criteria?: unknown }
    const rawMark = typeof obj.mark === 'number' ? obj.mark : Number(obj.mark)
    if (Number.isFinite(rawMark)) {
      const criteria: GradingCriterion[] = Array.isArray(obj.criteria)
        ? obj.criteria
            .map((c) => c as { met?: unknown; text?: unknown })
            .filter((c) => typeof c?.text === 'string' && (c.text as string).trim())
            .map((c) => ({ met: c.met === true, text: (c.text as string).trim() }))
        : []
      return {
        mark: clamp(rawMark),
        of,
        feedback: typeof obj.feedback === 'string' ? obj.feedback.trim() : '',
        criteria,
        elapsedMs: 0
      }
    }
  }

  const salvaged = salvageMark(normalized) ?? salvageMark(unfenced)
  if (salvaged === null) return null
  return {
    mark: clamp(salvaged),
    of,
    feedback: salvageFeedback(unfenced),
    criteria: [],
    // Say so rather than pretending the rubric came back clean: the candidate
    // should know the criteria are theirs to check.
    note: 'The grader\'s reply could not be read in full — the mark is theirs, the criteria were not.',
    elapsedMs: 0
  }
}

/** What a caller shows when the model was not used. */
function ungraded(question: QzQuestion, note: string, elapsedMs: number): Grading {
  return { mark: 0, of: question.marks, feedback: '', criteria: [], ungraded: true, note, elapsedMs }
}

/**
 * Mark one answer, or explain why it could not be marked.
 *
 * Never throws and never returns `null`: every failure path lands on an
 * `ungraded` result, because an exam must not be blocked by a network call and
 * marks already awarded must never be discarded. Callers render the model answer
 * alongside an ungraded result so the candidate can still self-mark.
 */
export async function gradeAnswer(req: GradingRequest): Promise<Grading> {
  const { question } = req
  // No AI means no request at all: an objective paper still marks itself, and a
  // prose answer becomes a self-marking exercise against its official scheme.
  // This is checked here, in the renderer's single grading entry point, so the
  // runner never shows an API error for a deliberate Off setting.
  let harness = 'none'
  try {
    harness = await window.api.agentHarnessGet()
  } catch {
    harness = 'none'
  }
  if (harness === 'none') {
    return ungraded(
      question,
      'AI marking is off. Use the marking scheme below to mark this answer yourself',
      0
    )
  }
  let res: { ok: boolean; text: string; error?: string; elapsedMs: number }
  const system = GRADING_SYSTEM
  const prompt = buildGradingPrompt(req)
  try {
    res = req.relPath
      ? await window.api.agentGradeQuiz({ relPath: req.relPath, system, prompt })
      : await window.api.agentOneshot({ system, prompt })
  } catch (err) {
    return ungraded(question, `Could not reach the grader: ${String((err as Error)?.message ?? err)}`, 0)
  }

  if (!res?.ok) {
    return ungraded(question, res?.error ?? 'The grader did not answer.', res?.elapsedMs ?? 0)
  }
  const grading = parseGradingReply(res.text, question)
  if (!grading) {
    return ungraded(question, 'The grader replied in a form that could not be read.', res.elapsedMs)
  }
  return { ...grading, elapsedMs: res.elapsedMs }
}

/** Which questions in a paper the model marks rather than the runner. */
export function aiGraded(doc: QzDoc): QzQuestion[] {
  return doc.questions.filter((q) => q.grade === 'ai')
}
