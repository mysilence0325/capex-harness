import { describe, expect, it } from 'vitest'
import {
  INSTALLER_CURL_CONFIG_PATH,
  deepseekHarnessInstallerPackage,
  installerDataFiles,
  installerPostinst,
  installerScheduler,
  renderInstallerConfig,
  renderInstallerCurlConfig,
  validateInstallerPayload,
  type InstallerPayload,
} from '../installer.ts'
import { renderControlFile } from '../debian.ts'

const payload: InstallerPayload = {
  architecture: 'arm64',
  filename: 'capex-harness_0.2.1~rc.3_arm64.deb',
  password: "p'ass@word",
  sha256: 'a'.repeat(64),
  sizeBytes: 956602304,
  url: 'http://15.11.40.31:7009/public/capex/capex-harness_0.2.1~rc.3_arm64.deb',
  user: 'cape',
  version: '0.2.1~rc.3',
}

describe('installer package metadata', () => {
  it('keeps the installer separate from the payload package', () => {
    const metadata = deepseekHarnessInstallerPackage('0.2.1-rc.3', {
      maintainer: 'Test <test@example.invalid>',
    })
    const control = renderControlFile(metadata)

    expect(control).toContain('Package: capex-harness-installer\n')
    expect(control).toContain('Version: 0.2.1~rc.3\n')
    expect(control).toContain('Architecture: arm64\n')
    expect(control).toContain('Depends: ca-certificates, coreutils, curl, dpkg, util-linux\n')
    expect(control).toContain('Recommends: systemd\n')
    expect(control).not.toContain('Depends: capex-harness')
  })
})

describe('installer payload configuration', () => {
  it('rejects credentials embedded in the URL', () => {
    expect(() => {
      validateInstallerPayload({
        ...payload,
        url: 'http://cape:secret@15.11.40.31:7009/public/capex/payload.deb',
      })
    }).toThrow('must not contain credentials')
  })

  it('rejects unsupported protocols and malformed digests', () => {
    expect(() => {
      validateInstallerPayload({ ...payload, url: 'ftp://server/payload.deb' })
    }).toThrow('HTTP or HTTPS')
    expect(() => {
      validateInstallerPayload({ ...payload, sha256: 'abc' })
    }).toThrow('SHA-256')
  })

  it('renders a curl config without putting the password in argv', () => {
    const config = renderInstallerCurlConfig(payload)

    expect(config).toContain(`url = "${payload.url}"`)
    expect(config).toContain('user = "cape:p\'ass@word"')
    expect(config).toContain('proto = "=http,https"')
    expect(config).toContain('continue-at = "-"')
    expect(config).toContain('connect-timeout = "15"')
    expect(config).toContain('output = "/var/cache/capex-harness-installer/capex-harness_0.2.1~rc.3_arm64.deb.part"')
  })

  it('keeps credentials out of the non-secret shell configuration', () => {
    const config = renderInstallerConfig(payload)

    expect(config).toContain("PAYLOAD_USER='cape'")
    expect(config).toContain("PAYLOAD_VERSION='0.2.1~rc.3'")
    expect(config).not.toContain(payload.password)
  })

  it('escapes curl config values that contain quotes and backslashes', () => {
    const config = renderInstallerCurlConfig({
      ...payload,
      password: 'quote"slash\\value',
    })

    expect(config).toContain('user = "cape:quote\\"slash\\\\value"')
  })
})

describe('installer package files', () => {
  it('installs the commands and keeps credentials root-only', () => {
    const files = installerDataFiles(payload)
    const byPath = new Map(files.map(file => [file.path, file]))

    expect(byPath.get('/usr/bin/capex-harness-install')?.mode).toBe(0o755)
    expect(byPath.get('/usr/bin/capex-harness-install-status')?.mode).toBe(0o755)
    expect(byPath.get('/usr/lib/capex-harness-installer/install-payload')?.mode).toBe(0o755)
    expect(byPath.get('/usr/lib/capex-harness-installer/write-status')?.mode).toBe(0o755)
    expect(byPath.get('/usr/lib/capex-harness-installer/config')?.mode).toBe(0o600)
    expect(byPath.get('/usr/lib/capex-harness-installer/curl.conf')?.mode).toBe(0o600)
    expect(files.filter(file => file.content.includes(payload.password)).map(file => file.path)).toEqual([
      INSTALLER_CURL_CONFIG_PATH,
    ])
    expect(byPath.get('/usr/bin/capex-harness-install-status')?.content)
      .not.toContain('. /usr/lib/capex-harness-installer/config')
    expect(byPath.get('/usr/lib/capex-harness-installer/install-payload')?.content)
      .toContain('available_kib=$(df -Pk "$CACHE_DIR"')
    expect(byPath.get('/usr/lib/capex-harness-installer/install-payload')?.content)
      .not.toContain('print $4 * 1024')
  })

  it('schedules a detached install without nesting dpkg in postinst', () => {
    const postinst = installerPostinst()

    expect(postinst).toContain('/usr/lib/capex-harness-installer/schedule')
    expect(postinst).not.toContain('dpkg --install')
    expect(postinst).not.toContain('apt-get')
  })

  it('installs the verified payload with dpkg and requires a configured package', () => {
    const runtime = installerDataFiles(payload)
      .find(file => file.path === '/usr/lib/capex-harness-installer/install-payload')?.content

    expect(runtime).toContain('DEBIAN_FRONTEND=noninteractive dpkg -i "$DOWNLOAD_FILE"')
    expect(runtime).toContain('installed_status=$(dpkg-query -W -f=\'${Status}\' capex-harness 2>/dev/null || true)')
    expect(runtime).toContain('"$installed_status" != "install ok installed"')
    expect(runtime).not.toContain('apt-get install')
  })

  it('prefers systemd and retains a detached fallback', () => {
    const scheduler = installerScheduler()

    expect(scheduler).toContain('systemd-run')
    expect(scheduler).toContain('capex-harness-payload-install')
    expect(scheduler).toContain('setsid')
    expect(scheduler).toContain('status scheduled')
  })
})
