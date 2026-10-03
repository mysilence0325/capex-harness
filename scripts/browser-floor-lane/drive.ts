/**
 * Chromium 90 browser-floor lane driver.
 *
 * Spawns a portable Chromium 90 snapshot build headless, drives it over the
 * Chrome DevTools protocol against a running dsh web server, runs the checks in
 * ./steps.ts, writes screenshots into a caller-chosen directory, and prints one
 * JSON report. Every input is a flag with a documented default or an
 * environment variable of the same name with the DSH_FLOOR_ prefix, so nothing
 * here depends on one workstation's paths.
 *
 * This lane is manual by design: no CI image carries Chromium 90. See
 * ./README.md for the acquisition steps, the checks, and what the lane cannot
 * see.
 * @module scripts/browser-floor-lane/drive
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { expiredSummaryLabel, isJsonObject, runSteps } from './steps.ts'
import type { CheckOutcome, StepEvents, StepPage } from './steps.ts'

/** Chromium release the floor names, and the default the engine check enforces. */
const DEFAULT_ENGINE_MAJOR = 90
/** Default server URL: the Web profile's own port. */
const DEFAULT_URL = 'http://127.0.0.1:3080/'
/** Default DevTools protocol port for the lane's own browser. */
const DEFAULT_CDP_PORT = 9333
/** Default viewport the marked side of every breakpoint is read at. */
const DEFAULT_NARROW_WIDTH = 520
/** Default viewport the unmarked side of every breakpoint is read at. */
const DEFAULT_WIDE_WIDTH = 2400
/** Default browser window; its height is every emulated viewport's height. */
const DEFAULT_WINDOW = '1440x900'
/** Default directory holding the screenshots, the browser profile, and the report. */
const DEFAULT_SHOTS = join('.artifacts', 'browser-floor-lane')
/** Default wait for the page target and for the app to answer after navigation. */
const DEFAULT_TARGET_TIMEOUT_MS = 60_000
/** Default quiet time after the app answers, before the first read. */
const DEFAULT_LOAD_SETTLE_MS = 4000
/** Default quiet time after each viewport change. */
const DEFAULT_SETTLE_MS = 1200
/** Default number of Session rows the driver opens while looking for turns. */
const DEFAULT_SESSION_ATTEMPTS = 6
/** Default wait for one Session row to render its turns. */
const DEFAULT_SESSION_TIMEOUT_MS = 6000
/** Longest console event text kept in the report. */
const EVENT_TEXT_LIMIT = 400
/** Most events kept per category. */
const EVENT_LIMIT = 25

/** One parsed command line. */
interface LaneOptions {
  readonly mode: 'server' | 'smoke'
  readonly url: string
  readonly chrome: string
  readonly shots: string
  readonly profile: string
  readonly report: string
  readonly cdpPort: number
  readonly windowWidth: number
  readonly windowHeight: number
  readonly narrowWidth: number
  readonly wideWidth: number
  readonly engineMajor: number
  readonly targetTimeoutMs: number
  readonly loadSettleMs: number
  readonly settleMs: number
  readonly sessionAttempts: number
  readonly sessionTimeoutMs: number
  readonly failOnLogErrors: boolean
}

/** One page target the browser exposes over the DevTools protocol. */
interface DebugTarget {
  readonly type?: string
  readonly webSocketDebuggerUrl?: string
}

/** One Session row the app lists in its sidebar. */
interface SessionRow {
  readonly key: string
  readonly label: string
}

/** The Session the driver opened, and how many turn marks it rendered. */
interface SessionChoice {
  readonly key: string
  readonly label: string
  readonly marks: number
}

/** The default URL for one option: its flag, its environment variable, or the fallback. */
function optionValue(flag: string | undefined, envName: string, fallback: string): string {
  if (flag !== undefined && flag !== '') return flag
  const fromEnv = process.env[envName]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return fallback
}

/**
 * Parse one integer option, failing loud on anything else.
 * @param value - raw option value, or undefined when absent.
 * @param fallback - value to use when the option is absent.
 * @param name - flag name for the error message.
 * @returns the parsed integer.
 */
function intValue(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer, got ' + JSON.stringify(value))
  return parsed
}

/**
 * Read a log or URL file, including the UTF-16LE a PowerShell redirect writes.
 * @param path - file to read.
 * @returns the file's text.
 */
function readServerFile(path: string): string {
  const bytes = readFileSync(path)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2)
  if (bytes.includes(0)) return bytes.toString('utf16le')
  return bytes.toString('utf8')
}

/**
 * Read the token URL a server printed, from a log or URL file.
 * @param path - file to read; its last token URL wins, so a log with restarts names the live server.
 * @returns the URL.
 * @throws {Error} when the file holds no token URL.
 */
function urlFromFile(path: string): string {
  const text = readServerFile(path)
  const matches = text.match(/https?:\/\/[^\s"'<>]+\?token=[A-Za-z0-9._~-]+/g)
  if (matches === null || matches.length === 0) throw new Error('no token URL found in ' + path)
  return matches[matches.length - 1] ?? ''
}

/**
 * Append a token to a URL that does not carry one.
 * @param url - server URL.
 * @param token - token to append, or undefined.
 * @returns the URL the browser opens.
 */
function withToken(url: string, token: string | undefined): string {
  if (token === undefined || token === '' || url.includes('token=')) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + token
}

/**
 * Parse a WxH window option.
 * @param value - raw option value.
 * @returns the width and height.
 * @throws {Error} when the value is not WxH.
 */
function windowSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value)
  if (match === null) throw new Error('--window must read WxH, got ' + JSON.stringify(value))
  return { width: intValue(match[1], 0, '--window width'), height: intValue(match[2], 0, '--window height') }
}

/** Usage text, printed by --help and on a usage error. */
const USAGE = [
  'Run the Chromium 90 browser-floor lane against a running dsh web server.',
  '',
  '  npx tsx scripts/browser-floor-lane/drive.ts --chrome <chrome.exe> --url <token URL>',
  '  npx tsx scripts/browser-floor-lane/drive.ts --chrome <chrome.exe> --url-file <server.log>',
  '  npx tsx scripts/browser-floor-lane/drive.ts --chrome <chrome.exe> --smoke',
  '',
  'Flags (environment variable, default):',
  '  --chrome <path>          DSH_FLOOR_CHROME          none; the portable build is not committed',
  '  --url <url>              DSH_FLOOR_URL             ' + DEFAULT_URL,
  '  --url-file <path>        DSH_FLOOR_URL_FILE        none; takes the last token URL the file holds',
  '  --token <token>          DSH_FLOOR_TOKEN           none; appended when the URL has no token',
  '  --shots <dir>            DSH_FLOOR_SHOTS           ' + DEFAULT_SHOTS,
  '  --profile <dir>          DSH_FLOOR_PROFILE         <shots>/chrome-profile',
  '  --report <path>          DSH_FLOOR_REPORT          <shots>/report.json',
  '  --cdp-port <port>        DSH_FLOOR_CDP_PORT        ' + String(DEFAULT_CDP_PORT),
  '  --window <WxH>           DSH_FLOOR_WINDOW          ' + DEFAULT_WINDOW,
  '  --narrow-width <px>      DSH_FLOOR_NARROW_WIDTH    ' + String(DEFAULT_NARROW_WIDTH),
  '  --wide-width <px>        DSH_FLOOR_WIDE_WIDTH      ' + String(DEFAULT_WIDE_WIDTH),
  '  --engine-major <n>       DSH_FLOOR_ENGINE_MAJOR    ' + String(DEFAULT_ENGINE_MAJOR),
  '  --target-timeout <ms>    DSH_FLOOR_TARGET_TIMEOUT  ' + String(DEFAULT_TARGET_TIMEOUT_MS),
  '  --load-settle <ms>       DSH_FLOOR_LOAD_SETTLE     ' + String(DEFAULT_LOAD_SETTLE_MS),
  '  --settle <ms>            DSH_FLOOR_SETTLE          ' + String(DEFAULT_SETTLE_MS),
  '  --session-attempts <n>   DSH_FLOOR_SESSION_ATTEMPTS ' + String(DEFAULT_SESSION_ATTEMPTS),
  '  --session-timeout <ms>   DSH_FLOOR_SESSION_TIMEOUT ' + String(DEFAULT_SESSION_TIMEOUT_MS),
  '  --fail-on-log-errors     DSH_FLOOR_FAIL_ON_LOG_ERRORS false; a network 404 is recorded but does not fail the run',
  '  --smoke                  -                          run the lane against its own fixture page',
  '  --help                   -                          print this text',
].join('\n')

/**
 * Parse the command line into one run's options.
 * @param argv - arguments after the script name.
 * @returns the parsed options, or null when the caller asked for usage.
 */
function parseOptions(argv: readonly string[]): LaneOptions | null {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      chrome: { type: 'string' },
      url: { type: 'string' },
      'url-file': { type: 'string' },
      token: { type: 'string' },
      shots: { type: 'string' },
      profile: { type: 'string' },
      report: { type: 'string' },
      'cdp-port': { type: 'string' },
      window: { type: 'string' },
      'narrow-width': { type: 'string' },
      'wide-width': { type: 'string' },
      'engine-major': { type: 'string' },
      'target-timeout': { type: 'string' },
      'load-settle': { type: 'string' },
      settle: { type: 'string' },
      'session-attempts': { type: 'string' },
      'session-timeout': { type: 'string' },
      'fail-on-log-errors': { type: 'boolean' },
      smoke: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (parsed.values.help === true) {
    return null
  }
  const smoke = parsed.values.smoke === true
  const urlFile = optionValue(parsed.values['url-file'], 'DSH_FLOOR_URL_FILE', '')
  const urlFlag = optionValue(parsed.values.url, 'DSH_FLOOR_URL', '')
  if (urlFile !== '' && urlFlag !== '') throw new Error('pass either --url or --url-file, not both')
  const url = smoke
    ? pathToFileURL(join(import.meta.dirname, 'smoke', 'fixture.html')).href
    : withToken(urlFile === '' ? (urlFlag === '' ? DEFAULT_URL : urlFlag) : urlFromFile(urlFile), optionValue(parsed.values.token, 'DSH_FLOOR_TOKEN', ''))
  const shots = resolve(optionValue(parsed.values.shots, 'DSH_FLOOR_SHOTS', DEFAULT_SHOTS))
  const window = windowSize(optionValue(parsed.values.window, 'DSH_FLOOR_WINDOW', DEFAULT_WINDOW))
  return {
    mode: smoke ? 'smoke' : 'server',
    url,
    chrome: optionValue(parsed.values.chrome, 'DSH_FLOOR_CHROME', ''),
    shots,
    profile: resolve(optionValue(parsed.values.profile, 'DSH_FLOOR_PROFILE', join(shots, 'chrome-profile'))),
    report: resolve(optionValue(parsed.values.report, 'DSH_FLOOR_REPORT', join(shots, 'report.json'))),
    cdpPort: intValue(optionValue(parsed.values['cdp-port'], 'DSH_FLOOR_CDP_PORT', ''), DEFAULT_CDP_PORT, '--cdp-port'),
    windowWidth: window.width,
    windowHeight: window.height,
    narrowWidth: intValue(optionValue(parsed.values['narrow-width'], 'DSH_FLOOR_NARROW_WIDTH', ''), DEFAULT_NARROW_WIDTH, '--narrow-width'),
    wideWidth: intValue(optionValue(parsed.values['wide-width'], 'DSH_FLOOR_WIDE_WIDTH', ''), DEFAULT_WIDE_WIDTH, '--wide-width'),
    engineMajor: intValue(optionValue(parsed.values['engine-major'], 'DSH_FLOOR_ENGINE_MAJOR', ''), DEFAULT_ENGINE_MAJOR, '--engine-major'),
    targetTimeoutMs: intValue(optionValue(parsed.values['target-timeout'], 'DSH_FLOOR_TARGET_TIMEOUT', ''), DEFAULT_TARGET_TIMEOUT_MS, '--target-timeout'),
    loadSettleMs: intValue(optionValue(parsed.values['load-settle'], 'DSH_FLOOR_LOAD_SETTLE', ''), DEFAULT_LOAD_SETTLE_MS, '--load-settle'),
    settleMs: intValue(optionValue(parsed.values.settle, 'DSH_FLOOR_SETTLE', ''), DEFAULT_SETTLE_MS, '--settle'),
    sessionAttempts: intValue(optionValue(parsed.values['session-attempts'], 'DSH_FLOOR_SESSION_ATTEMPTS', ''), DEFAULT_SESSION_ATTEMPTS, '--session-attempts'),
    sessionTimeoutMs: intValue(optionValue(parsed.values['session-timeout'], 'DSH_FLOOR_SESSION_TIMEOUT', ''), DEFAULT_SESSION_TIMEOUT_MS, '--session-timeout'),
    failOnLogErrors: parsed.values['fail-on-log-errors'] === true || process.env.DSH_FLOOR_FAIL_ON_LOG_ERRORS === '1',
  }
}

/**
 * Wait without blocking the event loop.
 * @param milliseconds - how long to wait.
 */
async function sleep(milliseconds: number): Promise<void> {
  await new Promise(settle => setTimeout(settle, milliseconds))
}

/**
 * Render one protocol value as text for the report.
 * @param value - value to describe.
 * @param fallback - text used when the value is absent.
 * @returns the value's own string, or its JSON form for a non-scalar.
 */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return fallback
  return JSON.stringify(value)
}

/**
 * Read one protocol frame.
 * @param data - the message event's payload.
 * @returns the parsed frame, or null when it is not a JSON object.
 */
function parseFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null
  const parsed: unknown = JSON.parse(data)
  return isJsonObject(parsed) ? parsed : null
}

/** One connected page, its captured events, and its teardown. */
interface PageSession {
  readonly page: StepPage
  readonly events: StepEvents
  /** Close the DevTools connection; the browser process stays up. */
  close(): void
}

/**
 * Connect to the browser's page target.
 * @param port - DevTools protocol port.
 * @param timeoutMs - how long to wait for a page target.
 * @param shots - directory the page session writes screenshots into.
 * @returns the connected page session.
 * @throws {Error} when no page target appears before the timeout.
 */
async function connect(port: number, timeoutMs: number, shots: string): Promise<PageSession> {
  const deadline = Date.now() + timeoutMs
  let target: DebugTarget | undefined
  while (Date.now() < deadline) {
    try {
      const listing = await (await fetch('http://127.0.0.1:' + String(port) + '/json/list')).json() as DebugTarget[]
      target = listing.find(entry => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
    } catch {
      // The debug port refuses connections until the browser binds it; poll again.
      target = undefined
    }
    if (target?.webSocketDebuggerUrl !== undefined) break
    await sleep(500)
  }
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error('no debuggable page appeared on port ' + String(port) + ' within ' + String(timeoutMs) + 'ms')
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((settle, fail) => {
    socket.addEventListener('open', () => { settle() })
    socket.addEventListener('error', () => { fail(new Error('the DevTools socket refused the connection')) })
  })
  const events: StepEvents = { consoleErrors: [], exceptions: [], logErrors: [], logErrorLabels: [] }
  const pending = new Map<number, (frame: Record<string, unknown>) => void>()
  let nextId = 1
  const record = (bucket: string[], text: string): void => {
    if (bucket.length < EVENT_LIMIT) bucket.push(text.slice(0, EVENT_TEXT_LIMIT))
  }
  socket.addEventListener('message', (event: { readonly data: unknown }) => {
    const frame = parseFrame(event.data)
    if (frame === null) return
    const id = frame.id
    if (typeof id === 'number') {
      const settle = pending.get(id)
      if (settle !== undefined) {
        pending.delete(id)
        settle(frame)
      }
      return
    }
    const method = frame.method
    const params = isJsonObject(frame.params) ? frame.params : null
    if (method === 'Runtime.exceptionThrown' && params !== null) {
      const details = isJsonObject(params.exceptionDetails) ? params.exceptionDetails : null
      const exception = details === null ? null : details.exception
      const description = isJsonObject(exception) ? exception.description : null
      record(events.exceptions, typeof description === 'string' ? description : asText(details?.text, 'exception'))
    }
    if (method === 'Runtime.consoleAPICalled' && params !== null && params.type === 'error') {
      const args = Array.isArray(params.args) ? params.args : []
      const parts = args.map((entry) => {
        if (!isJsonObject(entry)) return ''
        if (typeof entry.value === 'string') return entry.value
        if (typeof entry.description === 'string') return entry.description
        return typeof entry.type === 'string' ? entry.type : ''
      })
      record(events.consoleErrors, parts.join(' '))
    }
    if (method === 'Log.entryAdded' && params !== null) {
      const entry = isJsonObject(params.entry) ? params.entry : null
      if (entry !== null && entry.level === 'error') {
        const text = asText(entry.text, 'log error')
        const url = asText(entry.url, '(no url)')
        const index = events.logErrors.length
        record(events.logErrors, text + ' ' + url)
        // Only a recorded entry can be labelled: the report holds at most EVENT_LIMIT of them.
        if (index < events.logErrors.length) {
          const label = expiredSummaryLabel(text, url, index)
          if (label !== null) events.logErrorLabels.push(label)
        }
      }
    }
  })
  const send = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId
    nextId += 1
    const answer = new Promise<Record<string, unknown>>((settle) => { pending.set(id, settle) })
    socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
    const frame = await answer
    const error = frame.error
    if (isJsonObject(error)) throw new Error(method + ' failed: ' + asText(error.message, 'protocol error'))
    const result = frame.result
    return isJsonObject(result) ? result : {}
  }
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const exception = isJsonObject(result.exceptionDetails) ? result.exceptionDetails : null
    if (exception !== null) {
      const thrown = isJsonObject(exception.exception) ? exception.exception : null
      const description = thrown === null ? null : thrown.description
      throw new Error('page evaluation failed: ' + (typeof description === 'string' ? description : asText(exception.text, 'exception')))
    }
    const remote = isJsonObject(result.result) ? result.result : null
    return remote === null ? undefined : remote.value
  }
  const page: StepPage = {
    evaluate,
    send,
    sleep,
    shot: async (name: string): Promise<string> => {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const data = result.data
      if (typeof data !== 'string') throw new Error('the screenshot carried no data')
      writeFileSync(join(shots, name), Buffer.from(data, 'base64'))
      return name
    },
  }
  return { page, events, close: () => { socket.close() } }
}

/**
 * Poll a page expression until it is true.
 * @param page - page operations.
 * @param expression - expression that yields true when the wait is over.
 * @param timeoutMs - how long to wait.
 * @param intervalMs - how often to ask.
 * @returns whether the expression became true.
 */
async function waitFor(page: StepPage, expression: string, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate(expression) === true) return true
    await sleep(intervalMs)
  }
  return false
}

/** Expression listing the Session rows the sidebar shows. */
const SESSION_ROWS_EXPRESSION = [
  '(() => {',
  '  const rows = document.querySelectorAll(\'[data-row-key^="session:"]\')',
  '  const out = []',
  '  for (let index = 0; index < rows.length; index += 1) {',
  '    out.push({ key: rows[index].getAttribute(\'data-row-key\'), label: rows[index].innerText || \'\' })',
  '  }',
  '  return JSON.stringify(out)',
  '})()',
].join('\n')

/** How many turn marks the rail needs before it renders. */
const USABLE_MARKS = 2

/**
 * Build the expression that clicks one Session row.
 * @param index - position in the sidebar's Session rows.
 * @returns the expression the driver evaluates.
 */
function clickSessionRowExpression(index: number): string {
  return [
    '(() => {',
    '  const rows = document.querySelectorAll(\'[data-row-key^="session:"]\')',
    '  if (rows.length <= ' + String(index) + ') return \'missing\'',
    '  rows[' + String(index) + '].click()',
    '  return \'clicked\'',
    '})()',
  ].join('\n')
}

/**
 * Open a Session that renders turn marks, so the rail and trajectory checks can read them.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @returns the chosen Session, or null when the sidebar lists none.
 */
async function openUsableSession(page: StepPage, options: LaneOptions): Promise<SessionChoice | null> {
  if (options.sessionAttempts === 0) return null
  const raw = await page.evaluate(SESSION_ROWS_EXPRESSION)
  if (typeof raw !== 'string') return null
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return null
  const rows: SessionRow[] = []
  for (const entry of parsed) {
    if (!isJsonObject(entry)) continue
    const key = entry.key
    const label = entry.label
    rows.push({
      key: typeof key === 'string' ? key : '',
      label: typeof label === 'string' ? (label.split('\n')[0] ?? '').slice(0, 60) : '',
    })
  }
  if (rows.length === 0) return null
  let best: SessionChoice | null = null
  const attempts = Math.min(rows.length, options.sessionAttempts)
  for (let index = 0; index < attempts; index += 1) {
    await page.evaluate(clickSessionRowExpression(index))
    const ready = await waitFor(page, 'document.querySelectorAll(\'button[data-index]\').length >= ' + String(USABLE_MARKS), options.sessionTimeoutMs)
    const marks = ready ? USABLE_MARKS : await countMarks(page)
    const row = rows[index]
    if (row === undefined) continue
    if (marks >= USABLE_MARKS) return { key: row.key, label: row.label, marks }
    if (marks >= 1 && (best === null || marks > best.marks)) best = { key: row.key, label: row.label, marks }
  }
  return best
}

/**
 * Count the turn marks the rail currently renders.
 * @param page - page operations.
 * @returns the count, or 0 when the page did not answer with a number.
 */
async function countMarks(page: StepPage): Promise<number> {
  const count = await page.evaluate('document.querySelectorAll(\'button[data-index]\').length')
  return typeof count === 'number' ? count : 0
}

/**
 * Describe why a URL did not answer, for the readiness failure message.
 * @param url - the URL the browser opened.
 * @returns a one-line description.
 */
async function describeResponse(url: string): Promise<string> {
  try {
    const response = await fetch(url)
    return 'HTTP ' + String(response.status)
  } catch (error) {
    return 'unreachable (' + String(error instanceof Error ? error.message : error) + ')'
  }
}

/**
 * Run one lane pass and print its report.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
async function main(argv: readonly string[]): Promise<number> {
  let options: LaneOptions | null
  try {
    options = parseOptions(argv)
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n\n' + USAGE + '\n')
    return 2
  }
  if (options === null) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  if (options.chrome === '') {
    throw new Error('no Chromium 90 executable: pass --chrome <path> or set DSH_FLOOR_CHROME; scripts/browser-floor-lane/README.md says where the portable build comes from')
  }
  mkdirSync(options.shots, { recursive: true })
  mkdirSync(options.profile, { recursive: true })
  const startedAt = Date.now()
  const browser = spawn(options.chrome, [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + options.profile,
    '--remote-debugging-port=' + String(options.cdpPort),
    '--window-size=' + String(options.windowWidth) + ',' + String(options.windowHeight),
    'about:blank',
  ], { stdio: 'ignore' })
  let session: PageSession | null = null
  try {
    session = await connect(options.cdpPort, options.targetTimeoutMs, options.shots)
    const page = session.page
    await page.send('Runtime.enable')
    await page.send('Page.enable')
    await page.send('Log.enable')
    await page.send('Page.navigate', { url: options.url })
    const readyExpression = options.mode === 'smoke'
      ? 'document.readyState === \'complete\' && document.querySelector(\'[data-fixture-row]\') !== null'
      : 'document.readyState === \'complete\' && document.querySelectorAll(\'button\').length > 3'
    const ready = await waitFor(page, readyExpression, options.targetTimeoutMs)
    if (!ready) {
      throw new Error('the app did not render within ' + String(options.targetTimeoutMs) + 'ms at ' + options.url + ' (' + await describeResponse(options.url) + ')')
    }
    await sleep(options.loadSettleMs)
    const opened = options.mode === 'smoke' ? null : await openUsableSession(page, options)
    const outcomes = await runSteps(page, {
      narrowWidth: options.narrowWidth,
      wideWidth: options.wideWidth,
      viewportHeight: options.windowHeight,
      settleMs: options.settleMs,
      engineMajor: options.engineMajor,
      events: session.events,
      failOnLogErrors: options.failOnLogErrors,
      floorApisApplicable: options.mode === 'server',
      sessionUiApplicable: options.mode === 'server',
    })
    const summary = summarize(outcomes)
    const report = {
      lane: 'browser-floor-lane',
      mode: options.mode,
      url: options.url,
      chrome: options.chrome,
      profile: options.profile,
      shots: options.shots,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      viewports: { narrow: options.narrowWidth, wide: options.wideWidth, height: options.windowHeight },
      session: opened,
      screenshots: ['01-narrow.png', '02-wide.png', '03-trajectory.png'],
      checks: outcomes,
      summary,
      events: session.events,
    }
    writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write('browser-floor-lane: ' + summaryLine(summary) + '; report ' + options.report + '\n')
    return summary.ok ? 0 : 1
  } finally {
    session?.close()
    browser.kill()
  }
}

/**
 * Count the outcomes by status.
 * @param outcomes - the run's outcomes.
 * @returns per-status counts and whether the run passed.
 */
function summarize(outcomes: readonly CheckOutcome[]): { pass: number; fail: number; absent: number; notApplicable: number; ok: boolean } {
  let pass = 0
  let fail = 0
  let absent = 0
  let notApplicable = 0
  for (const outcome of outcomes) {
    if (outcome.status === 'pass') pass += 1
    else if (outcome.status === 'fail') fail += 1
    else if (outcome.status === 'absent') absent += 1
    else notApplicable += 1
  }
  // An absent fact is a failed run: the lane could not certify what it claims to check.
  return { pass, fail, absent, notApplicable, ok: fail === 0 && absent === 0 }
}

/**
 * Render the one-line summary the driver prints on stderr.
 * @param summary - the counted outcomes.
 * @returns the summary line.
 */
function summaryLine(summary: { pass: number; fail: number; absent: number; notApplicable: number; ok: boolean }): string {
  return String(summary.pass) + ' passed, ' + String(summary.fail) + ' failed, ' + String(summary.absent) + ' unreadable, '
    + String(summary.notApplicable) + ' not applicable -> ' + (summary.ok ? 'ok' : 'NOT ok')
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}, (error: unknown) => {
  process.stderr.write('browser-floor-lane: ' + String(error instanceof Error ? error.message : error) + '\n')
  process.exitCode = 2
})
