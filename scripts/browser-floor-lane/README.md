# Chromium 90 browser-floor lane

English | [中文](README.zh.md)

The lane drives a portable Chromium 90 snapshot build over the Chrome DevTools protocol against a `dsh web` server that is already running, reads the floor's facts back out of that engine, writes screenshots, and prints one JSON report. It is the behavior half of the [client browser floor](../../.agents/notes/implemented/architecture/2026-09-30-client-browser-floor.md): the gates beside it pin the build inputs and the shipped bytes, and this lane is what says the served client still renders on the engine itself. Three of its checks need a real model behind the server and a fourth needs the server started with this repository's agent-team overlay; the rest read any server.

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

Three checks type into the composer and let a real model answer, so the server they run against has to hold the key in its own environment:

```sh
$env:DEEPSEEK_API_KEY='<key>'
pnpm dsh web --no-open --port 3081
```

The key belongs to that server process; nothing here reads it, writes it, or prints it.

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

The keyed checks are opt-in, because every other check runs against a server that has no model behind it:

```sh
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url-file .artifacts/floor-lane-server.log --model-checks
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
| `--model-checks` | `DSH_FLOOR_MODEL_CHECKS=1` | off; runs the keyed, real-model checks against a server started with `DEEPSEEK_API_KEY` |
| `--pdf-preview <file>` | `DSH_FLOOR_PDF_PREVIEW` | none; opens a PDF already in the Session workspace and runs `preview.pdf` against it, without a model |
| `--gesture-timeout <ms>` | `DSH_FLOOR_GESTURE_TIMEOUT` | `45000`; how long one page gesture of a model check waits |
| `--reply-timeout <ms>` | `DSH_FLOOR_REPLY_TIMEOUT` | `240000`; how long one real-model turn may take |
| `--fail-on-log-errors` | `DSH_FLOOR_FAIL_ON_LOG_ERRORS=1` | off; see the console check below |
| `--smoke` | none | off; runs against `smoke/fixture.html` |

The driver picks the Session itself: it clicks the sidebar rows in order until one renders at least two turn marks, because the turn rail renders only for a multi-turn Session, and it restores the view tab it found afterwards. After the viewport passes it opens the right Sidebar, picks the workspace-files entry, and opens `AGENTS.md`, which is the gesture the preview check reads.

Output goes to three places: the JSON report on stdout, one summary line on stderr, and `--report` plus three screenshots in `--shots`, four under `--pdf-preview` and five under `--model-checks`. The exit code is `0` when every check passed, `1` when a check failed or a fact was unreadable, and `2` on a usage or startup failure.

## What each check means

| Check | Reads | Passes when |
|---|---|---|
| `floor.engine` | `navigator.userAgent` | the major version is `--engine-major`; any other engine makes every other check vacuous |
| `floor.apis` | every name in `CLIENT_FLOOR_APIS`, resolved in the page | each one is present and none is the engine's own `[native code]` implementation, so the shell compat entry ran |
| `floor.iterator-statics` | `Iterator.from`, `Iterator.prototype.map` | the global is installed and both statics stay undefined, the one gap the floor records |
| `layout.composer-control-row` | the control row's own content box, its `data-narrow`/`data-tight` markers, and the control groups' `column-gap` | at the narrow viewport the row is at or below 560px with both markers and an 8px gap; at the wide viewport it is above 560px with neither marker and a 12px gap |
| `layout.header-title-row` | the `header` title row's content box and its markers | at the narrow viewport it is at or below 540px with `data-narrow` (540) and `data-tight` (480); at the wide viewport it carries neither |
| `layout.agent-team-trigger` | the experimental agent-team header action's label and the markers the title row publishes | not applicable on a server that does not compose `@deepseek-ai/dsh-experimental-client-ui-agent-team`; where it is mounted, the marked title row keeps the trigger's icon and computes `display: none` for its label, and the unmarked row shows the label |
| `layout.turn-rail-band` | the band that states the transcript width, and the rail frame it selects | at the narrow viewport the band is at or below 900px, marked, and its frame computes `display: none`; at the wide viewport it is unmarked and the frame renders |
| `layout.trajectory-pane` | the trajectory pane's own width, its marker, and the kind label the compact columns collapse | at the narrow viewport the pane is at or below 620px, marked, with the label at `opacity: 0`; at the wide viewport it is unmarked with `opacity: 1` |
| `scroll.conversation-scroller` | the conversation scroller's computed `overflow-y` and the space reserved for its scrollbar | it computes `scroll`, the floor's replacement for `scrollbar-gutter`; the reserved width is reported |
| `css.no-container-queries` | every rule in every mounted document-level stylesheet | no `@container` rule is mounted, the feature the floor cannot render |
| `preview.workspace-file` | the document container the workspace-files pane opened at `AGENTS.md` | its `data-textpreview-state` is `text` and its rendered text carries the document's own opening prose, so the file resource service answered the address |
| `model.streaming-round-trip` | the assistant step the lane's own prompt produced, sampled by a page-side observer installed before the send | the composer sent the prompt, the assistant step entered its streaming state and its text grew while it streamed, and it settled on a reply carrying both ends of the range the prompt asked for, with no error notice |
| `layout.deliverables-card` | the closing turn's changed-files card and the declared-deliveries grid beside it, read at both viewports | the changed-files card names the files the turn was asked to write; at the narrow viewport the grid's container carries `data-narrow` and computes one column, and at the wide viewport it carries no marker and computes two |
| `preview.pdf` | the PDF the model wrote, or the file `--pdf-preview` names, opened through the workspace-files pane | the preview elected the PDF renderer, the page surface left its rendering state, and the canvas carries the document's ink. A body that refused the bytes renders its own failure line, and a surface that stays in its rendering state or a canvas with no ink is not a rendered document; the check reports whichever it read |
| `console.errors` | the run's console errors and exceptions, plus the browser's error-level log entries | the page logged no console error and threw no exception. Error-level log entries (a failed request) are recorded in the report and fail the run only under `--fail-on-log-errors`, because a route outside the floor answering 404 says nothing about the floor |

### The workspace-file preview

This check opens a Session's right Sidebar, the workspace-files pane, and `AGENTS.md` in it, then reads the preview container's own state. It is here because no Node-run case can prove this fact: the preview's address is a `dsh-resource://file/…` URL whose protocol key is read from the address string, and Chromium 90's URL parser reads no host for a non-special scheme — `hostname` stays empty and the remainder lands in the opaque path — where current Chromium, Node, and the Electron engine read `file`. [resources.ts](../../packages/client/resources/src/client/resources.ts) owns that derivation; this lane is where the engine under the floor answers it.

The prose the check requires is the opening line of the checkout's own `AGENTS.md`, read as the lane runs rather than pinned beside it, so an edit to the document cannot leave a stale expectation behind; the server the lane points at serves that same workspace. The pane is reached through the markers the client renders for its own behaviour — the header's expand control, the guide's `files` entry, the file row's path — so one gesture serves every locale.

### The changed-files 404s

A run against a Session older than the recording process's live turns records error-level log entries for `GET /api/changes.summary?sessionId=…&seq=…` answered `404`. The owner accepted them as designed: the changed-files card is a live-turn artifact, so the Host answers `404` with `Change summary unavailable.` once it no longer holds the turn's summary, and reading an older Session asks for summaries that are gone. The route is mounted and the answer comes from its registered handler, `handleChangesSummary` in [present-open.ts](../../packages/client/ui-deliverables/src/present-open.ts); the product behaviour is unchanged and [the deliverables README](../../packages/client/ui-deliverables/README.md) owns it.

Three answers share the status, and only the body separates them: `not found` is the dispatcher answering with no route matched, `Change summary unavailable.` (or `Change comparison unavailable.` for `/api/changes.diff`) is that handler refusing a summary it no longer holds, and an empty body with no `content-type` is the SPA fallback. A console log entry carries the status and the URL but not the body, so the lane cannot tell those three apart from the log alone.

The report labels what it recognizes. `events.logErrorLabels` holds one record per error-level log entry whose path starts with `/api/changes.` and whose log text states `404`: its index in `events.logErrors`, the path, the status, the label `handler's own expired-summary answer`, and a note stating that the reading is a heuristic on the URL family and the status rather than a look at the response. Every other entry in `events.logErrors` stays as it was, and the label decides nothing: console errors and exceptions still gate the run, and error-level log entries still gate it only under `--fail-on-log-errors`.

### The keyed, real-model checks

Three checks need a server started with `DEEPSEEK_API_KEY`, and the driver runs them only under `--model-checks`. They open a Session of their own, so the prompts they type never land in the Session the other checks read, and they run last because that Session is not the one the earlier readings measured.

Their prompts are fixed, so a failing run names the same fact a passing one does:

| Check | Prompt |
|---|---|
| `model.streaming-round-trip` | `Count from 1 to 40, one number per line.` |
| `layout.deliverables-card` | `Use the write tool to create two files in the working directory: floor-lane-probe.txt and floor-lane-probe-b.txt, each containing exactly the single word ok. Then call the present tool with both files as deliverables, and reply with one short sentence.` |
| `preview.pdf` | `Use the write tool to create a file named floor-lane-probe.pdf whose entire content is exactly these lines, byte for byte and with no code fence:`, then the 445 bytes of a one-page PDF, then `Do not change, reorder, or add any character. Then reply with one short sentence.` |

Two of those prompts are shaped by the surface rather than by taste. The streaming check asks for forty lines because a one-token answer mounts its assistant step already settled — measured on this client, `ok` never renders a streaming state at all — so a check built on that answer could only read the final text; and its observer watches mutations as well as the clock, because a short answer can add and remove the streaming attribute between two timer ticks. The deliverables prompt asks for two files because one declared file collapses the delivery grid to a single column at every width, and for a `present` call because that grid belongs to the declared deliveries rather than to the changed-files card beside it.

The run writes what it reads: the three files land in the Session's workspace, which is this checkout when the server runs from it. They carry the `floor-lane-probe` prefix so they are easy to find and remove, and a re-run overwrites them.

A reply is the model's own. When a check fails it names the fact that was missing — the reply did not carry the range, the turn rendered no changed-files card, the model never called `present` — so a red run can mean the model answered differently rather than that the client broke, and the lane fails loud instead of reading such a reply as a pass.

### The PDF preview's ink reading

`preview.pdf` reads the canvas's own pixels, because a page surface can report itself ready over a canvas nothing was ever drawn on. The reader's render completes successfully when the operator list it received is empty: the display marks the truncated list as the last chunk and runs the render task over it, while the capability that gates the task was already resolved by the page's start message, so the rejection that arrived with the empty list has nothing left to reject. A pane can therefore reach its ready state, render no failure line, and show a blank page. Chromium 90 did exactly that while the floor lacked `ArrayBuffer.prototype.transferToFixedLength`: the Worker's font export threw, the display painted the page background and stopped, and the check recorded one 400x213 canvas, surface ready, no failure line, no ink.

The model-driven step is the fuller reading, because it also proves a model's own bytes reach the reader. Where the document is already in the Session workspace — a re-run, or a workspace seeded with the 445-byte probe document — the same check runs without a model:

```sh
# the probe PDF ships as a fixture; the gesture reads the Session workspace
cp scripts/browser-floor-lane/smoke/floor-lane-probe.pdf .
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url-file .artifacts/floor-lane-server.log --pdf-preview floor-lane-probe.pdf
```

`--pdf-preview <file>` opens that file through the same workspace-files gesture, waits the same quiet window for the body's decision, and reports the same `preview.pdf` check, so one report carries one such check: the driver offers the keyless step only when `--model-checks` is off. It reads the bytes on disk, so it says nothing about whether a model can write them; that stays the keyed step's job.

### The agent-team trigger

`layout.agent-team-trigger` reports itself as not applicable on a server that does not compose the experimental agent-team client package, which is every ordinary run, so the lane stays green there. To read it, start a second server with the repository's own overlay and point a run at it:

```sh
pnpm dsh web --patch apps/web/tests/agent-team-panel.overlay.yml --no-open --port 3082
```

The launcher owns `--patch` and hands everything from the first option it does not recognize to the booted app, so the overlay comes before `--no-open`.

## What it cannot see

- It reads one Session's rendered DOM at two viewport widths, plus the one document preview the workspace-files pane opened. The workspace list, settings, dialogs, and the preview Workers are not exercised; a Worker is a realm of its own, and the lane reads only the page realm.
- It scans the mounted document-level stylesheets, inline and linked alike. A shadow root's own sheets are outside the walk, and a cross-origin sheet is counted as unreadable rather than read.
- Font metrics decide the composer row's own width, so `--narrow-width` has to stay inside the band: the check fails with the measured width when the row is too wide to be marked, rather than passing quietly.
- Surfaces a Session does not mount report as `absent`, and an absent fact fails the run. The turn rail needs two turns; the trajectory pane needs a Session with a trajectory.
- It does not prove the shipped bytes. Artifact syntax and post-floor API call sites belong to the artifact gate, and the corpus counts to the ratchet.
- The three keyed checks are absent from a run without `--model-checks`, and that flag is only useful against a server started with `DEEPSEEK_API_KEY`: a keyless server fails the first prompt instead of reading anything.
- Those checks read a real model's own work, so they measure the model as much as the client. Every failure names the missing fact, and a re-run can turn red-to-green on the same tree.
- `preview.pdf` reaches the PDF reader's own Worker realm, not only the page: the reader builds its Worker from `pdf.worker.min.mjs` alone ([runtime.ts](../../packages/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts)), so an install that stops at the page realm leaves the document unrendered and the check reports the body's own failure line. It also reads the canvas's own pixels, because a page surface can report itself ready over a canvas nothing was ever drawn on — which is the reading this check recorded on Chromium 90: one 400x213 canvas, surface ready, no failure line, and no ink.
- `--pdf-preview` reads a document the lane did not create. It proves the reader paints those bytes on this engine, not that a model can write them, and the keyed step stays the reading for that.
- `floor-lane-probe.txt`, `floor-lane-probe-b.txt`, and `floor-lane-probe.pdf` stay in the workspace after a keyed run. The lane does not remove them.
- A green run says the facts above were read from this engine on this server. It says nothing about engines newer than the floor, which the repository's other browser lanes already cover.

## Why this is a manual lane, not a CI job

No CI image carries Chromium 90, and none can: the repository's browser jobs install the Chromium and WebKit that the lockfile selects, and the floor is four years older than that Chromium. The floor's deployment target is also not CI — it is the LAN server a browser reaches — so a CI job with a modern engine would answer a different question. The lane therefore stays a workstation lane a teammate re-runs, and the decision to keep it out of the matrix is recorded here rather than in a job name.

CI holds three things in its place, all keyless and all on the artifact side. The artifact gate [verify-client-browser-floor.ts](../verify-client-browser-floor.ts) parses every browser artifact and every JavaScript payload embedded in one as text, rejecting post-floor syntax and every call site in its `FLOOR_DENIED_APIS` list. The corpus ratchet [client-browser-floor.spec.ts](../client-browser-floor.spec.ts) pins the resolved targets, the `color-mix()` rewrite, and the dynamic-viewport-unit fallbacks, proves every mix in the client stylesheets resolves, and holds the source corpus at its recorded counts for the nine features the floor drops whole, among them the absence of any container query and of any `scrollbar-gutter` declaration. The API contract in [compat.client.spec.ts](../../packages/client/web/tests/compat.client.spec.ts) removes each API from the realm, pins the install list in order, and drives every installed implementation. What none of them can do is boot the engine; that is what this lane is for, and a behavior regression is found by re-running it.

## Files

| File | Role |
|---|---|
| `drive.ts` | Flags, browser lifecycle, DevTools connection, Session selection, the report |
| `steps.ts` | The checks, the viewport passes, the workspace-file gesture, and the page operations they need |
| `model-steps.ts` | The PDF-preview check and the keyed, real-model steps around it: the Session they open, the prompts they type, and the facts they read back |
| `probe.js` | Page source the driver evaluates: it must stay parseable by the floor engine and must not call the APIs the floor installs |
| `smoke/fixture.html` | The lane's own fixture page, for a run without a server |
