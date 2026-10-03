# Chromium 90 browser-floor lane

English | [中文](README.zh.md)

The lane drives a portable Chromium 90 snapshot build over the Chrome DevTools protocol against a `dsh web` server that is already running, reads the floor's facts back out of that engine, writes screenshots, and prints one JSON report. It is the behavior half of the [client browser floor](../../.agents/notes/implemented/architecture/2026-09-30-client-browser-floor.md): the gates beside it pin the build inputs and the shipped bytes, and this lane is what says the served client still renders on the engine itself.

## Why it lives here

`scripts/` already owns the floor. [client-browser-floor.ts](../client-browser-floor.ts) defines the script target, the API contract, and the stylesheet rewrites, and [verify-client-browser-floor.ts](../verify-client-browser-floor.ts) is the artifact gate. The lane imports `CLIENT_FLOOR_APIS` from that definition, so the API list keeps one home, and it joins the other workstation-only lanes under `scripts/` that need a binary the repository does not vendor, such as `libreoffice-engine` and `wine-windows-gates.sh`.

The browser lane in `apps/web/tests/` is not this lane's home. Those specs are a vitest inventory that boots its own in-process host and drives the browsers the lockfile selects; this lane points at an already-running server and at an engine no lockfile can install. Nothing here is a gate, so [run-gates.ts](../run-gates.ts) does not list it.

## Get the portable build

Chromium **90.0.4430.0**, snapshot revision **857891** (2021-02-25), x64 Windows.

1. Download <https://mirrors.huaweicloud.com/chromium-browser-snapshots/Win_x64/857891/chrome-win.zip> (166 MB). The Google-hosted origin `commondatastorage.googleapis.com` was unreachable from the network this floor was built on, and npmmirror's cache holds only a Chromium 91 build for that window.
2. Unpack it anywhere. The executable is `<dir>\r857891\chrome-win\chrome.exe`, a PE binary whose ProductVersion is `90.0.4430.0`.
3. Point `--chrome` at it. A snapshot is portable: it needs no installer, writes no registry keys, and keeps its state in the `--user-data-dir` the lane passes, which defaults to `<shots>/chrome-profile`.

The archive is not committed, and no build step requires it.

## Start a server

```sh
pnpm dsh web --no-open
# dsh web: http://127.0.0.1:<port>/?token=<token>
```

The URL with its token is the lane's only credential. `--url-file <path>` reads the last token URL a file holds, which is how a teammate takes the URL from the log of a background server instead of copying a token that may already be stale; a UTF-16LE log written by a PowerShell redirect is decoded too.

## Run the lane

```sh
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url "http://127.0.0.1:<port>/?token=<token>"
```

Without a server, the same driver runs against the lane's own fixture page:

```sh
npx tsx scripts/browser-floor-lane/drive.ts --chrome "<dir>\r857891\chrome-win\chrome.exe" --smoke
```

| Flag | Environment variable | Default |
|---|---|---|
| `--chrome <path>` | `DSH_FLOOR_CHROME` | none; the run fails loud without it |
| `--url <url>` | `DSH_FLOOR_URL` | `http://127.0.0.1:3080/`, the Web profile port |
| `--url-file <path>` | `DSH_FLOOR_URL_FILE` | none |
| `--token <token>` | `DSH_FLOOR_TOKEN` | none; appended when the URL has no token |
| `--shots <dir>` | `DSH_FLOOR_SHOTS` | `.artifacts/browser-floor-lane` |
| `--profile <dir>` | `DSH_FLOOR_PROFILE` | `<shots>/chrome-profile` |
| `--report <path>` | `DSH_FLOOR_REPORT` | `<shots>/report.json` |
| `--cdp-port <port>` | `DSH_FLOOR_CDP_PORT` | `9333` |
| `--window <WxH>` | `DSH_FLOOR_WINDOW` | `1440x900` |
| `--narrow-width <px>` | `DSH_FLOOR_NARROW_WIDTH` | `520`, the marked side of every breakpoint |
| `--wide-width <px>` | `DSH_FLOOR_WIDE_WIDTH` | `2400`, the unmarked side |
| `--engine-major <n>` | `DSH_FLOOR_ENGINE_MAJOR` | `90` |
| `--target-timeout <ms>` | `DSH_FLOOR_TARGET_TIMEOUT` | `60000` |
| `--load-settle <ms>` | `DSH_FLOOR_LOAD_SETTLE` | `4000` |
| `--settle <ms>` | `DSH_FLOOR_SETTLE` | `1200` |
| `--session-attempts <n>` | `DSH_FLOOR_SESSION_ATTEMPTS` | `6`; `0` reads whatever Session is open |
| `--session-timeout <ms>` | `DSH_FLOOR_SESSION_TIMEOUT` | `6000` |
| `--fail-on-log-errors` | `DSH_FLOOR_FAIL_ON_LOG_ERRORS=1` | off; see the console check below |
| `--smoke` | none | off; runs against `smoke/fixture.html` |

The driver picks the Session itself: it clicks the sidebar rows in order until one renders at least two turn marks, because the turn rail renders only for a multi-turn Session, and it restores the view tab it found afterwards.

Output goes to three places: the JSON report on stdout, one summary line on stderr, and `--report` plus three screenshots in `--shots`. The exit code is `0` when every check passed, `1` when a check failed or a fact was unreadable, and `2` on a usage or startup failure.

## What each check means

| Check | Reads | Passes when |
|---|---|---|
| `floor.engine` | `navigator.userAgent` | the major version is `--engine-major`; any other engine makes every other check vacuous |
| `floor.apis` | every name in `CLIENT_FLOOR_APIS`, resolved in the page | each one is present and none is the engine's own `[native code]` implementation, so the shell compat entry ran |
| `floor.iterator-statics` | `Iterator.from`, `Iterator.prototype.map` | the global is installed and both statics stay undefined, the one gap the floor records |
| `layout.composer-control-row` | the control row's own content box, its `data-narrow`/`data-tight` markers, and the control groups' `column-gap` | at the narrow viewport the row is at or below 560px with both markers and an 8px gap; at the wide viewport it is above 560px with neither marker and a 12px gap |
| `layout.header-title-row` | the `header` title row's content box and its markers | at the narrow viewport it is at or below 540px with `data-narrow` (540) and `data-tight` (480); at the wide viewport it carries neither |
| `layout.turn-rail-band` | the band that states the transcript width, and the rail frame it selects | at the narrow viewport the band is at or below 900px, marked, and its frame computes `display: none`; at the wide viewport it is unmarked and the frame renders |
| `layout.trajectory-pane` | the trajectory pane's own width, its marker, and the kind label the compact columns collapse | at the narrow viewport the pane is at or below 620px, marked, with the label at `opacity: 0`; at the wide viewport it is unmarked with `opacity: 1` |
| `scroll.conversation-scroller` | the conversation scroller's computed `overflow-y` and the space reserved for its scrollbar | it computes `scroll`, the floor's replacement for `scrollbar-gutter`; the reserved width is reported |
| `css.no-container-queries` | every rule in every mounted document-level stylesheet | no `@container` rule is mounted, the feature the floor cannot render |
| `console.errors` | the run's console errors and exceptions, plus the browser's error-level log entries | the page logged no console error and threw no exception. Error-level log entries (a failed request) are recorded in the report and fail the run only under `--fail-on-log-errors`, because a route outside the floor answering 404 says nothing about the floor |

### The changed-files 404s

A run against a Session older than the recording process's live turns records error-level log entries for `GET /api/changes.summary?sessionId=…&seq=…` answered `404`. The owner accepted them as designed: the changed-files card is a live-turn artifact, so the Host answers `404` with `Change summary unavailable.` once it no longer holds the turn's summary, and reading an older Session asks for summaries that are gone. The route is mounted and the answer comes from its registered handler, `handleChangesSummary` in [present-open.ts](../../packages/client/ui-deliverables/src/present-open.ts); the product behaviour is unchanged and [the deliverables README](../../packages/client/ui-deliverables/README.md) owns it.

Three answers share the status, and only the body separates them: `not found` is the dispatcher answering with no route matched, `Change summary unavailable.` (or `Change comparison unavailable.` for `/api/changes.diff`) is that handler refusing a summary it no longer holds, and an empty body with no `content-type` is the SPA fallback. A console log entry carries the status and the URL but not the body, so the lane cannot tell those three apart from the log alone.

The report labels what it recognizes. `events.logErrorLabels` holds one record per error-level log entry whose path starts with `/api/changes.` and whose log text states `404`: its index in `events.logErrors`, the path, the status, the label `handler's own expired-summary answer`, and a note stating that the reading is a heuristic on the URL family and the status rather than a look at the response. Every other entry in `events.logErrors` stays as it was, and the label decides nothing: console errors and exceptions still gate the run, and error-level log entries still gate it only under `--fail-on-log-errors`.

## What it cannot see

- It reads one Session's rendered DOM at two viewport widths. The workspace list, settings, dialogs, and the preview Workers are not exercised; a Worker is a realm of its own, and the lane reads only the page realm.
- It scans the mounted document-level stylesheets, inline and linked alike. A shadow root's own sheets are outside the walk, and a cross-origin sheet is counted as unreadable rather than read.
- Font metrics decide the composer row's own width, so `--narrow-width` has to stay inside the band: the check fails with the measured width when the row is too wide to be marked, rather than passing quietly.
- Surfaces a Session does not mount report as `absent`, and an absent fact fails the run. The turn rail needs two turns; the trajectory pane needs a Session with a trajectory.
- It does not prove the shipped bytes. Artifact syntax and post-floor API call sites belong to the artifact gate, and the corpus counts to the ratchet.
- A green run says the facts above were read from this engine on this server. It says nothing about engines newer than the floor, which the repository's other browser lanes already cover.

## Why this is a manual lane, not a CI job

No CI image carries Chromium 90, and none can: the repository's browser jobs install the Chromium and WebKit that the lockfile selects, and the floor is four years older than that Chromium. The floor's deployment target is also not CI — it is the LAN server a browser reaches — so a CI job with a modern engine would answer a different question. The lane therefore stays a workstation lane a teammate re-runs, and the decision to keep it out of the matrix is recorded here rather than in a job name.

CI holds three things in its place, all keyless and all on the artifact side. The artifact gate [verify-client-browser-floor.ts](../verify-client-browser-floor.ts) parses every browser artifact and every JavaScript payload embedded in one as text, rejecting post-floor syntax and every call site in its `FLOOR_DENIED_APIS` list. The corpus ratchet [client-browser-floor.spec.ts](../client-browser-floor.spec.ts) pins the resolved targets, the `color-mix()` rewrite, and the dynamic-viewport-unit fallbacks, proves every mix in the client stylesheets resolves, and holds the source corpus at its recorded counts for the nine features the floor drops whole, among them the absence of any container query and of any `scrollbar-gutter` declaration. The API contract in [compat.client.spec.ts](../../packages/client/web/tests/compat.client.spec.ts) removes each API from the realm, pins the install list in order, and drives every installed implementation. What none of them can do is boot the engine; that is what this lane is for, and a behavior regression is found by re-running it.

## Files

| File | Role |
|---|---|
| `drive.ts` | Flags, browser lifecycle, DevTools connection, Session selection, the report |
| `steps.ts` | The checks, the viewport passes, and the page operations they need |
| `probe.js` | Page source the driver evaluates: it must stay parseable by the floor engine and must not call the APIs the floor installs |
| `smoke/fixture.html` | The lane's own fixture page, for a run without a server |
