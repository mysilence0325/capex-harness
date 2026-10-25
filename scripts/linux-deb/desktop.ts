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

/** Normalize one desktop file argument and append it to the authenticated launch URL. */
const LAUNCH_TARGET_RUNTIME = [
  'const fs=require("node:fs");',
  'const p=require("node:path");',
  'const {fileURLToPath}=require("node:url");',
  'let input=process.argv[1];',
  'if(input.startsWith("file:"))input=fileURLToPath(input);',
  'else if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)){console.error("unsupported launch URI");process.exit(2)}',
  'const file=fs.realpathSync(p.resolve(input));',
  'if(!fs.statSync(file).isFile()){console.error("launch target is not a file");process.exit(2)}',
  'const url=new URL(process.argv[2]);',
  'url.searchParams.set("open",file);',
  'url.searchParams.set("workspace",p.dirname(file));',
  'process.stdout.write(url.href)',
].join('')

/**
 * Find the first Capex window owned by the invoking desktop user.
 *
 * `wmctrl -lpx` rows contain the window id, desktop, PID, host, class, and
 * title. The window class must name a known browser family. A Session may
 * prefix the product title, so the final hostname-neutral rule accepts either
 * the product title alone or a Session suffixed with it.
 * @param windows Output from `wmctrl -lpx`.
 * @param currentUid Numeric uid of the desktop user.
 * @param uidForPid Resolve a window's process owner.
 * @returns Matching X11 window id, if one exists.
 */
export function capexWindowId(
  windows: string,
  currentUid: number,
  uidForPid: (pid: number) => number | undefined,
): string | undefined {
  for (const line of windows.split(/\r?\n/u)) {
    const fields = /^(0x[0-9a-f]+)\s+\S+\s+(\d+)\s+\S+\s+(\S+)\s+(.+)$/iu.exec(line)
    if (!fields) continue
    const [, id, pidText, windowClass, title] = fields
    if (!id || !pidText || !windowClass || !title) continue
    if (!/(?:qaxbrowser|qianxin|chrome|chromium|firefox|microsoft-edge|brave)/iu.test(windowClass)) continue
    if (title !== 'Capex Harness' && !/(?:^|\s)[-–—]\s+Capex Harness$/u.test(title)) continue
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || pid <= 0 || uidForPid(pid) !== currentUid) continue
    return id
  }
  return undefined
}

/**
 * Resolve and optionally launch the system default browser.
 *
 * Desktop launchers pass the identifiers returned by `xdg-settings` and
 * `xdg-mime`. The runtime also accepts a direct `DSH_BROWSER` override,
 * preserves the desktop entry's arguments, and falls back to `xdg-open`.
 * @returns JavaScript runtime evaluated by the packaged Node.js executable.
 */
export function desktopBrowserResolverRuntime(): string {
  return [
    'const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{spawn,spawnSync}=require("node:child_process");',
    'const env=process.env;',
    'const home=env.HOME||os.homedir();',
    'const dataDirs=(env.XDG_DATA_DIRS||"/usr/local/share:/usr/share").split(":").filter(Boolean);',
    'const appDirs=[env.XDG_DATA_HOME&&path.join(env.XDG_DATA_HOME,"applications"),path.join(home,".local/share/applications"),...dataDirs.map(dir=>path.join(dir,"applications"))];',
    'const appFiles=[...new Set(appDirs)].flatMap(dir=>{try{return fs.readdirSync(dir).filter(name=>name.endsWith(".desktop")).map(name=>({id:name,file:path.join(dir,name)}))}catch{return[]}});',
    'function executable(file){try{return fs.statSync(file).isFile()&&(fs.accessSync(file,fs.constants.X_OK),fs.realpathSync(file))}catch{return undefined}}',
    'function fromPath(command){',
    '  if(!command)return undefined;',
    '  if(path.isAbsolute(command))return executable(command);',
    '  for(const dir of (env.PATH||"/usr/local/bin:/usr/bin:/bin").split(":")){',
    '    if(!dir)continue;',
    '    const found=executable(path.join(dir,command));',
    '    if(found)return found;',
    '  }',
    '  return undefined;',
    '}',
    `const capexWindowId=${capexWindowId.toString()};`,
    'function uidForPid(pid){',
    '  try{',
    '    const status=fs.readFileSync(`/proc/${pid}/status`,"utf8");',
    '    const match=/^Uid:\\s+(\\d+)/m.exec(status);',
    '    return match?Number(match[1]):undefined;',
    '  }catch{return undefined}',
    '}',
    'function focusCapexWindow(){',
    '  if(!env.DISPLAY)return false;',
    '  const wmctrl=fromPath("wmctrl");',
    '  if(!wmctrl)return false;',
    '  const listed=spawnSync(wmctrl,["-lpx"],{encoding:"utf8",timeout:2000});',
    '  if(listed.status!==0||typeof listed.stdout!=="string")return false;',
    '  const uid=process.getuid?.();',
    '  if(uid===undefined)return false;',
    '  const id=capexWindowId(listed.stdout,uid,uidForPid);',
    '  if(!id)return false;',
    '  spawnSync(wmctrl,["-i","-r",id,"-b","remove,hidden"],{encoding:"utf8",timeout:2000});',
    '  const activated=spawnSync(wmctrl,["-i","-a",id],{encoding:"utf8",timeout:2000});',
    '  return activated.status===0;',
    '}',
    'function tokens(line){',
    '  const out=[];let value="",quote="",escaped=false;',
    '  for(const char of line){',
    '    if(escaped){value+=char;escaped=false;continue}',
    '    if(char==="\\\\"&&quote!=="\\\'"){escaped=true;continue}',
    '    if(quote){if(char===quote)quote="";else value+=char;continue}',
    '    if(char==="\\\""||char==="\\\'"){quote=char;continue}',
    '    if(/\\s/.test(char)){if(value){out.push(value);value=""}continue}',
    '    value+=char;',
    '  }',
    '  if(value)out.push(value);',
    '  return out;',
    '}',
    'function fieldCode(value){return /^%[fFuUdDnNickvm]$/.test(value)}',
    'function command(text){',
    '  const match=/^Exec=(.*)$/m.exec(text);',
    '  if(!match)return undefined;',
    '  const words=tokens(match[1]);',
    '  while(words[0]==="env"||/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]??""))words.shift();',
    '  const executable=fromPath(words.shift());',
    '  if(!executable)return undefined;',
    '  return {command:executable,args:words.filter(word=>!fieldCode(word))};',
    '}',
    'function desktopEntry(entry){',
    '  try{',
    '    const text=fs.readFileSync(entry.file,"utf8");',
    '    return command(text);',
    '  }catch{return undefined}',
    '}',
    'function appMode(profile){',
    '  const name=path.basename(profile.command).toLowerCase();',
    '  return /(?:qaxbrowser|qianxin|chrome|chromium|microsoft-edge|brave)/.test(name);',
    '}',
    'function target(profile,url){',
    '  if(!profile)return undefined;',
    '  return {command:profile.command,args:[...profile.args,appMode(profile)?`--app=${url}`:url]};',
    '}',
    'function override(url){',
    '  const command=fromPath(env.DSH_BROWSER);',
    '  return command?{command,args:[`--app=${url}`]}:undefined;',
    '}',
    'function knownQianxin(url){',
    '  const wrapper=fromPath("/usr/bin/qaxbrowser-safe-stable");',
    '  if(wrapper)return {command:wrapper,args:[`--app=${url}`]};',
    '  const binary=fromPath("/opt/qianxin.com/qaxbrowser/qaxbrowser-safe");',
    '  if(binary)return {command:binary,args:["--flag-switches-begin","--flag-switches-end","--qax-dsi","--qax-dws",`--app=${url}`]};',
    '  for(const name of ["qaxbrowser","qianxin-browser"]){const command=fromPath(name);if(command)return {command,args:[`--app=${url}`]}}',
    '  return undefined;',
    '}',
    'function resolveBrowser(url){',
    '  if(env.DSH_BROWSER)return override(url);',
    '  const requested=process.argv.slice(2,-1).filter(id=>id.endsWith(".desktop"));',
    '  for(const id of requested){',
    '    const entry=appFiles.find(candidate=>candidate.id===id);',
    '    const found=entry&&target(desktopEntry(entry),url);',
    '    if(found)return found;',
    '  }',
    '  const qianxin=knownQianxin(url);',
    '  if(qianxin)return qianxin;',
    '  const opener=fromPath("xdg-open");',
    '  return opener?{command:opener,args:[url]}:undefined;',
    '}',
    'function main(){',
    '  const mode=process.argv[1];',
    '  if(mode==="focus"){process.exitCode=focusCapexWindow()?0:4;return}',
    '  const url=process.argv.at(-1);',
    '  const resolved=resolveBrowser(url);',
    '  if(!resolved){process.stderr.write("The default browser and xdg-open could not be resolved.\\n");process.exitCode=1;return}',
    '  if(mode==="resolve"){process.stdout.write(JSON.stringify(resolved));return}',
    '  if(mode!=="launch"){process.stderr.write("browser resolver mode must be focus, resolve, or launch\\n");process.exitCode=2;return}',
    '  const child=spawn(resolved.command,resolved.args,{detached:true,stdio:"ignore"});',
    '  child.on("error",error=>{process.stderr.write(`could not start ${resolved.command}: ${error.message}\\n`);process.exitCode=1});',
    '  child.unref();',
    '}',
    'main();',
  ].join('')
}

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
    '# The launch URL carries the process token whose exchange answers 303 with the',
    '# session cookie, so a stored URL that still answers can be reopened as-is.',
    'set -eu',
    'umask 077',
    `DSH_ROOT=${DEB_INSTALL_ROOT}`,
    'NODE="$DSH_ROOT/node/bin/node"',
    'BOOTSTRAP="$DSH_ROOT/dsh/runtime/node/runtime-bootstrap.mjs"',
    `BROWSER_RESOLVER_B64='${Buffer.from(desktopBrowserResolverRuntime()).toString('base64')}'`,
    'export BROWSER_RESOLVER_B64',
    'DSH_HOME="${DSH_HOME:-$HOME/.dsh}"',
    'export DSH_HOME',
    'STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/capex-harness"',
    'RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/capex-harness-$(id -u)}"',
    'URL_FILE="$RUNTIME_DIR/web-url"',
    'LOG_FILE="$STATE_DIR/web.log"',
    'mkdir -p "$STATE_DIR" "$RUNTIME_DIR"',
    'if [ ! -d "$RUNTIME_DIR" ] || [ "$(stat -c %u "$RUNTIME_DIR")" != "$(id -u)" ]; then',
    '  printf \'Capex runtime directory is not owned by the current user: %s\\n\' "$RUNTIME_DIR" >&2',
    '  exit 1',
    'fi',
    'chmod 700 "$RUNTIME_DIR"',
    '',
    'focus_existing_window() {',
    '  "$NODE" -e \'eval(Buffer.from(process.env.BROWSER_RESOLVER_B64, "base64").toString())\' focus >/dev/null 2>&1',
    '}',
    '',
    'open_in_app() {',
    '  default_web_browser=',
    '  if command -v xdg-settings >/dev/null 2>&1; then',
    '    default_web_browser=$(xdg-settings get default-web-browser 2>/dev/null || true)',
    '  fi',
    '  default_http_handler=',
    '  if command -v xdg-mime >/dev/null 2>&1; then',
    '    default_http_handler=$(xdg-mime query default x-scheme-handler/http 2>/dev/null || true)',
    '  fi',
    '  if ! browser_error=$("$NODE" -e \'eval(Buffer.from(process.env.BROWSER_RESOLVER_B64, "base64").toString())\' launch "$default_web_browser" "$default_http_handler" "$1" 2>&1); then',
    '    message=${browser_error:-"The default browser could not be opened. Set DSH_BROWSER to its executable."}',
    '  else',
    '    return 0',
    '  fi',
    '  if command -v notify-send >/dev/null 2>&1; then',
    '    notify-send "Capex Harness" "$message" >/dev/null 2>&1 || true',
    '  fi',
    '  printf \'%s\\n\' "$message" >&2',
    '  return 1',
    '}',
    '',
    'launch_target() {',
    '  base_url=$1',
    '  input=${2:-}',
    '  if [ -z "$input" ]; then printf \'%s\\n\' "$base_url"; return 0; fi',
    `  "$NODE" -e ${JSON.stringify(LAUNCH_TARGET_RUNTIME)} "$input" "$base_url"`,
    '}',
    'launch_input=${1:-}',
    '',
    'if [ -f "$URL_FILE" ]; then',
    '  running_url=$(cat "$URL_FILE" 2>/dev/null || true)',
    '  if [ -n "${running_url:-}" ] && "$NODE" -e "fetch(process.argv[1], { redirect: \'manual\' }).then(r => process.exit(r.status === 303 ? 0 : 1), () => process.exit(1))" "$running_url" 2>/dev/null; then',
    '    if [ -z "$launch_input" ] && focus_existing_window; then',
    '      exit 0',
    '    fi',
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
