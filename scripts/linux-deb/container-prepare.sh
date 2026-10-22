#!/usr/bin/env bash
# Prepare the dsh payload inside the arm64 build container.
#
# scripts/linux-deb/build-deb.ts owns every input: it passes the DSH_ variables
# below and mounts the source tree read-only at $DSH_REPO, the work tree at
# /work, and the package output at /out. Steps record a marker under
# $DSH_STATE, so a rerun with the same work tree resumes after the last
# completed step instead of rebuilding it.
#
# $DSH_PHASE selects how far this run goes:
#   js      - runs on the build host's own architecture and stops once the
#             JavaScript artifacts exist. Bundlers load native bindings that
#             emulation cannot execute, so this phase never runs under
#             emulation, and it installs a toolchain for its own architecture.
#   payload - runs inside the arm64 container and assembles everything the
#             package ships. It reinstalls the workspace for arm64 and consumes
#             the artifacts the js phase left in the work tree.
#
# Payload steps: tools, node, pnpm, source, install, artifacts, native, exe,
# python, wheels, sdk, tree, resources, python-extras, share.
set -euo pipefail

require() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "container-prepare: $name must be set" >&2
    exit 2
  fi
}

for name in DSH_REPO DSH_SRC DSH_PRODUCT DSH_STATE DSH_DOWNLOADS DSH_DIST DSH_REPORT DSH_TOOLS DSH_STORE \
  DSH_NODE_VERSION DSH_NODE_URL DSH_NODE_SHA256 DSH_PYTHON_URL DSH_PYTHON_SHA256 DSH_PNPM_VERSION \
  DSH_UV_VERSION DSH_PYTHON_ONLY DSH_PHASE; do
  require "$name"
done

case "$DSH_PHASE" in
  js | payload) ;;
  *)
    echo "container-prepare: DSH_PHASE must be js or payload, got $DSH_PHASE" >&2
    exit 2
    ;;
esac

mkdir -p "$DSH_SRC" "$DSH_PRODUCT" "$DSH_STATE" "$DSH_DOWNLOADS" "$DSH_DIST" "$DSH_REPORT" "$DSH_TOOLS" "$DSH_STORE"

# Build scripts run their own installs (the packaged-runtime deploy, for one).
# pnpm reads npm-style environment configuration, so those nested installs reuse
# the mounted store and the configured registry instead of fetching every
# tarball again from the default registry into an ephemeral store.
export npm_config_store_dir="$DSH_STORE"
if [ -n "${DSH_NPM_REGISTRY:-}" ]; then
  export npm_config_registry="$DSH_NPM_REGISTRY"
  # Environment configuration alone does not reach every nested install, so the
  # registry is also written where both npm and pnpm read it unconditionally.
  printf 'registry=%s\n' "$DSH_NPM_REGISTRY" > "$HOME/.npmrc"
fi

step() { printf '\n===== %s =====\n' "$1"; }
finished() { [ -f "$DSH_STATE/$1.done" ]; }
finish() {
  date -u +%FT%TZ > "$DSH_STATE/$1.done"
  printf '===== %s complete =====\n' "$1"
}
skip() { printf '===== %s already complete, reusing =====\n' "$1"; }

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

verify_download() {
  local file=$1 sha256=$2
  if [ ! -f "$file" ]; then
    echo "container-prepare: missing archive $file" >&2
    return 1
  fi
  local actual
  actual=$(sha256_of "$file")
  if [ "$actual" != "$sha256" ]; then
    echo "container-prepare: checksum mismatch for $file: expected $sha256, got $actual" >&2
    return 1
  fi
}

fetch() {
  local url=$1 sha256=$2 destination=$3
  if verify_download "$destination" "$sha256" 2>/dev/null; then
    printf 'reusing %s\n' "$destination"
    return 0
  fi
  rm -f "$destination.part"
  curl -fsSL --retry 3 --retry-delay 5 -o "$destination.part" "$url"
  if ! verify_download "$destination.part" "$sha256"; then
    rm -f "$destination.part"
    return 1
  fi
  mv "$destination.part" "$destination"
}

record() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" >> "$DSH_REPORT/deps.tsv"
}

apt_family() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

# The base image's docker-clean hook deletes downloaded packages, which defeats
# the cache mount; keep them so a rebuild reuses the same archives.
keep_apt_archives() {
  rm -f /etc/apt/apt.conf.d/docker-clean
}

record_apt() {
  local purpose=$1
  shift
  local package
  for package in "$@"; do
    record apt "$package" "$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || printf -- '-')" \
      'ubuntu archive' - "$purpose" 0
  done
}

apply_apt_mirror() {
  # Containers on this build host have no IPv6 route; without this apt spends
  # seconds timing out per index and then installs against a half-updated set.
  printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99dsh-force-ipv4
  if [ -z "${DSH_APT_MIRROR:-}" ]; then
    return 0
  fi
  if [ ! -f /etc/apt/sources.list ]; then
    printf 'apt mirror: no /etc/apt/sources.list to rewrite\n'
    return 0
  fi
  sed -i -E "s#https?://(ports\.ubuntu\.com/ubuntu-ports|archive\.ubuntu\.com/ubuntu|security\.ubuntu\.com/ubuntu)#$DSH_APT_MIRROR#g" /etc/apt/sources.list
  printf 'apt mirror: %s\n' "$DSH_APT_MIRROR"
}

pip_index_arguments() {
  if [ -n "${DSH_PIP_INDEX:-}" ]; then
    printf -- '--index-url %s' "$DSH_PIP_INDEX"
  fi
}

install_workspace() {
  if [ -n "${DSH_NPM_REGISTRY:-}" ]; then
    if ( cd "$DSH_SRC" && pnpm install --frozen-lockfile --config.ignore-scripts=true \
      --store-dir "$DSH_STORE" --registry "$DSH_NPM_REGISTRY" ); then
      return 0
    fi
    printf 'install through %s failed; retrying with the registry the lockfile records\n' "$DSH_NPM_REGISTRY" >&2
  fi
  ( cd "$DSH_SRC" && pnpm install --frozen-lockfile --config.ignore-scripts=true --store-dir "$DSH_STORE" )
}

step 'tools'
# Every stage starts a fresh container, so the toolchain is installed on every
# run; only the work tree is reused across runs.
apply_apt_mirror
keep_apt_archives
apt-get update -qq
apt_family ca-certificates curl build-essential musl-tools python3 xz-utils binutils git
record_apt 'C toolchain, Git metadata, TLS trust store, and archivers used by the build' \
  ca-certificates curl build-essential musl-tools python3 xz-utils binutils git

if [ "$DSH_PHASE" = 'payload' ]; then
  step 'node'
  if ! finished node; then
    fetch "$DSH_NODE_URL" "$DSH_NODE_SHA256" "$DSH_DOWNLOADS/node.tar.gz"
    rm -rf "$DSH_PRODUCT/node"
    mkdir -p "$DSH_PRODUCT/node"
    tar -xzf "$DSH_DOWNLOADS/node.tar.gz" -C "$DSH_PRODUCT/node" --strip-components=1
    "$DSH_PRODUCT/node/bin/node" --version
    record archive "node-v$DSH_NODE_VERSION-linux-arm64.tar.gz" "$DSH_NODE_VERSION" "$DSH_NODE_URL" \
      "sha256:$DSH_NODE_SHA256" 'Node.js runtime shipped in /usr/lib/capex-harness/node' 1
    finish node
  else
    skip node
  fi
  export PATH="$DSH_PRODUCT/node/bin:$DSH_TOOLS/bin:$PATH"

  step 'pnpm'
  if ! finished pnpm; then
    npm install --global --prefix "$DSH_TOOLS" "pnpm@$DSH_PNPM_VERSION" \
      --registry "${DSH_NPM_REGISTRY:-https://registry.npmjs.org}" >/dev/null
    pnpm --version
    record npm pnpm "$DSH_PNPM_VERSION" "https://registry.npmjs.org/pnpm/-/pnpm-$DSH_PNPM_VERSION.tgz" \
      - 'Package manager that installs and deploys the workspace closure' 0
    finish pnpm
  else
    skip pnpm
  fi
else
  step 'host-toolchain'
  # The JavaScript build runs bundlers whose native bindings load only on the
  # architecture they were compiled for, so this phase carries its own Node.js
  # and pnpm and never touches the arm64 ones the payload ships.
  for name in DSH_HOST_ROOT DSH_HOST_NODE_URL DSH_HOST_NODE_SHA256; do require "$name"; done
  if [ ! -x "$DSH_HOST_ROOT/node/bin/node" ]; then
    fetch "$DSH_HOST_NODE_URL" "$DSH_HOST_NODE_SHA256" "$DSH_DOWNLOADS/node-host.tar.gz"
    rm -rf "$DSH_HOST_ROOT/node"
    mkdir -p "$DSH_HOST_ROOT/node"
    tar -xzf "$DSH_DOWNLOADS/node-host.tar.gz" -C "$DSH_HOST_ROOT/node" --strip-components=1
  fi
  "$DSH_HOST_ROOT/node/bin/node" --version
  if [ ! -x "$DSH_HOST_ROOT/tools/bin/pnpm" ]; then
    PATH="$DSH_HOST_ROOT/node/bin:$PATH" npm install --global --prefix "$DSH_HOST_ROOT/tools" \
      "pnpm@$DSH_PNPM_VERSION" --registry "${DSH_NPM_REGISTRY:-https://registry.npmjs.org}" >/dev/null
  fi
  export PATH="$DSH_HOST_ROOT/node/bin:$DSH_HOST_ROOT/tools/bin:$PATH"
  pnpm --version
  record archive "node-v$DSH_NODE_VERSION-$(uname -m).tar.gz" "$DSH_NODE_VERSION" "$DSH_HOST_NODE_URL" \
    "sha256:$DSH_HOST_NODE_SHA256" 'Node.js and pnpm that run the JavaScript build phase' 0
fi

step 'source'
if ! finished source; then
  rm -rf "$DSH_SRC"
  mkdir -p "$DSH_SRC"
  cp -a "$DSH_REPO/." "$DSH_SRC/"
  rm -rf "$DSH_SRC/node_modules" "$DSH_SRC/dist-exe" "$DSH_SRC/.desktop-build"
  finish source
else
  skip source
fi

step 'git-source'
if ! finished git-source; then
  # The client build embeds a commit hash and reads it from Git unless
  # DSH_CLIENT_COMMIT_HASH supplies one. A copy without Git metadata therefore
  # gets its own commit, so the recorded hash describes exactly the built bytes.
  if [ ! -d "$DSH_SRC/.git" ]; then
    git -C "$DSH_SRC" init -q
    git -C "$DSH_SRC" add -A
    git -C "$DSH_SRC" -c user.name='dsh deb build' -c user.email='dsh@localhost' \
      commit -qm 'dsh deb build source'
  fi
  export DSH_CLIENT_COMMIT_HASH
  DSH_CLIENT_COMMIT_HASH=$(git -C "$DSH_SRC" rev-parse HEAD)
  printf 'client build commit: %s\n' "$DSH_CLIENT_COMMIT_HASH"
  record local 'client build commit' "$DSH_CLIENT_COMMIT_HASH" "$DSH_SRC" - \
    'Commit hash embedded in the built client metadata' 1
  finish git-source
else
  skip git-source
  export DSH_CLIENT_COMMIT_HASH
  DSH_CLIENT_COMMIT_HASH=$(git -C "$DSH_SRC" rev-parse HEAD)
fi

step 'install'
install_marker=install
if [ "$DSH_PHASE" = 'js' ]; then
  install_marker=install-js
fi
if ! finished "$install_marker"; then
  if [ "$DSH_PHASE" = 'payload' ]; then
    # The JavaScript phase installed the workspace for the build host; the
    # payload closure is a different architecture and must replace it.
    rm -rf "$DSH_SRC/node_modules"
    find "$DSH_SRC" -mindepth 2 -type d -name node_modules -prune -exec rm -rf {} +
  fi
  # install-lefthook.mjs requires git 2.26, which Ubuntu 20.04 does not have;
  # the build container needs no repository hooks, so scripts stay off and the
  # platform binaries the build itself runs are rebuilt explicitly.
  install_workspace
  ( cd "$DSH_SRC" && pnpm rebuild esbuild node-pty koffi )
  finish "$install_marker"
else
  skip "$install_marker"
fi

step 'artifacts'
if [ "$DSH_PHASE" = 'js' ]; then
  if ! finished artifacts; then
    ( cd "$DSH_SRC" && pnpm run build:artifacts )
    finish artifacts
  else
    skip artifacts
  fi
  printf 'prepared (JavaScript phase)\n'
  exit 0
fi
if ! finished artifacts; then
  echo 'container-prepare: the JavaScript phase produced no artifacts; run it first' >&2
  exit 3
fi
skip artifacts

step 'native'
if ! finished native; then
  ( cd "$DSH_SRC/native/system" && pnpm run build:ts && pnpm run build:native )
  record local '@deepseek-ai/node-addon-system-linux-arm64' '0.1.2' "$DSH_SRC/native/system/packages/linux-arm64/bin" \
    - 'Landlock launcher and glibc/musl flock addons shipped in the closure' 1
  finish native
else
  skip native
fi

step 'exe'
if ! finished exe; then
  ( cd "$DSH_SRC" && pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-arm64 --skip-build )
  finish exe
else
  skip exe
fi

step 'python'
if ! finished python; then
  fetch "$DSH_PYTHON_URL" "$DSH_PYTHON_SHA256" "$DSH_DOWNLOADS/python.tar.gz"
  rm -rf "$DSH_PRODUCT/python"
  mkdir -p "$DSH_PRODUCT/python"
  tar -xzf "$DSH_DOWNLOADS/python.tar.gz" -C "$DSH_PRODUCT/python" --strip-components=1
  python_root="$DSH_PRODUCT/python"
  if ! "$python_root/bin/python3.12" -m pip --version >/dev/null 2>&1; then
    "$python_root/bin/python3.12" -m ensurepip --upgrade
  fi
  # shellcheck disable=SC2046 # the helper expands to a flag pair or to nothing
  "$python_root/bin/python3.12" -m pip install $(pip_index_arguments) --quiet --no-input \
    --disable-pip-version-check "uv==$DSH_UV_VERSION"
  "$python_root/bin/python3.12" --version
  record archive "cpython-$DSH_PYTHON_VERSION-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz" \
    "$DSH_PYTHON_VERSION" "$DSH_PYTHON_URL" "sha256:$DSH_PYTHON_SHA256" \
    'CPython shipped in /usr/lib/capex-harness/python for the Python SDK' 1
  record pypi uv "$DSH_UV_VERSION" 'https://pypi.org/project/uv/' - \
    'Wheel builder used by scripts/build-python-release.py' 0
  finish python
else
  skip python
fi
export PATH="$DSH_PRODUCT/python/bin:$PATH"

step 'wheels'
if ! finished wheels; then
  mkdir -p "$DSH_DIST/wheels"
  runtime_exe="$DSH_SRC/dist-exe/deepseek-harness-sdk-runtime-linux-arm64"
  if [ ! -f "$runtime_exe" ]; then
    echo "container-prepare: the packaged runtime executable is missing at $runtime_exe" >&2
    exit 1
  fi
  ( cd "$DSH_SRC" && python3 scripts/build-python-release.py --package sdk --output-dir "$DSH_DIST/wheels" )
  ( cd "$DSH_SRC" && python3 scripts/build-python-release.py --package runtime --platform linux-arm64 \
    --runtime-exe "$runtime_exe" --output-dir "$DSH_DIST/wheels" )
  record local 'deepseek-harness-sdk-runtime' "$DSH_NODE_VERSION" "$runtime_exe" \
    "sha256:$(sha256_of "$runtime_exe")" 'Single-file runtime executable embedded in the runtime wheel' 1
  finish wheels
else
  skip wheels
fi

step 'sdk'
if ! finished sdk; then
  sdk_wheel=$(ls "$DSH_DIST/wheels"/deepseek_harness_sdk-*.whl)
  runtime_wheel=$(ls "$DSH_DIST/wheels"/deepseek_harness_runtime_bin-*.whl)
  version=$(basename "$sdk_wheel" | sed -E 's/^deepseek_harness_sdk-(.*)-py3-none-any\.whl$/\1/')
  python="$DSH_PRODUCT/python/bin/python3.12"
  mkdir -p "$DSH_DIST/pypi"
  # shellcheck disable=SC2046 # the helper expands to a flag pair or to nothing
  "$python" -m pip download $(pip_index_arguments) --quiet --no-input --disable-pip-version-check --only-binary=:all: \
    --find-links "$DSH_DIST/wheels" --dest "$DSH_DIST/pypi" \
    "deepseek-harness-sdk==$version"
  # `pip download` has no --report, so the inventory comes from a dry-run
  # resolve, which names each distribution's upstream URL without installing it.
  # shellcheck disable=SC2046 # the helper expands to a flag pair or to nothing
  "$python" -m pip install --dry-run $(pip_index_arguments) --quiet --no-input --disable-pip-version-check \
    --only-binary=:all: --ignore-installed --find-links "$DSH_DIST/wheels" \
    --report "$DSH_REPORT/pypi-download.json" "deepseek-harness-sdk==$version"
  "$python" -m pip install --quiet --no-input --disable-pip-version-check --no-index \
    --find-links "$DSH_DIST/pypi" --find-links "$DSH_DIST/wheels" "deepseek-harness-sdk==$version"
  "$python" -c 'import deepseek_harness, deepseek_harness_runtime; print(deepseek_harness_runtime.__name__)'
  record local 'deepseek-harness-sdk' "$version" "$sdk_wheel" "sha256:$(sha256_of "$sdk_wheel")" \
    'Python SDK installed into the bundled CPython' 1
  record local 'deepseek-harness-runtime-bin' "$version" "$runtime_wheel" "sha256:$(sha256_of "$runtime_wheel")" \
    'Packaged runtime wheel whose console script dsh-sdk starts' 1
  finish sdk
else
  skip sdk
fi

step 'tree'
if ! finished tree; then
  module="$DSH_SRC/python/sdk-runtime/src/deepseek_harness_runtime/runtime"
  rm -rf "$DSH_PRODUCT/dsh"
  mkdir -p "$DSH_PRODUCT/dsh"
  # The wheel already carries the executable and the ripgrep sidecar; the
  # package ships only the Node carrier and the resource manifest beside it.
  cp -a "$module" "$DSH_PRODUCT/dsh/runtime"
  rm -f "$DSH_PRODUCT/dsh/runtime/deepseek-harness-sdk-runtime-linux-arm64" \
    "$DSH_PRODUCT/dsh/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg"
  if [ ! -f "$DSH_PRODUCT/dsh/runtime/node/runtime-bootstrap.mjs" ]; then
    echo 'container-prepare: the deployed Node carrier is missing its bootstrap' >&2
    exit 1
  fi
  record local 'dsh-node-carrier' "$DSH_NODE_VERSION" "$DSH_PRODUCT/dsh/runtime/node" - \
    'Source-built dsh dependency closure run by the bundled Node.js' 1
  finish tree
else
  skip tree
fi

step 'resources'
if ! finished resources; then
  export DSH_RESOURCE_CACHE="$DSH_PRODUCT/resources"
  node="$DSH_PRODUCT/node/bin/node"
  bootstrap="$DSH_PRODUCT/dsh/runtime/node/runtime-bootstrap.mjs"
  # Seeding downloads the whole locked payload; a slow build host needs more
  # than the runtime's five-minute default per archive. The offline proof below
  # keeps its own explicit 1 ms bound.
  export DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS="${DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS:-1800000}"
  primary=$(DSH_RUNTIME_DOWNLOAD=primary "$node" "$bootstrap")
  office=$(DSH_RUNTIME_DOWNLOAD=office "$node" "$bootstrap")
  # A bounded download timeout turns any remaining network access into a failure,
  # which is what proves the seeded cache serves the SDK without a network.
  DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=1 DSH_RUNTIME_DOWNLOAD=primary "$node" "$bootstrap" >/dev/null
  DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS=1 DSH_RUNTIME_DOWNLOAD=office "$node" "$bootstrap" >/dev/null
  printf 'primary\t%s\noffice\t%s\n' "$primary" "$office" > "$DSH_REPORT/resources.tsv"
  record archive 'deepseek-harness resource cache' "$DSH_NODE_VERSION" "$office" - \
    'Locked Office sidecar and authoring environment seeded into /usr/lib/capex-harness/resources' 1
  finish resources
else
  skip resources
fi

step 'python-extras'
if ! finished python-extras; then
  python="$DSH_PRODUCT/python/bin/python3.12"
  wheelhouse="$DSH_PRODUCT/wheelhouse"
  requirements="$DSH_SRC/scripts/linux-deb/python-extras.requirements.txt"
  primary=$(find "$DSH_PRODUCT/resources" -type d -path '*/primary/primary-runtime' -print -quit)
  if [ ! -f "$requirements" ]; then
    echo "container-prepare: missing Python extras requirements at $requirements" >&2
    exit 1
  fi
  if [ -z "$primary" ]; then
    echo "container-prepare: no primary runtime was seeded under $DSH_PRODUCT/resources" >&2
    exit 1
  fi
  rm -rf "$wheelhouse"
  mkdir -p "$wheelhouse"
  "$python" -m pip download $(pip_index_arguments) --quiet --no-input --disable-pip-version-check \
    --only-binary=:all: --dest "$wheelhouse" -r "$requirements"
  if ! find "$wheelhouse" -maxdepth 1 -type f -name '*.whl' -print -quit | grep -q .; then
    echo 'container-prepare: the Python extras wheelhouse is empty' >&2
    exit 1
  fi
  "$python" -m pip install --quiet --no-input --disable-pip-version-check \
    --no-index --find-links "$wheelhouse" -r "$requirements"
  primary_python="$primary/dependencies/python/bin/python3.12"
  "$primary_python" -m pip install --quiet --no-input --disable-pip-version-check \
    --no-index --find-links "$wheelhouse" -r "$requirements"
  "$primary_python" "$DSH_SRC/scripts/linux-deb/record-runtime-extras.py" "$primary/runtime.json"
  mkdir -p "$DSH_PRODUCT/share"
  "$python" "$DSH_SRC/scripts/linux-deb/record-wheelhouse.py" "$wheelhouse" \
    --notices "$DSH_PRODUCT/share/python-wheelhouse-NOTICES.md" >> "$DSH_REPORT/deps.tsv"
  "$python" -m pip check
  "$primary_python" -m pip check
  "$primary_python" -I -B -c 'import docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, pypdfium2, reportlab, markdown, markdown_it, mdit_py_plugins, pymdownx, frontmatter, bs4, markdownify, xlrd, pyxlsb, python_calamine, olefile, msoffcrypto, defusedxml, requests, httpx, yaml, tomlkit, orjson, jsonschema, jinja2, click, typer, rich, tqdm, dotenv, filelock, tenacity, git, sqlalchemy, pytest, pydantic, scipy, matplotlib, seaborn, pyarrow, tabulate'
  finish python-extras
else
  skip python-extras
fi

step 'share'
if ! finished share; then
  mkdir -p "$DSH_PRODUCT/share"
  cp -a "$DSH_SRC/LICENSE" "$DSH_PRODUCT/share/LICENSE"
  cp -a "$DSH_SRC/THIRD_PARTY_NOTICES.md" "$DSH_PRODUCT/share/THIRD_PARTY_NOTICES.md"
  if [ "$DSH_PYTHON_ONLY" = '1' ]; then
    rm -rf "$DSH_PRODUCT/node"
  fi
  finish share
else
  skip share
fi

du -sh "$DSH_PRODUCT" > "$DSH_REPORT/product-size.txt"
printf 'prepared\n'
