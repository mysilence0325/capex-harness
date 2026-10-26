/** Network bootstrap package generation for the arm64 Capex Harness payload. */

import {
  DEB_ARCHITECTURE,
  DEB_PACKAGE_NAME,
  debianVersion,
  renderControlFile,
  type DebianPackageMetadata,
} from './debian.ts'

/** Package installed by the small network bootstrap artifact. */
export const INSTALLER_PACKAGE_NAME = 'capex-harness-installer'

/** Runtime packages required by the bootstrap commands. */
export const INSTALLER_DEPENDS = ['apt', 'ca-certificates', 'coreutils', 'curl', 'util-linux'] as const

/** Optional scheduler integration installed on desktop systems. */
export const INSTALLER_RECOMMENDS = ['systemd'] as const

/** Root-only curl configuration containing the payload URL and credentials. */
export const INSTALLER_CURL_CONFIG_PATH = '/usr/lib/capex-harness-installer/curl.conf'

/** Non-secret expected payload metadata. */
export const INSTALLER_CONFIG_PATH = '/usr/lib/capex-harness-installer/config'

/** Background installer implementation. */
export const INSTALLER_RUNTIME_PATH = '/usr/lib/capex-harness-installer/install-payload'

/** Delayed scheduler called by postinst. */
export const INSTALLER_SCHEDULER_PATH = '/usr/lib/capex-harness-installer/schedule'

/** Atomic status writer shared by scheduler and installer. */
export const INSTALLER_STATUS_WRITER_PATH = '/usr/lib/capex-harness-installer/write-status'

/** User-facing manual retry command. */
export const INSTALLER_COMMAND_PATH = '/usr/bin/capex-harness-install'

/** User-facing status command. */
export const INSTALLER_STATUS_COMMAND_PATH = '/usr/bin/capex-harness-install-status'

/** Download cache and resumable payload location. */
export const INSTALLER_CACHE_DIR = '/var/cache/capex-harness-installer'

/** Persistent installer state and successful payload digest. */
export const INSTALLER_STATE_DIR = '/var/lib/capex-harness-installer'

/** Installer activity log. */
export const INSTALLER_LOG_PATH = '/var/log/capex-harness-installer.log'

/** Payload source and expected metadata embedded in one installer build. */
export interface InstallerPayload {
  readonly architecture: string
  readonly filename: string
  readonly password: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly url: string
  readonly user: string
  readonly version: string
}

/** One generated installer data file and its required mode. */
export interface InstallerFile {
  readonly path: string
  readonly content: string
  readonly mode: number
}

/**
 * Validate payload settings before writing them into a root-only installer.
 * @param payload - Payload source, credentials, and expected artifact identity.
 * @throws When the URL, digest, filename, size, or authentication fields are invalid.
 */
export function validateInstallerPayload(payload: InstallerPayload): void {
  let url: URL
  try {
    url = new URL(payload.url)
  } catch {
    throw new Error('installer payload URL is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('installer payload URL must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('installer payload URL must not contain credentials')
  }
  if (/[\0\r\n]/u.test(payload.url) || /[\0\r\n]/u.test(payload.user) || /[\0\r\n]/u.test(payload.password)) {
    throw new Error('installer payload URL and authentication fields must be single-line values')
  }
  if (payload.user === '' || payload.user.includes(':') || payload.password === '') {
    throw new Error('installer payload authentication requires a user without colon and a password')
  }
  if (!/^[0-9a-f]{64}$/iu.test(payload.sha256)) {
    throw new Error('installer payload SHA-256 must contain 64 hexadecimal characters')
  }
  if (!Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes <= 0) {
    throw new Error('installer payload size must be a positive safe integer')
  }
  if (
    payload.filename === ''
    || payload.filename !== payload.filename.split('/').at(-1)
    || !payload.filename.endsWith('.deb')
  ) {
    throw new Error('installer payload filename must be a basename ending in .deb')
  }
  if (decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !== payload.filename) {
    throw new Error('installer payload URL filename does not match the requested artifact')
  }
  if (!/^[0-9][0-9A-Za-z.+~]*$/u.test(payload.version) || payload.architecture === '') {
    throw new Error('installer payload version or architecture is invalid')
  }
}

/**
 * Build Debian metadata for the small network installer.
 * @param productVersion - Repository product version.
 * @param options - Maintainer and optional Debian revision.
 * @returns Control metadata for the network installer.
 */
export function deepseekHarnessInstallerPackage(
  productVersion: string,
  options: { readonly maintainer: string; readonly revision?: string },
): DebianPackageMetadata {
  return {
    name: INSTALLER_PACKAGE_NAME,
    version: debianVersion(productVersion, options.revision),
    architecture: DEB_ARCHITECTURE,
    maintainer: options.maintainer,
    depends: INSTALLER_DEPENDS,
    recommends: INSTALLER_RECOMMENDS,
    shortDescription: 'Network installer for the Capex Harness runtime',
    longDescription: [
      'Downloads the matching Capex Harness runtime package from the configured',
      'internal HTTP server, verifies its exact SHA-256 and Debian metadata, then',
      'installs it after the package-manager transaction that installed this',
      'bootstrap has completed.',
    ],
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function curlQuote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * Render non-secret payload metadata consumed by the installer scripts.
 * @param payload - Validated payload identity.
 * @returns POSIX shell assignments.
 */
export function renderInstallerConfig(payload: InstallerPayload): string {
  validateInstallerPayload(payload)
  return [
    '# Generated by the Capex Harness Debian installer builder.',
    `PAYLOAD_PACKAGE=${shellQuote(DEB_PACKAGE_NAME)}`,
    `PAYLOAD_ARCHITECTURE=${shellQuote(payload.architecture)}`,
    `PAYLOAD_VERSION=${shellQuote(payload.version)}`,
    `PAYLOAD_FILENAME=${shellQuote(payload.filename)}`,
    `PAYLOAD_SIZE=${shellQuote(String(payload.sizeBytes))}`,
    `PAYLOAD_SHA256=${shellQuote(payload.sha256.toLowerCase())}`,
    `PAYLOAD_USER=${shellQuote(payload.user)}`,
    `PAYLOAD_URL=${shellQuote(payload.url)}`,
    '',
  ].join('\n')
}

/**
 * Render the root-only curl configuration. Keeping the password here avoids
 * exposing it in process arguments while the downloader runs.
 * @param payload - Validated payload source and credentials.
 * @returns Curl configuration ending in one newline.
 */
export function renderInstallerCurlConfig(payload: InstallerPayload): string {
  validateInstallerPayload(payload)
  const partial = `${INSTALLER_CACHE_DIR}/${payload.filename}.part`
  return [
    `url = "${curlQuote(payload.url)}"`,
    `user = "${curlQuote(`${payload.user}:${payload.password}`)}"`,
    'anyauth',
    'location',
    'fail',
    'retry = "5"',
    'retry-delay = "3"',
    'retry-connrefused',
    'proto = "=http,https"',
    'proto-redir = "=http,https"',
    'continue-at = "-"',
    'silent',
    'show-error',
    'connect-timeout = "15"',
    `output = "${curlQuote(partial)}"`,
    '',
  ].join('\n')
}

function installerWriteStatus(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `. ${INSTALLER_CONFIG_PATH}`,
    `STATE_DIR=${shellQuote(INSTALLER_STATE_DIR)}`,
    'STATUS_FILE="$STATE_DIR/status.json"',
    'install -d -m 0755 "$STATE_DIR"',
    'status=$1',
    'message=$2',
    'now=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'temporary="$STATUS_FILE.tmp.$$"',
    'printf \'{"version":1,"status":"%s","message":"%s","payloadVersion":"%s","payloadSha256":"%s","updatedAt":"%s","log":"%s"}\\n\' \\',
    `  "$status" "$message" "$PAYLOAD_VERSION" "$PAYLOAD_SHA256" "$now" ${shellQuote(INSTALLER_LOG_PATH)} > "$temporary"`,
    'chmod 0644 "$temporary"',
    'mv -f "$temporary" "$STATUS_FILE"',
    '',
  ].join('\n')
}

function installerRuntime(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    '. /usr/lib/capex-harness-installer/config',
    `LOG=${shellQuote(INSTALLER_LOG_PATH)}`,
    `STATE_DIR=${shellQuote(INSTALLER_STATE_DIR)}`,
    `CACHE_DIR=${shellQuote(INSTALLER_CACHE_DIR)}`,
    `CURL_CONFIG=${shellQuote(INSTALLER_CURL_CONFIG_PATH)}`,
    `STATUS_WRITER=${shellQuote(INSTALLER_STATUS_WRITER_PATH)}`,
    'STATUS_FILE="$STATE_DIR/status.json"',
    'INSTALLED_MARKER="$STATE_DIR/installed.sha256"',
    'LOCK_FILE="$STATE_DIR/install.lock"',
    'DOWNLOAD_FILE="$CACHE_DIR/$PAYLOAD_FILENAME"',
    'PARTIAL_FILE="$DOWNLOAD_FILE.part"',
    'install -d -m 0755 "$STATE_DIR"',
    'install -d -m 0755 "$CACHE_DIR"',
    'install -d -m 0755 "$(dirname "$LOG")"',
    'touch "$LOG"',
    'chmod 0600 "$LOG"',
    'exec >> "$LOG" 2>&1',
    'status() { "$STATUS_WRITER" "$1" "$2"; }',
    'fail() {',
    '  status failed "$1"',
    '  logger -t capex-harness-installer "$1" 2>/dev/null || true',
    '  exit 1',
    '}',
    'if [ "$(id -u)" -ne 0 ]; then fail "The Capex Harness installer must run as root."; fi',
    'exec 9>"$LOCK_FILE"',
    'if ! flock -n 9; then fail "Another Capex Harness installation is already running."; fi',
    'if [ -f "$INSTALLED_MARKER" ] \\',
    '  && [ "$(cat "$INSTALLED_MARKER")" = "$PAYLOAD_SHA256" ] \\',
    `  && [ "$(dpkg-query -W -f='\${Version}' ${DEB_PACKAGE_NAME} 2>/dev/null || true)" = "$PAYLOAD_VERSION" ]; then`,
    '  status installed "Capex Harness is already installed from the expected payload."',
    '  exit 0',
    'fi',
    'status downloading "Downloading the Capex Harness payload."',
    'partial_size=0',
    'if [ -f "$PARTIAL_FILE" ]; then partial_size=$(stat -c %s "$PARTIAL_FILE"); fi',
    'required_kib=$(( (PAYLOAD_SIZE * 2 - partial_size + 67108863) / 1024 ))',
    'available_kib=$(df -Pk "$CACHE_DIR" | awk \'NR == 2 { print $4 }\')',
    'if [ -z "$available_kib" ] || [ "$available_kib" -lt "$required_kib" ]; then',
    '  fail "Insufficient disk space for the Capex Harness payload."',
    'fi',
    'if ! curl --config "$CURL_CONFIG"; then',
    '  fail "Payload download failed. Check the network and retry with: sudo capex-harness-install"',
    'fi',
    'actual_size=$(stat -c %s "$PARTIAL_FILE" 2>/dev/null || printf 0)',
    'if [ "$actual_size" != "$PAYLOAD_SIZE" ]; then',
    '  fail "Downloaded payload size does not match the expected size."',
    'fi',
    'status verifying "Verifying the downloaded payload."',
    'actual_sha256=$(sha256sum "$PARTIAL_FILE" | awk \'{ print $1 }\')',
    'if [ "$actual_sha256" != "$PAYLOAD_SHA256" ]; then',
    '  rm -f "$PARTIAL_FILE"',
    '  fail "Downloaded payload SHA-256 does not match the expected digest."',
    'fi',
    'mv -f "$PARTIAL_FILE" "$DOWNLOAD_FILE"',
    `if [ "$(dpkg-deb -f "$DOWNLOAD_FILE" Package 2>/dev/null || true)" != ${shellQuote(DEB_PACKAGE_NAME)} ] \\`,
    '  || [ "$(dpkg-deb -f "$DOWNLOAD_FILE" Version 2>/dev/null || true)" != "$PAYLOAD_VERSION" ] \\',
    '  || [ "$(dpkg-deb -f "$DOWNLOAD_FILE" Architecture 2>/dev/null || true)" != "$PAYLOAD_ARCHITECTURE" ]; then',
    '  fail "Downloaded payload Debian metadata does not match the installer."',
    'fi',
    'status installing "Installing the verified Capex Harness payload."',
    'if ! DEBIAN_FRONTEND=noninteractive apt-get \\',
    '  -o DPkg::Lock::Timeout=300 \\',
    '  install --reinstall -y --no-install-recommends "$DOWNLOAD_FILE"; then',
    '  fail "Payload installation failed. Retry with: sudo capex-harness-install"',
    'fi',
    `if [ "$(dpkg-query -W -f='\${Version}' ${DEB_PACKAGE_NAME} 2>/dev/null || true)" != "$PAYLOAD_VERSION" ]; then`,
    '  fail "Payload package is not installed at the expected version."',
    'fi',
    'printf \'%s\\n\' "$PAYLOAD_SHA256" > "$INSTALLED_MARKER"',
    'chmod 0600 "$INSTALLED_MARKER"',
    'rm -f "$DOWNLOAD_FILE" "$PARTIAL_FILE"',
    'status installed "Capex Harness payload installation completed."',
    '',
  ].join('\n')
}

/**
 * Render the postinst that schedules work but never installs packages directly.
 * @returns Maintainer script ending in one newline.
 */
export function installerPostinst(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'if [ "$1" = configure ]; then',
    `  ${INSTALLER_SCHEDULER_PATH}`,
    'fi',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Render the detached scheduler used after the installing dpkg transaction.
 * @returns Scheduler script ending in one newline.
 */
export function installerScheduler(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    '. /usr/lib/capex-harness-installer/config',
    `LOG=${shellQuote(INSTALLER_LOG_PATH)}`,
    `STATUS_WRITER=${shellQuote(INSTALLER_STATUS_WRITER_PATH)}`,
    'write_status() { "$STATUS_WRITER" "$1" "$2"; }',
    'if command -v systemctl >/dev/null 2>&1 \\',
    '  && systemctl is-active --quiet capex-harness-payload-install.service 2>/dev/null; then',
    '  write_status scheduled "The Capex Harness payload installation is already running."',
    '  exit 0',
    'fi',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl reset-failed capex-harness-payload-install.service >/dev/null 2>&1 || true',
    'fi',
    'if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then',
    '  if systemd-run \\',
    '    --unit=capex-harness-payload-install \\',
    '    --collect \\',
    '    --on-active=5s \\',
    '    --property=Type=oneshot \\',
    `    ${INSTALLER_RUNTIME_PATH} >/dev/null 2>&1; then`,
    '    write_status scheduled "Payload installation was scheduled."',
    '    exit 0',
    '  fi',
    'fi',
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid /bin/sh -c 'sleep 5; exec ${INSTALLER_RUNTIME_PATH}' >>"$LOG" 2>&1 </dev/null &`,
    '  write_status scheduled "Payload installation was scheduled without systemd."',
    '  exit 0',
    'fi',
    'write_status failed "No supported background scheduler is available. Run: sudo capex-harness-install"',
    'exit 1',
    '',
  ].join('\n')
}

function installerCommand(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'if [ "$(id -u)" -ne 0 ]; then',
    '  printf \'%s\\n\' "Run this command as root: sudo capex-harness-install" >&2',
    '  exit 1',
    'fi',
    `if ${INSTALLER_RUNTIME_PATH} "$@"; then exit_code=0; else exit_code=$?; fi`,
    `${INSTALLER_STATUS_COMMAND_PATH} || true`,
    'exit "$exit_code"',
    '',
  ].join('\n')
}

function installerStatusCommand(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `STATUS_FILE=${shellQuote(`${INSTALLER_STATE_DIR}/status.json`)}`,
    `LOG=${shellQuote(INSTALLER_LOG_PATH)}`,
    'if [ ! -f "$STATUS_FILE" ]; then',
    '  printf \'%s\\n\' "Capex Harness installer has not run yet."',
    '  printf \'%s\\n\' "Log: $LOG"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = --json ]; then cat "$STATUS_FILE"; exit 0; fi',
    'state=$(sed -n \'s/.*"status":"\\([^"]*\\)".*/\\1/p\' "$STATUS_FILE")',
    'message=$(sed -n \'s/.*"message":"\\([^"]*\\)".*/\\1/p\' "$STATUS_FILE")',
    'printf \'Capex Harness installer: %s\\n%s\\nLog: %s\\n\' "$state" "$message" "$LOG"',
    '',
  ].join('\n')
}

/**
 * Return every payload file installed by the network bootstrap package.
 * @param payload - Payload source and expected metadata.
 * @returns Files with the modes required by dpkg.
 */
export function installerDataFiles(payload: InstallerPayload): readonly InstallerFile[] {
  validateInstallerPayload(payload)
  return [
    { path: INSTALLER_CURL_CONFIG_PATH, content: renderInstallerCurlConfig(payload), mode: 0o600 },
    { path: INSTALLER_CONFIG_PATH, content: renderInstallerConfig(payload), mode: 0o600 },
    { path: INSTALLER_RUNTIME_PATH, content: installerRuntime(), mode: 0o755 },
    { path: INSTALLER_SCHEDULER_PATH, content: installerScheduler(), mode: 0o755 },
    { path: INSTALLER_STATUS_WRITER_PATH, content: installerWriteStatus(), mode: 0o755 },
    { path: INSTALLER_COMMAND_PATH, content: installerCommand(), mode: 0o755 },
    { path: INSTALLER_STATUS_COMMAND_PATH, content: installerStatusCommand(), mode: 0o755 },
  ]
}

/** Render the small package's Debian control file. */
export function renderInstallerControl(
  productVersion: string,
  options: { readonly maintainer: string; readonly revision?: string },
): string {
  return renderControlFile(deepseekHarnessInstallerPackage(productVersion, options))
}
