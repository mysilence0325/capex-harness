#!/usr/bin/env bash
# Check an installed capex-harness package on the machine that will run it.
#
# The builder cannot reach the target, so this script carries the checks it
# would otherwise run: architecture, glibc floor, the installed commands serving
# a turn with no network for their own resources, and the desktop shortcut a
# menu click runs. The capex profile is booted rather than only invoked with
# --help, because a mounted plugin whose dependencies are missing from the
# payload still leaves a listening server.
set -euo pipefail

FAILED=0

report() {
  printf '%-34s %s\n' "$1" "$2"
}

check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    report "$label" 'ok'
  else
    report "$label" 'FAILED'
    FAILED=1
  fi
}

# The launch URL `dsh web` prints carries a one-time token; exchanging it
# answers 303 with the session cookie, while a bare request answers 401.
launch_url() {
  sed -n 's#.*\(http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*\).*#\1#p' "$1" | head -1
}

# HTTP status of a URL, or `unknown` when the machine has no client to ask with.
http_status() {
  if command -v curl >/dev/null 2>&1; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>/dev/null) || true
    printf '%s' "${code:-000}"
    return 0
  fi
  if [ -x /usr/lib/capex-harness/node/bin/node ]; then
    /usr/lib/capex-harness/node/bin/node -e \
      'fetch(process.argv[1], { redirect: "manual" }).then(r => process.stdout.write(String(r.status)), () => process.stdout.write("000"))' \
      "$1" 2>/dev/null || printf '000'
    return 0
  fi
  printf 'unknown'
}

printf '== platform ==\n'
report 'uname -m' "$(uname -m)"
report 'getconf GNU_LIBC_VERSION' "$(getconf GNU_LIBC_VERSION)"
report 'dpkg -s capex-harness' "$(dpkg-query -W -f='${Version} ${Architecture}' capex-harness 2>/dev/null || printf 'not installed')"

printf '\n== kernel ==\n'
if [ -e /sys/kernel/security/landlock ]; then
  report 'landlock enforcing kernel' 'yes'
else
  report 'landlock enforcing kernel' 'not exposed; the payload then needs bubblewrap for sandbox modes'
fi

printf '\n== commands ==\n'
if [ -x /usr/bin/dsh ]; then
  check 'dsh --version' dsh --version
  check 'dsh web --help' dsh web --help
  check 'dsh doctor --quick' env DSH_HOME="$(mktemp -d)" dsh doctor --quick --no-report
  check 'dsh clean dry-run' env DSH_HOME="$(mktemp -d)" dsh clean --dry-run --json
else
  report 'dsh --version' 'not installed (python-only package)'
fi
check 'dsh-python --version' dsh-python --version
check 'import deepseek_harness' dsh-python -c 'import deepseek_harness'
check 'bundled authoring and development modules' env GIT_PYTHON_REFRESH=quiet dsh-python -c \
  'import docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, pypdfium2, reportlab, markdown, markdown_it, mdit_py_plugins, pymdownx, frontmatter, bs4, markdownify, xlrd, pyxlsb, python_calamine, olefile, msoffcrypto, defusedxml, requests, httpx, yaml, tomlkit, orjson, jsonschema, jinja2, click, typer, rich, tqdm, dotenv, filelock, tenacity, git, sqlalchemy, pytest, pydantic, scipy, matplotlib, seaborn, pyarrow, tabulate'
check 'dsh-pip --version' dsh-pip --version
if [ -x /usr/bin/dsh-office-convert ]; then
  check 'dsh-office-convert --help' dsh-office-convert --help
else
  report 'dsh-office-convert --help' 'not installed (python-only package)'
fi
report 'WPS word/sheet/slides' "$(command -v wps || true) $(command -v et || true) $(command -v wpp || true)"

printf '\n== native modules ==\n'
native_root=/usr/lib/capex-harness/dsh/runtime/node/node_modules
for file in \
  "$native_root/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node" \
  "$native_root/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node" \
  "$native_root/@deepseek-ai/node-addon-system-linux-arm64/bin/landlock-run" \
  "$native_root/node-pty/build/Release/pty.node"
do
  if [ -f "$file" ]; then
    report "$file" 'present'
  else
    report "$file" 'FAILED: missing native payload'
    FAILED=1
  fi
done
if ( cd /usr/lib/capex-harness/dsh/runtime/node && /usr/lib/capex-harness/node/bin/node --input-type=module -e '
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
  const file = path.join(os.tmpdir(), `capex-flock-${process.pid}`);
  const fd = fs.openSync(file, "w");
  try { await tryLockExclusive(fd); } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
'); then
  report 'system.node exclusive flock' 'ok'
else
  report 'system.node exclusive flock' 'FAILED: native addon did not lock a file'
  FAILED=1
fi

printf '\n== capex profile boot ==\n'
if [ -x /usr/bin/dsh ]; then
  boot_home=$(mktemp -d)
  boot_log=$(mktemp)
  DSH_HOME="$boot_home" dsh capex --no-open --port 0 >"$boot_log" 2>&1 &
  boot_pid=$!
  boot_state='timeout'
  boot_status=''
  for _ in $(seq 1 90); do
    boot_url=$(launch_url "$boot_log")
    if [ -n "$boot_url" ]; then
      boot_status=$(http_status "$boot_url")
      if [ "$boot_status" = '303' ] || [ "$boot_status" = 'unknown' ]; then
        boot_state='served'
        break
      fi
    fi
    if ! kill -0 "$boot_pid" 2>/dev/null; then
      boot_state='exited before serving'
      break
    fi
    sleep 2
  done
  kill "$boot_pid" 2>/dev/null || true
  wait "$boot_pid" 2>/dev/null || true
  if [ "$boot_state" = 'served' ] && [ "$boot_status" = 'unknown' ]; then
    report 'dsh capex serves the UI' 'ok (token exchange not checked: no HTTP client)'
  elif [ "$boot_state" = 'served' ]; then
    report 'dsh capex serves the UI' 'ok'
  else
    report 'dsh capex serves the UI' "FAILED: $boot_state"
    sed -n '1,40p' "$boot_log"
    FAILED=1
  fi
  # A loader entry whose plugin cannot resolve its own imports stays pending,
  # which the HTTP response does not reveal.
  if grep -qE 'did not activate|failed to import' "$boot_log"; then
    report 'dsh capex activates every plugin' 'FAILED: a mounted plugin did not activate'
    grep -E 'did not activate|failed to import' "$boot_log" | head -10
    FAILED=1
  else
    report 'dsh capex activates every plugin' 'ok'
  fi
  case "$boot_home" in
    "${TMPDIR:-/tmp}"/*) rm -rf "$boot_home" ;;
  esac
  rm -f "$boot_log"
else
    report 'dsh capex serves the UI' 'not installed (python-only package)'
fi

printf '\n== desktop shortcut ==\n'
if [ -x /usr/bin/dsh-web ]; then
  if [ -f /usr/share/applications/capex-harness-web.desktop ] \
    && grep -q '^Exec=/usr/bin/dsh-web %U$' /usr/share/applications/capex-harness-web.desktop \
    && grep -q '^MimeType=.*application/vnd.openxmlformats-officedocument.wordprocessingml.document' \
      /usr/share/applications/capex-harness-web.desktop \
    && grep -q '^Terminal=false$' /usr/share/applications/capex-harness-web.desktop; then
    report 'menu entry runs the launcher' 'ok'
  else
    report 'menu entry runs the launcher' 'FAILED: the entry is missing or does not run /usr/bin/dsh-web'
    FAILED=1
  fi
  if [ -f /usr/share/icons/hicolor/512x512/apps/capex-harness.png ]; then
    report 'application icon' 'ok'
  else
    report 'application icon' 'FAILED: the hicolor icon is missing'
    FAILED=1
  fi
  check 'launcher script parses' sh -n /usr/bin/dsh-web
  check 'file association helper parses' sh -n /usr/bin/dsh-web-register-file-types
  # A menu click runs this launcher, so the check runs the same script against a
  # stub default-browser entry: it must start the server, wait for the
  # authenticated URL, and preserve the desktop entry's security arguments.
  server_pattern='dsh/runtime/node/runtime-bootstrap.mjs capex'
  before_servers=$(pgrep -f "$server_pattern" 2>/dev/null | sort | tr '\n' ' ' || true)
  launcher_dir=$(mktemp -d)
  mkdir -p "$launcher_dir/bin" "$launcher_dir/home/.local/share/applications" "$launcher_dir/runtime" "$launcher_dir/state"
  printf '#!/bin/sh\nprintf "%%s\\n" qaxbrowser.desktop\n' > "$launcher_dir/bin/xdg-settings"
  printf '#!/bin/sh\nprintf "%%s\\n" qaxbrowser.desktop\n' > "$launcher_dir/bin/xdg-mime"
  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Name=QiAnXin Trusted Browser' \
    "Exec=\"$launcher_dir/qaxbrowser-safe-stable\" --flag-switches-begin --flag-switches-end --qax-dsi --qax-dws %U" \
    > "$launcher_dir/home/.local/share/applications/qaxbrowser.desktop"
  printf '%s\n' \
    '#!/bin/sh' \
    "count=\$(cat \"$launcher_dir/browser-count\" 2>/dev/null || printf 0)" \
    "printf '%s\\n' \"\$((count + 1))\" > \"$launcher_dir/browser-count\"" \
    "printf '%s\\n' \"\$@\" > \"$launcher_dir/opened-args\"" \
    'for arg in "$@"; do' \
    '  case "$arg" in' \
    "    --app=*) printf '%s\\n' \"\${arg#--app=}\" > \"$launcher_dir/opened-url\" ;;" \
    '  esac' \
    'done' \
    > "$launcher_dir/qaxbrowser-safe-stable"
  printf '%s\n' \
    '#!/bin/sh' \
    "if [ \"\$1\" = '-lpx' ]; then" \
    "  [ -f \"$launcher_dir/existing-window\" ] || exit 0" \
    "  printf '0x00a0003d  0 %s host qaxbrowser-safe.Qaxbrowser-safe test-host 简单问候 - Capex Harness\\n' \"\$PPID\"" \
    '  exit 0' \
    'fi' \
    "printf '%s\\n' \"\$@\" >> \"$launcher_dir/wmctrl-args\"" \
    > "$launcher_dir/bin/wmctrl"
  chmod 0755 "$launcher_dir/bin/xdg-settings" "$launcher_dir/bin/xdg-mime" \
    "$launcher_dir/bin/wmctrl" "$launcher_dir/qaxbrowser-safe-stable"
  mkdir -p "$launcher_dir/runtime"
  chmod 0700 "$launcher_dir/runtime"
  printf '%s\n' 'http://127.0.0.1:9/?token=stale-after-reboot' > "$launcher_dir/runtime/web-url"
  launcher_state='ran'
  if ! HOME="$launcher_dir/home" DSH_HOME="$launcher_dir/home/.dsh" DISPLAY=:0 \
    XDG_DATA_HOME="$launcher_dir/home/.local/share" XDG_RUNTIME_DIR="$launcher_dir/runtime" \
    XDG_STATE_HOME="$launcher_dir/state" PATH="$launcher_dir/bin:$PATH" \
    timeout 330 /usr/bin/dsh-web >"$launcher_dir/launcher.log" 2>&1; then
    launcher_state='failed'
  fi
  opened_url=$(cat "$launcher_dir/opened-url" 2>/dev/null || true)
  if [ "$launcher_state" != 'ran' ]; then
    report 'click starts dsh capex' 'FAILED: the launcher exited before serving'
    sed -n '1,20p' "$launcher_dir/launcher.log"
    if [ -f "$launcher_dir/state/capex-harness/web.log" ]; then
      report 'launcher web log' '---'
      sed -n '1,80p' "$launcher_dir/state/capex-harness/web.log"
    fi
    FAILED=1
  elif [ ! -s "$launcher_dir/opened-url" ]; then
    report 'click starts dsh capex' 'FAILED: no URL reached the browser'
    sed -n '1,20p' "$launcher_dir/launcher.log"
    if [ -f "$launcher_dir/state/capex-harness/web.log" ]; then
      report 'launcher web log' '---'
      sed -n '1,80p' "$launcher_dir/state/capex-harness/web.log"
    fi
    FAILED=1
  elif printf '%s\n' "$opened_url" | grep -Eq '^http://127\.0\.0\.1:[0-9]+/\?token='; then
    report 'click starts dsh capex' 'ok'
  else
    report 'click starts dsh capex' "FAILED: the opened URL is invalid: $opened_url"
    FAILED=1
  fi
  if [ -r "$launcher_dir/opened-url" ] && ! grep -q '127.0.0.1:9' "$launcher_dir/opened-url"; then
    report 'cold start replaces a stale reboot URL' 'ok'
  else
    report 'cold start replaces a stale reboot URL' 'FAILED: the launcher reused an unreachable post-reboot URL'
    FAILED=1
  fi
  if grep -Fxq -- '--flag-switches-begin' "$launcher_dir/opened-args" \
    && grep -Fxq -- '--flag-switches-end' "$launcher_dir/opened-args" \
    && grep -Fxq -- '--qax-dsi' "$launcher_dir/opened-args" \
    && grep -Fxq -- '--qax-dws' "$launcher_dir/opened-args" \
    && grep -q '^--app=' "$launcher_dir/opened-args"; then
    report 'launcher preserves default-browser arguments' 'ok'
  else
    report 'launcher preserves default-browser arguments' 'FAILED: QiAnXin argv was changed'
    FAILED=1
  fi
  if [ "$launcher_state" = 'ran' ] && [ -s "$launcher_dir/opened-url" ]; then
    # Leave the process token available for the second click: its Host probe
    # is what proves the saved URL still answers before wmctrl may focus.
    touch "$launcher_dir/existing-window"
    focus_state='ran'
    if ! HOME="$launcher_dir/home" DSH_HOME="$launcher_dir/home/.dsh" DISPLAY=:0 \
      XDG_DATA_HOME="$launcher_dir/home/.local/share" XDG_RUNTIME_DIR="$launcher_dir/runtime" \
      XDG_STATE_HOME="$launcher_dir/state" PATH="$launcher_dir/bin:$PATH" \
      timeout 15 /usr/bin/dsh-web >"$launcher_dir/focus.log" 2>&1; then
      focus_state='failed'
    fi
    browser_count=$(cat "$launcher_dir/browser-count" 2>/dev/null || printf 0)
    if [ "$focus_state" = 'ran' ] \
      && [ "$browser_count" = '1' ] \
      && grep -Fxq -- '-i' "$launcher_dir/wmctrl-args" \
      && grep -Fxq -- '0x00a0003d' "$launcher_dir/wmctrl-args" \
      && grep -Fxq -- 'remove,hidden' "$launcher_dir/wmctrl-args"; then
      report 'second click focuses the existing window' 'ok'
    else
      report 'second click focuses the existing window' \
        "FAILED: launcher exited=$focus_state browser launches=$browser_count"
      sed -n '1,20p' "$launcher_dir/focus.log"
      sed -n '1,40p' "$launcher_dir/wmctrl-args" 2>/dev/null || true
      FAILED=1
    fi
  else
    report 'second click focuses the existing window' 'FAILED: the first click did not leave a running Host'
    FAILED=1
  fi
  for pid in $(pgrep -f "$server_pattern" 2>/dev/null || true); do
    case " $before_servers " in
      *" $pid "*) ;;
      *) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  rm -rf "$launcher_dir"
else
  report 'desktop shortcut' 'not installed (python-only package)'
fi

printf '\n== seeded resources without network ==\n'
if DSH_HOME="${DSH_HOME:-$HOME/.dsh}" DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=1 dsh-sdk --version >/dev/null 2>&1; then
  report 'dsh-sdk --version (no downloads)' 'ok'
else
  report 'dsh-sdk --version (no downloads)' 'FAILED: the seeded resource cache did not serve the runtime'
  FAILED=1
fi

printf '\n'
if [ "$FAILED" = '0' ]; then
  printf 'all checks passed\n'
else
  printf 'some checks failed; report the output above\n'
fi
exit "$FAILED"
