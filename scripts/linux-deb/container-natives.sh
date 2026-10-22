#!/usr/bin/env bash
# Rebuild the glibc-linked native addons against an older C library.
#
# build-deb.ts runs this only when the requested floor is below the base image's
# own glibc: the payload's other interpreters and archives are prebuilt for
# glibc 2.28 already, so the two locally compiled addons set the real ceiling.
set -euo pipefail

require() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "container-natives: $name must be set" >&2
    exit 2
  fi
}

for name in DSH_SRC DSH_DOWNLOADS DSH_OVERRIDES; do
  require "$name"
done

NODE_ROOT=${DSH_NODE_ROOT:-/opt/dsh-node}

printf '\n===== node =====\n'
if [ -x "$NODE_ROOT/bin/node" ]; then
  "$NODE_ROOT/bin/node" --version
else
  mkdir -p "$NODE_ROOT"
  tar -xzf "$DSH_DOWNLOADS/node.tar.gz" -C "$NODE_ROOT" --strip-components=1
fi
export PATH="$NODE_ROOT/bin:$PATH"
if [ -d /work/tools/bin ]; then
  export PATH="/work/tools/bin:$PATH"
fi

printf '\n===== glibc addon =====\n'
( cd "$DSH_SRC/native/system" && node scripts/build.ts --host-addon-only )
built="$DSH_SRC/native/system/packages/linux-arm64/bin/glibc/system.node"
if [ ! -f "$built" ]; then
  echo "container-natives: $built was not produced" >&2
  exit 1
fi

printf '\n===== node-pty addon =====\n'
node_pty="$DSH_SRC/packages/subprocess/subprocess-local/node_modules/node-pty"
if [ ! -d "$node_pty" ]; then
  echo "container-natives: node-pty is not installed at $node_pty" >&2
  exit 1
fi
rm -rf "$node_pty/build"
(
  cd "$node_pty"
  npm_config_build_from_source=true npm_config_nodedir="$NODE_ROOT" \
    "$NODE_ROOT/bin/node" "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" rebuild node-pty
)
pty="$node_pty/build/Release/pty.node"
if [ ! -f "$pty" ]; then
  echo "container-natives: $pty was not produced" >&2
  exit 1
fi

mkdir -p "$DSH_OVERRIDES"
cp -f "$built" "$DSH_OVERRIDES/system.node"
cp -f "$pty" "$DSH_OVERRIDES/pty.node"
chmod 0755 "$DSH_OVERRIDES"/*.node
ls -l "$DSH_OVERRIDES"
printf 'natives rebuilt\n'
