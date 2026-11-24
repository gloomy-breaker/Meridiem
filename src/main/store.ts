import { app } from 'electron'
import { copyFileSync, cpSync, existsSync, mkdirSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

// Dev/test isolation: a second copy of the app can run against throwaway state
// (its own settings + workspace) without disturbing the real installation.
// Must happen before any electron-store instance is created. The YESTION_*
// name is still accepted so existing dev scripts keep working.
const userDataOverride = process.env.MERIDIEM_USER_DATA ?? process.env.YESTION_USER_DATA
// Pin the folder to the product name. Electron's very early default can still
// be the package name (`meridiem`) while the running app later reports
// `Meridiem`; without this, the same launch can end up with two case-variant
// data folders and settings split between them.
app.setPath('userData', userDataOverride ?? join(app.getPath('appData'), 'Meridiem'))

/**
 * One-time migration from the Yestion-era user-data folder.
 *
 * The app id/name changed with the Meridiem rebrand, so Electron now points
 * `userData` at a new folder. The user's workspace list and provider setup
 * should not disappear just because the product was renamed. Copy only the
 * durable app state (settings, agent config, private-workspace keys), never the
 * caches. The workspace folders themselves are untouched.
 */
function migrateLegacyUserData(): void {
  const current = app.getPath('userData')
  const legacy = join(app.getPath('appData'), 'yestion')
  if (current === legacy) return
  if (existsSync(join(current, 'settings.json'))) return
  if (!existsSync(join(legacy, 'settings.json'))) return
  try {
    mkdirSync(current, { recursive: true })
    copyFileSync(join(legacy, 'settings.json'), join(current, 'settings.json'))
    for (const dir of ['agent', 'vaults']) {
      const from = join(legacy, dir)
      if (existsSync(from)) cpSync(from, join(current, dir), { recursive: true })
    }
  } catch (err) {
    // A failed migration must never stop the app from booting; the user simply
    // starts with defaults and can re-add the workspace.
    console.error('Failed to migrate Yestion user data', err)
  }
}
migrateLegacyUserData()

/** A workspace the user has added to the switcher. */
export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'plain' | 'private'
}

export interface Settings {
  workspace: string | null
  workspaces: WorkspaceEntry[]
  theme: string
  previewFont: string
  agentProvider: string
  agentModel: string
  agentApiKey: string
  agentThinking: string
  sidebarOpen: boolean
  agentOpen: boolean
  sidebarWidth: number
  agentWidth: number
  /** Sidebar model: 'links' (children = link targets) or 'folders'. */
  treeMode: 'links' | 'folders'
  pageMode: 'continuous' | 'paged'
  showPageTitle: boolean
  showPageIcon: boolean
  renderFontSize: string
  splitRatio: number
  exportMargin: 'thin' | 'medium' | 'wide'
  exportTitle: boolean
  exportIcon: boolean
}

const DEFAULTS: Settings = {
  workspace: null,
  workspaces: [],
  theme: 'light',
  previewFont: 'default',
  agentProvider: 'anthropic',
  agentModel: '',
  agentApiKey: '',
  agentThinking: 'max',
  sidebarOpen: true,
  agentOpen: false,
  sidebarWidth: 248,
  agentWidth: 380,
  treeMode: 'links',
  pageMode: 'continuous',
  showPageTitle: true,
  showPageIcon: true,
  renderFontSize: 'm',
  splitRatio: 0.5,
  exportMargin: 'medium',
  exportTitle: true,
  exportIcon: true
}

const SETTINGS_FILE = 'settings.json'

class SettingsStore {
  private cache: Settings = { ...DEFAULTS }
  private file: string
  private loaded: Promise<void>
  /** Keys written before load() resolved — these must win over the file. */
  private touched = new Set<keyof Settings>()

  constructor() {
    this.file = join(app.getPath('userData'), SETTINGS_FILE)
    this.loaded = this.load()
  }

  private async load(): Promise<void> {
    let parsed: Partial<Settings> = {}
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf-8')) as Partial<Settings>
    } catch {
      // First run, or an unreadable/corrupt file: keep the defaults.
    }
    const merged: Settings = { ...DEFAULTS, ...parsed }
    // A set() that ran while this load was in flight must not be clobbered by
    // the file we just read (boot writes theme/tabs before the read resolves).
    for (const key of this.touched) {
      (merged as unknown as Record<string, unknown>)[key] = this.cache[key]
    }
    this.cache = merged
  }

  /** Resolves once the on-disk settings have been merged in. */
  ready(): Promise<void> {
    return this.loaded
  }

  getAll(): Settings {
    return { ...this.cache }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.cache[key]
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.touched.add(key)
    this.cache[key] = value
    void this.persist()
  }

  setMany(patch: Partial<Settings>): void {
    for (const [key, value] of Object.entries(patch)) {
      this.touched.add(key as keyof Settings)
      ;(this.cache as unknown as Record<string, unknown>)[key] = value
    }
    void this.persist()
  }

  private async persist(): Promise<void> {
    await this.loaded
    try {
      await fs.mkdir(app.getPath('userData'), { recursive: true })
      await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to persist settings', err)
    }
  }
}

export const settingsStore = new SettingsStore()
