---
kind: upgrade-guide
description: "The Debian product now launches the capex profile and adds local identity, desktop file opening, diagnostics, and recoverable maintenance commands."
---

# Capex launches the `capex` profile

English | [中文](guide.zh.md)

## Change

The Debian launcher now boots `capex`, an offline Web profile built from `dsh-base`, `dsh-web-app`, and `dsh-capex`. It disables cloud-account consumers while keeping `credentials-local` for browser-session cookies. The Settings fallback shows the Host process owner's local name, and desktop document launches open in a blank Session preview.

`dsh doctor` checks the installation and model endpoint. `dsh clean` previews recoverable local-data maintenance; `--apply` moves eligible archived Sessions and unreferenced data into a batch under `$DSH_HOME/trash/maintenance`, and `--restore` reverses it. The Debian artifact has no revision suffix and is named `capex-harness_<version>_arm64.deb`.

## Migration

1. Confirm that custom startup commands use `dsh capex` rather than `dsh web`.
2. Keep site-specific model endpoints in Settings or pass `--model-url` to `dsh doctor`; they are not embedded in the package.
3. Run `dsh doctor --quick` after installation and `dsh doctor --model-url <base-url>` against the deployed model.
4. Run `dsh clean` before `dsh clean --apply`; stop the Web Host before applying. Record the printed batch name and use `dsh clean --restore <batch>` if needed.
5. Run `/usr/bin/dsh-web-register-file-types` as the desktop user if supported documents should open in Capex by default.
6. Verify the desktop entry uses `Exec=/usr/bin/dsh-web %U`, `gio open` opens the file preview, and the sidebar shows the local user's name.
