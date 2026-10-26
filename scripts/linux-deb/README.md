# Linux arm64 Debian package

English | [中文](README.zh.md)

`pnpm run deb:build` builds the arm64 `.deb` for dsh on a host that only needs Docker and a network connection.
Every toolchain, interpreter, wheel, and resource archive is materialized inside an emulated linux/arm64 container, so the delivered package installs on an offline arm64 machine with no system Node.js or CPython.

## Build host requirements

- Docker with a reachable daemon, and network access to npm, PyPI, nodejs.org, GitHub release assets, and the container registry.
- The ability to run linux/arm64 containers.
  On an arm64 host this is native; on any other host the kernel must dispatch arm64 binaries to an emulator, which this builder mounts into every container with `--emulator`.
- Disk and memory for the emulated build: expect roughly 15 GB of build state and several hours of wall time under emulation, or under an hour on a native arm64 host.

If the daemon reports `exec format error` for arm64 images, register the emulator once:

```sh
docker create --name dsh-binfmt tonistiigi/binfmt:latest
docker cp dsh-binfmt:/usr/bin/qemu-aarch64 /usr/bin/qemu-aarch64-static
docker rm -f dsh-binfmt
printf '%s' ':qemu-aarch64:M::\x7f\x45\x4c\x46\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-aarch64-static:POC' > /proc/sys/fs/binfmt_misc/register
```

The `POC` registration works on kernels that reject the `F` flag; the builder then mounts `--emulator` into each container so the interpreter path resolves inside it.

## Usage

```sh
pnpm run deb:build                                  # dist/deb/capex-harness_<version>_arm64.deb
pnpm run deb:build -- --glibc-floor 2.28            # rebuild the glibc-linked addons on manylinux 2.28
pnpm run deb:build -- --python-only                 # skip the Node.js CLI payload
pnpm run deb:build -- --stage package               # rerun one stage against the existing work tree
pnpm run deb:build -- --dry-run                     # print the container commands only
pnpm run deb:build -- --stage installer \
  --payload-url http://15.11.40.31:7009/public/capex/capex-harness_0.2.1~rc.3_arm64.deb \
  --payload-user cape --payload-password-file /root/capex-installer-password
```

Options: `--repo`, `--out`, `--work`, `--cache`, `--clean`, `--stage <all|prepare|natives|package|reports|installer>`, `--base-image`, `--js-image`, `--natives-image`, `--emulator`, `--network`, `--glibc-floor`, `--maintainer`, `--revision`, `--python-only`, `--skip-smoke`, `--installer`, `--installer-image`, `--payload-url`, `--payload-user`, `--payload-password-file`, `--dry-run`.
`--network host` gives every stage container the host network namespace and its resolver; use it when the Docker bridge cannot resolve names or reach the internet, which otherwise fails at the first apt or registry download.
`--maintainer` sets the Debian `Maintainer` field and defaults to a local placeholder, so set it when the package leaves your machine.
`--revision` is empty by default, so the artifact keeps the product version without a Debian revision suffix. Pass an explicit value only when a downstream repository needs one.
`--installer` adds the small authenticated network installer after the payload package. It requires the exact payload URL, HTTP user, and a root-owned password file.
The resulting installer embeds an extractable copy of that password, so distribute the artifact only through a controlled channel and rotate the password if it escapes.

Downloaded dependencies are kept under `--cache` (default `<work>/cache`) and mounted into every stage: apt archives and indexes, the pnpm store inside the work tree, PyPI wheels, the packager's runtime cache, and the pip, npm, and uv caches. Rebuilding therefore reuses them; delete the cache only to force fresh downloads, and never delete it just to rerun a stage.

Downloads follow the locked upstream URLs by default; on a slow network point the build at faster mirrors without changing what is verified: `--npm-registry <url>` (npm registry used for the workspace install, with an automatic retry against the lockfile's registry), `--pip-index <url>`, `--apt-mirror <origin+path>` (rewrites the container's Ubuntu port origin), `--js-apt-mirror <origin+path>` (native-architecture origin for the JavaScript phase, which defaults to `--apt-mirror`), `--node-url <url>`, and `--python-url <url>` (both still checked against the lock's SHA-256).
The apt mirrors must serve the containers over plain HTTP, because the build installs `ca-certificates` before any TLS download can succeed, and each must carry the Ubuntu release of the image it serves: `--apt-mirror` the arm64 port archive, `--js-apt-mirror` the native archive beside it.

## Offline deployment

The package targets an intranet machine: no public internet, and a privately deployed model behind an OpenAI- or Anthropic-compatible endpoint. The shipped profile matches that shape.

- Session telemetry and the DeepSeek session-log contributor stay off, and `/usr/bin/dsh` plus `/usr/bin/dsh-sdk` set `DSH_TELEMETRY_DISABLED=1`; an explicit environment value still wins.
- The web search and fetch tools are unmounted, so the model is never offered a tool that could only reach the public internet.
- Plugin installs ask one registry: the one pnpm's own configuration names (`npm_config_registry`, or `registry=` in `~/.npmrc` or `/etc/npmrc`), or a URL typed into the install dialog. Public fallbacks are off, and a private registry needs no rebuild — point the machine at it once it exists.

Configure the model once: Settings → Models, fill the custom model API card (provider id, display name, base URL, protocol, model ids, API key), then choose one of its models in the composer's model picker. That choice becomes the default for later sessions.

## Browser baseline

The packaged UI targets the Chromium 102 shells that ship on the deployment images (Qaxbrowser 1.0.45966.7 reports Chromium 102.0.5005.200).

- `pnpm run compat:audit` scans the built artifacts and writes `dist/compat/chromium102.md`; `--fail-on=hard` exits non-zero while an unhandled call-time failure remains.
- Client bundles compile against `chrome102` (`packages/client/tsdown.client.ts`, `apps/web/vite.config.ts`), so the bundler never emits syntax or range media queries that shell drops.
- `installBrowserCompat()` in `packages/client/web/src/compat.ts` installs the standard-library members the shell lacks (`Promise.withResolvers`, `AbortSignal.any`/`timeout`, the Array copy methods, the Set composition methods). Without it the Models settings pane throws during render and stays blank.
- The PDF and spreadsheet engines run in their own workers; `worker-compat.ts` prepends the same shims to both blob sources, and the Excel preview scopes its vendor sheet with explicit selectors instead of a scoped at-rule.
- Menu and overlay fills are opaque and `--dsw-menu-backdrop-filter` resolves to `none`: that shell composites a translucent `backdrop-filter` layer against an empty backdrop, which paints the card gray and covers rows with leaked color bands.
- `color-mix()`, container queries, and `scrollbar-width` are compiled into their precomputed equivalents at build time (`scripts/compat/`), so tints, breakpoints, and hidden scrollbars survive.
- Rules that still use `:has()` lose only hover affordances and overlay padding on that shell; nothing in the boot or settings path depends on them.

`DSH_CLIENT_TARGET` overrides the bundle target for local checks, for example `DSH_CLIENT_TARGET=chrome90 pnpm run build:artifacts` to exercise the shell in an older locally available build.

## Stages

Each stage records a marker under `<work>/state` and is safe to rerun: `prepare` (toolchain, Node.js, pnpm, workspace install, artifacts, native addons, packaged runtime executable, wheels, bundled CPython, SDK install, resource seed, Python extras and wheelhouse), `natives` (only when `--glibc-floor` is below the base image's 2.31), `package` (relocation, control file, ELF symbol capture, `dpkg-deb`, installed smoke tests), and `reports` (glibc enforcement plus `manifest.json` and `DEPENDENCIES.md`).
Delete the work tree to force a clean build, or pass `--clean`.

`prepare` runs two containers against the same work tree. The JavaScript phase
runs on the daemon's own architecture and stops after `build:artifacts`;
bundlers load native bindings that emulation cannot execute, so this phase must
not run inside the arm64 container. The payload phase then runs in the arm64
container, reinstalls the workspace for arm64, and assembles everything else.
`--js-image` names the image for the first phase and defaults to the base image.

## Build performance

A full first build is dominated by arm64 execution under qemu, workspace installation, SDK/runtime generation, and compression of the approximately 1.1 GB payload. On the current VM, four vCPUs are the primary limit.

- Reuse the same `--work` and `--cache` for iterative packages. Run `prepare` when source dependencies, toolchains, native modules, resources, or generated runtime inputs change; otherwise run only `package` and `reports`.
- Use `--skip-smoke` only to shorten intermediate iterations. The delivery build always runs the installed-package smoke.
- Never delete the dependency cache to make a routine rebuild faster; deleting it forces network downloads and regeneration.
- Increasing VM vCPUs is the largest hardware improvement. QEMU still limits each arm64 process, but independent compiler, packaging, and runtime jobs can use additional cores.
- The `--cache` directory does not replace the work store or installed workspace closure. Preserve `work/store`, `work/.pnpm-store`, and the existing dependency tree when reusing a work tree, or allow one online prepare to populate them.
- Do not blindly reuse state markers after changing static bundle files. Refresh the product tree or patch the corresponding packaged file; otherwise tests can pass against source while the artifact retains an older profile.
- Native binaries are not guaranteed to exist in the source tree. Build the platform addons and verify `bin/glibc/system.node`, `bin/musl/system.node`, `bin/landlock-run`, and `node-pty` before packaging; loading the module without exercising a lock is insufficient.
- ELF discovery dominates package time under qemu. Cache the version-info result while the product is unchanged, and prefilter non-ELF files in future packaging changes.
- Default xz compression can take tens of minutes on this VM. A lower xz level retained broadly compatible dpkg support and reduced packaging to about 17 minutes while producing a 1.13 GB deb in the rc.3 build.
- Treat registry/CDN timeouts as a cache defect first. Mount npm and pnpm metadata caches, reuse the locked store, and keep full smoke for the final artifact.
- Runtime verification must execute the packaged launcher, not grep its text. Test the stale URL left after reboot, the complete browser argv, repeated-click window focus, a real native lock, and plugin activation.

## Output

- `capex-harness_<version>_arm64.deb` — the package. It installs `/usr/bin/dsh` (source-built closure on the bundled Node.js), `/usr/bin/dsh-sdk` (the packaged Python runtime wheel's console script with a default `DSH_HOME`), `/usr/bin/dsh-python` (bundled CPython), `/usr/bin/dsh-pip` (offline pip over the bundled wheelhouse), `/usr/bin/dsh-office-convert` (WPS-aware Office conversion), and the payload under `/usr/lib/capex-harness`.
- `capex-harness-installer_<version>_arm64.deb` — the optional few-KiB network installer. It downloads the exact payload URL after the installing package transaction completes, verifies its size, SHA-256, package name, version, and architecture, then installs it with `apt-get`. `capex-harness-install-status` reports progress and `sudo capex-harness-install` retries a failed download or installation.
- Desktop integration: an application-menu entry (`Capex Harness`) and the launcher a click runs (`/usr/bin/dsh-web`) start the `capex` profile, wait for its authenticated URL, and open it in the current default browser. On X11, a click without a document first focuses the current user's existing window whose title ends in `Capex Harness`, including a minimized window, instead of opening another one. The launcher honors `DSH_BROWSER`, preserves the default browser's desktop-entry arguments, requests `--app` from Chromium-compatible browsers, retains the installed QiAnXin launcher as a fallback, and finally uses `xdg-open`. Packaged Web builds use `Capex Harness` for both the document and application-frame title. The entry accepts file URIs through `%U`; `/usr/bin/dsh-web-register-file-types` opts the current user into supported document associations. Run the desktop-icon helper as the desktop user, never with `sudo`. `--python-only` ships no shortcut, because the launcher runs the bundled Node.js CLI.
- Each OS user gets a separate `$HOME/.dsh` and private runtime URL under `$XDG_RUNTIME_DIR` (or `/tmp/capex-harness-<uid>`), so a shared host does not reuse another user's Host. The Settings fallback identifies the Host process owner.
- The `capex` profile defaults to the `capexai` OpenAI Chat Completions route at `http://15.11.40.44:3100/v1` and the `deepseek-flash` model. Its credential reference is `CAPEXAI_API_KEY`; the package contains no secret. Users can add further providers in Settings.
- The arm64 payload includes the glibc and musl `system.node` addons, the static `landlock-run` launcher, and the `node-pty` addon. Package smoke loads `system.node` and acquires a real exclusive file lock.
- `DEPENDENCIES.md` — every apt package, npm tarball, PyPI distribution, locked archive, image, and locally built artifact the build resolved, with versions, sources, digests, and whether the bytes ship inside the package.
- `manifest.json` — the same inventory in machine-readable form, with the source revision and the payload's glibc symbol ceiling.
- `verify-on-target.sh` — run it on the target machine after installing: it checks the architecture, glibc, installed commands, and that the seeded resource cache serves the runtime with downloads disabled.
- `installer-manifest.json` — the network installer's package metadata, payload URL and expected digest, and artifact digest; it never contains the HTTP password.
- `build-report/` — the container evidence: rendered control file, `dpkg-deb` inspection and contents, smoke-test output, and the ELF symbol capture.

## Offline Python extras and WPS conversion

The ARM64 payload installs the distributions listed in [`python-extras.requirements.txt`](python-extras.requirements.txt) into both bundled CPython environments and copies every resolved wheel into `/usr/lib/capex-harness/wheelhouse`. The build accepts binary wheels only; `record-runtime-extras.py` writes the exact installed distribution versions into the primary runtime's `runtime.json`, and `record-wheelhouse.py` adds each wheel's name, version, and SHA-256 to `DEPENDENCIES.md`. It also writes `share/python-wheelhouse-NOTICES.md` from the wheels' own metadata and rejects GPL/AGPL terms.

`dsh-python` points `PIP_NO_INDEX` and `PIP_FIND_LINKS` at that wheelhouse by default. `dsh-pip` uses an active virtual environment when `VIRTUAL_ENV` names one, and otherwise installs into the bundled Python. Both variables remain operator-overridable for a private source.

The Web profile mounts `workspace-dependencies` and `skill-office` from the same `DSH_PRIMARY_RUNTIME` or `DSH_BUNDLED_PRIMARY_RUNTIME` paths as the SDK profile. `dsh` and `dsh-sdk` export `DSH_BUNDLED_OFFICE_CONVERT` to that profile.

`dsh-office-convert` accepts `--input`, `--output`, and `--engine auto|wps|libreoffice`. `auto` uses a system WPS only when its help advertises both `--headless` and `--convert-to`; a probe failure, timeout, nonzero exit, or invalid output falls back to LibreOffice Kit. Set `DSH_WPS_DIR` when the `wps`, `et`, and `wpp` executables live outside PATH or `/opt/kingsoft/wps-office/office6`.

## Verification and limits

The `package` stage installs the built `.deb` inside the container and runs `dsh --version`, `dsh web --help`, `dsh-sdk --help`, `import deepseek_harness`, the bundled extension imports, an offline virtual-environment install, and a LibreOffice conversion fallback; pass `--skip-smoke` only to iterate on packaging. `--python-only` omits the Node-backed `dsh` and `dsh-office-convert` commands while keeping `dsh-pip` and the Python extras.
The builder then refuses to deliver a package whose payload needs glibc newer than `--glibc-floor`, naming every offending file.

Known limits: the payload is arm64 only; the glibc floor is the base image's 2.31 unless `--glibc-floor` triggers the manylinux rebuild; `--python-only` drops the Node.js CLI, its runtime, and the desktop shortcut; and the target machine is never contacted, so `verify-on-target.sh` is the only check that runs there.
