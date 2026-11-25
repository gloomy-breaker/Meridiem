import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export const zoomMenuState = { outAt: 0, inAt: 0 }

function runZoom(dir: 1 | -1 | 0): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (dir === 0) {
    win.webContents.setZoomLevel(0)
    return
  }
  const zoom = win.webContents.getZoomLevel()
  win.webContents.setZoomLevel(Math.min(5, Math.max(-3, zoom + dir * 0.5)))
}

export function buildAppMenu(_onNewWindow: () => void, onCommand: (cmd: string) => void): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Meridiem',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Page', accelerator: 'CmdOrCtrl+N', click: () => onCommand('new-page') },
        { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: () => onCommand('open-workspace') },
        { label: 'Reveal Page in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: () => onCommand('reveal-page') },
        { type: 'separator' },
        { label: 'Save Now', accelerator: 'CmdOrCtrl+S', click: () => onCommand('save') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => onCommand('toggle-sidebar') },
        { label: 'Toggle Agent', accelerator: 'CmdOrCtrl+Shift+A', click: () => onCommand('toggle-agent') },
        { label: 'Toggle Source View', accelerator: 'CmdOrCtrl+Shift+E', click: () => onCommand('toggle-source') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => onCommand('nav-back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => onCommand('nav-forward') },
        { type: 'separator' as const },
        { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => onCommand('find') },
        { label: 'Search Workspace…', accelerator: 'CmdOrCtrl+Shift+F', click: () => onCommand('find-workspace') },
        { type: 'separator' as const },
        {
          label: 'Reload Window',
          accelerator: 'CmdOrCtrl+R',
          // Re-reads the renderer bundle (used to pick up app updates without
          // quitting). Open tabs and the current page are restored from settings.
          click: (_item, win) => {
            const wc = (win as unknown as { webContents?: { reload: () => void } } | undefined)?.webContents
            wc?.reload()
          }
        },
        { type: 'separator' as const },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => onCommand('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => onCommand('close-tab') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => onCommand('reopen-tab') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => onCommand('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => onCommand('prev-tab') },
        { type: 'separator' },
        { label: 'Cycle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => onCommand('cycle-theme') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Reset Zoom',
          accelerator: 'CommandOrControl+0',
          click: () => runZoom(0)
        },
        {
          // Custom rather than role:'zoomIn': the physical ⌘⇧= gesture never
          // reached the built-in accelerator, so zoom-in looked broken.
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          click: () => {
            zoomMenuState.inAt = Date.now()
            runZoom(1)
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => {
            zoomMenuState.outAt = Date.now()
            runZoom(-1)
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        { label: `Meridiem ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        // Was a dead "Meridiem on GitHub" item pointing at https://github.com/.
        // Nobody has a repo URL for this build, so the Help menu does something
        // real instead: open the folder holding settings and meridiem.log.
        {
          label: 'Open App Data Folder',
          click: () => void shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
