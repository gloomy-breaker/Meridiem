import { renderAgentMarkdown } from './agent-markdown'
import { anchorFloat } from './floats'
import { iconEl, iconSvg, type IconName } from './icons'

/**
 * The agent's mark, in place of the ✨ it used to wear on every message. Same
 * slot, same 24px circle — line art that inherits the panel's colour instead of
 * a colour emoji repeated down the whole conversation.
 */
function agentAvatarEl(): HTMLDivElement {
  const a = document.createElement('div')
  a.className = 'agent-avatar'
  a.replaceChildren(iconEl('sparkle', 12))
  return a
}

const AGENT_AVATAR_HTML = '<div class="agent-avatar">' + iconSvg('sparkle', 12) + '</div>'

export interface AgentPanelOpts {
  getContext?: () => { title: string; relPath: string } | null
  workspace: string | null
  onNeedSettings: () => void
  getAgentSettings: () => Promise<{
    provider: string
    model: string
    apiKey: string
    sessionFile?: string
    newSession?: boolean
  }>
}

export interface ToolCmdData {
  id: string
  name: string
  display: string
  output: string
  status: 'running' | 'ok' | 'error'
}

export type TurnItem =
  | { kind: 'thinking'; text: string; tokens: number }
  | { kind: 'tools'; cmds: ToolCmdData[] }
  | { kind: 'text'; text: string }

interface ChatMsg {
  role: 'user' | 'assistant'
  text?: string
  status?: string
  images?: Attachment[]
  items?: TurnItem[]
}

interface Attachment {
  data: string
  mimeType: string
  name: string
}

// 320 → "320", 1240 → "1.2k"
function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.max(0, Math.round(n)))
}

// The command a tool call represents, e.g. `ls -la` or `read notes.md`.
function toolDisplay(name: string, args: Record<string, unknown>): string {
  const a = args ?? {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'bash':
    case 'shell':
    case 'powershell':
      return str(a.command)
    case 'read':
    case 'write':
    case 'edit':
    case 'create':
      return str(a.path ?? a.file_path ?? a.filePath)
    case 'grep':
    case 'find':
      return [str(a.pattern), str(a.path)].filter(Boolean).join('  in  ')
    case 'ls':
    case 'list':
      return str(a.path) || '.'
    // Bundled DeepSeek web tools (src/main/agent-extensions/deepseek-search.ts).
    case 'deepseek_search':
      return [str(a.query), Number(a.count) > 0 ? `${String(a.count)} results` : ''].filter(Boolean).join('  ·  ')
    case 'deepseek_fetch':
      return str(a.url)
    default: {
      const first = Object.values(a).find((v) => typeof v === 'string' && v)
      return typeof first === 'string' ? first : ''
    }
  }
}

// Context usage shown at the top of the panel. Module scope on purpose: the
// panel is rebuilt on every agent restart, and these were being reset to nothing
// each time — which is why the context window "disappeared".
let agentCtxWindow = 0
let agentCtxInput = 0

export function setupAgentPanel(opts: AgentPanelOpts): {
  restart: () => Promise<void>
  newChat: () => Promise<void>
  openRecent: (anchor: HTMLElement) => Promise<void>
  setWorkspace: (path: string | null) => Promise<void>
  dismissFloats: () => HTMLElement[]
} {
  const messagesEl = document.getElementById('agent-messages') as HTMLElement
  const form = document.getElementById('agent-form') as HTMLFormElement
  const input = document.getElementById('agent-input') as HTMLInputElement
  const modelEl = document.getElementById('agent-model') as HTMLElement
  const stopBtn = document.getElementById('agent-stop') as HTMLButtonElement
  const historyBtn = document.getElementById('agent-history') as HTMLButtonElement | null
  historyBtn?.addEventListener('click', () => void openRecent(historyBtn))
  const newBtn = document.getElementById('agent-new') as HTMLButtonElement | null
  newBtn?.addEventListener('click', () => void openRecent(newBtn))

  // ---- context usage stats (shown at the top of the panel) ----
  const statsEl = document.getElementById('agent-stats') as HTMLElement | null
  function updateStats(): void {
    if (!statsEl) return
    // The window is shown as soon as it is known; the used-token figure fills in
    // after the first turn. Both live at module scope so a panel rebuild (which
    // every agent restart does) no longer wipes them.
    const windowText = agentCtxWindow > 0 ? formatTokens(agentCtxWindow) : '—'
    if (agentCtxInput <= 0) {
      statsEl.textContent = `Ctx: — | ${windowText} | —`
      statsEl.title =
        agentCtxWindow > 0
          ? 'No tokens used yet · ' + formatTokens(agentCtxWindow) + ' context window'
          : 'No tokens used yet'
      return
    }
    const pct =
      agentCtxWindow > 0 ? Math.min(100, (agentCtxInput / agentCtxWindow) * 100).toFixed(1) + '%' : '—'
    statsEl.textContent = `Ctx: ${pct} | ${windowText} | ${formatTokens(agentCtxInput)}`
    statsEl.title = `${formatTokens(agentCtxInput)} of ${agentCtxWindow > 0 ? formatTokens(agentCtxWindow) : 'unknown'} context window used · ${history.length} messages`
  }
  function noteUsage(usage: unknown): void {
    const u = usage as
      | {
          input?: number
          output?: number
          cacheRead?: number
          cacheWrite?: number
          promptTokens?: number
          completionTokens?: number
          totalTokens?: number
        }
      | undefined
    if (!u) return
    const input = u.input ?? u.promptTokens ?? 0
    const cacheRead = u.cacheRead ?? 0
    const output = u.output ?? u.completionTokens ?? 0
    // Keep the biggest figure we have seen: pi reports per-message usage, and
    // the context in play is the largest of them, not the last one.
    const used = input + cacheRead
    if (used <= 0 && output <= 0) return
    if (used > agentCtxInput) agentCtxInput = used
    updateStats()
  }

  let running = false
  const history: ChatMsg[] = []
  /** Session the agent is attached to (authoritative copy mirrors main). */
  let currentSessionFile: string | null = null
  /** Session whose messages the panel is showing. */
  let shownSessionFile: string | null = null
  /** Workspace this panel belongs to. Switching workspaces rewrites it —
   *  `opts.workspace` is captured once at boot and went stale on a switch,
   *  which pointed session-reopen and agentSessionRoot at the old folder. */
  let workspacePath: string | null = opts.workspace

  // The panel transcript and the pi session are separate state. They must never
  // drift: every start/resume goes through attachToShown(), and any mismatch is
  // surfaced in the header instead of silently continuing in another session.

  // ---- transcript model -------------------------------------------------
  // One assistant turn is a list of items: thinking blocks, tool runs and the
  // markdown answer. Groups collapse to a single summary line, so a finished
  // reply reads as: Thinking (1.2k tokens) / Ran 3 commands (3 succeeded) / output.
  type ThinkingItem = Extract<TurnItem, { kind: 'thinking' }>
  type ToolsItem = Extract<TurnItem, { kind: 'tools' }>
  type TextItem = Extract<TurnItem, { kind: 'text' }>

  let currentTurn: ChatMsg | null = null
  let turnContentEl: HTMLElement | null = null
  let liveThinking: { item: ThinkingItem; body: HTMLElement; meta: HTMLElement; group: HTMLElement } | null = null
  let liveTools: {
    item: ToolsItem
    group: HTMLElement
    meta: HTMLElement
    cmds: Map<string, { data: ToolCmdData; root: HTMLElement; out: HTMLElement; dot: HTMLElement }>
  } | null = null
  let liveText: { item: TextItem; el: HTMLElement } | null = null
  let textRaf: number | null = null
  let toolSeq = 0

  /**
   * The text block the turn that was just closed ended with, kept while nothing
   * new has been said.
   *
   * pi replays a finished message's stream events (its text_end and its
   * message_end, carrying the whole answer) *after* the prompt promise has
   * resolved — and resolving the promise is what calls endTurn(). With the turn
   * already closed those replays ran ensureText(), which started a brand new
   * turn: the answer appeared a second time, as a bare ✨ row with no groups.
   * Anything that arrives between turns belongs to the turn on screen, so it is
   * folded back into this block instead of opening another one.
   */
  let closedTurnText: { item: TextItem; el: HTMLElement } | null = null
  /** The closed turn's container and history entry, so a late answer that had
   *  no text at all when the turn closed still lands in the right row. */
  let closedTurnContent: HTMLElement | null = null
  let closedTurnMsg: ChatMsg | null = null
  /** True from the moment a turn closes until the user says something new. */
  let betweenTurns = false
  /** Deltas seen since the turn closed, to tell a replay from a live tail. */
  let lateDeltaBuf = ''
  let lateDropLogged = false
  /** Last notice shown in the open turn, so a replayed event cannot double it. */
  let lastNoticeText = ''

  function makeGroup(labelText: string, metaText: string): {
    group: HTMLElement
    meta: HTMLElement
    body: HTMLElement
  } {
    const group = document.createElement('div')
    group.className = 'agent-group'
    group.dataset.open = 'false'
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'agent-group-head'
    const caret = document.createElement('span')
    caret.className = 'agent-caret'
    const label = document.createElement('span')
    label.className = 'agent-group-label'
    label.textContent = labelText
    const meta = document.createElement('span')
    meta.className = 'agent-group-meta'
    meta.textContent = metaText
    head.append(caret, label, meta)
    const body = document.createElement('div')
    body.className = 'agent-group-body'
    head.addEventListener('click', () => {
      const open = group.dataset.open === 'true'
      group.dataset.open = open ? 'false' : 'true'
    })
    group.append(head, body)
    return { group, meta, body }
  }

  function setGroupOpen(group: HTMLElement, open: boolean): void {
    group.dataset.open = open ? 'true' : 'false'
  }

  function ensureTurnContent(): HTMLElement {
    if (turnContentEl) return turnContentEl
    // A genuinely new turn: whatever the previous one left behind is no longer
    // the newest thing on screen, so late events are no longer folded into it.
    betweenTurns = false
    closedTurnText = null
    closedTurnContent = null
    closedTurnMsg = null
    lateDeltaBuf = ''
    lastNoticeText = ''
    const msg: ChatMsg = { role: 'assistant', items: [] }
    history.push(msg)
    currentTurn = msg
    const hint = messagesEl.querySelector('.agent-empty-wrap')
    if (hint) hint.remove()
    const wrap = document.createElement('div')
    wrap.className = 'agent-row agent-row-assistant'
    const content = document.createElement('div')
    content.className = 'agent-turn'
    wrap.append(agentAvatarEl(), content)
    messagesEl.appendChild(wrap)
    turnContentEl = content
    return content
  }

  function endTurn(): void {
    turnContentEl?.querySelectorAll('.agent-group').forEach((g) => setGroupOpen(g as HTMLElement, false))
    // Remember what it ended with *before* dropping the handles: the answer's
    // text node stays addressable so a replayed stream can be folded into it.
    if (turnContentEl) {
      closedTurnText = liveText
      closedTurnContent = turnContentEl
      closedTurnMsg = currentTurn
      lateDeltaBuf = ''
      lateDropLogged = false
      betweenTurns = true
    }
    currentTurn = null
    turnContentEl = null
    liveThinking = null
    liveTools = null
    liveText = null
  }

  /**
   * The provider re-sent text for a turn that is already finished on screen.
   * Full-message replays either carry more than we rendered (the deltas stopped
   * early — extend in place) or are the same answer again (drop it).
   */
  /**
   * Where text that arrives after the turn closed belongs.
   *
   * A reasoning turn can finish with only thinking and tool blocks, so
   * `liveText` was null when the turn closed and the answer itself arrives
   * afterwards. The old fold treated that as a replay and dropped it — the
   * turn then sat on screen with thinking and no answer. If the closed turn
   * exists, give it a text block now.
   */
  function lateTextTarget(): { item: TextItem; el: HTMLElement } | null {
    if (closedTurnText) return closedTurnText
    if (!closedTurnContent) return null
    const el = document.createElement('div')
    el.className = 'agent-output markdown-body'
    closedTurnContent.appendChild(el)
    const item: TextItem = { kind: 'text', text: '' }
    closedTurnMsg?.items?.push(item)
    closedTurnText = { item, el }
    return closedTurnText
  }

  function renderLateText(target: { item: TextItem; el: HTMLElement }): void {
    target.el.innerHTML = renderAgentMarkdown(target.item.text)
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function foldLateText(full: string, what: string): void {
    const closed = lateTextTarget()
    if (!closed) {
      noteLateDrop(what, full.length)
      return
    }
    const shown = closed.item.text
    // A replay of what is already on screen — the case this guard was built for.
    if (full === shown || shown.startsWith(full) || shown.includes(full)) {
      noteLateDrop(what, full.length)
      return
    }
    // The final message carries more than the stream did: complete it in place.
    if (full.startsWith(shown) || full.includes(shown)) {
      closed.item.text = full
      lateDeltaBuf = ''
      renderLateText(closed)
      logLine('info', `agent: late ${what} completed the closed turn (${shown.length} → ${full.length} chars)`)
      return
    }
    // A genuinely separate message from the same turn: append it rather than
    // losing it. Two messages are better than no answer.
    closed.item.text = shown ? `${shown}\n\n${full}` : full
    lateDeltaBuf = ''
    renderLateText(closed)
    logLine('info', `agent: late ${what} appended to the closed turn (${full.length} chars)`)
  }

  /**
   * Deltas that arrive after the turn closed are either a replay of text that
   * is already rendered (skip it) or the tail of an answer the provider kept
   * streaming past the prompt promise (append it). The buffer tells them apart.
   */
  function appendLateDelta(delta: string): void {
    const closed = lateTextTarget()
    if (!closed) {
      noteLateDrop('text_delta', delta.length)
      return
    }
    const next = lateDeltaBuf + delta
    if (closed.item.text.startsWith(next)) {
      lateDeltaBuf = next
      noteLateDrop('text_delta', delta.length)
      return
    }
    lateDeltaBuf = ''
    closed.item.text += delta
    renderLateText(closed)
  }

  function noteLateDrop(what: string, chars: number): void {
    if (lateDropLogged) return
    lateDropLogged = true
    logLine(
      'info',
      `agent: dropped a replayed ${what} (${chars} chars) — the turn it belongs to was already rendered; this used to appear as a duplicate answer`
    )
  }

  function collapseAllGroups(): void {
    turnContentEl?.querySelectorAll('.agent-group').forEach((g) => setGroupOpen(g as HTMLElement, false))
  }

  function ensureThinking(): { item: ThinkingItem; body: HTMLElement; meta: HTMLElement } | null {
    if (liveThinking) return liveThinking
    if (!currentTurn) ensureTurnContent()
    collapseAllGroups()
    const content = ensureTurnContent()
    const { group, meta, body } = makeGroup('Thinking', '')
    content.appendChild(group)
    setGroupOpen(group, true)
    const item: ThinkingItem = { kind: 'thinking', text: '', tokens: 0 }
    currentTurn?.items?.push(item)
    liveThinking = { item, body, meta, group }
    liveTools = null
    liveText = null
    return liveThinking
  }

  function ensureTools(): {
    item: ToolsItem
    group: HTMLElement
    meta: HTMLElement
    cmds: Map<string, { data: ToolCmdData; root: HTMLElement; out: HTMLElement; dot: HTMLElement }>
  } | null {
    if (liveTools) return liveTools
    if (!currentTurn) ensureTurnContent()
    collapseAllGroups()
    const content = ensureTurnContent()
    const { group, meta } = makeGroup('Ran 0 commands', '(starting…)')
    content.appendChild(group)
    setGroupOpen(group, true)
    const item: ToolsItem = { kind: 'tools', cmds: [] }
    currentTurn?.items?.push(item)
    liveTools = { item, group, meta, cmds: new Map() }
    liveThinking = null
    liveText = null
    return liveTools
  }

  function toolMetaText(cmds: ToolCmdData[]): string {
    const done = cmds.filter((c) => c.status !== 'running')
    const ok = cmds.filter((c) => c.status === 'ok').length
    const failed = cmds.filter((c) => c.status === 'error').length
    if (done.length < cmds.length) return `(${done.length} of ${cmds.length} done)`
    if (failed === 0) return `(${ok} succeeded)`
    if (ok === 0) return `(${failed} failed)`
    return `(${ok} succeeded, ${failed} failed)`
  }

  function ensureText(): { item: TextItem; el: HTMLElement } | null {
    if (liveText) return liveText
    const content = ensureTurnContent()
    collapseAllGroups()
    const el = document.createElement('div')
    el.className = 'agent-output markdown-body'
    content.appendChild(el)
    const item: TextItem = { kind: 'text', text: '' }
    currentTurn?.items?.push(item)
    liveText = { item, el }
    liveThinking = null
    liveTools = null
    return liveText
  }

  function logLine(level: 'info' | 'warn' | 'error', message: string): void {
    void window.api.log({ level, message })
  }

  /** A short inline note in the transcript (stream errors, truncation, …). */
  function addNotice(text: string, kind: 'info' | 'warn' = 'info'): void {
    // turn_end and the finished message_end carry the same stop reason, so the
    // same sentence was printed twice in one turn — a replay on top of that
    // made it three. Once per turn is enough.
    if (text === lastNoticeText) return
    // A late notice about the turn that just finished belongs in that turn.
    // ensureTurnContent() would open another ✨ row for it — and clear the
    // between-turns guard, which is what let a replayed answer land there.
    const closedRow = closedTurnText?.el.parentElement ?? null
    const content = betweenTurns && closedRow ? closedRow : ensureTurnContent()
    lastNoticeText = text
    const el = document.createElement('div')
    el.className = 'agent-notice' + (kind === 'warn' ? ' warn' : '')
    el.textContent = text
    content.appendChild(el)
    messagesEl.scrollTop = messagesEl.scrollHeight
    logLine(kind === 'warn' ? 'warn' : 'info', 'agent notice: ' + text)
  }

  function renderText(): void {
    if (!liveText) return
    liveText.el.innerHTML = renderAgentMarkdown(liveText.item.text)
  }

  function scheduleTextRender(): void {
    if (textRaf !== null) return
    textRaf = requestAnimationFrame(() => {
      textRaf = null
      renderText()
      messagesEl.scrollTop = messagesEl.scrollHeight
    })
  }

  let typingEl: HTMLElement | null = null
  function showTyping(on: boolean): void {
    if (on && !typingEl) {
      typingEl = document.createElement('div')
      typingEl.className = 'agent-row agent-row-assistant'
      typingEl.innerHTML =
        AGENT_AVATAR_HTML +
        '<div class="agent-msg agent-msg-assistant agent-typing"><span></span><span></span><span></span></div>'
      messagesEl.appendChild(typingEl)
      messagesEl.scrollTop = messagesEl.scrollHeight
    } else if (!on && typingEl) {
      typingEl.remove()
      typingEl = null
    }
  }

  // ---- rendering past turns (history) ----
  function renderTurnInto(content: HTMLElement, items: TurnItem[]): void {
    for (const item of items) {
      if (item.kind === 'thinking') {
        const { group } = makeGroup('Thinking', `(${formatTokens(item.tokens)} tokens)`)
        const body = group.querySelector('.agent-group-body') as HTMLElement
        const text = document.createElement('div')
        text.className = 'agent-think-text'
        text.textContent = item.text
        body.appendChild(text)
        content.appendChild(group)
      } else if (item.kind === 'tools') {
        const { group } = makeGroup(`Ran ${item.cmds.length} commands`, toolMetaText(item.cmds))
        const body = group.querySelector('.agent-group-body') as HTMLElement
        for (const cmd of item.cmds) body.appendChild(buildCmdBox(cmd).root)
        content.appendChild(group)
      } else {
        const el = document.createElement('div')
        el.className = 'agent-output markdown-body'
        el.innerHTML = renderAgentMarkdown(item.text)
        content.appendChild(el)
      }
    }
  }

  function buildCmdBox(cmd: ToolCmdData): { root: HTMLElement; out: HTMLElement; dot: HTMLElement } {
    const root = document.createElement('div')
    root.className = 'agent-cmd'
    root.dataset.status = cmd.status
    const head = document.createElement('div')
    head.className = 'agent-cmd-head'
    const dot = document.createElement('span')
    dot.className = 'agent-cmd-dot'
    const name = document.createElement('span')
    name.className = 'agent-cmd-name'
    name.textContent = cmd.name
    const text = document.createElement('code')
    text.className = 'agent-cmd-text'
    text.textContent = cmd.display || '—'
    head.append(dot, name, text)
    const out = document.createElement('pre')
    out.className = 'agent-cmd-out'
    out.textContent = cmd.output
    if (!cmd.output) out.hidden = true
    root.append(head, out)
    return { root, out, dot }
  }

  /**
   * Build a user row without touching `history`.
   *
   * renderHistory() walks `history`, so it must never append to it — addMsg()
   * does append, and calling it from renderHistory looped forever (each pass
   * added another message to the array being iterated).
   */
  function buildUserRow(text: string, images?: Attachment[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'agent-row agent-row-user'
    const body = document.createElement('div')
    body.className = 'agent-msg agent-msg-user'
    if (images && images.length > 0) {
      const strip = document.createElement('div')
      strip.className = 'agent-msg-images'
      for (const a of images) {
        const img = document.createElement('img')
        img.src = `data:${a.mimeType};base64,${a.data}`
        img.alt = a.name
        img.addEventListener('click', () => {
          const w = window.open('', '_blank')
          if (w) {
            w.document.write(
              `<title>${a.name}</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh"><img src="data:${a.mimeType};base64,${a.data}" style="max-width:100%;max-height:100%"></body>`
            )
          }
        })
        strip.appendChild(img)
      }
      body.appendChild(strip)
    }
    if (text) {
      const textEl = document.createElement('div')
      textEl.textContent = text
      body.appendChild(textEl)
    }
    wrap.appendChild(body)
    return wrap
  }

  function addMsg(role: ChatMsg['role'], text = '', images?: Attachment[]): HTMLElement {
    if (role === 'user') {
      // A new question: nothing that arrives from here on belongs to the turn
      // we just finished, so stop folding late events into it.
      betweenTurns = false
      closedTurnText = null
      lateDeltaBuf = ''
    }
    const msg: ChatMsg = { role, text }
    history.push(msg)
    const hint = messagesEl.querySelector('.agent-empty-wrap')
    if (hint) hint.remove()
    if (role === 'assistant') {
      msg.items = [{ kind: 'text', text }]
      const wrap = document.createElement('div')
      wrap.className = 'agent-row agent-row-assistant'
      const content = document.createElement('div')
      content.className = 'agent-turn'
      renderTurnInto(content, msg.items)
      wrap.append(agentAvatarEl(), content)
      messagesEl.appendChild(wrap)
      messagesEl.scrollTop = messagesEl.scrollHeight
      return content
    }
    msg.images = images
    const row = buildUserRow(text, images)
    messagesEl.appendChild(row)
    messagesEl.scrollTop = messagesEl.scrollHeight
    return row
  }

  function renderEmpty(): void {
    messagesEl.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'agent-empty-wrap'
    wrap.innerHTML = `
      <div class="agent-empty-icon">${iconSvg('sparkle', 28, 1.5)}</div>
      <div class="agent-empty-sub">Runs pi inside this workspace — it can read, draft and edit your pages.</div>
      <div class="agent-suggestions"></div>`
    const chips = wrap.querySelector('.agent-suggestions') as HTMLElement
    const suggestions: [IconName, string][] = [
      ['list', 'Summarize this page'],
      ['table', 'Make flashcards'],
      ['book', 'Draft revision notes'],
      ['help', 'Quiz me on this page']
    ]
    for (const [ico, s] of suggestions) {
      const chip = document.createElement('button')
      chip.className = 'agent-chip'
      chip.append(iconEl(ico, 13), document.createTextNode(s))
      chip.addEventListener('click', () => {
        input.value = s
        void send()
      })
      chips.appendChild(chip)
    }
    messagesEl.appendChild(wrap)
  }

  // ---- recent conversations (pi session files) -------------------------
  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime()
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return mins + 'm ago'
    const hours = Math.round(mins / 60)
    if (hours < 24) return hours + 'h ago'
    const days = Math.round(hours / 24)
    if (days < 30) return days + 'd ago'
    return new Date(iso).toLocaleDateString()
  }

  /** Turn stored pi messages into the panel's transcript model. */
  function messagesToHistory(messages: unknown[]): ChatMsg[] {
    const out: ChatMsg[] = []
    let turn: ChatMsg | null = null
    let toolsItem: Extract<TurnItem, { kind: 'tools' }> | null = null
    const byToolId = new Map<string, ToolCmdData>()

    const textOf = (content: unknown): string => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .map((b) => {
          const block = b as { type?: string; text?: string }
          return block?.type === 'text' ? (block.text ?? '') : ''
        })
        .join('')
        .trim()
    }
    const imagesOf = (content: unknown): Attachment[] | undefined => {
      if (!Array.isArray(content)) return undefined
      const imgs = content
        .map((b) => b as { type?: string; data?: string; mimeType?: string })
        .filter((b) => b?.type === 'image' && b.data && b.mimeType)
        .map((b) => ({ data: b.data as string, mimeType: b.mimeType as string, name: 'image' }))
      return imgs.length > 0 ? imgs : undefined
    }

    const startTurn = (): ChatMsg => {
      turn = { role: 'assistant', items: [] }
      out.push(turn)
      toolsItem = null
      return turn
    }

    for (const raw of messages) {
      const m = raw as {
        role?: string
        content?: unknown
        toolCallId?: string
        isError?: boolean
      }
      if (m.role === 'user') {
        out.push({ role: 'user', text: textOf(m.content), images: imagesOf(m.content) })
        turn = null
        toolsItem = null
      } else if (m.role === 'assistant') {
        const t = startTurn()
        for (const block of Array.isArray(m.content) ? m.content : []) {
          const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }
          if (b.type === 'thinking' && (b.thinking ?? '').trim()) {
            t.items?.push({ kind: 'thinking', text: b.thinking ?? '', tokens: Math.round((b.thinking ?? '').length / 4) })
            toolsItem = null
          } else if (b.type === 'toolCall') {
            if (!toolsItem) {
              toolsItem = { kind: 'tools', cmds: [] }
              t.items?.push(toolsItem)
            }
            const cmd: ToolCmdData = {
              id: b.id ?? 'tool-' + toolSeq++,
              name: b.name ?? 'tool',
              display: toolDisplay(b.name ?? 'tool', (b.arguments ?? {}) as Record<string, unknown>),
              output: '',
              status: 'running'
            }
            byToolId.set(cmd.id, cmd)
            toolsItem.cmds.push(cmd)
          } else if (b.type === 'text' && (b.text ?? '').trim()) {
            t.items?.push({ kind: 'text', text: b.text ?? '' })
            toolsItem = null
          }
        }
        if (t.items?.length === 0) out.pop()
      } else if (m.role === 'toolResult') {
        const cmd = m.toolCallId ? byToolId.get(m.toolCallId) : undefined
        if (cmd) {
          cmd.output = textOf(m.content).slice(0, 20000)
          cmd.status = m.isError ? 'error' : 'ok'
        }
      }
    }
    return out
  }

  /**
   * Mirror a session's messages into the panel and return how many there were.
   * The context gauge is seeded from the newest usage the session carries.
   */
  async function loadTranscript(path: string): Promise<number> {
    const messages = await window.api.agentSessionMessages(path)
    if (!Array.isArray(messages)) return 0
    betweenTurns = false
    closedTurnText = null
    lateDeltaBuf = ''
    lastNoticeText = ''
    history.length = 0
    history.push(...messagesToHistory(messages))
    agentCtxInput = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = (messages[i] as { usage?: { input?: number; cacheRead?: number } })?.usage
      if (usage) {
        agentCtxInput = (usage.input ?? 0) + (usage.cacheRead ?? 0)
        break
      }
    }
    shownSessionFile = path
    updateStats()
    updateSessionNotice()
    renderHistory()
    return messages.length
  }

  /** Remember this conversation so the next launch reopens it. */
  async function rememberSession(path: string | null): Promise<void> {
    await window.api.setSettings('agentSessionFile', path ?? '')
    await window.api.setSettings('agentSessionRoot', path ? workspacePath ?? '' : '')
  }

  function clearTranscript(): void {
    // renderHistory() rebuilds the rows from scratch, so the folded-into node
    // from the old transcript is about to be detached.
    betweenTurns = false
    closedTurnText = null
    lateDeltaBuf = ''
    lastNoticeText = ''
    history.length = 0
    agentCtxInput = 0
    updateStats()
    renderHistory()
  }

  /**
   * Attach the agent to the conversation the panel is showing. Called before
   * every prompt, so a restart/stop on the main side can never leave the two
   * halves pointing at different sessions.
   */
  async function attachToShown(): Promise<void> {
    const settings = await opts.getAgentSettings()
    const live = await window.api.agentSessionCurrent()
    if (agentReady && live && live === shownSessionFile) {
      currentSessionFile = live
      updateSessionNotice()
      return
    }
    if (shownSessionFile) {
      const res = await window.api.agentResume({ ...settings, sessionFile: shownSessionFile })
      currentSessionFile = res?.sessionFile ?? shownSessionFile
    } else {
      const res = await window.api.agentStart({ ...settings, newSession: true })
      currentSessionFile = res?.sessionFile ?? null
      shownSessionFile = currentSessionFile
    }
    agentReady = true
    await rememberSession(currentSessionFile)
    updateSessionNotice()
  }

  /**
   * The mismatch that used to be invisible: the panel showing one conversation
   * while the agent is attached to another. Auto-healed before every prompt, so
   * this notice is the belt-and-braces case (and it says what it will do).
   */
  function updateSessionNotice(): void {
    const el = document.getElementById('agent-session-notice')
    if (!el) return
    const drift = agentReady && !!currentSessionFile && !!shownSessionFile && currentSessionFile !== shownSessionFile
    if (!drift) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.innerHTML = ''
    const text = document.createElement('span')
    text.className = 'agent-session-notice-text'
    text.textContent = 'The agent is on a different conversation than this page shows.'
    const fix = document.createElement('button')
    fix.type = 'button'
    fix.className = 'agent-session-notice-fix'
    fix.textContent = 'Continue the shown one'
    fix.addEventListener('click', () => {
      const path = shownSessionFile
      if (!path) return
      void (async () => {
        try {
          const res = await window.api.agentResume({ ...(await opts.getAgentSettings()), sessionFile: path })
          currentSessionFile = res?.sessionFile ?? path
          agentReady = true
          await rememberSession(currentSessionFile)
        } catch (err) {
          addMsg('assistant', 'Could not re-attach: ' + String((err as Error).message ?? err))
        }
        updateSessionNotice()
      })()
    })
    el.append(text, fix)
  }

  async function resumeSession(path: string): Promise<void> {
    // Ask main which session is actually live — comparing with the rendered
    // path made "click the conversation you are looking at" a silent no-op.
    const live = await window.api.agentSessionCurrent()
    if (agentReady && live === path && shownSessionFile === path) {
      // Already live and on screen. Say so instead of doing nothing at all —
      // a silent click is what made resume look unsupported.
      addNotice('Already on this conversation.')
      return
    }
    try {
      running = false
      setRunning(false)
      showTyping(false)
      endTurn()
      const count = await loadTranscript(path)
      const settings = await opts.getAgentSettings()
      const res = await window.api.agentResume({ ...settings, sessionFile: path })
      currentSessionFile = res?.sessionFile ?? path
      agentReady = true
      await rememberSession(currentSessionFile)
      updateSessionNotice()
      if (count === 0) addMsg('assistant', 'Resumed that conversation — it is empty so far.')
    } catch (err) {
      logLine('error', 'resume failed: ' + String((err as Error).message ?? err))
      addMsg('assistant', 'Could not resume that conversation: ' + String((err as Error).message ?? err))
      updateSessionNotice()
    }
  }

  async function newChat(): Promise<void> {
    let started = false
    try {
      await window.api.agentStop()
      agentReady = false
      const res = await window.api.agentStart({ ...(await opts.getAgentSettings()), newSession: true })
      currentSessionFile = res?.sessionFile ?? null
      agentReady = true
      started = true
    } catch (err) {
      logLine('error', 'new chat failed: ' + String((err as Error).message ?? err))
      addMsg('assistant', 'Could not start a new chat: ' + String((err as Error).message ?? err))
      updateSessionNotice()
      return
    }
    if (!started) return
    shownSessionFile = currentSessionFile
    clearTranscript()
    await rememberSession(currentSessionFile)
    updateSessionNotice()
  }

  async function openRecent(anchor: HTMLElement): Promise<void> {
    const existing = document.getElementById('agent-recent-pop')
    // Pressing the same button again closes the list instead of rebuilding it.
    if (existing && existing.dataset.anchorId === anchor.id) {
      existing.remove()
      return
    }
    existing?.remove()
    const pop = document.createElement('div')
    pop.id = 'agent-recent-pop'
    pop.className = 'agent-recent-pop'
    pop.dataset.anchorId = anchor.id
    const head = document.createElement('div')
    head.className = 'agent-recent-head'
    head.textContent = 'Recent conversations'
    const newBtn = document.createElement('button')
    newBtn.type = 'button'
    newBtn.className = 'agent-recent-new'
    newBtn.textContent = '＋ New chat'
    newBtn.addEventListener('click', () => {
      pop.remove()
      void newChat()
    })
    const list = document.createElement('div')
    list.className = 'agent-recent-list'
    const loading = document.createElement('div')
    loading.className = 'agent-recent-empty'
    loading.textContent = 'Loading…'
    list.appendChild(loading)
    pop.append(head, newBtn, list)
    document.body.appendChild(pop)
    anchorFloat(pop, anchor)
    const rect = anchor.getBoundingClientRect()
    pop.style.top = Math.round(rect.bottom + 6) + 'px'
    pop.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px'

    // Highlight the session the agent is actually attached to: marking the
    // rendered one made the highlighted row look clickable-but-dead.
    currentSessionFile = (await window.api.agentSessionCurrent()) ?? currentSessionFile
    list.innerHTML = ''
    let sessions: Awaited<ReturnType<typeof window.api.agentSessions>>
    try {
      sessions = await window.api.agentSessions()
    } catch (err) {
      // Without this the popup sat on "Loading…" forever and the rejection
      // vanished into the console.
      const failed = document.createElement('div')
      failed.className = 'agent-recent-empty'
      failed.textContent = 'Could not list conversations: ' + String((err as Error)?.message ?? err)
      list.appendChild(failed)
      logLine('warn', 'agent panel: listing conversations failed: ' + String((err as Error)?.message ?? err))
      return
    }
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'agent-recent-empty'
      empty.textContent = 'No past conversations in this workspace yet.'
      list.appendChild(empty)
      return
    }
    for (const s of sessions) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className =
        'agent-recent-item' +
        (s.path === currentSessionFile ? ' current' : '') +
        (s.path === shownSessionFile && s.path !== currentSessionFile ? ' shown' : '')
      const title = document.createElement('div')
      title.className = 'agent-recent-title'
      title.textContent = s.name?.trim() || s.firstMessage || '(empty conversation)'
      const meta = document.createElement('div')
      meta.className = 'agent-recent-meta'
      meta.textContent = relativeTime(s.modified) + ' · ' + s.messageCount + ' messages'
      row.append(title, meta)
      row.addEventListener('click', () => {
        pop.remove()
        void resumeSession(s.path)
      })
      list.appendChild(row)
    }
  }

  function renderHistory(): void {
    if (history.length === 0) {
      renderEmpty()
      return
    }
    messagesEl.innerHTML = ''
    for (const msg of [...history]) {
      if (msg.role === 'user') {
        messagesEl.appendChild(buildUserRow(msg.text ?? '', msg.images))
      } else if (msg.items && msg.items.length > 0) {
        const wrap = document.createElement('div')
        wrap.className = 'agent-row agent-row-assistant'
        const content = document.createElement('div')
        content.className = 'agent-turn'
        renderTurnInto(content, msg.items)
        wrap.append(agentAvatarEl(), content)
        messagesEl.appendChild(wrap)
      } else if (msg.text) {
        const wrap = document.createElement('div')
        wrap.className = 'agent-row agent-row-assistant'
        wrap.innerHTML = AGENT_AVATAR_HTML
        const content = document.createElement('div')
        content.className = 'agent-turn'
        const el = document.createElement('div')
        el.className = 'agent-output markdown-body'
        el.innerHTML = renderAgentMarkdown(msg.text)
        content.appendChild(el)
        wrap.appendChild(content)
        messagesEl.appendChild(wrap)
      }
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  // Links inside replies open in the browser, not in the app window.
  messagesEl.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href) return
    e.preventDefault()
    window.open(href, '_blank')
  })

  // ---- tool events ----
  function extractText(v: unknown): string {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(extractText).join('')
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.text === 'string') return o.text
      if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
        return String(o.stdout ?? '') + String(o.stderr ?? '')
      }
      if (o.content !== undefined) return extractText(o.content)
    }
    return ''
  }

  function toolIdOf(e: Record<string, unknown>): string {
    const v = e.toolCallId ?? e.id ?? e.callId
    return v != null ? String(v) : 'tool-' + toolSeq++
  }

  // A turn the main process started on its own — quiz marking sent back to the
  // conversation that wrote the paper. The panel did not type this prompt, so
  // it has to add the user turn itself; the reply then streams in as usual.
  window.api.onAgentInjectedPrompt((text) => {
    // Same order as send(): close whatever turn was on screen first, then open
    // the user row (which clears the late-event guard).
    endTurn()
    addMsg('user', text)
    showTyping(true)
    // Hold the composer while marking runs: letting another prompt interleave
    // would put two turns in flight and the runner could read the wrong reply.
    setRunning(true)
    messagesEl.scrollTop = messagesEl.scrollHeight
  })
  window.api.onAgentInjectedDone(() => {
    showTyping(false)
    setRunning(false)
    endTurn()
  })

  window.api.onAgentEvent((raw) => {
    const ev = raw as Record<string, unknown>
    const type = String(ev.type ?? '')

    if (type === 'tool_execution_start') {
      showTyping(false)
      // The finished turn's tool calls, replayed after it closed. Running them
      // through ensureTools() again would rebuild every command box a second
      // time inside a new turn.
      if (betweenTurns) return
      const tools = ensureTools()
      if (!tools) return
      const id = toolIdOf(ev)
      if (tools.cmds.has(id)) return
      const name = String(ev.toolName ?? ev.name ?? 'tool')
      const args = (ev.args ?? ev.input ?? {}) as Record<string, unknown>
      const data: ToolCmdData = { id, name, display: toolDisplay(name, args), output: '', status: 'running' }
      tools.item.cmds.push(data)
      const box = buildCmdBox(data)
      tools.cmds.set(id, { data, root: box.root, out: box.out, dot: box.dot })
      ;(tools.group.querySelector('.agent-group-body') as HTMLElement).appendChild(box.root)
      const label = tools.group.querySelector('.agent-group-label')
      if (label) label.textContent = `Ran ${tools.item.cmds.length} command${tools.item.cmds.length === 1 ? '' : 's'}`
      tools.meta.textContent = toolMetaText(tools.item.cmds)
      messagesEl.scrollTop = messagesEl.scrollHeight
      return
    }

    if (type === 'tool_execution_update') {
      const tools = liveTools
      const entry = tools?.cmds.get(toolIdOf(ev))
      if (entry) {
        const chunk = extractText(ev.partial ?? ev.partialResult ?? ev.delta ?? ev.output ?? ev.content ?? ev.result)
        if (chunk) {
          entry.data.output += chunk
          entry.out.textContent = entry.data.output
          entry.out.hidden = false
          entry.out.scrollTop = entry.out.scrollHeight
          messagesEl.scrollTop = messagesEl.scrollHeight
        }
      }
      return
    }

    if (type === 'tool_execution_end') {
      const tools = liveTools
      const entry = tools?.cmds.get(toolIdOf(ev))
      if (tools && entry) {
        const finalOut = extractText(ev.result ?? ev.output ?? ev.content)
        if (finalOut && !entry.data.output.includes(finalOut.slice(0, 40))) {
          entry.data.output += (entry.data.output ? '\n' : '') + finalOut
          entry.out.textContent = entry.data.output
          entry.out.hidden = false
        }
        const isError = Boolean(ev.isError ?? ev.error)
        entry.data.status = isError ? 'error' : 'ok'
        entry.root.dataset.status = entry.data.status
        tools.meta.textContent = toolMetaText(tools.item.cmds)
      }
      return
    }

    // ---- turn lifecycle ----
    // The authoritative text lives on the finished message, not only in the
    // deltas: if the last chunk never arrives as a delta the reply looked
    // truncated. Also surface *why* a turn ended, which is what "it just cuts
    // off while thinking" actually is.
    if (type === 'message_end' || type === 'turn_end') {
      const msg = ev.message as
        | {
            content?: unknown
            stopReason?: string
            errorMessage?: string
            usage?: Record<string, unknown>
          }
        | undefined
      const full = extractText(msg?.content)
      if (full) {
        if (liveText) {
          if (full.length > liveText.item.text.length) {
            liveText.item.text = full
            scheduleTextRender()
          }
        } else if (betweenTurns) {
          // The finished message, replayed after its turn was closed. Fold it
          // into the turn on screen rather than leaving a copy behind.
          foldLateText(full, type)
        }
      }
      const stop = msg?.stopReason ?? ''
      logLine(
        'info',
        `agent ${type}: stop=${stop || '?'} chars=${full.length} tools=${Array.isArray(ev.toolResults) ? ev.toolResults.length : 0} usage=${JSON.stringify(msg?.usage ?? null)}`
      )
      if (stop === 'length') {
        addNotice('The model hit its output token limit — raise “Max output tokens” in Settings → Models.', 'warn')
      } else if (stop === 'aborted') {
        addNotice('The response was stopped before it finished.', 'warn')
      } else if (stop === 'error') {
        const detail = String(msg?.errorMessage ?? '').trim()
        addNotice(
          `The provider ended the response with an error${detail ? ` — ${detail}` : ''}. ` +
            'Dropped connections are continued automatically; if this repeats, ask it to continue or switch models.',
          'warn'
        )
      } else if (type === 'turn_end' && !full && (ev.toolResults as unknown[] | undefined)?.length === 0) {
        addNotice('The model ended the turn without producing any text.', 'warn')
      }
      return
    }

    if (type === 'retry_scheduled' || type === 'retry_start') {
      // pi retries interrupted streams; without this the reply just seemed to
      // stop.
      addNotice(
        `Stream interrupted — retrying (attempt ${String(ev.attempt ?? '?')}${ev.maxAttempts ? ` of ${String(ev.maxAttempts)}` : ''})…`,
        'warn'
      )
      return
    }

    if (type === 'retry_end' && ev.success === false) {
      addNotice(`Retry failed: ${String(ev.finalError ?? 'unknown error')}`, 'warn')
      return
    }

    if (type === 'agent_end') {
      logLine(
        'info',
        `agent_end: willRetry=${String(ev.willRetry)} messages=${Array.isArray(ev.messages) ? (ev.messages as unknown[]).length : '?'}`
      )
      return
    }

    if (type !== 'message_update') return
    const ame = ev.assistantMessageEvent as
      | { type?: string; delta?: string; content?: string; partial?: { usage?: { reasoning?: number } } }
      | undefined
    if (!ame) return

    if (ame.type === 'thinking_delta' && ame.delta) {
      // Replayed reasoning for a turn that already rendered its groups.
      if (betweenTurns) return
      showTyping(false)
      const thinking = ensureThinking()
      if (!thinking) return
      thinking.item.text += ame.delta
      thinking.body.textContent = thinking.item.text
      const reasoning = ame.partial?.usage?.reasoning
      thinking.item.tokens =
        typeof reasoning === 'number' && reasoning > 0 ? reasoning : Math.round(thinking.item.text.length / 4)
      thinking.meta.textContent = `(${formatTokens(thinking.item.tokens)} tokens)`
      messagesEl.scrollTop = messagesEl.scrollHeight
      return
    }

    if (ame.type === 'thinking_end' && typeof ame.content === 'string') {
      const thinking = liveThinking
      if (thinking) {
        thinking.item.text = ame.content
        thinking.body.textContent = ame.content
        const reasoning = ame.partial?.usage?.reasoning
        if (typeof reasoning === 'number' && reasoning > 0) thinking.item.tokens = reasoning
        thinking.meta.textContent = `(${formatTokens(thinking.item.tokens)} tokens)`
      }
      return
    }

    if (ame.type === 'text_end' && typeof ame.content === 'string') {
      if (betweenTurns) {
        foldLateText(ame.content, 'text_end')
        return
      }
      const text = ensureText()
      if (text && ame.content.length > text.item.text.length) {
        text.item.text = ame.content
        scheduleTextRender()
      }
      return
    }

    if (ame.type === 'text_delta' && ame.delta) {
      if (betweenTurns) {
        appendLateDelta(ame.delta)
        return
      }
      showTyping(false)
      const text = ensureText()
      if (!text) return
      text.item.text += ame.delta
      scheduleTextRender()
    }
  })

  // Token usage can ride several event shapes (message_end, turn_end, …); pick
  // it up wherever it shows up.
  window.api.onAgentEvent((raw) => {
    const e = raw as {
      usage?: unknown
      message?: { usage?: unknown }
      assistantMessage?: { usage?: unknown }
    }
    const usage = e.usage ?? e.message?.usage ?? e.assistantMessage?.usage
    if (usage) noteUsage(usage)
  })

  window.api.onAgentStarted(({ model, contextWindow }) => {
    modelEl.textContent = model
    if (typeof contextWindow === 'number' && contextWindow > 0) agentCtxWindow = contextWindow
    running = true
    stopBtn.disabled = false
    updateStats()
  })

  window.api.onAgentStopped(() => {
    running = false
    agentReady = false
    updateStats()
    updateSessionNotice()
    // Leave the current turn open: providers can keep streaming after a stop
    // event, and closing it mid-delivery would split one answer into two turns.
    stopBtn.disabled = true
    modelEl.textContent = ''
  })

  // ---- bottom model selector ----
  const modelSelect = document.getElementById('agent-model-select') as HTMLSelectElement
  ;(window as any).__reloadModels = loadModels  // let settings force a refresh
  const ctxLabel = document.getElementById('agent-ctx') as HTMLElement
  async function loadModels(): Promise<void> {
    const prov = ((await window.api.getSettings('agentProvider')) as string) || 'anthropic'
    const cur = ((await window.api.getSettings('agentModel')) as string) || ''
    const models = await window.api.agentModels()
    modelSelect.innerHTML = ''
    const def = document.createElement('option')
    def.value = ''
    def.textContent = models.length ? 'First configured model' : 'No models configured'
    modelSelect.appendChild(def)
    // Group by provider: only the models the user configured are listed.
    const byProvider = new Map<string, typeof models>()
    for (const m of models) {
      const list = byProvider.get(m.providerName) ?? []
      list.push(m)
      byProvider.set(m.providerName, list)
    }
    for (const [providerName, list] of byProvider) {
      const group = document.createElement('optgroup')
      group.label = providerName
      for (const m of list) {
        const opt = document.createElement('option')
        opt.value = `${m.provider}/${m.id}`
        opt.textContent = `${m.name} · ${Math.round(m.contextWindow / 1000)}K ctx`
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    modelSelect.value = cur ? `${prov}/${cur}` : ''
    if (modelSelect.value !== (cur ? `${prov}/${cur}` : '')) modelSelect.value = ''
  }
  modelSelect.addEventListener('change', () => {
    void (async () => {
      // Switching models restarts the agent. If a run is in flight, end it
      // rather than refusing the switch: a selector that silently does nothing
      // (especially when `running` is stale after /stop) is worse than an
      // aborted turn.
      await window.api.agentAbort()
      setRunning(false)
      const v = modelSelect.value
      if (!v) {
        await window.api.setSettings('agentProvider', 'anthropic')
        await window.api.setSettings('agentModel', '')
      } else {
        const [provider, ...rest] = v.split('/')
        await window.api.setSettings('agentProvider', provider)
        await window.api.setSettings('agentModel', rest.join('/'))
      }
      // Restart alone only kills the live session. Re-attach immediately so the
      // new model is actually in use (and its label updates) before the next
      // message, instead of the first prompt paying for a lazy reload.
      await window.api.agentRestart()
      try {
        await attachToShown()
      } catch (err) {
        addMsg('assistant', 'Could not switch model: ' + String((err as Error).message ?? err))
      }
      ctxLabel.textContent = v ? v.split('/').pop() || v : 'default'
    })()
  })
  void loadModels()

  // ---- thinking effort (right of the model selector) ----
  const effortSelect = document.getElementById('agent-effort') as HTMLSelectElement
  const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  function setEffortValue(level: string): void {
    effortSelect.value = (EFFORT_LEVELS as readonly string[]).includes(level) ? level : 'max'
  }
  async function loadEffort(): Promise<void> {
    const cur = ((await window.api.getSettings('agentThinking')) as string) || 'max'
    effortSelect.innerHTML = ''
    for (const level of EFFORT_LEVELS) {
      const opt = document.createElement('option')
      opt.value = level
      opt.textContent = level === 'xhigh' ? 'extra high' : level
      effortSelect.appendChild(opt)
    }
    setEffortValue(cur)
  }
  effortSelect.addEventListener('change', () => {
    void (async () => {
      const level = effortSelect.value || 'max'
      await window.api.setSettings('agentThinking', level)
      await window.api.agentThinking(level)
    })()
  })
  void loadEffort()

  // ---- pi-style slash commands ----
  const SLASH_CMDS: { cmd: string; arg?: string; desc: string; run: (arg: string) => Promise<void> | void }[] = [
    { cmd: '/compact', desc: 'Compact the context window', run: async () => { const res = await window.api.agentCompact(); const detail = typeof res === 'string' ? res : ''; addMsg('assistant', 'Context compacted.' + (detail ? ' ' + detail : '')) } },
    { cmd: '/new', desc: 'Start a fresh agent session', run: async () => { await newChat(); addMsg('assistant', 'New session started.') } },
    { cmd: '/resume', desc: 'Open a recent conversation', run: async () => { const b = document.getElementById('agent-history'); if (b) await openRecent(b as HTMLElement) } },
    { cmd: '/stop', desc: 'Abort the current run', run: async () => { await window.api.agentAbort(); setRunning(false) } },
    { cmd: '/thinking', arg: 'off|low|medium|high|max', desc: 'Set thinking level', run: async (arg) => { const lvl = (arg || 'medium').trim(); await window.api.setSettings('agentThinking', lvl); setEffortValue(lvl); await window.api.agentThinking(lvl); addMsg('assistant', `Thinking effort: ${lvl}`) } },
    { cmd: '/model', desc: 'Open the model selector', run: () => { modelSelect.focus(); modelSelect.click() } },
    { cmd: '/help', desc: 'List available commands', run: () => { addMsg('assistant', SLASH_CMDS.map((c) => `**${c.cmd}**${c.arg ? ' ' + c.arg : ''} — ${c.desc}`).join('\n')) } }
  ]
  const slashMenu = document.getElementById('agent-slash-menu') as HTMLElement
  let slashActive = 0

  function slashFiltered(): typeof SLASH_CMDS {
    const q = input.value.trim().toLowerCase()
    return SLASH_CMDS.filter((c) => c.cmd.startsWith(q))
  }

  function hideSlash(): void {
    slashMenu.hidden = true
    slashMenu.innerHTML = ''
    slashActive = 0
  }

  function showSlash(): void {
    const items = slashFiltered()
    if (input.value.trim() === '/' || (input.value.startsWith('/') && items.length > 0)) {
      slashMenu.hidden = false
      slashMenu.innerHTML = ''
      items.forEach((c, i) => {
        const row = document.createElement('div')
        row.className = 'agent-slash-item' + (i === slashActive ? ' active' : '')
        row.innerHTML = `<span class="agent-slash-cmd"></span><span class="agent-slash-desc"></span>`
        ;(row.querySelector('.agent-slash-cmd') as HTMLElement).textContent = c.cmd + (c.arg ? ' ' + c.arg : '')
        ;(row.querySelector('.agent-slash-desc') as HTMLElement).textContent = c.desc
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          void execSlash(c, '')
        })
        slashMenu.appendChild(row)
      })
    } else {
      hideSlash()
    }
  }

  async function execSlash(c: (typeof SLASH_CMDS)[number], arg: string): Promise<void> {
    hideSlash()
    input.value = ''
    addMsg('user', c.cmd + (arg ? ' ' + arg : ''))
    // A rejected command used to become an unhandled rejection that only showed
    // up in meridiem.log, while the panel printed a success message anyway.
    try {
      await c.run(arg)
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
      logLine('error', `${c.cmd} failed: ${msg}`)
      addMsg('assistant', `**${c.cmd} failed** — ${msg}`)
    }
  }

  input.addEventListener('input', () => {
    if (input.value.startsWith('/')) {
      slashActive = 0
      showSlash()
    } else hideSlash()
  })
  input.addEventListener('keydown', (e) => {
    if (slashMenu.hidden) return
    const items = slashFiltered()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashActive = Math.min(items.length - 1, slashActive + 1)
      showSlash()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashActive = Math.max(0, slashActive - 1)
      showSlash()
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const parts = input.value.trim().split(/\s+/)
      const cmd = parts[0]
      const arg = parts.slice(1).join(' ')
      const found = items[slashActive] ?? SLASH_CMDS.find((c) => c.cmd === cmd)
      if (found) {
        e.preventDefault()
        void execSlash(found, arg)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hideSlash()
    }
  })

  const sendBtn = document.querySelector('.agent-send') as HTMLButtonElement
  function setRunning(on: boolean): void {
    running = on
    sendBtn.replaceChildren(iconEl(on ? 'stop' : 'arrowUp', 14, 2.2))
    sendBtn.title = on ? 'Stop generating' : 'Send'
    sendBtn.classList.toggle('is-stop', on)
    stopBtn.disabled = !on
  }
  sendBtn.type = 'button'
  sendBtn.addEventListener('click', () => {
    if (running) {
      void window.api.agentAbort()
      setRunning(false)
    } else {
      void send()
    }
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    if (running) return
    const v = input.value.trim()
    if (v.startsWith('/')) {
      const parts = v.split(/\s+/)
      const found = SLASH_CMDS.find((c) => c.cmd === parts[0])
      if (found) {
        void execSlash(found, parts.slice(1).join(' '))
        return
      }
    }
    void send()
  })

  stopBtn.addEventListener('click', () => {
    void window.api.agentAbort()
    setRunning(false)
  })

  let agentReady = false
  let retried = false

  // ---- image attachments ----
  let attachments: Attachment[] = []
  const attachStrip = document.getElementById('agent-attachments') as HTMLElement
  const attachBtn = document.getElementById('agent-attach') as HTMLButtonElement

  function renderAttachments(): void {
    attachStrip.innerHTML = ''
    attachStrip.hidden = attachments.length === 0
    attachments.forEach((a, i) => {
      const chip = document.createElement('div')
      chip.className = 'agent-attachment'
      const img = document.createElement('img')
      img.src = `data:${a.mimeType};base64,${a.data}`
      img.alt = a.name
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'agent-attachment-x'
      remove.textContent = '✕'
      remove.title = 'Remove'
      remove.addEventListener('click', () => {
        attachments.splice(i, 1)
        renderAttachments()
      })
      chip.append(img, remove)
      chip.title = a.name
      attachStrip.appendChild(chip)
    })
  }

  function addAttachment(a: Attachment | null): void {
    if (!a) return
    attachments.push(a)
    renderAttachments()
    input.focus()
  }

  attachBtn.addEventListener('click', () => {
    void (async () => {
      const picked = await window.api.pickImage()
      addAttachment(picked)
    })()
  })

  // Grow the composer with its content (multiline once it hits the width).
  const MAX_INPUT_H = 148
  function autoGrow(): void {
    input.style.height = 'auto'
    if (!input.value) {
      input.style.height = ''
      input.style.overflowY = 'hidden'
      return
    }
    const next = Math.min(input.scrollHeight, MAX_INPUT_H)
    input.style.height = next + 'px'
    input.style.overflowY = input.scrollHeight > MAX_INPUT_H ? 'auto' : 'hidden'
  }
  input.addEventListener('input', autoGrow)
  autoGrow()

  // Enter sends (unless the slash menu is open); Shift+Enter makes a newline.
  input.addEventListener('keydown', (e) => {
    // isComposing: don't send while an IME (Chinese/Japanese) is composing.
    if (e.key === 'Enter' && !e.shiftKey && slashMenu.hidden && !e.isComposing) {
      e.preventDefault()
      void send()
    }
  })

  // Drag & drop images anywhere on the agent panel.
  //
  // The cue is a whole-panel outline, so it has to survive the pointer crossing
  // the panel's own children: dragenter/dragleave fire for every element in and
  // out of the path, and a plain boolean gets cleared by the first child left.
  // Count entries instead, and make sure every way a drag can end takes the cue
  // down — including the ones that never deliver a dragleave, which is how the
  // dashed "Drop image to attach" outline used to stay painted on the panel
  // after a drag was released outside the window.
  const panelEl = document.getElementById('agent-panel') as HTMLElement
  let dragDepth = 0
  let dragSeenAt = 0
  let dragWatchdog: number | null = null
  const dragHasFiles = (e: DragEvent): boolean =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files')
  const stopDragWatchdog = (): void => {
    if (dragWatchdog === null) return
    window.clearInterval(dragWatchdog)
    dragWatchdog = null
  }
  const clearDragCue = (): void => {
    dragDepth = 0
    panelEl.classList.remove('agent-drag-over')
    stopDragWatchdog()
  }
  /** While the cue is up, re-check it: a drag session that ended without a
   *  dragleave (cancelled with Escape, released over another app) sends the
   *  panel nothing at all, and the cue would otherwise be stuck until the next
   *  drop. dragover repeats while the file is genuinely held over the panel. */
  const armDragWatchdog = (): void => {
    dragSeenAt = performance.now()
    if (dragWatchdog !== null) return
    dragWatchdog = window.setInterval(() => {
      if (performance.now() - dragSeenAt > 800) clearDragCue()
    }, 250)
  }
  panelEl.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return
    dragDepth++
    panelEl.classList.add('agent-drag-over')
    armDragWatchdog()
  })
  panelEl.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
    panelEl.classList.add('agent-drag-over')
    armDragWatchdog()
  })
  panelEl.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) clearDragCue()
  })
  panelEl.addEventListener('drop', (e) => {
    clearDragCue()
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        if (comma < 0) return
        addAttachment({ data: result.slice(comma + 1), mimeType: file.type || 'image/png', name: file.name })
      }
      reader.readAsDataURL(file)
    }
  })
  // The drag session belongs to the whole window, not the panel, so the ways it
  // can end without a panel dragleave are caught out here.
  document.addEventListener('dragend', clearDragCue)
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) clearDragCue() // nothing left to move onto → out of the window
  })
  window.addEventListener('blur', clearDragCue)

  // Paste an image straight from the clipboard (screenshots).
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (!file) continue
      e.preventDefault()
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        if (comma < 0) return
        addAttachment({
          data: result.slice(comma + 1),
          mimeType: file.type || 'image/png',
          name: file.name || 'pasted-image.png'
        })
      }
      reader.readAsDataURL(file)
    }
  })
  async function send(): Promise<void> {
    const text = input.value.trim()
    if ((!text && attachments.length === 0) || running) return
    const sentAttachments = attachments.slice()
    input.value = ''
    input.style.height = 'auto'
    attachments = []
    renderAttachments()
    // Close the previous turn *before* the user row goes in: addMsg() clears
    // the between-turns guard, and endTurn() would set it again — swallowing
    // the answer to the question we are about to ask.
    endTurn()
    addMsg('user', text, sentAttachments)
    showTyping(true)
    try {
      // Keys come from ~/.pi/agent/auth.json via the shared ModelRuntime; a
      // Meridiem-level key is only an optional override.
      try {
        // Make sure the agent is attached to the conversation on screen before
        // every prompt. main reuses a live session, so this is one cheap call.
        await attachToShown()
      } catch (err) {
        agentReady = false
        updateSessionNotice()
        addMsg('assistant', 'Agent failed to start: ' + String((err as Error).message ?? err))
        running = false
        return
      }
      agentReady = true
      setRunning(true)
      const images = sentAttachments.map((a) => ({ data: a.data, mimeType: a.mimeType }))
      try {
        await window.api.agentPrompt(text, opts.getContext?.(), images.length > 0 ? images : undefined)
      } catch (err) {
        // Session was disposed underneath us (stop, restart, workspace
        // switch). Recover transparently: start a fresh session, retry once.
        const msg = String((err as Error).message ?? err)
        if (/not running/i.test(msg) && !retried) {
          retried = true
          await attachToShown()
          await window.api.agentPrompt(text, opts.getContext?.(), images.length > 0 ? images : undefined)
          retried = false
        } else {
          throw err
        }
      }
      // pi replays the finished message's events *after* prompt() resolves, and
      // resolving is what closes the turn here. Keep the turn open — and the
      // composer locked — for a beat so the tail lands in the right place. A
      // new message sent inside this window aborts the stream, which is what
      // looked like the answer being cut off.
      await new Promise((resolve) => setTimeout(resolve, 450))
      setRunning(false)
      showTyping(false)
      endTurn()
    } catch (err) {
      setRunning(false)
      showTyping(false)
      endTurn()
      addMsg('assistant', 'Error: ' + String((err as Error).message ?? err))
    }
  }

  // ---- boot: reopen the conversation this workspace was last on ------------
  // Without this the panel started empty on every launch and the agent silently
  // began a new session, which is why yesterday's conversation looked lost.
  async function reopenRemembered(): Promise<void> {
    try {
      const root = workspacePath
      const remembered = ((await window.api.getSettings('agentSessionFile')) as string) || ''
      const rememberedRoot = ((await window.api.getSettings('agentSessionRoot')) as string) || ''
      if (!root || !remembered || rememberedRoot !== root) return
      const count = await loadTranscript(remembered)
      if (count === 0) shownSessionFile = null
      logLine('info', `agent panel: reopened ${remembered} (${count} messages)`)
    } catch (err) {
      logLine('warn', 'agent panel: could not reopen the last conversation: ' + String((err as Error).message ?? err))
    }
  }
  void reopenRemembered()

  return {
    restart: async () => {
      await window.api.agentStop()
      agentReady = false
      updateSessionNotice()
      // Re-attach immediately to the conversation on screen: a model change
      // used to leave the agent on a fresh session while the panel kept showing
      // the old one (the root cause of "compact says the session is too small").
      try {
        await attachToShown()
      } catch (err) {
        logLine('error', 're-attach after restart failed: ' + String((err as Error).message ?? err))
        agentReady = false
        updateSessionNotice()
      }
    },
    newChat,
    openRecent,
    /**
     * Follow the app to another workspace. The transcript on screen belongs to
     * the old one, so detach, clear, and reopen whatever this workspace was
     * last on — otherwise the header keeps advertising a conversation that the
     * agent (now rooted in the new folder) can no longer reach.
     */
    setWorkspace: async (path: string | null) => {
      if (path === workspacePath) return
      workspacePath = path
      await window.api.agentStop()
      agentReady = false
      currentSessionFile = null
      shownSessionFile = null
      clearTranscript()
      updateSessionNotice()
      await reopenRemembered()
    },
    /**
     * Close the panel's own floating bits — the recent-conversations popover
     * and the slash list. Without this they stayed on screen after the panel
     * was hidden, and Escape reached neither.
     */
    dismissFloats: (): HTMLElement[] => {
      const closed: HTMLElement[] = []
      const pop = document.getElementById('agent-recent-pop')
      if (pop) {
        pop.remove()
        closed.push(pop)
      }
      if (!slashMenu.hidden) {
        hideSlash()
        closed.push(slashMenu)
      }
      return closed
    }
  }
}
