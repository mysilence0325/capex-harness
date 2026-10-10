/**
 * Facts the Chromium 90 browser-floor lane reads back from the engine.
 *
 * The probe in ./probe.js is page source rather than a module: it is evaluated
 * in the engine under test and must stay parseable there. This module supplies
 * its input, sends the viewport changes, and turns what came back into named
 * checks.
 * @module scripts/browser-floor-lane/steps
 */

import { readFileSync } from 'node:fs'
import { CLIENT_FLOOR_APIS } from '../client-browser-floor.ts'

/** Composer control row content width (CSS pixels) at or below which its gaps tighten. */
const COMPOSER_NARROW_WIDTH = 560
/** Composer control row content width (CSS pixels) at or below which chip labels drop. */
const COMPOSER_TIGHT_WIDTH = 460
/** Control-group gap the marked composer row computes, and the unmarked one. */
const COMPOSER_NARROW_GAP = '8px'
const COMPOSER_WIDE_GAP = '12px'
/** Header title row content widths (CSS pixels) the preset label and actions yield at. */
const TITLE_ROW_NARROW_WIDTH = 540
const TITLE_ROW_TIGHT_WIDTH = 480
/** Turn-rail band width (CSS pixels) at or below which the rail hides its frame. */
const RAIL_BAND_WIDTH = 900
/** Trajectory pane width (CSS pixels) at or below which its columns compact. */
const TRAJECTORY_PANE_WIDTH = 620
/** Kind-label opacity the trajectory pane's compact columns compute, and the full one. */
const KIND_LABEL_NARROW_OPACITY = '0'
const KIND_LABEL_WIDE_OPACITY = '1'
/** Workspace file the preview check opens, listed at the Session's workspace root. */
const PREVIEW_FILE_NAME = 'AGENTS.md'
/** How long one gesture of that check waits for the client to answer it. */
const PREVIEW_TIMEOUT_MS = 15_000
/** Characters of the open document's own prose the rendered preview must carry. */
const PREVIEW_MARKER_LENGTH = 48

/** Page-side probe, evaluated with the floor's API list as its argument. */
const PROBE_SOURCE = readFileSync(new URL('./probe.js', import.meta.url), 'utf8')

/** The lane's checkout, which a Session's workspace root resolves to on the server it is pointed at. */
const CHECKOUT_ROOT = new URL('../../', import.meta.url)

/** Where one check landed. Status 'absent' fails a run: the lane could not read the fact. */
export type CheckStatus = 'pass' | 'fail' | 'absent' | 'not-applicable'

/** One checked fact with its verdict and the values the verdict came from. */
export interface CheckOutcome {
  /** Stable check id, unique inside one report. */
  readonly id: string
  readonly status: CheckStatus
  /** One line naming what was read and why the verdict followed. */
  readonly detail: string
  /** Values the verdict came from, for diagnosing a failing run. */
  readonly evidence?: Readonly<Record<string, unknown>>
}

/** Page operations the driver hands to the steps. */
export interface StepPage {
  /**
   * Evaluate an expression in the page and return its value.
   * @param expression - JavaScript source evaluated in the main realm.
   * @returns the value the expression produced.
   */
  evaluate(expression: string): Promise<unknown>
  /**
   * Send one Chrome DevTools protocol command.
   * @param method - protocol method name.
   * @param params - protocol parameters.
   * @returns the command's result.
   */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  /**
   * Wait without blocking the event loop.
   * @param milliseconds - how long to wait.
   */
  sleep(milliseconds: number): Promise<void>
  /**
   * Capture a PNG screenshot into the run's shot directory.
   * @param name - file name inside that directory.
   * @returns the written file name.
   */
  shot(name: string): Promise<string>
}

/** Console, exception, and log entries one run captured, newest last. */
export interface StepEvents {
  /** console.error calls the page made. */
  readonly consoleErrors: string[]
  /** Uncaught exceptions and unhandled rejections the page raised. */
  readonly exceptions: string[]
  /** Error-level entries the browser logged, including failed requests. */
  readonly logErrors: string[]
  /** The changed-files card's own expired-summary 404s among those entries, in the order they were logged. */
  readonly logErrorLabels: LogErrorLabel[]
}

/** One error-level log entry the lane reads as the changed-files card's expired-summary 404. */
export interface LogErrorLabel {
  /** Zero-based position in the report's `events.logErrors`. */
  readonly index: number
  /** Request path the entry's URL carries, without its query. */
  readonly path: string
  /** Status the browser's own log text states. */
  readonly status: number
  /** One line naming the answer the lane reads the entry as. */
  readonly label: string
  /** Why that reading is a heuristic on the log text rather than a look at the response. */
  readonly note: string
}

/** Inputs one run fixes before the steps read the page. */
export interface StepOptions {
  /** Viewport width the marked side of every breakpoint is read at. */
  readonly narrowWidth: number
  /** Viewport width the unmarked side of every breakpoint is read at. */
  readonly wideWidth: number
  /** Viewport height every emulated viewport uses. */
  readonly viewportHeight: number
  /** Quiet time after a viewport change, before the app has laid out for it. */
  readonly settleMs: number
  /** Chromium major version the floor names; another engine makes every check vacuous. */
  readonly engineMajor: number
  /**
   * Floor APIs the target engine ships natively, so the shell's install skips
   * them. Empty on the floor itself, where the release lacks every entry; a
   * newer engine names the ones its own version ships, because the API check
   * otherwise reads each native implementation as an install that did not run.
   */
  readonly engineNative: readonly string[]
  /** Console errors, exceptions, and log errors the driver captured during the run. */
  readonly events: StepEvents
  /**
   * Whether an error-level log entry fails the run. Console errors and
   * exceptions always do; a network 404 for a route outside the floor is
   * recorded and reported but does not decide a floor verdict.
   */
  readonly failOnLogErrors: boolean
  /**
   * Whether the floor-API checks apply. False on the lane's own smoke fixture,
   * which does not load the client and cannot install the shell's compat entry.
   */
  readonly floorApisApplicable: boolean
  /**
   * Whether the served client's Session surface applies. False on the lane's own
   * smoke fixture, which renders no Session, so the workspace-files check reports
   * itself as not applicable rather than opening a sidebar that is not there.
   */
  readonly sessionUiApplicable: boolean
}

/**
 * Whether a parsed value is a JSON object rather than an array or a scalar.
 * @param value - value to test.
 * @returns whether the value is a non-null, non-array object.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a nested JSON object.
 * @param source - object to read from.
 * @param key - property name.
 * @returns the nested object, or null when the property is absent or not an object.
 */
export function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return isJsonObject(value) ? value : null
}

/**
 * Read a string property.
 * @param source - object to read from, or null.
 * @param key - property name.
 * @returns the string, or null when the property is absent or not a string.
 */
export function textAt(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null
  const value = source[key]
  return typeof value === 'string' ? value : null
}

/**
 * Read a number property.
 * @param source - object to read from, or null.
 * @param key - property name.
 * @returns the number, or null when the property is absent or not a number.
 */
export function numberAt(source: Record<string, unknown> | null, key: string): number | null {
  if (source === null) return null
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read a boolean property.
 * @param source - object to read from, or null.
 * @param key - property name.
 * @returns the boolean, or null when the property is absent or not a boolean.
 */
export function booleanAt(source: Record<string, unknown> | null, key: string): boolean | null {
  if (source === null) return null
  const value = source[key]
  return typeof value === 'boolean' ? value : null
}

/**
 * Build the page expression that runs the probe.
 * @param floorApis - API names to resolve in the page realm.
 * @returns the expression the driver evaluates.
 */
export function probeExpression(floorApis: readonly string[]): string {
  return '(' + PROBE_SOURCE + ')(' + JSON.stringify(floorApis) + ')'
}

/**
 * Click the view tab that mounts the trajectory pane.
 *
 * The English label only reorders the probe; every tab is tried whatever the
 * locale, and the selected tab is reported so the driver can restore it.
 */
const ACTIVATE_TRAJECTORY = [
  '(async () => {',
  '  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))',
  '  const tabs = Array.prototype.slice.call(document.querySelectorAll(\'[data-conversation-tabs] [role="tab"]\'))',
  '  if (tabs.length === 0) return JSON.stringify({ activated: false, reason: \'no view tab strip is mounted\' })',
  '  const selected = tabs.filter((tab) => tab.getAttribute(\'aria-selected\') === \'true\')[0]',
  '  const hinted = tabs.filter((tab) => /trajectory/i.test(tab.textContent || \'\'))',
  '  const ordered = hinted.concat(tabs.filter((tab) => hinted.indexOf(tab) === -1))',
  '  for (let index = 0; index < ordered.length; index += 1) {',
  '    ordered[index].click()',
  '    for (let attempt = 0; attempt < 16; attempt += 1) {',
  '      await wait(250)',
  '      if (document.querySelector(\'[class*="_tablePane"]\') !== null) {',
  '        return JSON.stringify({',
  '          activated: true,',
  '          label: (ordered[index].textContent || \'\').trim(),',
  '          selectedLabel: selected === undefined ? null : (selected.textContent || \'\').trim(),',
  '          tabs: tabs.length,',
  '        })',
  '      }',
  '    }',
  '  }',
  '  return JSON.stringify({ activated: false, reason: \'no view tab mounted a trajectory pane\', tabs: tabs.length })',
  '})()',
].join('\n')

/**
 * Click the view tab the caller read before the trajectory probe ran.
 * @param label - the tab label to restore.
 * @returns the expression the driver evaluates.
 */
export function restoreViewTabExpression(label: string): string {
  return [
    '(() => {',
    '  const tabs = Array.prototype.slice.call(document.querySelectorAll(\'[data-conversation-tabs] [role="tab"]\'))',
    '  for (let index = 0; index < tabs.length; index += 1) {',
    '    if ((tabs[index].textContent || \'\').trim() === ' + JSON.stringify(label) + ') { tabs[index].click(); return \'restored\' }',
    '  }',
    '  return \'missing\'',
    '})()',
  ].join('\n')
}

/** One mounted document preview as the probe read it. */
interface PreviewReading {
  /** The container's own state: `text` once a document is rendered, `loading` before it, `unsupported` for a type this preview refuses. */
  readonly state: string | null
  /** The `dsh-resource://` address the preview was opened at. */
  readonly url: string | null
  /** Id of the renderer that claimed the address. */
  readonly renderer: string | null
  /** Id of the Sidebar tab whose body holds the preview. */
  readonly tab: string | null
  /** Whether the tab showing it is the selected one, rather than a hidden sibling. */
  readonly shown: boolean
  /** Whether the preview has mounted its document body. */
  readonly body: boolean
  /** Characters of rendered text, before the probe's cap. */
  readonly textLength: number | null
  /** The rendered text, capped by the probe. */
  readonly text: string
  /** Whether the PDF body reported itself, which it does only once its bytes parsed. */
  readonly pdf: boolean
  /** Page elements the PDF body mounted. */
  readonly pdfPages: number
  /** Canvases the preview mounted, one per painted PDF page. */
  readonly canvases: number
  /** Dark pixels the fullest canvas carries, sampled; null when the bitmap could not be read. */
  readonly ink: number | null
  /** Whether the page surface is still hidden, which it is until a render completes; null when no surface is mounted. */
  readonly surfaceHidden: boolean | null
  /** Backing-store size of the fullest canvas, as WxH; null when no canvas reports one. */
  readonly canvasSize: string | null
  /** Text of the preview's own failure line, when it carries one. */
  readonly alert: string | null
}

/** What opening the workspace file reported. */
export interface FileOpenAttempt {
  /** Whether the pane was reached and the file's own tab became the selected one. */
  readonly opened: boolean
  /** Sidebar tab id whose body the gesture read the preview in. */
  readonly tab: string | null
  /** Why the gesture stopped, when it did not open. */
  readonly reason: string | null
}

/**
 * Open the Session's workspace-files pane and one file in it.
 *
 * Every step reads a marker the client renders for its own behaviour rather than
 * localized copy, so one gesture serves every locale: the header's expand
 * control, the guide's `files` entry (or the strip's add control that asks for a
 * guide), the file row's path, and the tab the row selects, whose chip carries
 * the file's own name. The wait ends when that tab's preview text carries the
 * document's opening prose, so a gesture that opened the pane reports `opened`
 * only once the document is on screen; what the preview then shows is the probe's
 * reading, taken after this returns.
 * @param fileName - basename of the file to open.
 * @param marker - prose the rendered document must carry; an absent marker stops the wait at the mounted container.
 * @param timeoutMs - how long one gesture of this check waits for the client to answer it.
 * @returns the expression the driver evaluates.
 */
export function openWorkspaceFileExpression(fileName: string, marker: string | undefined, timeoutMs = PREVIEW_TIMEOUT_MS): string {
  const suffix = JSON.stringify(`/${fileName}`)
  const suffixLength = fileName.length + 1
  const noRow = JSON.stringify(`the workspace-files pane lists no ${fileName}`)
  const noPreview = JSON.stringify(`the workspace-files pane selected no tab named ${fileName} with a document preview in it`)
  return [
    '(async () => {',
    '  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))',
    '  const until = async (read) => {',
    '    const deadline = Date.now() + ' + String(timeoutMs),
    '    for (;;) {',
    '      const found = read()',
    '      if (found !== null && found !== undefined) return found',
    '      if (Date.now() >= deadline) return null',
    '      await wait(250)',
    '    }',
    '  }',
    '  const report = (payload) => JSON.stringify(payload)',
    '  const endsWithFile = (path) => path.slice(-' + String(suffixLength) + ') === ' + suffix,
    '  const fileRow = () => {',
    '    const rows = document.querySelectorAll(\'[data-files-entry="file"]\')',
    '    for (let index = 0; index < rows.length; index += 1) {',
    '      if (endsWithFile(rows[index].getAttribute(\'data-files-path\') || \'\')) return rows[index]',
    '    }',
    '    return null',
    '  }',
    '  const shownPreviews = () => Array.prototype.slice.call(document.querySelectorAll(\'[data-textpreview-state]\'))',
    '    .filter((node) => node.closest(\'[hidden]\') === null)',
    '  const seen = shownPreviews()',
    '  const selectedTabNamed = () => {',
    '    const chips = document.querySelectorAll(\'[data-dockkit-tab][aria-selected="true"]\')',
    '    for (let index = 0; index < chips.length; index += 1) {',
    '      if ((chips[index].textContent || \'\').trim() === ' + JSON.stringify(fileName) + ') return true',
    '    }',
    '    return false',
    '  }',
    '  const previewFor = () => {',
    '    const nodes = shownPreviews()',
    '    for (let index = 0; index < nodes.length; index += 1) {',
    '      if (seen.indexOf(nodes[index]) === -1) return nodes[index]',
    '    }',
    '    for (let index = nodes.length - 1; index >= 0; index -= 1) {',
    '      if (endsWithFile(nodes[index].getAttribute(\'data-textpreview-url\') || \'\')) return nodes[index]',
    '    }',
    '    return nodes.length === 0 ? null : nodes[nodes.length - 1]',
    '  }',
    '  const marker = ' + (marker === undefined ? 'null' : JSON.stringify(marker)),
    '  const renderedDocument = () => {',
    '    const node = previewFor()',
    '    if (node === null || marker === null) return node',
    '    const body = node.querySelector(\'[data-textpreview-body]\')',
    '    if (body === null) return null',
    '    return (body.textContent || \'\').indexOf(marker) === -1 ? null : node',
    '  }',
    '  const files = () => document.querySelector(\'[data-files-state]\')',
    '  if (document.querySelector(\'[data-sidebar-right-open]\') === null) {',
    '    const expand = document.querySelector(\'[data-sidebar-right-expand]\')',
    '    if (expand === null) return report({ opened: false, reason: \'no right-sidebar expand control is mounted\' })',
    '    expand.click()',
    '    if (await until(() => document.querySelector(\'[data-sidebar-right-open]\')) === null) {',
    '      return report({ opened: false, reason: \'the right sidebar did not open\' })',
    '    }',
    '  }',
    '  if (files() === null) {',
    '    const entry = () => document.querySelector(\'[data-sidebar-right-guide-entry="files"]\')',
    '    if (entry() === null) {',
    '      const add = document.querySelector(\'[data-dockkit-add-tab]\')',
    '      if (add === null) return report({ opened: false, reason: \'the right sidebar offers no way to the workspace files\' })',
    '      add.click()',
    '    }',
    '    const picked = await until(entry)',
    '    if (picked === null) return report({ opened: false, reason: \'no workspace-files entry appeared in the right sidebar\' })',
    '    picked.click()',
    '    if (await until(files) === null) return report({ opened: false, reason: \'the workspace-files pane did not mount\' })',
    '  }',
    '  const row = await until(fileRow)',
    '  if (row === null) return report({ opened: false, reason: ' + noRow + ' })',
    '  const open = row.querySelector(\'button\')',
    '  if (open === null) return report({ opened: false, reason: \'the file row carries no open control\' })',
    '  open.click()',
    '  const mounted = await until(() => selectedTabNamed() ? previewFor() : null)',
    '  if (mounted === null) return report({ opened: false, tab: null, reason: ' + noPreview + ' })',
    '  await until(renderedDocument)',
    '  const node = previewFor()',
    '  const host = (node === null ? mounted : node).closest(\'[data-sidebar-right-tab]\')',
    '  return report({ opened: true, tab: host === null ? null : host.getAttribute(\'data-sidebar-right-tab\'), reason: null })',
    '})()',
  ].join('\n')
}

/**
 * Read what the file-opening gesture reported.
 * @param value - the page's return value.
 * @returns the attempt, reading an answer it cannot parse as a gesture that never opened.
 */
export function fileOpenAttempt(value: unknown): FileOpenAttempt {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null
  if (!isJsonObject(parsed)) return { opened: false, tab: null, reason: 'the page did not report the file-opening gesture' }
  return {
    opened: parsed.opened === true,
    tab: textAt(parsed, 'tab'),
    reason: textAt(parsed, 'reason'),
  }
}

/** One probe payload with the sections the checks read. */
export interface PageReading {
  readonly payload: Record<string, unknown>
  readonly composer: Record<string, unknown> | null
  readonly titleRow: Record<string, unknown> | null
  readonly rail: Record<string, unknown> | null
  readonly trajectory: Record<string, unknown> | null
  readonly scroller: Record<string, unknown> | null
  readonly previews: PreviewReading[]
  readonly deliverables: Record<string, unknown> | null
  readonly teamTrigger: Record<string, unknown> | null
  readonly containerQueries: Record<string, unknown> | null
}

/**
 * Read the previews the probe found.
 * @param payload - the probe's parsed report.
 * @returns one reading per mounted preview, in document order.
 */
function previewReadings(payload: Record<string, unknown>): PreviewReading[] {
  const raw = payload.previews
  if (!Array.isArray(raw)) return []
  const readings: PreviewReading[] = []
  for (const entry of raw) {
    if (!isJsonObject(entry)) continue
    readings.push({
      state: textAt(entry, 'state'),
      url: textAt(entry, 'url'),
      renderer: textAt(entry, 'renderer'),
      tab: textAt(entry, 'tab'),
      shown: booleanAt(entry, 'shown') === true,
      body: booleanAt(entry, 'body') === true,
      textLength: numberAt(entry, 'textLength'),
      text: textAt(entry, 'text') ?? '',
      pdf: booleanAt(entry, 'pdf') === true,
      pdfPages: numberAt(entry, 'pdfPages') ?? 0,
      canvases: numberAt(entry, 'canvases') ?? 0,
      ink: numberAt(entry, 'ink'),
      surfaceHidden: booleanAt(entry, 'surfaceHidden'),
      canvasSize: textAt(entry, 'canvasSize'),
      alert: textAt(entry, 'alert'),
    })
  }
  return readings
}

/**
 * Read one probe payload out of the page.
 * @param page - page operations.
 * @returns the parsed payload with its nested sections.
 * @throws {Error} when the probe did not return its JSON report.
 */
export async function readPage(page: StepPage): Promise<PageReading> {
  const raw = await page.evaluate(probeExpression(CLIENT_FLOOR_APIS))
  if (typeof raw !== 'string') throw new Error('the page probe returned ' + typeof raw + ' instead of its JSON report')
  const parsed: unknown = JSON.parse(raw)
  if (!isJsonObject(parsed)) throw new Error('the page probe report is not a JSON object')
  return {
    payload: parsed,
    composer: objectAt(parsed, 'composer'),
    titleRow: objectAt(parsed, 'titleRow'),
    rail: objectAt(parsed, 'rail'),
    trajectory: objectAt(parsed, 'trajectory'),
    scroller: objectAt(parsed, 'scroller'),
    previews: previewReadings(parsed),
    deliverables: objectAt(parsed, 'deliverables'),
    teamTrigger: objectAt(parsed, 'teamTrigger'),
    containerQueries: objectAt(parsed, 'containerQueries'),
  }
}

/**
 * Whether the engine under test is the floor's own release.
 * @param reading - probe payload carrying the user agent.
 * @param expectedMajor - Chromium major version the floor names.
 * @returns the check outcome.
 */
function engineCheck(reading: PageReading, expectedMajor: number): CheckOutcome {
  const userAgent = textAt(reading.payload, 'userAgent') ?? ''
  const match = /Chrome\/(\d+)\./.exec(userAgent)
  const major = match === null ? null : Number(match[1])
  const evidence = { userAgent, major, expectedMajor }
  if (major === null) {
    return { id: 'floor.engine', status: 'fail', detail: 'the page reports no Chrome version; the lane must drive a Chromium build', evidence }
  }
  if (major !== expectedMajor) {
    return {
      id: 'floor.engine',
      status: 'fail',
      detail: 'the page runs Chromium ' + String(major) + ', not the floor release ' + String(expectedMajor) + '; point --chrome at the floor build or pass --engine-major',
      evidence,
    }
  }
  return { id: 'floor.engine', status: 'pass', detail: 'the page runs Chromium ' + String(major) + ', the release the floor names', evidence }
}

/** How one engine's floor-API readings answer the contract, split by the three outcomes. */
export interface FloorApiVerdict {
  /** Contract names the page did not resolve at all. */
  readonly missing: readonly string[]
  /** Contract names the shell's compat install supplied. */
  readonly installed: readonly string[]
  /** Contract names the engine's own implementation answered, sorted. */
  readonly native: readonly string[]
  /** The declaration the verdict was read against, sorted. */
  readonly declared: readonly string[]
  /** What is wrong with the contract's standing; empty means it holds. */
  readonly faults: readonly string[]
}

/**
 * Faults in the floor contract's standing on one engine, read out of the probe's
 * API readings: every API the floor names is present, every one the engine lacks
 * was installed by the shell, and every one the engine ships natively is declared.
 * @param readings - the probe payload's `floorApis` entries, one per contract name.
 * @param declared - floor APIs the target engine ships natively; empty on the floor itself.
 * @returns the readings split by outcome, and the faults; an empty fault list means the contract holds.
 */
export function judgeFloorApis(readings: readonly unknown[], declared: readonly string[]): FloorApiVerdict {
  const declaredSorted = [...declared].sort()
  const missing: string[] = []
  const native: string[] = []
  const installed: string[] = []
  const faults: string[] = []
  const unknownDeclared = declared.filter(name => !CLIENT_FLOOR_APIS.includes(name))
  if (unknownDeclared.length > 0) faults.push('--engine-native names APIs outside the floor contract: ' + unknownDeclared.join(', '))
  for (const raw of readings) {
    if (!isJsonObject(raw)) continue
    const name = textAt(raw, 'name') ?? '(unnamed)'
    if (booleanAt(raw, 'present') !== true) missing.push(name)
    else if (booleanAt(raw, 'native') === true) native.push(name)
    else installed.push(name)
  }
  native.sort()
  if (missing.length > 0) faults.push('absent: ' + missing.join(', '))
  // A declaration outside the contract cannot be compared against the readings;
  // the fault above already says what to fix.
  if (unknownDeclared.length === 0 && native.join() !== declaredSorted.join()) {
    faults.push('engine-native APIs read back as [' + native.join(', ') + '] but --engine-native declares ['
      + declaredSorted.join(', ') + ']; copy the read-back list into the flag (or leave it empty on the floor itself)')
  }
  if (readings.length !== CLIENT_FLOOR_APIS.length) {
    faults.push('read ' + String(readings.length) + ' of ' + String(CLIENT_FLOOR_APIS.length) + ' names')
  }
  return { missing, installed, native, declared: declaredSorted, faults }
}

/**
 * Whether the floor contract holds on the engine under test.
 * @param reading - probe payload carrying the API readings.
 * @param applicable - whether the floor checks apply to this page.
 * @param engineNative - floor APIs the target engine ships natively; empty on the floor itself.
 * @returns the check outcome.
 */
function floorApiCheck(reading: PageReading, applicable: boolean, engineNative: readonly string[]): CheckOutcome {
  if (!applicable) {
    return {
      id: 'floor.apis',
      status: 'not-applicable',
      detail: 'the smoke fixture does not load the client, so the shell compat entry never ran on this page',
    }
  }
  const readings = reading.payload.floorApis
  if (!Array.isArray(readings)) {
    return { id: 'floor.apis', status: 'fail', detail: 'the probe returned no API readings' }
  }
  const verdict = judgeFloorApis(readings, engineNative)
  const evidence = {
    expected: CLIENT_FLOOR_APIS.length,
    read: readings.length,
    installed: verdict.installed,
    missing: verdict.missing,
    native: verdict.native,
    declared: verdict.declared,
  }
  if (verdict.faults.length === 0) {
    return {
      id: 'floor.apis',
      status: 'pass',
      detail: 'all ' + String(CLIENT_FLOOR_APIS.length) + ' floor APIs are present: '
        + String(verdict.installed.length) + ' installed by the shell, '
        + String(verdict.native.length) + ' engine-native as declared',
      evidence,
    }
  }
  return {
    id: 'floor.apis',
    status: 'fail',
    detail: 'the installed floor does not cover the contract: ' + verdict.faults.join('; '),
    evidence,
  }
}

/**
 * Whether the install still leaves the iterator statics undefined, the one gap the floor records.
 * @param reading - probe payload carrying the iterator readings.
 * @param applicable - whether the floor checks apply to this page.
 * @returns the check outcome.
 */
function iteratorGapCheck(reading: PageReading, applicable: boolean): CheckOutcome {
  if (!applicable) {
    return {
      id: 'floor.iterator-statics',
      status: 'not-applicable',
      detail: 'the smoke fixture does not load the client, so the shell compat entry never ran on this page',
    }
  }
  const statics = objectAt(reading.payload, 'iteratorStatics')
  const evidence: Record<string, unknown> = { from: textAt(statics, 'from'), prototypeMap: textAt(statics, 'prototypeMap'), global: textAt(statics, 'global') }
  const global = textAt(statics, 'global')
  const from = textAt(statics, 'from')
  const prototypeMap = textAt(statics, 'prototypeMap')
  if (global !== 'function') {
    return {
      id: 'floor.iterator-statics',
      status: 'fail',
      detail: 'the Iterator global is ' + String(global) + '; the install names the shared iterator prototype',
      evidence,
    }
  }
  if (from === 'undefined' && prototypeMap === 'undefined') {
    return {
      id: 'floor.iterator-statics',
      status: 'pass',
      detail: 'Iterator is installed and Iterator.from / Iterator.prototype.map stay undefined, the gap the floor records',
      evidence,
    }
  }
  return {
    id: 'floor.iterator-statics',
    status: 'fail',
    detail: 'Iterator.from is ' + String(from) + ' and Iterator.prototype.map is ' + String(prototypeMap) + '; the floor records both as undefined, so the note needs the new fact',
    evidence,
  }
}

/**
 * Whether the composer control row carries the markers its own width implies and computes the gap.
 * @param reading - probe payload carrying the composer reading.
 * @param side - which side of the breakpoint this reading came from.
 * @returns the check outcome.
 */
function composerCheck(reading: PageReading, side: 'narrow' | 'wide'): CheckOutcome {
  const evidence = {
    side,
    contentWidth: numberAt(reading.composer, 'contentWidth'),
    narrow: booleanAt(reading.composer, 'narrow'),
    tight: booleanAt(reading.composer, 'tight'),
    toolsGap: textAt(reading.composer, 'toolsGap'),
    trailingGap: textAt(reading.composer, 'trailingGap'),
  }
  if (reading.composer === null) {
    return {
      id: 'layout.composer-control-row',
      status: 'absent',
      detail: 'no composer control row is mounted; open a Session whose composer is rendered and re-run',
      evidence,
    }
  }
  const width = numberAt(reading.composer, 'contentWidth')
  const narrow = booleanAt(reading.composer, 'narrow') === true
  const tight = booleanAt(reading.composer, 'tight') === true
  const gap = textAt(reading.composer, 'toolsGap')
  if (side === 'narrow') {
    if (width === null || width > COMPOSER_NARROW_WIDTH) {
      return {
        id: 'layout.composer-control-row',
        status: 'fail',
        detail: 'the row measures ' + String(width) + 'px at the narrow viewport, above the ' + String(COMPOSER_NARROW_WIDTH) + 'px band the marker follows; lower --narrow-width so the lane reads the marked side',
        evidence,
      }
    }
    if (narrow && tight && gap === COMPOSER_NARROW_GAP) {
      return {
        id: 'layout.composer-control-row',
        status: 'pass',
        detail: 'at ' + String(width) + 'px the row carries data-narrow and data-tight and its control groups compute a ' + COMPOSER_NARROW_GAP + ' gap',
        evidence,
      }
    }
    return {
      id: 'layout.composer-control-row',
      status: 'fail',
      detail: 'at ' + String(width) + 'px the row must carry data-narrow (<= ' + String(COMPOSER_NARROW_WIDTH) + 'px) and data-tight (<= ' + String(COMPOSER_TIGHT_WIDTH) + 'px) with a ' + COMPOSER_NARROW_GAP + ' gap; read narrow=' + String(narrow) + ', tight=' + String(tight) + ', gap=' + String(gap),
      evidence,
    }
  }
  if (width !== null && width > COMPOSER_NARROW_WIDTH && !narrow && !tight && gap === COMPOSER_WIDE_GAP) {
    return {
      id: 'layout.composer-control-row',
      status: 'pass',
      detail: 'at ' + String(width) + 'px the row carries neither marker and its control groups compute a ' + COMPOSER_WIDE_GAP + ' gap',
      evidence,
    }
  }
  return {
    id: 'layout.composer-control-row',
    status: 'fail',
    detail: 'at ' + String(width) + 'px the row must carry neither marker with a ' + COMPOSER_WIDE_GAP + ' gap; read narrow=' + String(narrow) + ', tight=' + String(tight) + ', gap=' + String(gap),
    evidence,
  }
}

/**
 * Whether the header title row carries both markers on the marked side and neither on the other.
 * @param reading - probe payload carrying the title-row reading.
 * @param side - which side of the breakpoint this reading came from.
 * @returns the check outcome.
 */
function titleRowCheck(reading: PageReading, side: 'narrow' | 'wide'): CheckOutcome {
  const evidence = {
    side,
    contentWidth: numberAt(reading.titleRow, 'contentWidth'),
    narrow: booleanAt(reading.titleRow, 'narrow'),
    tight: booleanAt(reading.titleRow, 'tight'),
  }
  if (reading.titleRow === null) {
    return {
      id: 'layout.header-title-row',
      status: 'absent',
      detail: 'no header title row is mounted; the lane needs a page whose conversation header is rendered',
      evidence,
    }
  }
  const width = numberAt(reading.titleRow, 'contentWidth')
  const narrow = booleanAt(reading.titleRow, 'narrow') === true
  const tight = booleanAt(reading.titleRow, 'tight') === true
  if (side === 'narrow') {
    if (width !== null && width <= TITLE_ROW_NARROW_WIDTH && narrow && tight) {
      return {
        id: 'layout.header-title-row',
        status: 'pass',
        detail: 'at ' + String(width) + 'px the title row carries data-narrow and data-tight',
        evidence,
      }
    }
    return {
      id: 'layout.header-title-row',
      status: 'fail',
      detail: 'at ' + String(width) + 'px the title row must carry data-narrow (<= ' + String(TITLE_ROW_NARROW_WIDTH) + 'px) and data-tight (<= ' + String(TITLE_ROW_TIGHT_WIDTH) + 'px); read narrow=' + String(narrow) + ', tight=' + String(tight),
      evidence,
    }
  }
  if (width !== null && width > TITLE_ROW_NARROW_WIDTH && !narrow && !tight) {
    return {
      id: 'layout.header-title-row',
      status: 'pass',
      detail: 'at ' + String(width) + 'px the title row carries neither marker',
      evidence,
    }
  }
  return {
    id: 'layout.header-title-row',
    status: 'fail',
    detail: 'at ' + String(width) + 'px the title row must carry neither marker; read narrow=' + String(narrow) + ', tight=' + String(tight),
    evidence,
  }
}

/** Label display the collapsed agent-team trigger computes. */
const TRIGGER_COLLAPSED_DISPLAY = 'none'

/**
 * Whether the experimental agent-team header action follows the title row's own markers.
 *
 * The action is composed only on a server that loads the experimental
 * ui-agent-team package, so its absence reports as not applicable rather than
 * as a fault: every other check in this lane runs without it. Where it is
 * mounted, its label is what the marked title row sacrifices, and the fact read
 * here is the label's own computed display.
 * @param reading - probe payload carrying the header reading.
 * @param side - which side of the breakpoint this reading came from.
 * @returns the check outcome.
 */
function agentTeamTriggerCheck(reading: PageReading, side: 'narrow' | 'wide'): CheckOutcome {
  const evidence = {
    side,
    present: booleanAt(reading.teamTrigger, 'present'),
    labelDisplay: textAt(reading.teamTrigger, 'labelDisplay'),
    labelText: textAt(reading.teamTrigger, 'labelText'),
    icons: numberAt(reading.teamTrigger, 'icons'),
    titleRowWidth: numberAt(reading.titleRow, 'contentWidth'),
    titleRowTight: booleanAt(reading.titleRow, 'tight'),
  }
  if (booleanAt(reading.teamTrigger, 'present') !== true) {
    return {
      id: 'layout.agent-team-trigger',
      status: 'not-applicable',
      detail: 'no agent-team header action is mounted: this server does not compose the experimental ui-agent-team package',
      evidence,
    }
  }
  const display = textAt(reading.teamTrigger, 'labelDisplay')
  const icons = numberAt(reading.teamTrigger, 'icons')
  const tight = booleanAt(reading.titleRow, 'tight') === true
  if (side === 'narrow') {
    if (tight && display === TRIGGER_COLLAPSED_DISPLAY && icons !== null && icons > 0) {
      return {
        id: 'layout.agent-team-trigger',
        status: 'pass',
        detail: 'the title row carries data-tight and the team trigger keeps its ' + String(icons) + ' icon with its label at display: ' + TRIGGER_COLLAPSED_DISPLAY,
        evidence,
      }
    }
    return {
      id: 'layout.agent-team-trigger',
      status: 'fail',
      detail: 'with the title row marked data-tight the trigger must keep only its icon; read tight=' + String(tight) + ', label display=' + String(display) + ', icons=' + String(icons),
      evidence,
    }
  }
  if (!tight && display !== null && display !== TRIGGER_COLLAPSED_DISPLAY) {
    return {
      id: 'layout.agent-team-trigger',
      status: 'pass',
      detail: 'the title row carries no marker and the team trigger shows its label at display: ' + display,
      evidence,
    }
  }
  return {
    id: 'layout.agent-team-trigger',
    status: 'fail',
    detail: 'with the title row unmarked the trigger must show its label; read tight=' + String(tight) + ', label display=' + String(display),
    evidence,
  }
}

/**
 * Whether the turn-rail band states its own width and hides its frame when marked.
 * @param reading - probe payload carrying the rail reading.
 * @param side - which side of the breakpoint this reading came from.
 * @returns the check outcome.
 */
function railBandCheck(reading: PageReading, side: 'narrow' | 'wide'): CheckOutcome {
  const marks = numberAt(reading.rail, 'marks')
  const evidence = {
    side,
    marks,
    bandWidth: numberAt(reading.rail, 'bandWidth'),
    bandNarrow: booleanAt(reading.rail, 'bandNarrow'),
    frameDisplay: textAt(reading.rail, 'frameDisplay'),
    bandClassName: textAt(reading.rail, 'bandClassName'),
  }
  if (booleanAt(reading.rail, 'bandNarrow') === null) {
    return {
      id: 'layout.turn-rail-band',
      status: 'absent',
      detail: 'no turn-rail band is mounted: the rail renders only for a Session with at least two turns, and this page renders ' + String(marks ?? 0) + ' turn marks; open a Session with a multi-turn conversation and re-run',
      evidence,
    }
  }
  const width = numberAt(reading.rail, 'bandWidth')
  const bandNarrow = booleanAt(reading.rail, 'bandNarrow') === true
  const frameDisplay = textAt(reading.rail, 'frameDisplay')
  if (side === 'narrow') {
    if (width !== null && width <= RAIL_BAND_WIDTH && bandNarrow && frameDisplay === 'none') {
      return {
        id: 'layout.turn-rail-band',
        status: 'pass',
        detail: 'at ' + String(width) + 'px the band carries data-narrow and the rail frame it selects computes display: none',
        evidence,
      }
    }
    return {
      id: 'layout.turn-rail-band',
      status: 'fail',
      detail: 'at ' + String(width) + 'px the band must carry data-narrow (<= ' + String(RAIL_BAND_WIDTH) + 'px) and hide its frame; read narrow=' + String(bandNarrow) + ', frame display=' + String(frameDisplay),
      evidence,
    }
  }
  if (width !== null && width > RAIL_BAND_WIDTH && !bandNarrow && frameDisplay !== 'none') {
    return {
      id: 'layout.turn-rail-band',
      status: 'pass',
      detail: 'at ' + String(width) + 'px the band carries no marker and its frame computes display: ' + String(frameDisplay),
      evidence,
    }
  }
  return {
    id: 'layout.turn-rail-band',
    status: 'fail',
    detail: 'at ' + String(width) + 'px the band must carry no marker and show its frame; read narrow=' + String(bandNarrow) + ', frame display=' + String(frameDisplay),
    evidence,
  }
}

/**
 * Whether the trajectory pane states its own width and compacts its columns when marked.
 * @param reading - probe payload carrying the trajectory reading.
 * @param side - which side of the breakpoint this reading came from.
 * @param activation - what activating the trajectory view reported.
 * @returns the check outcome.
 */
function trajectoryPaneCheck(reading: PageReading, side: 'narrow' | 'wide', activation: Record<string, unknown> | null): CheckOutcome {
  const evidence = {
    side,
    activated: booleanAt(activation, 'activated'),
    tab: textAt(activation, 'label'),
    paneWidth: numberAt(reading.trajectory, 'width'),
    paneNarrow: booleanAt(reading.trajectory, 'narrow'),
    kindLabelOpacity: textAt(reading.trajectory, 'kindLabelOpacity'),
    kindLabelMaxWidth: textAt(reading.trajectory, 'kindLabelMaxWidth'),
  }
  if (reading.trajectory === null) {
    return {
      id: 'layout.trajectory-pane',
      status: 'absent',
      detail: 'no trajectory pane is mounted: ' + (textAt(activation, 'reason') ?? 'no view tab mounted a trajectory pane'),
      evidence,
    }
  }
  const width = numberAt(reading.trajectory, 'width')
  const paneNarrow = booleanAt(reading.trajectory, 'narrow') === true
  const opacity = textAt(reading.trajectory, 'kindLabelOpacity')
  // The kind label is absent from an empty ledger, so the marker alone carries
  // the check there and the detail says so.
  const effect = opacity === null
    ? ' (no kind label is rendered, so only the marker was read)'
    : ' and its kind label computes opacity ' + opacity
  if (side === 'narrow') {
    if (width !== null && width <= TRAJECTORY_PANE_WIDTH && paneNarrow && (opacity === null || opacity === KIND_LABEL_NARROW_OPACITY)) {
      return {
        id: 'layout.trajectory-pane',
        status: 'pass',
        detail: 'at ' + String(width) + 'px the pane carries data-narrow' + effect,
        evidence,
      }
    }
    return {
      id: 'layout.trajectory-pane',
      status: 'fail',
      detail: 'at ' + String(width) + 'px the pane must carry data-narrow (<= ' + String(TRAJECTORY_PANE_WIDTH) + 'px) and collapse its kind label to opacity ' + KIND_LABEL_NARROW_OPACITY + '; read narrow=' + String(paneNarrow) + ', opacity=' + String(opacity),
      evidence,
    }
  }
  if (width !== null && width > TRAJECTORY_PANE_WIDTH && !paneNarrow && (opacity === null || opacity === KIND_LABEL_WIDE_OPACITY)) {
    return {
      id: 'layout.trajectory-pane',
      status: 'pass',
      detail: 'at ' + String(width) + 'px the pane carries no marker' + effect,
      evidence,
    }
  }
  return {
    id: 'layout.trajectory-pane',
    status: 'fail',
    detail: 'at ' + String(width) + 'px the pane must carry no marker with a full kind label; read narrow=' + String(paneNarrow) + ', opacity=' + String(opacity),
    evidence,
  }
}

/**
 * Whether the conversation scroller reserves its scrollbar with an always-present one.
 * @param reading - probe payload carrying the scroller reading.
 * @returns the check outcome.
 */
function scrollerCheck(reading: PageReading): CheckOutcome {
  const evidence = {
    overflowY: textAt(reading.scroller, 'overflowY'),
    clientWidth: numberAt(reading.scroller, 'clientWidth'),
    offsetWidth: numberAt(reading.scroller, 'offsetWidth'),
    scrollHeight: numberAt(reading.scroller, 'scrollHeight'),
    clientHeight: numberAt(reading.scroller, 'clientHeight'),
    composerOverlay: booleanAt(reading.scroller, 'composerOverlay'),
    className: textAt(reading.scroller, 'className'),
  }
  if (reading.scroller === null) {
    return {
      id: 'scroll.conversation-scroller',
      status: 'absent',
      detail: 'no conversation scroller is mounted; the lane needs a page whose conversation shell is rendered',
      evidence,
    }
  }
  if (booleanAt(reading.scroller, 'composerOverlay') === true) {
    return {
      id: 'scroll.conversation-scroller',
      status: 'fail',
      detail: 'the composer overlay still marks the shell, which cancels the reservation through overflow-y: auto; read the chat view rather than a full-bleed view',
      evidence,
    }
  }
  const overflowY = textAt(reading.scroller, 'overflowY')
  const client = numberAt(reading.scroller, 'clientWidth')
  const offset = numberAt(reading.scroller, 'offsetWidth')
  const reserved = client === null || offset === null ? null : offset - client
  const withReservation: Record<string, unknown> = { ...evidence, reserved }
  if (overflowY === 'scroll') {
    return {
      id: 'scroll.conversation-scroller',
      status: 'pass',
      detail: 'the scroller computes overflow-y: scroll and reserves ' + String(reserved) + 'px of scrollbar space',
      evidence: withReservation,
    }
  }
  return {
    id: 'scroll.conversation-scroller',
    status: 'fail',
    detail: 'the scroller computes overflow-y: ' + String(overflowY) + '; the floor replaces scrollbar-gutter with an always-present scrollbar',
    evidence: withReservation,
  }
}

/**
 * Whether any mounted stylesheet still carries a container query.
 * @param reading - probe payload carrying the stylesheet scan.
 * @returns the check outcome.
 */
function containerQueryCheck(reading: PageReading): CheckOutcome {
  const scan = reading.containerQueries
  const evidence = {
    stylesheets: numberAt(scan, 'stylesheets'),
    readable: numberAt(scan, 'readable'),
    unreadable: numberAt(scan, 'unreadable'),
    count: numberAt(scan, 'count'),
    samples: scan === null ? null : scan.samples,
  }
  if (scan === null) {
    return { id: 'css.no-container-queries', status: 'fail', detail: 'the probe returned no stylesheet scan', evidence }
  }
  const count = numberAt(scan, 'count')
  const readable = numberAt(scan, 'readable')
  if (count === 0) {
    return {
      id: 'css.no-container-queries',
      status: 'pass',
      detail: 'no @container rule is mounted across ' + String(readable) + ' readable stylesheets; the floor could not render one',
      evidence,
    }
  }
  return {
    id: 'css.no-container-queries',
    status: 'fail',
    detail: String(count) + ' @container rule(s) are mounted; the floor drops them whole, so the stylesheet must state the width through a marker instead',
    evidence,
  }
}

/**
 * The opening prose of the document the preview check opens.
 *
 * Read from the lane's checkout rather than copied beside it, so editing the
 * document cannot leave a stale expectation behind; the server the lane points
 * at serves that same workspace. Markdown syntax is stripped the way the
 * renderer strips it — link targets and the inline-code and emphasis marks —
 * leaving the words the preview's own text has to carry.
 * @returns the prose run, or undefined when the checkout has no such document or nothing to read from it.
 */
function documentMarker(): string | undefined {
  let document: string
  try {
    document = readFileSync(new URL(PREVIEW_FILE_NAME, CHECKOUT_ROOT), 'utf8')
  } catch {
    // A checkout without the document this check opens cannot state what its preview must render.
    return undefined
  }
  const line = document.split('\n').find(candidate => candidate.trim() !== '' && !candidate.trimStart().startsWith('#'))
  if (line === undefined) return undefined
  const prose = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim()
  return prose === '' ? undefined : prose.slice(0, PREVIEW_MARKER_LENGTH)
}

/**
 * Whether the Session's workspace-files pane renders the document it opened.
 *
 * The Chromium 90 URL parser reads no host for a `dsh-resource://file/…`
 * address, so a preview opened at one is stamped with no protocol, no provider
 * ever runs, and the pane says the file resource service is unavailable instead
 * of reading the file. What is read here is the preview's own container: its
 * `data-textpreview-state` is `text` only once a document was rendered, and the
 * rendered text has to carry the opened document's own words. A preview that
 * never arrived reports `absent`, because the lane could not read the fact.
 * @param reading - probe payload carrying the mounted previews.
 * @param attempt - what opening the file in the pane reported.
 * @param marker - prose of the opened document, absent when the lane cannot read it.
 * @returns the check outcome.
 */
function previewCheck(reading: PageReading, attempt: FileOpenAttempt, marker: string | undefined): CheckOutcome {
  // The tab id is the gesture's own identity for the body it clicked open; an
  // address match is the fallback for a run whose tab was re-created between
  // the two page evaluations. A preview that never reached `text` carries no
  // address at all, which is why the tab id comes first.
  const preview = reading.previews.find(candidate => candidate.tab !== null && candidate.tab === attempt.tab)
    ?? [...reading.previews].reverse().find(candidate => candidate.url !== null && candidate.url.endsWith(`/${PREVIEW_FILE_NAME}`))
  const evidence = {
    opened: attempt.opened,
    reason: attempt.reason,
    tab: attempt.tab,
    marker: marker ?? null,
    previews: reading.previews.map(entry => ({
      state: entry.state, url: entry.url, renderer: entry.renderer, tab: entry.tab, shown: entry.shown,
      body: entry.body, textLength: entry.textLength,
    })),
    text: preview === undefined ? null : preview.text.slice(0, 200),
  }
  if (!attempt.opened) {
    return {
      id: 'preview.workspace-file',
      status: 'absent',
      detail: 'the lane could not open ' + PREVIEW_FILE_NAME + ' in the workspace-files pane: ' + (attempt.reason ?? 'the page reported no reason'),
      evidence,
    }
  }
  if (preview === undefined) {
    return {
      id: 'preview.workspace-file',
      status: 'absent',
      detail: 'the document preview of ' + PREVIEW_FILE_NAME + ' is not in the page after opening it',
      evidence,
    }
  }
  if (preview.state !== 'text') {
    return {
      id: 'preview.workspace-file',
      status: 'fail',
      detail: 'the preview opened at the file states data-textpreview-state=' + String(preview.state)
        + ' and renders "' + preview.text.slice(0, 120) + '" instead of the document, so the file resource service never answered',
      evidence,
    }
  }
  if (marker === undefined) {
    return {
      id: 'preview.workspace-file',
      status: 'fail',
      detail: 'the preview rendered a document, but the lane cannot read ' + PREVIEW_FILE_NAME + ' from its own checkout to state what that document must carry',
      evidence,
    }
  }
  if (!preview.text.includes(marker)) {
    return {
      id: 'preview.workspace-file',
      status: 'fail',
      detail: 'the preview rendered ' + String(preview.textLength) + ' characters whose first ' + String(preview.text.length)
        + ' do not carry the opening prose of ' + PREVIEW_FILE_NAME + ' ("' + marker + '")',
      evidence,
    }
  }
  return {
    id: 'preview.workspace-file',
    status: 'pass',
    detail: 'the workspace-files pane opened ' + PREVIEW_FILE_NAME + ' and its preview rendered the document through the '
      + String(preview.renderer) + ' renderer: ' + String(preview.textLength) + ' characters, opening with "' + marker + '"',
    evidence,
  }
}

/** URL path every changed-files request starts with, summary and diff alike. */
const CHANGES_PATH_PREFIX = '/api/changes.'
/** Status a refused request states, and the one the changed-files handler answers once the summary is gone. */
const LOG_STATUS_PATTERN = /status of (\d{3})/
const EXPIRED_SUMMARY_STATUS = 404
/** One line naming the answer the lane reads a recognized entry as. */
const EXPIRED_SUMMARY_LABEL = 'handler\'s own expired-summary answer'
/** Why that reading is a heuristic, carried beside every label so the report states its own limit. */
const EXPIRED_SUMMARY_NOTE = 'Heuristic on the URL family and on the status the browser\'s log text states, because the entry carries no response body: the dispatcher answers 404 with the body "not found" and the SPA fallback with an empty body, so only the body separates the three. What the label asserts is that /api/changes.* is mounted and refused a summary the recording process no longer holds, the changed-files card being a live-turn artifact, rather than that no route served the request.'

/**
 * Read the path of one request URL, without its query or fragment.
 * @param url - the URL the log entry names.
 * @returns the path, or null when the entry names something that is not a URL.
 */
function requestPath(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    // A log entry can name a value that is not a URL at all; it is not one of these requests.
    return null
  }
}

/**
 * Read one error-level log entry as the changed-files card's own expired-summary 404.
 *
 * The reading is a heuristic on the request's URL family and on the status the
 * browser's log text states, because the entry carries no response body: the
 * dispatcher's "not found" and the SPA fallback share the status, and only the
 * body separates the three answers. The label asserts the shape a live page's
 * own /api/changes.summary and /api/changes.diff requests take once the
 * recording process no longer holds that turn's summary, and it never decides a
 * verdict.
 * @param text - the entry's text, which states the status.
 * @param url - the request URL the entry names.
 * @param index - the entry's position in the report's `events.logErrors`.
 * @returns the label, or null when the entry is not one of these 404s.
 */
export function expiredSummaryLabel(text: string, url: string, index: number): LogErrorLabel | null {
  const status = Number(LOG_STATUS_PATTERN.exec(text)?.[1] ?? '')
  if (status !== EXPIRED_SUMMARY_STATUS) return null
  const path = requestPath(url)
  if (path === null || !path.startsWith(CHANGES_PATH_PREFIX)) return null
  return { index, path, status, label: EXPIRED_SUMMARY_LABEL, note: EXPIRED_SUMMARY_NOTE }
}

/**
 * Whether the page logged no error and threw no exception.
 *
 * Console errors and exceptions always fail the run. Error-level log entries
 * (the browser's own record of a failed request) fail it only when the caller
 * asked for that, because a route outside the floor answering 404 says nothing
 * about the floor and would otherwise hold the lane red indefinitely. They stay
 * in the evidence and in the report's event list either way, and the ones the
 * lane reads as the changed-files card's own expired-summary 404 are labelled
 * there without changing any verdict.
 * @param events - the run's captured events.
 * @param failOnLogErrors - whether an error-level log entry fails the run.
 * @returns the check outcome.
 */
function consoleErrorCheck(events: StepEvents, failOnLogErrors: boolean): CheckOutcome {
  const consoleErrors = events.consoleErrors
  const exceptions = events.exceptions
  const logErrors = events.logErrors
  const labels = events.logErrorLabels
  const evidence = {
    consoleErrors: consoleErrors.length,
    exceptions: exceptions.length,
    logErrors: logErrors.length,
    labelledLogErrors: labels.length,
    firstLogError: logErrors[0] ?? null,
    first: consoleErrors[0] ?? exceptions[0] ?? null,
  }
  const logged = String(logErrors.length) + ' error-level log entry(ies)'
  const labelled = labels.length === 0
    ? ''
    : ', ' + String(labels.length) + ' of them labelled as the ' + EXPIRED_SUMMARY_LABEL
  const recorded = logErrors.length === 0
    ? 'and reported no error-level log entry'
    : '; ' + logged + ' are recorded in the report' + labelled + ': ' + String(evidence.firstLogError)
  if (consoleErrors.length === 0 && exceptions.length === 0 && (logErrors.length === 0 || !failOnLogErrors)) {
    return {
      id: 'console.errors',
      status: 'pass',
      detail: 'the page logged no console error and threw no exception' + recorded,
      evidence,
    }
  }
  if (consoleErrors.length === 0 && exceptions.length === 0) {
    return {
      id: 'console.errors',
      status: 'fail',
      detail: logged + ' failed the run because --fail-on-log-errors is set; first: ' + String(evidence.firstLogError),
      evidence,
    }
  }
  return {
    id: 'console.errors',
    status: 'fail',
    detail: String(consoleErrors.length) + ' console error(s) and ' + String(exceptions.length) + ' exception(s); first: ' + String(evidence.first),
    evidence,
  }
}

/**
 * The keyed, real-model steps one run appends before its console check.
 *
 * The driver supplies them only when it was told to drive a real model, so a
 * keyless run keeps exactly the checks that need no model.
 * @param page - page operations.
 * @returns one outcome per model-driven check, in report order.
 */
export type ModelStepRunner = (page: StepPage) => Promise<CheckOutcome[]>

/**
 * Run every check the lane owns against one server page.
 *
 * The chat view is read at both viewport widths first, because the turn rail
 * and the conversation scroller belong to it; the trajectory view is then
 * activated and read on both sides of its own breakpoint; the workspace-files
 * preview is opened last, because it widens the right Sidebar over the
 * conversation the earlier readings measured.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @param runModel - the keyed, real-model steps to append before the console check, absent on a run that has no key.
 * @returns one outcome per check, in report order.
 */
export async function runSteps(page: StepPage, options: StepOptions, runModel?: ModelStepRunner): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  const setViewport = async (width: number): Promise<void> => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: options.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await page.sleep(options.settleMs)
  }

  await setViewport(options.narrowWidth)
  const chatNarrow = await readPage(page)
  outcomes.push(engineCheck(chatNarrow, options.engineMajor))
  outcomes.push(floorApiCheck(chatNarrow, options.floorApisApplicable, options.engineNative))
  outcomes.push(iteratorGapCheck(chatNarrow, options.floorApisApplicable))
  outcomes.push(composerCheck(chatNarrow, 'narrow'))
  outcomes.push(titleRowCheck(chatNarrow, 'narrow'))
  outcomes.push(agentTeamTriggerCheck(chatNarrow, 'narrow'))
  outcomes.push(railBandCheck(chatNarrow, 'narrow'))
  outcomes.push(scrollerCheck(chatNarrow))
  outcomes.push(containerQueryCheck(chatNarrow))
  await page.shot('01-narrow.png')

  await setViewport(options.wideWidth)
  const chatWide = await readPage(page)
  outcomes.push(composerCheck(chatWide, 'wide'))
  outcomes.push(titleRowCheck(chatWide, 'wide'))
  outcomes.push(agentTeamTriggerCheck(chatWide, 'wide'))
  outcomes.push(railBandCheck(chatWide, 'wide'))
  await page.shot('02-wide.png')

  const activationRaw = await page.evaluate(ACTIVATE_TRAJECTORY)
  const activation: unknown = typeof activationRaw === 'string' ? JSON.parse(activationRaw) : null
  const activationRecord = isJsonObject(activation) ? activation : null
  const trajectoryWide = await readPage(page)
  outcomes.push(trajectoryPaneCheck(trajectoryWide, 'wide', activationRecord))

  await setViewport(options.narrowWidth)
  const trajectoryNarrow = await readPage(page)
  outcomes.push(trajectoryPaneCheck(trajectoryNarrow, 'narrow', activationRecord))
  await page.shot('03-trajectory.png')

  if (options.sessionUiApplicable) {
    const marker = documentMarker()
    const attempt = fileOpenAttempt(await page.evaluate(openWorkspaceFileExpression(PREVIEW_FILE_NAME, marker)))
    outcomes.push(previewCheck(await readPage(page), attempt, marker))
  } else {
    outcomes.push({
      id: 'preview.workspace-file',
      status: 'not-applicable',
      detail: 'the lane is reading its own smoke fixture, which renders no Session and no workspace-files pane',
    })
  }

  const selectedLabel = textAt(activationRecord, 'selectedLabel')
  if (selectedLabel !== null && selectedLabel !== '') await page.evaluate(restoreViewTabExpression(selectedLabel))
  // The keyed, real-model steps run last: they open a Session of their own,
  // which would invalidate every reading above if a Session is what they read.
  if (runModel !== undefined && options.sessionUiApplicable) outcomes.push(...await runModel(page))
  await page.send('Emulation.clearDeviceMetricsOverride')
  outcomes.push(consoleErrorCheck(options.events, options.failOnLogErrors))
  return outcomes
}
