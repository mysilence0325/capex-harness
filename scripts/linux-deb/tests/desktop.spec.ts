import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ENTRY_PATH,
  DESKTOP_ICON_HELPER_PATH,
  DESKTOP_FILE_ASSOCIATION_HELPER_PATH,
  DESKTOP_ICON_NAME,
  DESKTOP_ICON_SIZES,
  DESKTOP_LAUNCHER_PATH,
  desktopEntry,
  desktopIconHelper,
  desktopFileAssociationHelper,
  DESKTOP_MIME_TYPES,
  desktopLauncher,
  desktopPackageFiles,
} from '../desktop.ts'

const pluginDirectory = join(import.meta.dirname, '..')

describe('desktopEntry', () => {
  it('runs the launcher without a terminal window', () => {
    const entry = desktopEntry()
    expect(entry).toContain('[Desktop Entry]')
    expect(entry).toContain('Type=Application')
    expect(entry).toContain(`Exec=${DESKTOP_LAUNCHER_PATH} %U\n`)
    expect(entry).toContain('Terminal=false\n')
    expect(entry).toContain('MimeType=application/pdf;')
  })

  it('looks up the installed icon and carries a localized comment', () => {
    const entry = desktopEntry()
    expect(entry).toContain(`Icon=${DESKTOP_ICON_NAME}\n`)
    expect(entry).toContain('Comment[zh_CN]=')
    expect(entry).toMatch(/^Categories=.*;$/mu)
  })

  it('ends with exactly one newline', () => {
    const entry = desktopEntry()
    expect(entry.endsWith('\n')).toBe(true)
    expect(entry.endsWith('\n\n')).toBe(false)
  })
})

describe('desktopLauncher', () => {
  const launcher = desktopLauncher()

  it('is a fail-fast POSIX shell script', () => {
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true)
    expect(launcher).toContain('set -eu\n')
  })

  it('reuses a stored launch URL through the token exchange', () => {
    expect(launcher).toContain("fetch(process.argv[1], { redirect: 'manual' })")
    expect(launcher).toContain('r.status === 303')
    expect(launcher).toContain('web-url')
  })

  it('starts the bundled CLI and waits for its authenticated URL', () => {
    expect(launcher).toContain('nohup "$NODE" --expose-internals "$BOOTSTRAP" capex --no-open')
    expect(launcher).toContain('http://127\\.0\\.0\\.1')
    expect(launcher).toContain('launch_url')
  })

  it('opens the browser through xdg-open with a gio fallback', () => {
    expect(launcher).toContain('command -v xdg-open')
    expect(launcher).toContain('command -v gio')
    expect(launcher).toContain('open_in_browser')
  })

  it('opens supported launches through a Chromium app window', () => {
    expect(launcher).toContain('--app="$1"')
    expect(launcher).toContain('qaxbrowser')
    expect(launcher).toContain('searchParams.set("open"')
    expect(launcher).toContain('searchParams.set("workspace"')
  })
})

describe('desktopFileAssociationHelper', () => {
  it('registers every supported MIME type for the current desktop user', () => {
    const helper = desktopFileAssociationHelper()
    expect(helper).toContain('xdg-mime default capex-harness-web.desktop')
    for (const type of DESKTOP_MIME_TYPES) expect(helper).toContain(type)
    expect(helper).toContain('run this as the desktop user')
  })
})

describe('desktopIconHelper', () => {
  it('refuses to run through sudo', () => {
    expect(desktopIconHelper()).toContain('SUDO_USER')
  })

  it('resolves the localized and English desktop directories', () => {
    const helper = desktopIconHelper()
    expect(helper).toContain('xdg-user-dir DESKTOP')
    expect(helper).toContain('"$HOME/Desktop"')
    expect(helper).toContain('"$HOME/桌面"')
  })

  it('models the entry as trusted where the file manager records that', () => {
    expect(desktopIconHelper()).toContain('metadata::trusted true')
  })
})

describe('desktopPackageFiles', () => {
  it('installs the menu entry, the launcher, the helper, and every icon size', () => {
    const paths = desktopPackageFiles().map(file => file.path)
    expect(paths).toContain(DESKTOP_ENTRY_PATH)
    expect(paths).toContain(DESKTOP_LAUNCHER_PATH)
    expect(paths).toContain(DESKTOP_ICON_HELPER_PATH)
    expect(paths).toContain(DESKTOP_FILE_ASSOCIATION_HELPER_PATH)
    for (const size of DESKTOP_ICON_SIZES) {
      expect(paths).toContain(`/usr/share/icons/hicolor/${size}x${size}/apps/${DESKTOP_ICON_NAME}.png`)
    }
    expect(paths).toContain(`/usr/share/pixmaps/${DESKTOP_ICON_NAME}.png`)
  })

  it('marks only the two scripts executable', () => {
    const executable = desktopPackageFiles()
      .filter(file => file.executable === true)
      .map(file => file.path)
      .sort()
    expect(executable).toEqual([
      DESKTOP_FILE_ASSOCIATION_HELPER_PATH,
      DESKTOP_ICON_HELPER_PATH,
      DESKTOP_LAUNCHER_PATH,
    ].sort())
  })

  it('sources every icon from artwork the builder can copy', () => {
    const assets = desktopPackageFiles().filter(file => file.source !== undefined)
    expect(assets.length).toBeGreaterThan(1)
    for (const asset of assets) {
      expect(existsSync(join(pluginDirectory, asset.source ?? ''))).toBe(true)
    }
  })
})
