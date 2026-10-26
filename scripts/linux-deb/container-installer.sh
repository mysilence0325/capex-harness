#!/usr/bin/env bash
set -euo pipefail

require() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "container-installer: $name must be set" >&2
    exit 2
  fi
}

for name in DSH_INSTALLER_ROOT DSH_INSTALLER_NAME DSH_PAYLOAD_NAME DSH_PAYLOAD_PACKAGE \
  DSH_PAYLOAD_VERSION DSH_PAYLOAD_ARCH DSH_PAYLOAD_SIZE DSH_PAYLOAD_SHA256; do
  require "$name"
done

payload="/out/$DSH_PAYLOAD_NAME"
if [ ! -f "$payload" ]; then
  echo "container-installer: payload is missing: $payload" >&2
  exit 1
fi
if [ "$(dpkg-deb -f "$payload" Package)" != "$DSH_PAYLOAD_PACKAGE" ] \
  || [ "$(dpkg-deb -f "$payload" Version)" != "$DSH_PAYLOAD_VERSION" ] \
  || [ "$(dpkg-deb -f "$payload" Architecture)" != "$DSH_PAYLOAD_ARCH" ]; then
  echo "container-installer: payload Debian metadata does not match the requested release" >&2
  exit 1
fi
if [ "$(stat -c %s "$payload")" != "$DSH_PAYLOAD_SIZE" ] \
  || [ "$(sha256sum "$payload" | cut -d' ' -f1)" != "$DSH_PAYLOAD_SHA256" ]; then
  echo "container-installer: payload size or SHA-256 changed during installer generation" >&2
  exit 1
fi

root=$DSH_INSTALLER_ROOT
installed_kib=$(du -sk "$root" | cut -f1)
if ! grep -q '^Installed-Size: ' "$root/DEBIAN/control"; then
  printf 'Installed-Size: %s\n' "$installed_kib" >> "$root/DEBIAN/control"
fi
(
  cd "$root"
  find . -type f ! -path './DEBIAN/*' -printf '%P\0' \
    | sort -z \
    | xargs -0 -r md5sum > DEBIAN/md5sums
)
mkdir -p /work/installer-report
dpkg-deb --build --root-owner-group "$root" "/out/$DSH_INSTALLER_NAME" >/dev/null
dpkg-deb -I "/out/$DSH_INSTALLER_NAME" > /work/installer-report/control.txt
dpkg-deb -c "/out/$DSH_INSTALLER_NAME" > /work/installer-report/contents.txt
