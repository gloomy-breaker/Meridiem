// ---------------------------------------------------------------------------
// First-run onboarding.
//
// One screen, one provider, one model: base URL, protocol, key, model id,
// model name. That is everything the agent needs to start, and nothing about
// it depends on software already installed on the machine — Meridiem talks to
// the endpoint directly (through its own main process) and stores the key in
// the macOS keychain.
// ---------------------------------------------------------------------------
const PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    modelId: 'deepseek-flash',
    modelName: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
    modelId: 'gpt-4o-mini',
    modelName: 'GPT-4o mini',
    contextWindow: 128000
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
    modelId: 'claude-sonnet-4-5',
    modelName: 'Claude Sonnet 4.5',
    contextWindow: 200000
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    modelId: 'anthropic/claude-sonnet-4.5',
    modelName: 'Claude Sonnet 4.5',
    contextWindow: 200000
  },
  {
    id: 'groq',
    label: 'Groq',
    provider: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai-completions',
    modelId: 'llama-3.3-70b-versatile',
    modelName: 'Llama 3.3 70B',
    contextWindow: 128000
  },
  {
    id: 'google',
    label: 'Google',
    provider: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    api: 'google-generative-ai',
    modelId: 'gemini-2.0-flash',
    modelName: 'Gemini 2.0 Flash',
    contextWindow: 1000000
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    provider: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    modelId: 'qwen2.5-coder:7b',
    modelName: 'Qwen2.5 Coder 7B',
    contextWindow: 32000
  }
] as const

export interface OnboardingOpts {
  /** Called once the provider/model exist, so the panel can pick them up. */
  onConfigured: () => void
}

export function setupOnboarding(opts: OnboardingOpts): { maybeShow: () => Promise<boolean>; show: () => void } {
  const overlay = document.getElementById('onboarding') as HTMLElement
  const chips = document.getElementById('ob-preset-row') as HTMLElement
  const baseUrl = document.getElementById('ob-baseurl') as HTMLInputElement
  const api = document.getElementById('ob-api') as HTMLSelectElement
  const key = document.getElementById('ob-key') as HTMLInputElement
  const modelId = document.getElementById('ob-model-id') as HTMLInputElement
  const modelName = document.getElementById('ob-model-name') as HTMLInputElement
  const providerName = document.getElementById('ob-provider-name') as HTMLInputElement
  const context = document.getElementById('ob-context') as HTMLInputElement
  const status = document.getElementById('ob-status') as HTMLElement
  const testBtn = document.getElementById('ob-test') as HTMLButtonElement
  const startBtn = document.getElementById('ob-start') as HTMLButtonElement

  let chosen = 'deepseek'

  function applyPreset(id: string): void {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    chosen = id
    baseUrl.value = preset.baseUrl
    api.value = preset.api
    modelId.value = preset.modelId
    modelName.value = preset.modelName
    providerName.value = preset.provider
    context.value = String(preset.contextWindow)
    status.textContent = ''
    for (const chip of chips.querySelectorAll<HTMLButtonElement>('.ob-chip')) {
      chip.classList.toggle('on', chip.dataset.id === id)
    }
  }

  for (const preset of PRESETS) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'ob-chip'
    chip.dataset.id = preset.id
    chip.textContent = preset.label
    chip.addEventListener('click', () => applyPreset(preset.id))
    chips.appendChild(chip)
  }
  applyPreset('deepseek')

  function readForm(): { provider: string; baseUrl: string; api: string; key: string; modelId: string; modelName: string; contextWindow: number } {
    return {
      provider: providerName.value.trim() || 'Provider',
      baseUrl: baseUrl.value.trim(),
      api: api.value,
      key: key.value.trim(),
      modelId: modelId.value.trim(),
      modelName: modelName.value.trim() || modelId.value.trim(),
      contextWindow: Number(context.value.replace(/[^0-9]/g, '')) || 128000
    }
  }

  testBtn.addEventListener('click', () => {
    const form = readForm()
    if (!form.baseUrl || !form.modelId) {
      status.textContent = 'Fill in the base URL and the model id first.'
      return
    }
    testBtn.disabled = true
    testBtn.textContent = 'Testing…'
    void window.api
      .providersTestDraft({ baseUrl: form.baseUrl, api: form.api, key: form.key, modelId: form.modelId })
      .then((res) => {
        status.textContent = res.message
      })
      .finally(() => {
        testBtn.disabled = false
        testBtn.textContent = 'Test connection'
      })
  })

  startBtn.addEventListener('click', () => {
    void (async () => {
      const form = readForm()
      if (!form.baseUrl || !form.modelId) {
        status.textContent = 'Base URL and model id are required.'
        return
      }
      startBtn.disabled = true
      startBtn.textContent = 'Setting up…'
      try {
        const id = chosen && PRESETS.some((p) => p.id === chosen) ? chosen : slug(form.provider)
        const provider = {
          id,
          name: form.provider,
          baseUrl: form.baseUrl,
          api: form.api,
          models: [
            {
              id: form.modelId,
              name: form.modelName,
              contextWindow: form.contextWindow,
              maxTokens: Math.min(8192, form.contextWindow),
              reasoning: false,
              input: { text: true, image: false, audio: false, video: false }
            }
          ]
        }
        await window.api.providersSave([provider])
        if (form.key) await window.api.providersKey(id, form.key)
        await window.api.setSettings('agentProvider', id)
        await window.api.setSettings('agentModel', form.modelId)
        await window.api.setSettings('onboarded', true)
        key.value = ''
        overlay.hidden = true
        opts.onConfigured()
      } catch (err) {
        status.textContent = 'Could not save: ' + String((err as Error)?.message ?? err)
      } finally {
        startBtn.disabled = false
        startBtn.textContent = 'Start using Meridiem'
      }
    })()
  })

  document.getElementById('ob-skip')!.addEventListener('click', () => {
    void window.api.setSettings('onboarded', true)
    overlay.hidden = true
  })

  function show(): void {
    overlay.hidden = false
    requestAnimationFrame(() => baseUrl.focus())
  }

  async function maybeShow(): Promise<boolean> {
    const done = (await window.api.getSettings('onboarded')) as boolean | undefined
    if (done) return false
    const providers = await window.api.providersList()
    if (providers.length > 0) {
      // Already configured (e.g. upgraded from a pi setup) — don't nag.
      await window.api.setSettings('onboarded', true)
      return false
    }
    show()
    return true
  }

  return { maybeShow, show }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'provider'
  )
}
