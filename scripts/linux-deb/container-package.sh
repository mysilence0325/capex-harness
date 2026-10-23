#!/usr/bin/env bash
# Assemble the .deb from a prepared payload and smoke-test the installed package.
#
# build-deb.ts mounts the work tree at /work; this script reads $DSH_PRODUCT,
# applies any native overrides produced by container-natives.sh, relocates the
# staged paths to their install prefix, records the payload's glibc symbol
# ceiling, builds the package, and runs the installed commands.
set -euo pipefail

require() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "container-package: $name must be set" >&2
    exit 2
  fi
}

for name in DSH_PRODUCT DSH_STATE DSH_REPORT DSH_DEB_ROOT DSH_INSTALL_ROOT DSH_ARTIFACT DSH_DEB_NAME \
  DSH_CONTROL DSH_ROOT_FILES DSH_PYTHON_ONLY DSH_SKIP_SMOKE DSH_OVERRIDES; do
  require "$name"
done

step() { printf '\n===== %s =====\n' "$1"; }

step 'overrides'
# Relocating the payload and compressing it is the longest part of the stage.
# A smoke-only change must not repeat it, so the assembled artifact is its own
# resumable unit.
reuse_artifact=0
if [ -f "$DSH_STATE/package-artifact.done" ] && [ -f "$DSH_ARTIFACT/$DSH_DEB_NAME" ] \
  && ! find "$DSH_PRODUCT" -newer "$DSH_ARTIFACT/$DSH_DEB_NAME" -print -quit 2>/dev/null | grep -q .; then
  reuse_artifact=1
fi
if [ "$reuse_artifact" = '1' ]; then
  printf 'artifact already assembled, reusing %s\n' "$DSH_DEB_NAME"
else
if [ -d "$DSH_OVERRIDES" ]; then
  for entry in "$DSH_OVERRIDES"/*; do
    [ -f "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      pty.node)
        destination="$DSH_PRODUCT/dsh/runtime/node/node_modules/node-pty/build/Release/pty.node"
        ;;
      system.node)
        destination="$DSH_PRODUCT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node"
        ;;
      *)
        echo "container-package: unknown native override $name" >&2
        exit 1
        ;;
    esac
    if [ ! -f "$destination" ]; then
      echo "container-package: native override $name has no destination at $destination" >&2
      exit 1
    fi
    cp -f "$entry" "$destination"
    chmod 0755 "$destination"
    printf 'applied native override %s -> %s\n' "$name" "$destination"
  done
else
  printf 'no native overrides present\n'
fi
if [ "$DSH_PYTHON_ONLY" = '0' ]; then
  for native_path in \
    "$DSH_PRODUCT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node" \
    "$DSH_PRODUCT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node" \
    "$DSH_PRODUCT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/landlock-run" \
    "$DSH_PRODUCT/dsh/runtime/node/node_modules/node-pty/build/Release/pty.node"
  do
    if [ ! -f "$native_path" ]; then
      printf 'native payload is missing %s\n' "$native_path"
      exit 1
    fi
  done
fi

step 'stage'
rm -rf "$DSH_DEB_ROOT"
mkdir -p "$DSH_DEB_ROOT/DEBIAN" "$DSH_DEB_ROOT/usr/bin" "$DSH_DEB_ROOT$DSH_INSTALL_ROOT"
cp -a "$DSH_PRODUCT/." "$DSH_DEB_ROOT$DSH_INSTALL_ROOT/"
cp -a "$DSH_ROOT_FILES/." "$DSH_DEB_ROOT/"
find "$DSH_DEB_ROOT/usr/bin" -type f -exec chmod 0755 {} +
cp -a "$DSH_CONTROL" "$DSH_DEB_ROOT/DEBIAN/control"

step 'relocate'
from="$DSH_PRODUCT"
to="$DSH_INSTALL_ROOT"
links=0
while IFS= read -r -d '' link; do
  target=$(readlink "$link")
  case "$target" in
    "$from"/*) ln -sfn "$to${target#"$from"}" "$link"; links=$((links + 1)) ;;
    "$from") ln -sfn "$to" "$link"; links=$((links + 1)) ;;
  esac
done < <(find "$DSH_DEB_ROOT$DSH_INSTALL_ROOT" -type l -print0)
mapfile -t shebang_files < <(grep -rlI "^#!$from" "$DSH_DEB_ROOT$DSH_INSTALL_ROOT" || true)
for file in "${shebang_files[@]}"; do
  sed -i "1s|^#!$from|#!$to|" "$file"
done
printf 'relocated %s symbolic link(s) and %s shebang(s)\n' "$links" "${#shebang_files[@]}"
if grep -rlI "^#!$from" "$DSH_DEB_ROOT$DSH_INSTALL_ROOT" >/dev/null; then
  echo 'container-package: a shebang still points at the staging root' >&2
  exit 1
fi

step 'control'
installed_kib=$(du -sk --exclude=DEBIAN "$DSH_DEB_ROOT" | cut -f1)
if ! grep -q '^Installed-Size: ' "$DSH_DEB_ROOT/DEBIAN/control"; then
  printf 'Installed-Size: %s\n' "$installed_kib" >> "$DSH_DEB_ROOT/DEBIAN/control"
fi
cat "$DSH_DEB_ROOT/DEBIAN/control" > "$DSH_REPORT/control.txt"

step 'glibc'
rm -f /etc/apt/apt.conf.d/docker-clean
printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99dsh-force-ipv4
if [ -n "${DSH_APT_MIRROR:-}" ] && [ -f /etc/apt/sources.list ]; then
  sed -i -E "s#https?://(ports\.ubuntu\.com/ubuntu-ports|archive\.ubuntu\.com/ubuntu|security\.ubuntu\.com/ubuntu)#$DSH_APT_MIRROR#g" /etc/apt/sources.list
fi
apt-get update -qq
# The Office fallback renders through fontconfig; a bare base image has no
# fonts at all, so the smoke would fail before the converter could run.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  binutils ca-certificates curl file fontconfig fonts-dejavu-core
dump="$DSH_REPORT/version-info.txt"
: > "$dump"
# One `file` process classifies the whole payload. Spawning a reader per file
# costs minutes per thousand entries under emulation, which made this pass the
# slowest part of packaging on a qemu build host.
while IFS= read -r -d '' file; do
  IFS= read -r line || break
  mime=${line#: }
  case "$mime" in
    application/x-executable|application/x-sharedlib|application/x-pie-executable) ;;
    *) continue ;;
  esac
  printf '%s%s\n' '@@FILE ' "${file#"$DSH_DEB_ROOT"}" >> "$dump"
  readelf --version-info "$file" >> "$dump" 2>&1 || true
done < <(find "$DSH_DEB_ROOT/usr" -type f -print0 | xargs -0 -r file -0 -N --mime-type)
if ! grep -c '^@@FILE ' "$dump" > "$DSH_REPORT/elf-count.txt"; then
  printf '0\n' > "$DSH_REPORT/elf-count.txt"
fi
printf 'recorded %s ELF file(s)\n' "$(cat "$DSH_REPORT/elf-count.txt")"

step 'package'
mkdir -p "$DSH_ARTIFACT"
dpkg-deb --build --root-owner-group "$DSH_DEB_ROOT" "$DSH_ARTIFACT/$DSH_DEB_NAME" >/dev/null
dpkg-deb -I "$DSH_ARTIFACT/$DSH_DEB_NAME" > "$DSH_REPORT/deb-control.txt"
dpkg-deb -c "$DSH_ARTIFACT/$DSH_DEB_NAME" > "$DSH_REPORT/deb-contents.txt"
for path in ./usr/bin/dsh-sdk ./usr/bin/dsh-python ./usr/bin/dsh-pip ./usr/bin/dsh-web \
  ./usr/bin/dsh-web-register-file-types \
  ./usr/share/applications/capex-harness-web.desktop \
  ./usr/share/icons/hicolor/512x512/apps/capex-harness.png \
  "$DSH_INSTALL_ROOT/python/bin/python3.12" \
  "$DSH_INSTALL_ROOT/resources" "$DSH_INSTALL_ROOT/wheelhouse" \
  "$DSH_INSTALL_ROOT/share/python-wheelhouse-NOTICES.md" "$DSH_INSTALL_ROOT/dsh/runtime/node/runtime-bootstrap.mjs" \
  "$DSH_INSTALL_ROOT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node" \
  "$DSH_INSTALL_ROOT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node" \
  "$DSH_INSTALL_ROOT/dsh/runtime/node/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/landlock-run" \
  "$DSH_INSTALL_ROOT/dsh/runtime/node/node_modules/node-pty/build/Release/pty.node" \
  "$DSH_INSTALL_ROOT/share/LICENSE"; do
  if ! grep -qF "$path" "$DSH_REPORT/deb-contents.txt"; then
    echo "container-package: $path is missing from the package" >&2
    exit 1
  fi
done
if [ "$DSH_PYTHON_ONLY" = '0' ]; then
  for path in ./usr/bin/dsh ./usr/bin/dsh-office-convert "$DSH_INSTALL_ROOT/node/bin/node" \
    "$DSH_INSTALL_ROOT/share/office-convert.mjs"; do
    if ! grep -qF "$path" "$DSH_REPORT/deb-contents.txt"; then
      echo "container-package: $path is missing from the package" >&2
      exit 1
    fi
  done
fi
size_bytes=$(stat -c %s "$DSH_ARTIFACT/$DSH_DEB_NAME")
printf '%s\t%s\t%s\n' "$DSH_DEB_NAME" "$size_bytes" "$(sha256sum "$DSH_ARTIFACT/$DSH_DEB_NAME" | cut -d' ' -f1)" \
  > "$DSH_REPORT/artifact.tsv"
date -u +%FT%TZ > "$DSH_STATE/package-artifact.done"
fi

step 'smoke'
if [ "$reuse_artifact" = '1' ]; then
  rm -f /etc/apt/apt.conf.d/docker-clean
  printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99dsh-force-ipv4
  if [ -n "${DSH_APT_MIRROR:-}" ] && [ -f /etc/apt/sources.list ]; then
    sed -i -E "s#https?://(ports\.ubuntu\.com/ubuntu-ports|archive\.ubuntu\.com/ubuntu|security\.ubuntu\.com/ubuntu)#$DSH_APT_MIRROR#g" /etc/apt/sources.list
  fi
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    binutils ca-certificates curl file fontconfig fonts-dejavu-core
fi
if [ -f "$DSH_STATE/package-smoke.done" ] && [ -s "$DSH_REPORT/smoke.txt" ] \
  && [ "$DSH_REPORT/smoke.txt" -nt "$DSH_ARTIFACT/$DSH_DEB_NAME" ]; then
  printf 'smoke already complete, reusing report\n'
elif [ "$DSH_SKIP_SMOKE" = '1' ]; then
  printf 'skipped on request\n' > "$DSH_REPORT/smoke.txt"
else
  : > "$DSH_REPORT/smoke.txt"
  DEBIAN_FRONTEND=noninteractive dpkg --install "$DSH_ARTIFACT/$DSH_DEB_NAME" >> "$DSH_REPORT/smoke.txt" 2>&1
  {
    printf '== glibc ==\n'; getconf GNU_LIBC_VERSION
    if [ "$DSH_PYTHON_ONLY" = '0' ]; then
      printf '== dsh --version ==\n'; dsh --version
      printf '== dsh web --help ==\n'; dsh web --help
      printf '== dsh doctor quick ==\n'
      DSH_HOME=/tmp/dsh-home-web dsh doctor --quick --no-report --json > /tmp/dsh-doctor-quick.json
      printf '== dsh clean dry-run ==\n'
      DSH_HOME=/tmp/dsh-home-web dsh clean --dry-run --json > /tmp/dsh-clean-dry-run.json
      printf '== offline posture ==\n'
      # `head` closes the pipe on the second match, so the pipeline's status is
      # deliberately ignored rather than aborting the smoke under `set -e`.
      base_patch=$(find "$DSH_INSTALL_ROOT/dsh" -path '*/@deepseek-ai/dsh-base/cordis.patch.yml' | head -1 || true)
      if [ -z "$base_patch" ]; then
        printf 'the installed payload carries no base bundle patch\n'
        exit 1
      fi
      row_has_in() {
        file=$1
        row=$2
        pat=$3
        awk -v id="- id: $row" -v pat="$pat" '
          index($0, id) == length($0) - length(id) + 1 { inside = 1; next }
          inside && /^[[:space:]]*- id:/ { inside = 0 }
          inside && index($0, pat) { found = 1 }
          END { exit found ? 0 : 1 }
        ' "$file"
      }
      row_has() { row_has_in "$base_patch" "$1" "$2"; }
      for row in session-telemetry-otel web web-search-deepseek web-fetch-http tool-web; do
        if ! row_has "$row" 'disabled: true'; then
          printf '%s is still enabled in the shipped profile\n' "$row"
          exit 1
        fi
      done
      row_has session-log-deepseek 'enabled: false' || {
        printf 'the DeepSeek session-log contributor is still enabled\n'
        exit 1
      }
      row_has plugin-manager 'fallbackRegistries: []' || {
        printf 'the plugin manager still falls back to public registries\n'
        exit 1
      }
      web_patch=$(find "$DSH_INSTALL_ROOT/dsh" -path '*/@deepseek-ai/dsh-web-app/cordis.patch.yml' | head -1 || true)
      if [ -z "$web_patch" ] || ! grep -A 3 -- '- id: ui-settings-web-search' "$web_patch" | grep -q 'disabled: true'; then
        printf 'the web-search settings page is still mounted\n'
        exit 1
      fi
      capex_patch=$(find "$DSH_INSTALL_ROOT/dsh" -path '*/@deepseek-ai/dsh-capex/cordis.patch.yml' | head -1 || true)
      if [ -z "$capex_patch" ]; then
        printf 'the installed payload carries no Capex bundle patch\n'
        exit 1
      fi
      for row in authorization deepseek-account llm-deepseek-account account-controller ui-settings-account; do
        if ! row_has_in "$capex_patch" "$row" 'disabled: true'; then
          printf '%s is not disabled in the Capex profile\n' "$row"
          exit 1
        fi
      done
      if row_has_in "$capex_patch" credentials 'disabled: true'; then
        printf 'credentials-local must stay enabled for Web authentication\n'
        exit 1
      fi
      for expected in \
        'capexai:' \
        'apiKeyEnv: CAPEXAI_API_KEY' \
        'api: openai-completions' \
        'baseURL: http://15.11.40.44:3100/v1' \
        'id: deepseek-flash' \
        'contextWindow: 131072' \
        'maxTokens: 4096'
      do
        if ! grep -Fq -- "$expected" "$capex_patch"; then
          printf 'the Capex default model configuration is missing %s\n' "$expected"
          exit 1
        fi
      done
      if grep -Eq 'sk-[A-Za-z0-9_-]{16,}' "$capex_patch"; then
        printf 'the Capex profile contains a plaintext API key\n'
        exit 1
      fi
      if [ -z "$web_patch" ] \
        || ! grep -q -- '- id: workspace-dependencies' "$web_patch" \
        || ! grep -q -- '- id: skill-office' "$web_patch"; then
        printf 'the Web profile does not mount the packaged Office dependencies\n'
        exit 1
      fi
      printf 'telemetry, session-log upload, web tools, and public registry fallbacks are off\n'
      # `--help` only prints usage; a real boot is what proves every mounted
      # plugin activates, which is where a missing peer dependency surfaces.
      printf '== dsh web boot ==\n'
      DSH_HOME=/tmp/dsh-home-web dsh capex --no-open --port 4188 > /tmp/dsh-web-boot.log 2>&1 &
      web_pid=$!
      web_ready=no
      for _ in $(seq 1 120); do
        # The launch URL carries a one-time token whose exchange answers 303 and
        # sets the session cookie; a request without it answers 401, so the probe
        # requires that redirect and never follows it.
        token=$(sed -n 's#.*http://127\.0\.0\.1:4188/?token=\([A-Za-z0-9_-]*\).*#\1#p' /tmp/dsh-web-boot.log | head -1)
        if [ -n "$token" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4188/?token=$token")" = '303' ]; then
          web_ready=yes
          break
        fi
        if ! kill -0 "$web_pid" 2>/dev/null; then break; fi
        sleep 2
      done
      if [ "$web_ready" != 'yes' ]; then
        printf 'dsh web did not serve a response\n'
        cat /tmp/dsh-web-boot.log
        exit 1
      fi
      sleep 5
      if grep -q 'did not activate' /tmp/dsh-web-boot.log; then
        printf 'dsh web reported inactive plugins\n'
        cat /tmp/dsh-web-boot.log
        exit 1
      fi
      kill "$web_pid" 2>/dev/null || true
      printf 'dsh capex boot: served and activated\n'
      printf '== bundled pnpm local tarball ==\n'
      probe_dir=$(mktemp -d)
      mkdir -p "$probe_dir/package"
      printf '%s\n' '{"name":"dsh-offline-probe","version":"1.0.0","private":true,"type":"module","main":"index.js"}' \
        > "$probe_dir/package/package.json"
      printf '%s\n' 'export {}' > "$probe_dir/package/index.js"
      ( cd "$probe_dir/package" && tar -czf "$probe_dir/dsh-offline-probe.tgz" package.json index.js )
      DSH_HOME=/tmp/dsh-home-web dsh plugin --profile capex add "file:$probe_dir/dsh-offline-probe.tgz" --offline --ignore-scripts
      grep -q '"dsh-offline-probe"' /tmp/dsh-home-web/profiles/capex/package.json
      rm -rf "$probe_dir"
      printf 'bundled pnpm installed a local tarball without a registry\n'
      printf '== native system addon ==\n'
      (
        cd "$DSH_INSTALL_ROOT/dsh/runtime/node"
        "$DSH_INSTALL_ROOT/node/bin/node" --input-type=module -e '
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
        '
      )
      printf 'native system.node loaded and locked a file\n'
    fi
    printf '== dsh-sdk --help ==\n'; DSH_HOME=/tmp/dsh-home dsh-sdk --help
    printf '== dsh-python ==\n'
    dsh-python -c 'import sys, deepseek_harness; print(sys.version.split()[0], deepseek_harness.__name__)'
    printf '== bundled extensions ==\n'
    # GitPython raises at import when no `git` binary is on PATH; the import
    # check is about the bundled distributions, so the missing executable is
    # reported by the quiet policy instead of failing the package.
    GIT_PYTHON_REFRESH=quiet dsh-python -c 'import docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, pypdfium2, reportlab, markdown, markdown_it, mdit_py_plugins, pymdownx, frontmatter, bs4, markdownify, xlrd, pyxlsb, python_calamine, olefile, msoffcrypto, defusedxml, requests, httpx, yaml, tomlkit, orjson, jsonschema, jinja2, click, typer, rich, tqdm, dotenv, filelock, tenacity, git, sqlalchemy, pytest, pydantic, scipy, matplotlib, seaborn, pyarrow, tabulate'
    printf '== dsh-pip ==\n'
    dsh-pip --version
    printf '== offline wheelhouse ==\n'
    venv_dir=$(mktemp -d)
    dsh-python -m venv "$venv_dir"
    VIRTUAL_ENV="$venv_dir" dsh-pip install --no-input markdown
    "$venv_dir/bin/python" -c 'import markdown; print(markdown.__version__)'
    rm -rf "$venv_dir"
    if [ -x /usr/bin/dsh-office-convert ]; then
      printf '== office conversion fallback ==\n'
      office_dir=$(mktemp -d)
      ( cd "$office_dir" && dsh-python -c 'from docx import Document; d=Document(); d.add_paragraph("offline conversion"); d.save("input.docx")' )
      DSH_OFFICE_CONVERT_TIMEOUT_MS="${DSH_OFFICE_SMOKE_TIMEOUT_MS:-900000}" \
        dsh-office-convert --input "$office_dir/input.docx" --output "$office_dir/result.pdf"
      test "$(head -c 5 "$office_dir/result.pdf")" = '%PDF-'
      rm -rf "$office_dir"
    fi
    printf '== product title ==\n'
    web_index=$(find "$DSH_INSTALL_ROOT/dsh/runtime/node" \
      -path '*/@deepseek-ai/dsh-web-frontend/dist/index.html' -print -quit)
    if [ -z "$web_index" ] || ! grep -q '<title>Capex Harness</title>' "$web_index"; then
      printf 'packaged Web title is not Capex Harness\n'
      exit 1
    fi
    printf 'Capex Harness\n'
    printf '== seeded resources without network ==\n'
    DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=1 dsh-sdk --version
    printf '== desktop integration ==\n'
    if [ -x /usr/bin/dsh-web ] && [ -x /usr/bin/dsh-web-desktop-icon ] \
      && [ -x /usr/bin/dsh-web-register-file-types ] \
      && sh -n /usr/bin/dsh-web \
      && grep -q '^Exec=/usr/bin/dsh-web %U$' /usr/share/applications/capex-harness-web.desktop \
      && grep -q '^MimeType=application/pdf;' /usr/share/applications/capex-harness-web.desktop \
      && [ -f /usr/share/icons/hicolor/512x512/apps/capex-harness.png ]; then
      printf 'menu entry, launcher, and icon installed\n'
    else
      printf 'desktop integration is incomplete\n'
      ls -l /usr/bin/dsh-web /usr/share/applications/capex-harness-web.desktop 2>&1 || true
      exit 1
    fi
  } >> "$DSH_REPORT/smoke.txt" 2>&1
  date -u +%FT%TZ > "$DSH_STATE/package-smoke.done"
fi
printf 'packaged\n'
