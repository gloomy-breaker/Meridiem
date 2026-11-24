import { app } from 'electron'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Append one line to the app log (`<userData>/meridiem.log`).
 *
 * Main-process failures used to be swallowed silently, which made the agent
 * panel look healthy while its session was detached. Anything that can fail
 * quietly should leave a trace here.
 */
export async function logLine(message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  try {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    await appendFile(join(app.getPath('userData'), 'meridiem.log'), line, 'utf-8')
  } catch {
    /* logging must never break the app */
  }
  if (level === 'error') console.error(`[meridiem] ${message}`)
  else if (level === 'warn') console.warn(`[meridiem] ${message}`)
}
