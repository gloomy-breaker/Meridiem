// ---------------------------------------------------------------------------
// Settings — workspace, providers & keys, models, agent.
//
// Providers and models are Meridiem's own configuration (see src/main/providers.ts):
// each provider has a base URL, a wire protocol and a keychain-stored API key;
// each model belongs to a provider and carries its id, context window and the
// inputs it accepts. pi is generated from this, so the app never shows a
// hundred-entry catalog and never refreshes one.
// ---------------------------------------------------------------------------
import { THEMES } from './themes'
import { fillFontSelect, resolveFontId } from './fonts'

interface ModelInputs {
  text: boolean
  image: boolean
  audio: boolean
  video: boolean
}

interface ModelConfig {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: ModelInputs
  /** Position in the flat models list; new models append at the end. */
  order?: number
}

interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  api: string
  hasKey: boolean
  models: ModelConfig[]
}

const WIRE_APIS = [
  { id: 'openai-completions', label: 'OpenAI-compatible' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Generative AI' }
]

interface SettingsOpts {
  onWorkspaceChanged: () => void
  onAgentSettingsChanged: () => void
  onThemeChange: (id: string) => void
  onFontChange: (id: string) => void
  /** Which unit the page footer counts in. */
  onCountModeChange: (mode: 'words' | 'asian') => void
}

export function setupSettings(opts: SettingsOpts): { show: () => void; close: () => HTMLElement | null } {
  const backdrop = document.getElementById('settings-modal') as HTMLElement
  const workspacePathEl = document.getElementById('settings-workspace-path') as HTMLElement
  const themeSelect = document.getElementById('settings-theme') as HTMLSelectElement
  const fontSelect = document.getElementById('settings-font') as HTMLSelectElement
  const sizeSelect = document.getElementById('settings-size') as HTMLSelectElement | null
  const countingSelect = document.getElementById('settings-counting') as HTMLSelectElement | null
  const providersHost = document.getElementById('settings-providers') as HTMLElement
  const modelsHost = document.getElementById('settings-models') as HTMLElement
  const defaultModelSelect = document.getElementById('settings-default-model') as HTMLSelectElement
  const thinkingSelect = document.getElementById('settings-thinking') as HTMLSelectElement
  const statusEl = document.getElementById('settings-status') as HTMLElement

  // Theme options
  for (const group of [
    ['Light', THEMES.filter((t) => t.kind === 'light')],
    ['Dark', THEMES.filter((t) => t.kind === 'dark')]
  ] as const) {
    const og = document.createElement('optgroup')
    og.label = group[0]
    for (const t of group[1]) {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.label
      og.appendChild(opt)
    }
    themeSelect.appendChild(og)
  }
  fillFontSelect(fontSelect, 'default')

  let providers: ProviderConfig[] = []

  /** Ollama is recognised by its endpoint, so imports/keys behave sensibly. */
  function isOllama(provider: ProviderConfig): boolean {
    return /localhost:11434|127\.0\.0\.1:11434/i.test(provider.baseUrl) || /ollama/i.test(provider.id + provider.name)
  }
  let saveTimer: number | null = null

  function scheduleSave(): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      void window.api.providersSave(providers).then(() => {
        opts.onAgentSettingsChanged()
        void fillModelSelect()
        ;(window as any).__reloadModels?.()  // refresh the composer model picker
      })
    }, 400)
  }

  // ---- providers ----------------------------------------------------------

  function field(labelText: string, value: string, onChange: (v: string) => void, type = 'text'): HTMLElement {
    const row = document.createElement('label')
    row.className = 'prov-field'
    const span = document.createElement('span')
    span.textContent = labelText
    const input = document.createElement('input')
    input.type = type
    input.value = value
    input.addEventListener('input', () => onChange(input.value))
    row.append(span, input)
    return row
  }

  function renderProviders(): void {
    providersHost.innerHTML = ''
    for (const provider of providers) {
      const card = document.createElement('div')
      card.className = 'prov-card'

      const head = document.createElement('div')
      head.className = 'prov-head'
      const title = document.createElement('input')
      title.className = 'prov-name'
      title.value = provider.name
      title.addEventListener('input', () => {
        provider.name = title.value
        scheduleSave()
      })
      const test = document.createElement('button')
      test.type = 'button'
      test.className = 'btn small'
      test.textContent = 'Test'
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'btn small danger'
      remove.textContent = 'Remove'
      remove.addEventListener('click', () => {
        providers = providers.filter((p) => p.id !== provider.id)
        renderProviders()
        renderModels()
        scheduleSave()
      })
      head.append(title, test, remove)

      const apiRow = document.createElement('label')
      apiRow.className = 'prov-field'
      const apiLabel = document.createElement('span')
      apiLabel.textContent = 'Protocol'
      const apiSelect = document.createElement('select')
      for (const api of WIRE_APIS) {
        const opt = document.createElement('option')
        opt.value = api.id
        opt.textContent = api.label
        apiSelect.appendChild(opt)
      }
      apiSelect.value = provider.api
      apiSelect.addEventListener('change', () => {
        provider.api = apiSelect.value
        scheduleSave()
      })
      apiRow.append(apiLabel, apiSelect)

      const keyRow = document.createElement('label')
      keyRow.className = 'prov-field'
      const keyLabel = document.createElement('span')
      keyLabel.textContent = 'API Key'
      const keyInput = document.createElement('input')
      keyInput.type = 'password'
      keyInput.placeholder = provider.hasKey ? '•••••••• saved in keychain' : 'sk-…'
      keyInput.addEventListener('change', () => {
        const value = keyInput.value.trim()
        if (!value) return
        void window.api.providersKey(provider.id, value).then(() => {
          provider.hasKey = true
          keyInput.value = ''
          keyInput.placeholder = '•••••••• saved in keychain'
          opts.onAgentSettingsChanged()
        })
      })
      keyRow.append(keyLabel, keyInput)

      test.addEventListener('click', () => {
        test.disabled = true
        test.textContent = 'Testing…'
        void window.api.providersTest(provider.id).then((res) => {
          test.disabled = false
          test.textContent = 'Test'
          statusEl.textContent = `${provider.name}: ${res.message}`
        })
      })

      card.append(
        head,
        field('Base URL', provider.baseUrl, (v) => {
          provider.baseUrl = v
          scheduleSave()
        }),
        apiRow,
        keyRow
      )
      providersHost.appendChild(card)
    }
  }

  // ---- models -------------------------------------------------------------

  function nextOrder(): number {
    return providers.reduce((max, p) => p.models.reduce((m, x) => Math.max(m, x.order ?? 0), max), 0) + 1
  }

  /** Every model in one flat list, in the order the user arranged them. */
  function renderModels(): void {
    modelsHost.innerHTML = ''
    const rows = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
    rows.sort((a, b) => (a.model.order ?? 0) - (b.model.order ?? 0))

    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'muted small'
      empty.textContent = 'No models yet — add one below.'
      modelsHost.appendChild(empty)
      return
    }

    for (const { provider, model } of rows) {
      const card = document.createElement('div')
      card.className = 'prov-card'
      const head = document.createElement('div')
      head.className = 'prov-head'
      const title = document.createElement('input')
      title.className = 'prov-name'
      title.value = model.name
      title.addEventListener('input', () => {
        model.name = title.value
        scheduleSave()
      })
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'btn small danger'
      remove.textContent = 'Remove'
      remove.addEventListener('click', () => {
        provider.models = provider.models.filter((m) => m !== model)
        renderModels()
        scheduleSave()
      })
      head.append(title, remove)

      const providerRow = document.createElement('label')
      providerRow.className = 'prov-field'
      const providerLabel = document.createElement('span')
      providerLabel.textContent = 'Provider'
      const providerSelect = document.createElement('select')
      for (const candidate of providers) {
        const opt = document.createElement('option')
        opt.value = candidate.id
        opt.textContent = candidate.name
        providerSelect.appendChild(opt)
      }
      providerSelect.value = provider.id
      providerSelect.addEventListener('change', () => {
        const target = providers.find((p) => p.id === providerSelect.value)
        if (!target || target === provider) return
        provider.models = provider.models.filter((m) => m !== model)
        target.models.push(model)
        renderProviders()
        renderModels()
        scheduleSave()
      })
      providerRow.append(providerLabel, providerSelect)

      const inputs = document.createElement('div')
      inputs.className = 'prov-inputs'
      const inputLabel = document.createElement('span')
      inputLabel.textContent = 'Input'
      inputs.appendChild(inputLabel)
      for (const kind of ['text', 'image', 'video', 'audio'] as const) {
        const box = document.createElement('label')
        box.className = 'prov-check'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = model.input[kind]
        cb.addEventListener('change', () => {
          model.input[kind] = cb.checked
          scheduleSave()
        })
        const span = document.createElement('span')
        span.textContent = kind
        box.append(cb, span)
        inputs.appendChild(box)
      }

      card.append(
        head,
        providerRow,
        field('Model ID', model.id, (v) => {
          model.id = v
          scheduleSave()
        }),
        field('Context window', String(model.contextWindow), (v) => {
          model.contextWindow = Number(v.replace(/[^0-9]/g, '')) || model.contextWindow
          scheduleSave()
        }),
        field('Max output tokens', String(model.maxTokens), (v) => {
          model.maxTokens = Number(v.replace(/[^0-9]/g, '')) || model.maxTokens
          scheduleSave()
        }),
        inputs
      )
      modelsHost.appendChild(card)
    }
  }

  async function fillModelSelect(): Promise<void> {
    const models = await window.api.agentModels()
    const current = ((await window.api.getSettings('agentProvider')) as string) || ''
    const currentModel = ((await window.api.getSettings('agentModel')) as string) || ''
    defaultModelSelect.innerHTML = ''
    const none = document.createElement('option')
    none.value = ''
    none.textContent = 'First available'
    defaultModelSelect.appendChild(none)
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = `${m.provider}/${m.id}`
      opt.textContent = `${m.providerName} · ${m.name}`
      defaultModelSelect.appendChild(opt)
    }
    defaultModelSelect.value = current && currentModel ? `${current}/${currentModel}` : ''
  }

  async function loadProviders(): Promise<void> {
    providers = (await window.api.providersList()) as ProviderConfig[]
    renderProviders()
    renderModels()
    await fillModelSelect()
  }

  // ---- wiring -------------------------------------------------------------

  document.getElementById('settings-add-ollama')?.addEventListener('click', () => {
    const existing = providers.find((p) => isOllama(p))
    if (existing) {
      statusEl.textContent = `${existing.name} is already configured.`
      return
    }
    providers.push({
      id: 'ollama',
      name: 'Ollama (local)',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      hasKey: true, // local: no key needed
      models: []
    })
    renderProviders()
    renderModels()
    scheduleSave()
    statusEl.textContent = 'Ollama added — use “Import from Ollama” under Models to pull in your local models.'
  })

  document.getElementById('settings-import-pi')?.addEventListener('click', () => {
    void (async () => {
      const count = await window.api.providersSeed()
      statusEl.textContent = count
        ? `Imported ${count} provider${count === 1 ? '' : 's'} from ~/.pi/agent.`
        : 'Nothing found in ~/.pi/agent.'
      await loadProviders()
      opts.onAgentSettingsChanged()
    })()
  })

  document.getElementById('settings-add-provider')!.addEventListener('click', () => {
    const id = `provider-${providers.length + 1}`
    providers.push({ id, name: 'New provider', baseUrl: '', api: 'openai-completions', hasKey: false, models: [] })
    renderProviders()
    renderModels()
    scheduleSave()
  })

  document.getElementById('settings-add-model')?.addEventListener('click', () => {
    const provider = providers[0]
    if (!provider) {
      statusEl.textContent = 'Add a provider first.'
      return
    }
    provider.models.push({
      id: 'new-model',
      name: 'New model',
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
      input: { text: true, image: false, audio: false, video: false },
      order: nextOrder()
    })
    renderModels()
    scheduleSave()
  })

  // Pull the local Ollama models in, appending at the end (never reordering).
  document.getElementById('settings-import-ollama')?.addEventListener('click', () => {
    void (async () => {
      let ollama = providers.find((p) => isOllama(p))
      if (!ollama) {
        ollama = {
          id: 'ollama',
          name: 'Ollama (local)',
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          hasKey: true,
          models: []
        }
        providers.push(ollama)
        renderProviders()
      }
      const res = await window.api.providersOllama(ollama.baseUrl)
      statusEl.textContent = `Ollama: ${res.message}`
      if (!res.ok) return
      let order = nextOrder()
      let added = 0
      for (const name of res.models) {
        if (providers.some((p) => p.models.some((m) => m.id === name))) continue
        ollama.models.push({
          id: name,
          name,
          contextWindow: 32768,
          maxTokens: 8192,
          reasoning: false,
          input: { text: true, image: false, audio: false, video: false },
          order: order++
        })
        added++
      }
      if (added > 0) {
        renderModels()
        scheduleSave()
        statusEl.textContent = `Ollama: added ${added} model${added === 1 ? '' : 's'}.`
      }
    })()
  })

  // The Save button flushes the debounced writes right away.
  document.getElementById('settings-save')?.addEventListener('click', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    statusEl.textContent = 'Saving…'
    void window.api.providersSave(providers).then(() => {
      const total = providers.reduce((n, p) => n + p.models.length, 0)
      statusEl.textContent = `Saved — ${providers.length} provider(s), ${total} model(s).`
      void fillModelSelect()
      ;(window as any).__reloadModels?.()  // refresh the composer model picker
    })
  })

  defaultModelSelect.addEventListener('change', () => {
    const [provider, ...rest] = defaultModelSelect.value.split('/')
    void window.api.setSettings('agentProvider', provider || '')
    void window.api.setSettings('agentModel', rest.join('/') || '')
    opts.onAgentSettingsChanged()
  })

  thinkingSelect.addEventListener('change', () => {
    void window.api.setSettings('agentThinking', thinkingSelect.value)
    opts.onAgentSettingsChanged()
  })

  document.getElementById('settings-choose-workspace')!.addEventListener('click', () => {
    void (async () => {
      const res = await window.api.wsOpenWorkspace()
      if (res.ok && res.path) {
        workspacePathEl.textContent = res.path
        opts.onWorkspaceChanged()
      }
    })()
  })

  themeSelect.addEventListener('change', () => {
    void window.api.setSettings('theme', themeSelect.value)
    opts.onThemeChange(themeSelect.value)
  })

  fontSelect.addEventListener('change', () => {
    void window.api.setSettings('previewFont', resolveFontId(fontSelect.value))
    opts.onFontChange(fontSelect.value)
  })

  if (sizeSelect) {
    for (const [id, label] of [
      ['xs', 'Extra small'],
      ['s', 'Small'],
      ['m', 'Medium'],
      ['l', 'Large'],
      ['xl', 'Extra large']
    ] as const) {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = label
      sizeSelect.appendChild(opt)
    }
    sizeSelect.addEventListener('change', () => {
      void window.api.setSettings('renderFontSize', sizeSelect.value)
    })
  }

  if (countingSelect) {
    countingSelect.addEventListener('change', () => {
      const mode = countingSelect.value === 'asian' ? 'asian' : 'words'
      void window.api.setSettings('wordCountMode', mode)
      opts.onCountModeChange(mode)
    })
  }

  async function load(): Promise<void> {
    const w = (await window.api.wsGet()).workspace
    workspacePathEl.textContent = w ?? 'No workspace'
    themeSelect.value = ((await window.api.getSettings('theme')) as string) || 'light'
    fillFontSelect(fontSelect, (await window.api.getSettings('previewFont')) as string | undefined)
    if (sizeSelect) {
      sizeSelect.value = ((await window.api.getSettings('renderFontSize')) as string) || 'm'
    }
    if (countingSelect) {
      countingSelect.value =
        ((await window.api.getSettings('wordCountMode')) as string) === 'asian' ? 'asian' : 'words'
    }
    thinkingSelect.value = ((await window.api.getSettings('agentThinking')) as string) || 'max'
    await loadProviders()
    const models = await window.api.agentModels()
    const providerNames = [...new Set(models.map((m) => m.providerName))]
    statusEl.textContent = models.length
      ? `${models.length} model${models.length === 1 ? '' : 's'} across ${providerNames.length} provider${providerNames.length === 1 ? '' : 's'}.`
      : 'No models yet — add a provider and a model below.'
  }

  function show(): void {
    backdrop.hidden = false
    void load()
  }

  /** Returns the element it closed, so the shared dismissal pass (Escape, a
   *  click elsewhere) can close the modal too. */
  function close(): HTMLElement | null {
    if (backdrop.hidden) return null
    backdrop.hidden = true
    return backdrop
  }

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })
  document.getElementById('settings-close')?.addEventListener('click', () => {
    close()
  })

  // Cancel = discard whatever hasn't been flushed yet and reload from disk.
  document.getElementById('settings-cancel')?.addEventListener('click', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    void loadProviders().then(() => {
      statusEl.textContent = 'Reverted unsaved changes.'
    })
  })

  return { show, close }
}
