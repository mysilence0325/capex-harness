import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capexWindowId,
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
  desktopBrowserResolverRuntime,
  desktopLauncher,
  desktopPackageFiles,
} from '../desktop.ts'

const pluginDirectory = join(import.meta.dirname, '..')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function runBrowserResolver(defaultBrowser: string, defaultHttpHandler: string, environment: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    '-e',
    desktopBrowserResolverRuntime(),
    'resolve',
    defaultBrowser,
    defaultHttpHandler,
    'http://127.0.0.1:3080/?token=test',
  ], {
    encoding: 'utf8',
    env: environment,
  })
}

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

  it('isolates each OS user\'s Host, runtime URL, and harness home', () => {
    expect(launcher).toContain('DSH_HOME="${DSH_HOME:-$HOME/.dsh}"')
    expect(launcher).toContain('RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/capex-harness-$(id -u)}"')
    expect(launcher).toContain('URL_FILE="$RUNTIME_DIR/web-url"')
    expect(launcher).toContain('stat -c %u "$RUNTIME_DIR"')
  })

  it("keeps the system default browser's complete QiAnXin launch arguments", () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-qaxbrowser-'))
    temporaryDirectories.push(home)
    const applications = join(home, '.local', 'share', 'applications')
    const browser = join(home, 'opt', 'qianxin', 'qaxbrowser-safe-stable')
    mkdirSync(applications, { recursive: true })
    mkdirSync(join(home, 'opt', 'qianxin'), { recursive: true })
    writeFileSync(browser, '#!/bin/sh\n')
    chmodSync(browser, 0o755)
    writeFileSync(join(applications, 'qaxbrowser.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=QiAnXin Trusted Browser',
      `Exec="${browser.replaceAll('\\', '/')}" --flag-switches-begin --flag-switches-end --qax-dsi --qax-dws %U`,
      '',
    ].join('\n'))

    const result = runBrowserResolver('qaxbrowser.desktop', '', {
      HOME: home,
      PATH: join(home, 'opt', 'qianxin'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      command: realpathSync(browser),
      args: [
        '--flag-switches-begin',
        '--flag-switches-end',
        '--qax-dsi',
        '--qax-dws',
        '--app=http://127.0.0.1:3080/?token=test',
      ],
    })
  })

  it('does not force app mode on a non-Chromium default browser', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-firefox-'))
    temporaryDirectories.push(home)
    const applications = join(home, '.local', 'share', 'applications')
    const browser = join(home, 'opt', 'firefox', 'firefox')
    mkdirSync(applications, { recursive: true })
    mkdirSync(join(home, 'opt', 'firefox'), { recursive: true })
    writeFileSync(browser, '#!/bin/sh\n')
    chmodSync(browser, 0o755)
    writeFileSync(join(applications, 'firefox.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Firefox',
      `Exec="${browser.replaceAll('\\', '/')}" %U`,
      '',
    ].join('\n'))

    const result = runBrowserResolver('firefox.desktop', '', {
      HOME: home,
      PATH: '/usr/bin:/bin',
      XDG_DATA_HOME: join(home, '.local', 'share'),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      command: realpathSync(browser),
      args: ['http://127.0.0.1:3080/?token=test'],
    })
  })

  it('honors an explicit browser override', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-browser-override-'))
    temporaryDirectories.push(home)
    const browser = join(home, 'custom-browser')
    writeFileSync(browser, '#!/bin/sh\n')
    chmodSync(browser, 0o755)

    const result = runBrowserResolver('', '', {
      DSH_BROWSER: browser,
      HOME: home,
      PATH: '/usr/bin:/bin',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      command: realpathSync(browser),
      args: ['--app=http://127.0.0.1:3080/?token=test'],
    })
  })

  it('falls back to xdg-open when no browser entry can be resolved', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-xdg-open-'))
    temporaryDirectories.push(home)
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'xdg-open'), '#!/bin/sh\n')
    chmodSync(join(bin, 'xdg-open'), 0o755)

    const result = runBrowserResolver('', '', {
      HOME: home,
      PATH: bin,
      XDG_DATA_DIRS: join(home, 'empty'),
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      command: realpathSync(join(bin, 'xdg-open')),
      args: ['http://127.0.0.1:3080/?token=test'],
    })
  })

  it('opens supported launches through the default browser app window', () => {
    expect(launcher).toContain(' launch "$default_web_browser" "$default_http_handler" "$1"')
    expect(launcher).toContain('BROWSER_RESOLVER_B64=')
    expect(launcher).toContain('eval(Buffer.from(process.env.BROWSER_RESOLVER_B64, "base64").toString())')
    expect(launcher).toContain('notify-send "Capex Harness"')
    expect(launcher).toContain('searchParams.set(\\"open\\"')
    expect(launcher).toContain('searchParams.set(\\"workspace\\"')
  })

  it('focuses an existing window only when no document was passed', () => {
    expect(launcher).toContain('if [ -z "$launch_input" ] && focus_existing_window; then')
    expect(launcher).toContain('launch_input=${1:-}')
    expect(launcher).toContain('focus_existing_window')
  })

  it('focuses only after proving the running Host still answers', () => {
    const runningHost = launcher.indexOf('r.status === 303')
    const focus = launcher.indexOf('if [ -z "$launch_input" ] && focus_existing_window; then')
    const coldStart = launcher.indexOf('nohup "$NODE"')

    expect(runningHost).toBeGreaterThan(-1)
    expect(focus).toBeGreaterThan(runningHost)
    expect(focus).toBeLessThan(coldStart)
  })
})

describe('capexWindowId', () => {
  it('selects the current user\'s Capex Harness window', () => {
    const windows = [
      '0x00a0001f  0 6100 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S 北信源安全保密套件管理系统-奇安信可信浏览器',
      '0x00a0003d  0 6200 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S 简单问候 - Capex Harness',
      '0x00a0004e  0 6300 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S 另一会话 — Capex Harness',
    ].join('\n')

    expect(capexWindowId(windows, 1000, pid => pid >= 6200 ? 1000 : 1001)).toBe('0x00a0003d')
  })

  it('ignores other users and windows without the product title suffix', () => {
    const windows = [
      '0x00a0001f  0 6100 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S Capex Harness',
      '0x00a0002d  0 6200 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S 北信源安全保密套件管理系统-奇安信可信浏览器',
    ].join('\n')

    expect(capexWindowId(windows, 1000, pid => pid === 6200 ? 1000 : 1001)).toBeUndefined()
  })

  it('rejects malformed and unrelated window rows', () => {
    const windows = [
      'not a wmctrl row',
      '0x00a0001f  0 0 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S Capex Harness',
      '0x00a0002d  0 6200 host qaxbrowser-safe.Qaxbrowser-safe GCH-zhoulh-S Capex Harness archive',
      '0x00a0003e  0 6300 host mate-terminal.Mate-terminal GCH-zhoulh-S 简单问候 - Capex Harness',
    ].join('\n')

    expect(capexWindowId(windows, 1000, () => 1000)).toBeUndefined()
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
