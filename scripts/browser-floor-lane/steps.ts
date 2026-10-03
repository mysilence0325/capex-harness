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

/** Page-side probe, evaluated with the floor's API list as its argument. */
const PROBE_SOURCE = readFileSync(new URL('./probe.js', import.meta.url), 'utf8')

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

/** One probe payload with the sections the checks read. */
interface PageReading {
  readonly payload: Record<string, unknown>
  readonly composer: Record<string, unknown> | null
  readonly titleRow: Record<string, unknown> | null
  readonly rail: Record<string, unknown> | null
  readonly trajectory: Record<string, unknown> | null
  readonly scroller: Record<string, unknown> | null
  readonly containerQueries: Record<string, unknown> | null
}

/**
 * Read one probe payload out of the page.
 * @param page - page operations.
 * @returns the parsed payload with its nested sections.
 * @throws {Error} when the probe did not return its JSON report.
 */
async function readPage(page: StepPage): Promise<PageReading> {
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

/**
 * Whether every API the floor names is present and was installed rather than native.
 * @param reading - probe payload carrying the API readings.
 * @param applicable - whether the floor checks apply to this page.
 * @returns the check outcome.
 */
function floorApiCheck(reading: PageReading, applicable: boolean): CheckOutcome {
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
  const missing: string[] = []
  const nativeInstalled: string[] = []
  const installed: string[] = []
  for (const raw of readings) {
    if (!isJsonObject(raw)) continue
    const name = textAt(raw, 'name') ?? '(unnamed)'
    if (booleanAt(raw, 'present') !== true) missing.push(name)
    else if (booleanAt(raw, 'native') === true) nativeInstalled.push(name)
    else installed.push(name)
  }
  const evidence = { expected: CLIENT_FLOOR_APIS.length, read: readings.length, installed, missing, native: nativeInstalled }
  if (missing.length === 0 && nativeInstalled.length === 0 && readings.length === CLIENT_FLOOR_APIS.length) {
    return {
      id: 'floor.apis',
      status: 'pass',
      detail: 'all ' + String(CLIENT_FLOOR_APIS.length) + ' floor APIs are present and none of them is the engine native implementation',
      evidence,
    }
  }
  const faults: string[] = []
  if (missing.length > 0) faults.push('absent: ' + missing.join(', '))
  if (nativeInstalled.length > 0) faults.push('native, so the install did not run: ' + nativeInstalled.join(', '))
  if (readings.length !== CLIENT_FLOOR_APIS.length) {
    faults.push('read ' + String(readings.length) + ' of ' + String(CLIENT_FLOOR_APIS.length) + ' names')
  }
  return { id: 'floor.apis', status: 'fail', detail: 'the installed floor does not cover the contract: ' + faults.join('; '), evidence }
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
 * Run every check the lane owns against one server page.
 *
 * The chat view is read at both viewport widths first, because the turn rail
 * and the conversation scroller belong to it; the trajectory view is then
 * activated and read on both sides of its own breakpoint.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @returns one outcome per check, in report order.
 */
export async function runSteps(page: StepPage, options: StepOptions): Promise<CheckOutcome[]> {
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
  outcomes.push(floorApiCheck(chatNarrow, options.floorApisApplicable))
  outcomes.push(iteratorGapCheck(chatNarrow, options.floorApisApplicable))
  outcomes.push(composerCheck(chatNarrow, 'narrow'))
  outcomes.push(titleRowCheck(chatNarrow, 'narrow'))
  outcomes.push(railBandCheck(chatNarrow, 'narrow'))
  outcomes.push(scrollerCheck(chatNarrow))
  outcomes.push(containerQueryCheck(chatNarrow))
  await page.shot('01-narrow.png')

  await setViewport(options.wideWidth)
  const chatWide = await readPage(page)
  outcomes.push(composerCheck(chatWide, 'wide'))
  outcomes.push(titleRowCheck(chatWide, 'wide'))
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

  const selectedLabel = textAt(activationRecord, 'selectedLabel')
  if (selectedLabel !== null && selectedLabel !== '') await page.evaluate(restoreViewTabExpression(selectedLabel))
  await page.send('Emulation.clearDeviceMetricsOverride')
  outcomes.push(consoleErrorCheck(options.events, options.failOnLogErrors))
  return outcomes
}
