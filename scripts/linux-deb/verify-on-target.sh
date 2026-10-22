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
check 'bundled authoring and development modules' dsh-python -c \
  'import docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, pypdfium2, reportlab, markdown, markdown_it, mdit_py_plugins, pymdownx, frontmatter, bs4, markdownify, xlrd, pyxlsb, python_calamine, olefile, msoffcrypto, defusedxml, requests, httpx, yaml, tomlkit, orjson, jsonschema, jinja2, click, typer, rich, tqdm, dotenv, filelock, tenacity, git, sqlalchemy, pytest, pydantic, scipy, matplotlib, seaborn, pyarrow, tabulate'
check 'dsh-pip --version' dsh-pip --version
if [ -x /usr/bin/dsh-office-convert ]; then
  check 'dsh-office-convert --help' dsh-office-convert --help
else
  report 'dsh-office-convert --help' 'not installed (python-only package)'
fi
report 'WPS word/sheet/slides' "$(command -v wps || true) $(command -v et || true) $(command -v wpp || true)"

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
  # stub browser: it must start the server, wait for the authenticated URL, and
  # hand that URL to the browser. The temporary HOME and state directory keep
  # the check out of the invoking user's files.
  server_pattern='dsh/runtime/node/runtime-bootstrap.mjs capex'
  before_servers=$(pgrep -f "$server_pattern" 2>/dev/null | sort | tr '\n' ' ' || true)
  launcher_dir=$(mktemp -d)
  mkdir -p "$launcher_dir/home" "$launcher_dir/state"
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" > "%s"\n' "$launcher_dir/opened-url" > "$launcher_dir/xdg-open"
  chmod 0755 "$launcher_dir/xdg-open"
  launcher_state='ran'
  if ! HOME="$launcher_dir/home" XDG_STATE_HOME="$launcher_dir/state" PATH="$launcher_dir:$PATH" \
    timeout 330 /usr/bin/dsh-web >"$launcher_dir/launcher.log" 2>&1; then
    launcher_state='failed'
  fi
  # The probe asks the server the launcher left running, so it runs before that
  # server is stopped.
  opened_url=$(cat "$launcher_dir/opened-url" 2>/dev/null || true)
  opened_status='000'
  if [ -n "$opened_url" ]; then
    opened_status=$(http_status "$opened_url")
  fi
  for pid in $(pgrep -f "$server_pattern" 2>/dev/null || true); do
    case " $before_servers " in
      *" $pid "*) ;;
      *) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  if [ "$launcher_state" != 'ran' ]; then
    report 'click starts dsh capex' 'FAILED: the launcher exited before serving'
    sed -n '1,20p' "$launcher_dir/launcher.log"
    FAILED=1
  elif [ ! -s "$launcher_dir/opened-url" ]; then
    report 'click starts dsh capex' 'FAILED: no URL reached the browser'
    sed -n '1,20p' "$launcher_dir/launcher.log"
    FAILED=1
  elif [ "$opened_status" = '303' ] || [ "$opened_status" = 'unknown' ]; then
    report 'click starts dsh capex' 'ok'[?25l
  else
    report 'click starts dsh capex' "FAILED: the opened URL answered $opened_status"
    FAILED=1
  fi
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
