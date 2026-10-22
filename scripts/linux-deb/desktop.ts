/**
 * Desktop integration for the installed payload.
 *
 * The package ships an application-menu entry, the launcher that entry runs,
 * and the icon set they share, so a desktop user can open the web interface
 * without a terminal. The launcher also backs the optional desktop-icon helper
 * that copies the entry into the current user's desktop directory.
 */

import { DEB_INSTALL_ROOT } from './debian.ts'

/** Icon name the desktop entry looks up in the installed icon theme. */
export const DESKTOP_ICON_NAME = 'capex-harness'

/** Icon sizes installed into the hicolor theme, largest first. */
export const DESKTOP_ICON_SIZES = [512, 256, 128, 64, 48] as const

/** Application-menu entry installed by the package. */
export const DESKTOP_ENTRY_PATH = '/usr/share/applications/capex-harness-web.desktop'

/** Launcher the menu entry and desktop icon run. */
export const DESKTOP_LAUNCHER_PATH = '/usr/bin/dsh-web'

/** Helper that copies the menu entry into the invoking user's desktop directory. */
export const DESKTOP_ICON_HELPER_PATH = '/usr/bin/dsh-web-desktop-icon'

/** Helper that makes Capex the per-user handler for supported document types. */
export const DESKTOP_FILE_ASSOCIATION_HELPER_PATH = '/usr/bin/dsh-web-register-file-types'

/** MIME types handed to the in-app read-only document preview. */
export const DESKTOP_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/markdown',
  'text/plain',
  'text/csv',
] as const

/**
 * sed program that lifts the authenticated launch URL out of the server log.
 *
 * The launcher runs it inside single quotes, so the pattern keeps its own
 * backslashes; the token character class matches the URL the server prints.
 */
const LAUNCH_URL_PROGRAM = 's#.*\\(http://127\\.0\\.0\\.1:[0-9]*/?token=[A-Za-z0-9_-]*\\).*#\\1#p'

/** One file the package adds outside the install root. */
export interface PackageFile {
  /** Absolute path inside the package tree. */
  readonly path: string
  /** File content for generated text files. */
  readonly content?: string
  /** Builder-relative asset path copied byte for byte instead. */
  readonly source?: string
  /** Whether the file must be executable. */
  readonly executable?: boolean
}

/**
 * Launcher that opens the web interface for a desktop session.
 *
 * A stored launch URL that still answers is opened directly, so repeated clicks
 * focus the running server instead of starting a second one.
 * @returns Launcher script content.
 */
export function desktopLauncher(): string {
  return [
    '#!/bin/sh',
    '# Open the dsh web interface from a desktop session.',
    '#',
    '# The launch URL carries a one-time token whose exchange answers 303 with the',
    '# session cookie, so a stored URL that still answers can be reopened as-is.',
    'set -eu',
    `DSH_ROOT=${DEB_INSTALL_ROOT}`,
    'NODE="$DSH_ROOT/node/bin/node"',
    'BOOTSTRAP="$DSH_ROOT/dsh/runtime/node/runtime-bootstrap.mjs"',
    'STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/capex-harness"',
    'URL_FILE="$STATE_DIR/web-url"',
    'LOG_FILE="$STATE_DIR/web.log"',
    'mkdir -p "$STATE_DIR"',
    '',
    'open_in_browser() {',
    '  if command -v xdg-open >/dev/null 2>&1; then',
    '    xdg-open "$1" >/dev/null 2>&1 && return 0',
    '  fi',
    '  if command -v gio >/dev/null 2>&1; then',
    '    gio open "$1" >/dev/null 2>&1 && return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    'open_in_app() {',
    '  for browser in ${DSH_BROWSER:-} google-chrome google-chrome-stable chromium chromium-browser qaxbrowser; do',
    '    if command -v "$browser" >/dev/null 2>&1; then',
    '      "$browser" --app="$1" >/dev/null 2>&1 & return 0',
    '    fi',
    '  done',
    '  open_in_browser "$1"',
    '}',
    '',
    'launch_target() {',
    '  base_url=$1',
    '  input=${2:-}',
    '  if [ -z "$input" ]; then printf \'%s\\n\' "$base_url"; return 0; fi',
    `  "$NODE" -e 'const fs=require("node:fs");const p=require("node:path");const {fileURLToPath}=require("node:url");let input=process.argv[1];if(input.startsWith("file:"))input=fileURLToPath(input);else if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)){console.error("unsupported launch URI");process.exit(2)}const file=fs.realpathSync(p.resolve(input));if(!fs.statSync(file).isFile()){console.error("launch target is not a file");process.exit(2)}const url=new URL(process.argv[2]);url.searchParams.set("open",file);url.searchParams.set("workspace",p.dirname(file));process.stdout.write(url.href)' "$input" "$base_url"`,
    '}',
    'launch_input=${1:-}',
    '',
    'if [ -f "$URL_FILE" ]; then',
    '  running_url=$(cat "$URL_FILE" 2>/dev/null || true)',
    '  if [ -n "${running_url:-}" ] && "$NODE" -e "fetch(process.argv[1], { redirect: \'manual\' }).then(r => process.exit(r.status === 303 ? 0 : 1), () => process.exit(1))" "$running_url" 2>/dev/null; then',
    '    target_url=$(launch_target "$running_url" "$launch_input") || exit 1',
    '    open_in_app "$target_url" || printf \'dsh web is already running: %s\\n\' "$target_url"',
    '    exit 0',
    '  fi',
    'fi',
    '',
    ': > "$LOG_FILE"',
    'DSH_RESOURCE_CACHE="${DSH_RESOURCE_CACHE:-$DSH_ROOT/resources}" \\',
    '  nohup "$NODE" --expose-internals "$BOOTSTRAP" capex --no-open >> "$LOG_FILE" 2>&1 </dev/null &',
    'server_pid=$!',
    '',
    'attempt=0',
    'launch_url=',
    'while [ "$attempt" -lt 150 ]; do',
    `  launch_url=$(sed -n '${LAUNCH_URL_PROGRAM}' "$LOG_FILE" | head -1)`,
    '  [ -n "$launch_url" ] && break',
    '  kill -0 "$server_pid" 2>/dev/null || break',
    '  attempt=$((attempt + 1))',
    '  sleep 2',
    'done',
    '',
    'if [ -z "$launch_url" ]; then',
    '  printf \'dsh web did not start; see %s\\n\' "$LOG_FILE" >&2',
    '  exit 1',
    'fi',
    'printf \'%s\\n\' "$launch_url" > "$URL_FILE"',
    'target_url=$(launch_target "$launch_url" "$launch_input") || exit 1',
    'open_in_app "$target_url" || printf \'dsh web is running: %s\\n\' "$target_url"',
    '',
  ].join('\n')
}

/**
 * Desktop entry that starts the launcher without a terminal window.
 * @returns Desktop entry content.
 */
export function desktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Capex Harness',
    'Comment=Open the Capex Harness web interface',
    'Comment[zh_CN]=打开 Capex Harness Web 界面',
    `Exec=${DESKTOP_LAUNCHER_PATH} %U`,
    `Icon=${DESKTOP_ICON_NAME}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    `MimeType=${DESKTOP_MIME_TYPES.join(';')};`,
    'Keywords=dsh;deepseek;harness;agent;',
    'StartupNotify=true',
    '',
  ].join('\n')
}

/**
 * Helper that adds the menu entry to the current user's desktop directory.
 *
 * A desktop environment treats a copied entry as untrusted until its executable
 * bit and, where the file manager records metadata, its trusted flag are set.
 * @returns Helper script content.
 */
export function desktopIconHelper(): string {
  return [
    '#!/bin/sh',
    '# Copy the Capex Harness launcher onto the current user\'s desktop.',
    'set -eu',
    `entry=${DESKTOP_ENTRY_PATH}`,
    'if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then',
    '  printf \'run this as the desktop user, not with sudo\\n\' >&2',
    '  exit 1',
    'fi',
    'desktop_dir=',
    'if command -v xdg-user-dir >/dev/null 2>&1; then',
    '  desktop_dir=$(xdg-user-dir DESKTOP 2>/dev/null || true)',
    'fi',
    'if [ -z "$desktop_dir" ] || [ ! -d "$desktop_dir" ]; then',
    '  for candidate in "$HOME/Desktop" "$HOME/桌面"; do',
    '    if [ -d "$candidate" ]; then',
    '      desktop_dir=$candidate',
    '      break',
    '    fi',
    '  done',
    'fi',
    'if [ -z "$desktop_dir" ]; then',
    '  desktop_dir="$HOME/Desktop"',
    '  mkdir -p "$desktop_dir"',
    'fi',
    'target="$desktop_dir/capex-harness-web.desktop"',
    'cp -f "$entry" "$target"',
    'chmod 0755 "$target"',
    'if command -v gio >/dev/null 2>&1; then',
    '  gio set "$target" metadata::trusted true >/dev/null 2>&1 || true',
    'fi',
    'printf \'installed %s\\n\' "$target"',
    '',
  ].join('\n')
}

/** Helper that opts the current user into Capex document associations. */
export function desktopFileAssociationHelper(): string {
  return [
    '#!/bin/sh',
    '# Associate supported document types with Capex Harness for the current user.',
    'set -eu',
    'if [ "$(id -u)" -eq 0 ]; then',
    '  printf \'run this as the desktop user, not with root or sudo\\n\' >&2',
    '  exit 1',
    'fi',
    'if ! command -v xdg-mime >/dev/null 2>&1; then',
    '  printf \'xdg-mime is required to register document types\\n\' >&2',
    '  exit 1',
    'fi',
    `for type in ${DESKTOP_MIME_TYPES.join(' ')}; do`,
    `  xdg-mime default ${DESKTOP_ENTRY_PATH.split('/').at(-1)} "$type"`,
    'done',
    'printf \'registered Capex Harness as the preferred handler for supported documents\\n\'',
    '',
  ].join('\n')
}

/**
 * Files the package adds for desktop integration.
 * @returns Package files: launcher, helper, menu entry, and every icon size.
 */
export function desktopPackageFiles(): readonly PackageFile[] {
  return [
    { path: DESKTOP_LAUNCHER_PATH, content: desktopLauncher(), executable: true },
    { path: DESKTOP_ICON_HELPER_PATH, content: desktopIconHelper(), executable: true },
    { path: DESKTOP_FILE_ASSOCIATION_HELPER_PATH, content: desktopFileAssociationHelper(), executable: true },
    { path: DESKTOP_ENTRY_PATH, content: desktopEntry() },
    ...DESKTOP_ICON_SIZES.map(size => ({
      path: `/usr/share/icons/hicolor/${size}x${size}/apps/${DESKTOP_ICON_NAME}.png`,
      source: `resources/icons/${DESKTOP_ICON_NAME}-${size}.png`,
    })),
    { path: `/usr/share/pixmaps/${DESKTOP_ICON_NAME}.png`, source: `resources/icons/${DESKTOP_ICON_NAME}-512.png` },
  ]
}
