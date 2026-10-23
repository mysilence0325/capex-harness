---
kind: upgrade-guide
description: "The Debian product now launches the capex profile and adds local identity, desktop file opening, diagnostics, and recoverable maintenance commands."
---

# Capex launches the `capex` profile

English | [中文](guide.zh.md)

## Change

The Debian launcher now boots `capex`, an offline Web profile built from `dsh-base`, `dsh-web-app`, and `dsh-capex`. It disables cloud-account consumers while keeping `credentials-local` for browser-session cookies. The Settings fallback shows the Host process owner's local name, and desktop document launches open in a blank Session preview. The Client Remote assembly includes `remote.storageMaintenance`, so the local-data Settings row activates normally.

The Debian launcher uses the current default browser. It reads `DSH_BROWSER`, preserves the default browser desktop entry's arguments, requests an application window with `--app` from Chromium-compatible browsers, falls back to the installed QiAnXin launcher, then to `xdg-open`. The document and application-frame title is `Capex Harness`.

The `capex` profile supplies the `capexai` OpenAI Chat Completions route at `http://15.11.40.44:3100/v1`, the `deepseek-flash` model, and that model as the default. It authenticates through `CAPEXAI_API_KEY`; the package contains no secret. Model settings remain profile-local, so old settings under `web` are retained but do not appear in `capex`.

On a shared host, every OS account gets its own `$HOME/.dsh`, private runtime URL, and Host process. The Settings fallback names that process owner. Multiple natural users sharing one OS account are not distinguished.

The arm64 package now carries the glibc and musl `system.node` addons and `landlock-run`. The previous same-version package omitted them, so startup succeeded until session persistence first requested a native file lock.

`dsh doctor` checks the installation and model endpoint. `dsh clean` previews recoverable local-data maintenance; `--apply` moves eligible archived Sessions and unreferenced data into a batch under `$DSH_HOME/trash/maintenance`, and `--restore` reverses it. The Debian artifact has no revision suffix and is named `capex-harness_<version>_arm64.deb`.

## Migration

1. Reinstall the corrected same-version artifact with `sudo dpkg -i capex-harness_0.2.1~rc.3_arm64.deb`.
2. Confirm that custom startup commands use `dsh capex` rather than `dsh web`.
3. If the existing credential store does not already hold `CAPEXAI_API_KEY`, enter the key once under Settings → Models. Do not place it in `cordis.patch.yml`.
4. Keep settings for other providers in `$DSH_HOME/profiles/capex/cordis.patch.yml`; settings under `profiles/web` are not migrated.
5. Set `DSH_BROWSER` only to override the desktop default. The packaged launcher preserves QiAnXin's safe launcher arguments.
6. Run `dsh doctor --quick`, then `dsh doctor --model-url http://15.11.40.44:3100/v1`, and confirm a model request succeeds.
7. Run `dsh clean` before `dsh clean --apply`; stop the Web Host before applying. Record the printed batch name and use `dsh clean --restore <batch>` if needed.
8. Run `/usr/bin/dsh-web-register-file-types` as the desktop user if supported documents should open in Capex by default.
9. Verify the desktop entry uses `Exec=/usr/bin/dsh-web %U`, the window title is `Capex Harness`, Settings shows `capexai` and `DeepSeek Flash`, and local data loads without a plugin error.
10. Run the delivered `verify-on-target.sh`; it checks the native payload and acquires a real exclusive file lock.
