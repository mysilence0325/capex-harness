/**
 * The checks only a keyed, real-model run can give.
 *
 * Every other step in this lane reads a Session the server already holds. These
 * steps open a Session of their own, type a prompt into the composer, let the
 * real model answer, and read what the client rendered: the assistant's own
 * streamed reply, the closing turn's file cards, and a PDF the model wrote.
 * None of that exists without a server started with DEEPSEEK_API_KEY, so
 * ./drive.ts appends these steps only under --model-checks, and a keyless run
 * keeps exactly the checks that need no model.
 *
 * Every wait here is on a rendered fact rather than on a duration: the prompt is
 * read back out of the composer before Enter, the reply is read out of the
 * assistant node, and the cards are read out of the turn tail. The one state the
 * lane cannot read after the fact — that the assistant message entered its
 * streaming state — is recorded by a page-side observer installed before the
 * prompt is sent, so a fast answer cannot slip between two polls.
 * @module scripts/browser-floor-lane/model-steps
 */

import { booleanAt, fileOpenAttempt, isJsonObject, numberAt, openWorkspaceFileExpression, readPage, textAt } from './steps.ts'
import type { CheckOutcome, FileOpenAttempt, PageReading, StepPage } from './steps.ts'

/** Prompt the streaming round trip sends. */
const STREAM_PROMPT = 'Count from 1 to 40, one number per line.'

/**
 * Numbers the rendered reply must carry for the round trip to have answered.
 *
 * Measured on this client, a one-token answer mounts its assistant step already
 * settled, so no streaming state is ever rendered for it and a check built on
 * that prompt could only assert the final text. This prompt asks for a reply
 * long enough to arrive in several chunks, which is what makes the streaming
 * state itself readable, and the two numbers prove the answer reached both ends
 * of the requested range. The range is wide on purpose: a short sentence can
 * reach a real model and still come back in a single batch.
 */
const STREAM_REPLY_FIRST = '1'
const STREAM_REPLY_LAST = '40'

/**
 * Files the deliverables turn is asked to write.
 *
 * Two of them, because a single declared file collapses the delivery grid to
 * one column at every width, which would leave the wide reading unable to tell
 * the two-column default from the narrow override.
 */
const DELIVERABLE_FILES = ['floor-lane-probe.txt', 'floor-lane-probe-b.txt'] as const

/** Prompt the deliverables turn sends. */
const DELIVERABLES_PROMPT = 'Use the write tool to create two files in the working directory: '
  + DELIVERABLE_FILES.join(' and ') + ', each containing exactly the single word ok. '
  + 'Then call the present tool with both files as deliverables, and reply with one short sentence.'

/** File the PDF turn is asked to write. */
const PDF_FILE = 'floor-lane-probe.pdf'

/** Content stream the PDF turn is asked to write verbatim. */
const PDF_STREAM = [
  'BT /F1 16 Tf 24 110 Td (floor lane ok) Tj ET',
  'BT /F1 11 Tf 24 80 Td (chromium 90 pdf preview) Tj ET',
  '',
].join('\n')

/**
 * The complete PDF the model is asked to write.
 *
 * ASCII only, one page, no cross-reference table: the reader recovers the
 * objects itself, which keeps a byte-exact instruction short enough for a
 * prompt. Every byte is stated, including the stream length, so a model that
 * follows the instruction writes a document rather than a description of one.
 */
const PDF_BYTES = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  '4 0 obj<</Length ' + String(PDF_STREAM.length) + '>>stream',
  PDF_STREAM.replace(/\n$/, ''),
  'endstream endobj',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n')

/** Prompt the PDF turn sends. */
const PDF_PROMPT = 'Use the write tool to create a file named ' + PDF_FILE
  + ' whose entire content is exactly these lines, byte for byte and with no code fence:\n'
  + PDF_BYTES + '\nDo not change, reorder, or add any character. Then reply with one short sentence.'

/** How often the driver reads the page-side record of one turn. */
const POLL_MS = 300
/** Samples the page-side observer keeps, which is far more than one turn produces at 150ms. */
const SAMPLE_LIMIT = 600
/** Characters of one assistant message the record keeps per sample. */
const SAMPLE_TEXT_LIMIT = 200

/**
 * Page source that records one turn as it happens.
 *
 * The lane can read a finished message, but nothing left in the page says the
 * message was ever streaming, so this observer is installed before the prompt is
 * sent. It watches mutations as well as sampling on a timer, because a short
 * answer can add and remove the assistant step's streaming attribute between two
 * timer ticks.
 */
const RECORDER = [
  '(() => {',
  '  const LIMIT = ' + String(SAMPLE_LIMIT),
  '  const TEXT = ' + String(SAMPLE_TEXT_LIMIT),
  '  const state = { startedAt: Date.now(), streamingSeen: false, firstStreaming: null, streamLengths: [], samples: [], last: null, errorText: null }',
  '  window.__dshFloorLaneTurn = state',
  '  const answer = () => {',
  '    const responses = document.querySelectorAll(\'[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]\')',
  '    if (responses.length > 0) return responses[responses.length - 1]',
  '    const steps = document.querySelectorAll(\'[data-chat-flow-kind="assistant-step"]\')',
  '    return steps.length === 0 ? null : steps[steps.length - 1]',
  '  }',
  '  const read = () => {',
  '    const node = answer()',
  '    const text = node === null ? \'\' : (node.textContent || \'\').trim()',
  '    const streaming = node !== null && node.querySelector(\'[data-streaming]\') !== null',
  '    const errors = document.querySelectorAll(\'[class*="_turnErrorRow"]\')',
  '    const lastError = errors.length === 0 ? null : errors[errors.length - 1]',
  '    const error = lastError === null ? null : (lastError.textContent || \'\').trim().slice(0, 300)',
  '    return { present: node !== null, assistants: document.querySelectorAll(\'[data-chat-flow-kind="assistant-step"]\').length, streaming: streaming, text: text, error: error }',
  '  }',
  '  const observe = () => {',
  '    const now = read()',
  '    if (now.streaming) {',
  '      state.streamingSeen = true',
  '      if (state.firstStreaming === null) state.firstStreaming = now.text.slice(0, TEXT)',
  '      const lengths = state.streamLengths',
  '      if (lengths.length < 40 && lengths[lengths.length - 1] !== now.text.length) lengths.push(now.text.length)',
  '    }',
  '    if (now.error !== null && state.errorText === null) state.errorText = now.error',
  '    if (state.samples.length < LIMIT) state.samples.push({ ms: Date.now() - state.startedAt, streaming: now.streaming, length: now.text.length })',
  '    state.last = now',
  '  }',
  '  const observer = new MutationObserver(observe)',
  '  observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true })',
  '  state.stop = () => { observer.disconnect(); clearInterval(state.timer) }',
  '  state.timer = setInterval(() => {',
  '    observe()',
  '    if (Date.now() - state.startedAt > 180000) state.stop()',
  '  }, 150)',
  '  return \'recording\'',
  '})()',
].join('\n')

/** Expression that reads the observer's record back out. */
const READ_RECORD = [
  '(() => {',
  '  const state = window.__dshFloorLaneTurn',
  '  if (state === undefined || state === null) return null',
  '  return JSON.stringify({',
  '    streamingSeen: state.streamingSeen, firstStreaming: state.firstStreaming, last: state.last, streamLengths: state.streamLengths,',
  '    samples: state.samples.length, errorText: state.errorText, elapsedMs: Date.now() - state.startedAt,',
  '  })',
  '})()',
].join('\n')

/**
 * Build the expression that opens a Session of this lane's own.
 *
 * A blank Session is the one place the composer is guaranteed to be the hero,
 * so the wait is for the shell's own hero phase with an editable composer under
 * it: the Session the earlier checks read is never touched, and its turns stay
 * out of the transcript these checks read.
 * @param timeoutMs - how long to wait for the client to open the Session.
 * @returns the expression the driver evaluates.
 */
function startSessionExpression(timeoutMs: number): string {
  return [
    '(async () => {',
    '  const wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) })',
    '  const start = document.querySelector(\'[class*="_newSession"]\')',
    '  if (start === null) return JSON.stringify({ started: false, reason: \'the sidebar renders no new-session control\' })',
    '  start.click()',
    '  const deadline = Date.now() + ' + String(timeoutMs),
    '  for (;;) {',
    '    const shell = document.querySelector(\'[data-conversation-shell]\')',
    '    const input = document.querySelector(\'[data-composer-input]\')',
    '    const hero = shell !== null && shell.getAttribute(\'data-phase\') === \'hero\'',
    '    if (hero && input !== null && input.getAttribute(\'contenteditable\') === \'true\') {',
    '      return JSON.stringify({ started: true, reason: null })',
    '    }',
    '    if (Date.now() >= deadline) {',
    '      return JSON.stringify({',
    '        started: false,',
    '        reason: \'no blank Session reached an editable composer; the shell is \' + (shell === null ? \'absent\' : String(shell.getAttribute(\'data-phase\'))) + \' and the composer is \' + (input === null ? \'absent\' : String(input.getAttribute(\'contenteditable\'))),',
    '      })',
    '    }',
    '    await wait(200)',
    '  }',
    '})()',
  ].join('\n')
}

/** Expression that puts the caret in the composer and reports what it found. */
const FOCUS_COMPOSER = [
  '(() => {',
  '  const input = document.querySelector(\'[data-composer-input]\')',
  '  if (input === null) return JSON.stringify({ present: false, focused: false, editable: null })',
  '  input.focus()',
  '  return JSON.stringify({ present: true, focused: document.activeElement === input, editable: input.getAttribute(\'contenteditable\') })',
  '})()',
].join('\n')

/** Expression that reads the composer's own draft text. */
const READ_DRAFT = [
  '(() => {',
  '  const input = document.querySelector(\'[data-composer-input]\')',
  '  return input === null ? null : (input.textContent || \'\')',
  '})()',
].join('\n')

/**
 * Build the fallback insertion expression.
 *
 * Chromium's own editing pipeline is what both paths use; this one is the
 * document command, kept for a build whose protocol text insertion the focused
 * frame does not take.
 * @param text - prompt to insert.
 * @returns the expression the driver evaluates.
 */
function insertTextExpression(text: string): string {
  return [
    '(() => {',
    '  const input = document.querySelector(\'[data-composer-input]\')',
    '  if (input === null) return JSON.stringify({ inserted: false })',
    '  input.focus()',
    '  const inserted = document.execCommand(\'insertText\', false, ' + JSON.stringify(text) + ')',
    '  return JSON.stringify({ inserted: inserted })',
    '})()',
  ].join('\n')
}

/**
 * Build the expression that reports what one preview's PDF body decided.
 *
 * The container states text as soon as a body is elected, so the body's own
 * report, or the failure line it renders instead, is what says whether the
 * document was painted.
 * @param fileName - basename of the file the pane opened.
 * @returns the expression the driver evaluates.
 */
function pdfBodyExpression(fileName: string): string {
  const suffix = JSON.stringify('/' + fileName)
  const suffixLength = fileName.length + 1
  return [
    '(() => {',
    '  const nodes = document.querySelectorAll(\'[data-textpreview-state]\')',
    '  for (let index = nodes.length - 1; index >= 0; index -= 1) {',
    '    const node = nodes[index]',
    '    const url = node.getAttribute(\'data-textpreview-url\') || \'\'',
    '    if (url.slice(-' + String(suffixLength) + ') !== ' + suffix + ') continue',
    '    const alert = node.querySelector(\'[role="alert"]\')',
    '    const surface = node.querySelector(\'[data-document-zoom-surface]\')',
    '    const canvases = node.querySelectorAll(\'canvas\')',
    '    let ink = 0',
    '    let size = null',
    '    for (let index = 0; index < canvases.length; index += 1) {',
    '      try {',
    '        const context = canvases[index].getContext(\'2d\')',
    '        const pixels = context === null ? null : context.getImageData(0, 0, canvases[index].width, canvases[index].height).data',
    '        if (pixels === null) continue',
    '        let dark = 0',
    '        for (let pixel = 0; pixel + 3 < pixels.length; pixel += 16) {',
    '          if (pixels[pixel + 3] > 32 && (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3 < 200) dark += 1',
    '        }',
    '        if (dark > ink) { ink = dark; size = String(canvases[index].width) + \'x\' + String(canvases[index].height) }',
    '      } catch (error) {',
    '        ink = 0',
    '      }',
    '    }',
    '    return JSON.stringify({',
    '      state: node.getAttribute(\'data-textpreview-state\'),',
    '      pdf: node.querySelector(\'[data-pdf-preview]\') !== null,',
    '      canvases: canvases.length,',
    '      ink: ink,',
    '      canvasSize: size,',
    '      surfaceHidden: surface === null ? null : surface.hasAttribute(\'hidden\'),',
    '      alert: alert === null ? null : (alert.textContent || \'\').slice(0, 200),',
    '    })',
    '  }',
    '  return JSON.stringify({ state: null, pdf: false, canvases: 0, ink: 0, canvasSize: null, surfaceHidden: null, alert: null })',
    '})()',
  ].join('\n')
}

/** Expression that reports the closing turn's file sections. */
const READ_CARDS = [
  '(() => {',
  '  const flow = document.querySelector(\'[data-chat-flow]\')',
  '  return JSON.stringify({',
  '    changed: document.querySelectorAll(\'[data-changed-files]\').length,',
  '    rows: document.querySelectorAll(\'[data-presented-files-row]\').length,',
  '    flowText: flow === null ? \'\' : (flow.innerText || \'\').slice(-800),',
  '  })',
  '})()',
].join('\n')

/** Expression that asks the workspace-files pane to reread its listing. */
const RELOAD_FILES = [
  '(() => {',
  '  const reload = document.querySelector(\'[data-files-reload]\')',
  '  if (reload === null) return JSON.stringify({ reloaded: false })',
  '  reload.click()',
  '  return JSON.stringify({ reloaded: true })',
  '})()',
].join('\n')
/** The turn as the recorder last saw it. */
interface TurnSnapshot {
  readonly present: boolean
  readonly assistants: number
  readonly streaming: boolean
  readonly text: string
  readonly error: string | null
}

/** One turn's record, read back out of the page. */
interface TurnRecord {
  readonly streamingSeen: boolean
  readonly firstStreaming: string | null
  readonly last: TurnSnapshot | null
  /** Text lengths observed while the assistant step was streaming, in order. */
  readonly streamLengths: number[]
  readonly samples: number
  readonly errorText: string | null
  readonly elapsedMs: number | null
}

/** Inputs the model steps fix before they type. */
export interface ModelStepOptions {
  /** Viewport width the marked side of every breakpoint is read at. */
  readonly narrowWidth: number
  /** Viewport width the unmarked side of every breakpoint is read at. */
  readonly wideWidth: number
  /** Viewport height every emulated viewport uses. */
  readonly viewportHeight: number
  /** Quiet time after a viewport change, before the app has laid out for it. */
  readonly settleMs: number
  /** How long one page gesture waits for the client to answer it. */
  readonly gestureTimeoutMs: number
  /** How long one real-model turn may take, from Enter to a settled assistant message. */
  readonly replyTimeoutMs: number
}

/** One turn the lane drove, and everything it read from it. */
interface TurnResult {
  readonly prompt: string
  readonly typedBy: string | null
  readonly submitted: boolean
  readonly reason: string | null
  readonly record: TurnRecord | null
  readonly timedOut: boolean
  readonly elapsedMs: number
}

/** What the closing-turn card wait last read. */
interface CardPresence {
  readonly changed: number
  readonly rows: number
  readonly flowText: string
}

/**
 * Read a list of numbers out of one probe value.
 * @param value - the value to read.
 * @returns the numbers it carries, in order.
 */
function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const numbers: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isFinite(entry)) numbers.push(entry)
  }
  return numbers
}

/**
 * Read the recorder's record.
 * @param value - the page's return value.
 * @returns the record, or null when the page has none.
 */
function turnRecord(value: unknown): TurnRecord | null {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null
  if (!isJsonObject(parsed)) return null
  const last = isJsonObject(parsed.last) ? parsed.last : null
  return {
    streamingSeen: parsed.streamingSeen === true,
    firstStreaming: textAt(parsed, 'firstStreaming'),
    last: last === null ? null : {
      present: last.present === true,
      assistants: numberAt(last, 'assistants') ?? 0,
      streaming: last.streaming === true,
      text: textAt(last, 'text') ?? '',
      error: textAt(last, 'error'),
    },
    streamLengths: numberList(parsed.streamLengths),
    samples: numberAt(parsed, 'samples') ?? 0,
    errorText: textAt(parsed, 'errorText'),
    elapsedMs: numberAt(parsed, 'elapsedMs'),
  }
}

/**
 * Read what the closing turn's card wait last saw.
 * @param value - the page's return value.
 * @returns the presence reading, reading an unparseable answer as nothing seen.
 */
function cardPresence(value: unknown): CardPresence {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null
  if (!isJsonObject(parsed)) return { changed: 0, rows: 0, flowText: '' }
  return {
    changed: numberAt(parsed, 'changed') ?? 0,
    rows: numberAt(parsed, 'rows') ?? 0,
    flowText: textAt(parsed, 'flowText') ?? '',
  }
}

/**
 * Whether rendered text carries one number as a standalone token.
 * @param text - the rendered text.
 * @param value - the number to look for.
 * @returns whether the text states that number on its own.
 */
function carriesNumber(text: string, value: string): boolean {
  return new RegExp('(^|[^0-9])' + value + '([^0-9]|$)').test(text)
}

/**
 * Whether the record states a finished assistant message.
 * @param record - the turn's record.
 * @returns whether the assistant step stopped streaming with text on screen.
 */
function settledRecord(record: TurnRecord | null): boolean {
  if (record === null || record.errorText !== null) return false
  // An answer that arrives in one batch mounts its step already settled, so a
  // missing streaming state says nothing about whether the turn is over: the
  // step is done exactly when it carries text and is no longer streaming.
  const last = record.last
  return last !== null && last.present && !last.streaming && last.text !== ''
}

/**
 * Read the composer's own draft out of one page evaluation.
 * @param value - the page's return value.
 * @returns the draft text, or null when the composer is not mounted.
 */
function draftText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Whether the composer holds the prompt the lane typed.
 *
 * The comparison folds runs of whitespace, because a rich-text surface states
 * the same draft with its own line breaks.
 * @param draft - the composer's own text.
 * @param prompt - the prompt the lane typed.
 * @returns whether the draft carries the prompt.
 */
function draftCarries(draft: string | null, prompt: string): boolean {
  if (draft === null) return false
  const fold = (value: string): string => value.replace(/\s+/g, ' ').trim()
  return fold(draft) === fold(prompt)
}

/**
 * Open a blank Session for the model steps.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @returns whether a blank Session reached its composer, and why not when it did not.
 */
async function startModelSession(page: StepPage, options: ModelStepOptions): Promise<{ started: boolean; reason: string | null }> {
  const raw = await page.evaluate(startSessionExpression(options.gestureTimeoutMs))
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
  if (!isJsonObject(parsed) || parsed.started !== true) {
    return { started: false, reason: textAt(isJsonObject(parsed) ? parsed : null, 'reason') ?? 'the page did not report opening a Session' }
  }
  return { started: true, reason: null }
}

/**
 * Type one prompt into the composer, send it, and wait for the turn to settle.
 *
 * The prompt is read back out of the composer before Enter is pressed, so a
 * gesture that never landed is reported as such rather than watched for a reply
 * that cannot come. The wait then ends on the rendered message: the assistant
 * node stopped streaming and carries text, or the turn raised its own error.
 * @param page - page operations.
 * @param prompt - prompt to send.
 * @param options - the run's fixed inputs.
 * @returns the turn's record and how it was driven.
 */
async function runTurn(page: StepPage, prompt: string, options: ModelStepOptions): Promise<TurnResult> {
  const startedAt = Date.now()
  await page.evaluate(RECORDER)
  const focusRaw = await page.evaluate(FOCUS_COMPOSER)
  const focus: unknown = typeof focusRaw === 'string' ? JSON.parse(focusRaw) : null
  const editable = isJsonObject(focus) && focus.focused === true && focus.editable === 'true'
  let typedBy: string | null = null
  if (editable) {
    await page.send('Input.insertText', { text: prompt })
    if (draftCarries(draftText(await page.evaluate(READ_DRAFT)), prompt)) typedBy = 'protocol text insertion'
  }
  if (typedBy === null) {
    await page.evaluate(insertTextExpression(prompt))
    if (draftCarries(draftText(await page.evaluate(READ_DRAFT)), prompt)) typedBy = 'the document insert command'
  }
  if (typedBy === null) {
    return {
      prompt, typedBy: null, submitted: false, record: null, timedOut: false,
      reason: 'the composer did not hold the prompt after the lane typed it',
      elapsedMs: Date.now() - startedAt,
    }
  }
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
  const deadline = Date.now() + options.replyTimeoutMs
  let submitted = false
  let record: TurnRecord | null = null
  let revisited = false
  while (Date.now() < deadline) {
    if (!submitted) {
      const draft = await page.evaluate(READ_DRAFT)
      submitted = typeof draft === 'string' && draft.trim() === ''
    }
    record = turnRecord(await page.evaluate(READ_RECORD))
    if (record !== null) {
      if (record.errorText !== null) break
      if (settledRecord(record)) {
        // The step stops streaming just before its turn closes, so one more
        // quiet window is what lets a notice arriving with the close be read.
        if (revisited) break
        revisited = true
        await page.sleep(options.settleMs)
        continue
      }
    }
    await page.sleep(POLL_MS)
  }
  return {
    prompt,
    typedBy,
    submitted,
    reason: submitted ? null : 'the composer kept the prompt, so Enter did not send it',
    record,
    timedOut: !settledRecord(record),
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * Wait for the closing turn's changed-files card and declared deliveries.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @returns the last presence reading, taken when both sections were there or when the wait ran out.
 */
async function awaitCards(page: StepPage, options: ModelStepOptions): Promise<CardPresence> {
  const deadline = Date.now() + options.gestureTimeoutMs
  let latest: CardPresence = { changed: 0, rows: 0, flowText: '' }
  for (;;) {
    latest = cardPresence(await page.evaluate(READ_CARDS))
    if (latest.changed > 0 && latest.rows > 0) return latest
    if (Date.now() >= deadline) return latest
    await page.sleep(400)
  }
}
/**
 * Whether the turn's own reply rendered, streamed, and ended without an error notice.
 * @param turn - the turn the lane drove, and its record.
 * @returns the check outcome.
 */
function streamingRoundTripCheck(turn: TurnResult): CheckOutcome {
  const record = turn.record
  const last = record === null ? null : record.last
  const text = last === null ? '' : last.text
  const evidence = {
    prompt: turn.prompt,
    typedBy: turn.typedBy,
    submitted: turn.submitted,
    streamingSeen: record === null ? null : record.streamingSeen,
    firstStreaming: record === null ? null : record.firstStreaming,
    streamLengths: record === null ? null : record.streamLengths,
    samples: record === null ? null : record.samples,
    assistants: last === null ? null : last.assistants,
    finalText: text,
    errorText: record === null ? null : record.errorText,
    timedOut: turn.timedOut,
    elapsedMs: turn.elapsedMs,
  }
  if (!turn.submitted) {
    return {
      id: 'model.streaming-round-trip',
      status: 'fail',
      detail: 'the composer never sent the prompt: ' + String(turn.reason),
      evidence,
    }
  }
  if (record !== null && record.errorText !== null) {
    return {
      id: 'model.streaming-round-trip',
      status: 'fail',
      detail: 'the turn ended on its own error notice: ' + record.errorText.slice(0, 200),
      evidence,
    }
  }
  if (!turn.timedOut && record !== null && record.streamingSeen) {
    const answered = carriesNumber(text, STREAM_REPLY_FIRST) && carriesNumber(text, STREAM_REPLY_LAST)
    if (answered) {
      const grew = record.streamLengths.length > 1
      return {
        id: 'model.streaming-round-trip',
        status: 'pass',
        detail: 'the composer sent the prompt, the assistant message streamed (text lengths observed while streaming: '
          + (record.streamLengths.length === 0 ? 'none' : record.streamLengths.join(', ')) + '), and it settled on "'
          + text.replace(/\n/g, ' ') + '" with no error notice after ' + String(Math.round(turn.elapsedMs / 1000)) + 's'
          + (grew ? '; the text grew while it streamed' : '; the whole answer arrived in one chunk'),
        evidence,
      }
    }
    return {
      id: 'model.streaming-round-trip',
      status: 'fail',
      detail: 'the assistant message settled on "' + text.replace(/\n/g, ' ').slice(0, 120)
        + '", which does not carry both ends of the reply the prompt asked for (' + STREAM_REPLY_FIRST + ' and ' + STREAM_REPLY_LAST + ')',
      evidence,
    }
  }
  if (record !== null && !record.streamingSeen) {
    return {
      id: 'model.streaming-round-trip',
      status: 'fail',
      detail: 'the turn ended without the assistant message ever entering its streaming state; last text "' + text.slice(0, 120) + '"',
      evidence,
    }
  }
  return {
    id: 'model.streaming-round-trip',
    status: 'fail',
    detail: 'no assistant message settled within ' + String(Math.round(turn.elapsedMs / 1000)) + 's; the record saw '
      + String(record === null ? 0 : record.samples) + ' sample(s) and the last text was "' + text.slice(0, 120) + '"',
    evidence,
  }
}

/**
 * Split a computed grid-template-columns value into its tracks.
 *
 * The value states one size per column, and a track can carry a space inside a
 * function of its own, so the split respects parentheses rather than whitespace.
 * @param columns - the computed value, or null when no grid was read.
 * @returns one entry per column track.
 */
function gridTracks(columns: string | null): string[] {
  if (columns === null) return []
  const tracks: string[] = []
  let depth = 0
  let current = ''
  for (const character of columns.trim()) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (/\s/.test(character) && depth === 0) {
      if (current !== '') tracks.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') tracks.push(current)
  return tracks
}

/**
 * Whether the closing turn's file cards follow the width the client states.
 *
 * The changed-files card is the turn's own record that the model wrote a file.
 * The declared-deliveries grid beside it is the section a container query used
 * to size, so its container is what carries the marker: one column on the
 * marked side, the stylesheet's two columns on the other.
 * @param reading - probe payload carrying the closing turn's cards.
 * @param side - which side of the breakpoint this reading came from.
 * @param files - file names the turn was asked to write.
 * @returns the check outcome.
 */
function deliverablesCardCheck(reading: PageReading, side: 'narrow' | 'wide', files: readonly string[]): CheckOutcome {
  const card = reading.deliverables
  const columns = textAt(card, 'columns')
  const tracks = gridTracks(columns)
  const changedText = textAt(card, 'changedText')
  const named = changedText !== null && files.some(file => changedText.includes(file))
  const evidence = {
    side,
    expectedFiles: files,
    changedCards: numberAt(card, 'changedCards'),
    changedText: changedText === null ? null : changedText.slice(0, 300),
    presentedRows: numberAt(card, 'presentedRows'),
    containerNarrow: booleanAt(card, 'containerNarrow'),
    containerClass: textAt(card, 'containerClass'),
    single: textAt(card, 'single'),
    cards: numberAt(card, 'cards'),
    columns,
    tracks,
    text: textAt(card, 'text'),
  }
  if (card === null || numberAt(card, 'presentedRows') === 0) {
    return {
      id: 'layout.deliverables-card',
      status: 'absent',
      detail: 'the turn declares no deliverables, so the grid this check reads is not in the page; the model did not call present for '
        + files.join(' and '),
      evidence,
    }
  }
  if (numberAt(card, 'changedCards') === 0) {
    return {
      id: 'layout.deliverables-card',
      status: 'fail',
      detail: 'the turn rendered no changed-files card, so the turn it closed left no recorded file change behind',
      evidence,
    }
  }
  if (!named) {
    return {
      id: 'layout.deliverables-card',
      status: 'fail',
      detail: 'the changed-files card does not name ' + files.join(' or ') + '; it reads "' + String(changedText).slice(0, 160) + '"',
      evidence,
    }
  }
  const marked = booleanAt(card, 'containerNarrow') === true
  if (side === 'narrow') {
    if (marked && tracks.length === 1) {
      return {
        id: 'layout.deliverables-card',
        status: 'pass',
        detail: 'at the narrow viewport the deliveries container carries data-narrow and its grid computes one column (' + String(columns) + ')',
        evidence,
      }
    }
    return {
      id: 'layout.deliverables-card',
      status: 'fail',
      detail: 'at the narrow viewport the deliveries container must carry data-narrow and compute one column; read data-narrow=' + String(marked)
        + ', grid-template-columns=' + String(columns) + ' (' + String(tracks.length) + ' track(s))',
      evidence,
    }
  }
  if (!marked && tracks.length === 2) {
    return {
      id: 'layout.deliverables-card',
      status: 'pass',
      detail: 'at the wide viewport the deliveries container carries no marker and its grid computes two columns (' + String(columns) + ')',
      evidence,
    }
  }
  return {
    id: 'layout.deliverables-card',
    status: 'fail',
    detail: 'at the wide viewport the deliveries container must carry no marker and compute two columns; read data-narrow=' + String(marked)
      + ', grid-template-columns=' + String(columns) + ' (' + String(tracks.length) + ' track(s))'
      + (textAt(card, 'single') === 'true' ? '; the row marks itself data-single, which collapses it to one column at every width' : ''),
    evidence,
  }
}

/**
 * Whether the workspace-files pane rendered the PDF the model wrote.
 *
 * A preview that claimed the address is not a rendered document: its state is
 * text from the moment a body was elected, so the fact read here is the PDF
 * body's own report and the canvases it painted. A body that refused the bytes
 * says so through its own failure line, which is carried into the evidence.
 * @param reading - probe payload carrying the mounted previews.
 * @param attempt - what opening the file in the pane reported.
 * @param fileName - the PDF this check opened.
 * @returns the check outcome.
 */
function pdfPreviewCheck(reading: PageReading, attempt: FileOpenAttempt, fileName: string): CheckOutcome {
  const preview = reading.previews.find(candidate => candidate.tab !== null && candidate.tab === attempt.tab)
    ?? [...reading.previews].reverse().find(candidate => candidate.url !== null && candidate.url.endsWith('/' + fileName))
  const evidence = {
    opened: attempt.opened,
    reason: attempt.reason,
    tab: attempt.tab,
    file: fileName,
    previews: reading.previews.map(entry => ({
      state: entry.state, url: entry.url, renderer: entry.renderer, tab: entry.tab, shown: entry.shown,
      pdf: entry.pdf, pdfPages: entry.pdfPages, canvases: entry.canvases, ink: entry.ink,
      canvasSize: entry.canvasSize, surfaceHidden: entry.surfaceHidden, alert: entry.alert,
    })),
  }
  if (!attempt.opened) {
    return {
      id: 'preview.pdf',
      status: 'absent',
      detail: 'the lane could not open ' + fileName + ' in the workspace-files pane: ' + (attempt.reason ?? 'the page reported no reason'),
      evidence,
    }
  }
  if (preview === undefined) {
    return {
      id: 'preview.pdf',
      status: 'absent',
      detail: 'the document preview of ' + fileName + ' is not in the page after opening it',
      evidence,
    }
  }
  if (preview.state !== 'text') {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the preview states data-textpreview-state=' + String(preview.state)
        + ', so it is still loading or has no resource rather than a rendered document',
      evidence,
    }
  }
  if (preview.renderer === null || !preview.renderer.endsWith('/pdf')) {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the preview rendered ' + fileName + ' through ' + String(preview.renderer) + ' instead of the PDF renderer',
      evidence,
    }
  }
  if (preview.alert !== null) {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the PDF body refused ' + fileName + ' and renders its own failure line instead of the document: "' + preview.alert + '"',
      evidence,
    }
  }
  if (!preview.pdf || preview.canvases === 0) {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the PDF renderer claimed ' + fileName + ' but painted no page',
      evidence,
    }
  }
  if (preview.surfaceHidden !== false) {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the PDF page of ' + fileName + ' is still in its rendering state: the pane holds a placeholder'
        + (preview.surfaceHidden === null ? ' and no page surface at all' : ' and its page surface stays hidden'),
      evidence,
    }
  }
  if (preview.ink === null || preview.ink === 0) {
    return {
      id: 'preview.pdf',
      status: 'fail',
      detail: 'the PDF renderer mounted ' + String(preview.canvases) + ' canvas(es) for ' + fileName
        + ' that carry no ink, so the page was never drawn on (dark pixels sampled: ' + String(preview.ink)
        + ', canvas ' + String(preview.canvasSize) + ')',
      evidence,
    }
  }
  return {
    id: 'preview.pdf',
    status: 'pass',
    detail: 'the workspace-files pane opened ' + fileName + ' and its PDF renderer painted ' + String(preview.canvases)
      + ' canvas(es) across ' + String(preview.pdfPages) + ' page element(s), carrying ' + String(preview.ink) + ' sampled dark pixels',
    evidence,
  }
}

/**
 * Report one check the run could not reach.
 * @param id - check id.
 * @param detail - why it could not run.
 * @returns an unreadable outcome.
 */
function unreachable(id: string, detail: string): CheckOutcome {
  return { id, status: 'absent', detail }
}

/** Ids the model steps own, in report order. */
const MODEL_CHECK_IDS = ['model.streaming-round-trip', 'layout.deliverables-card', 'preview.pdf'] as const

/**
 * Run the keyed, real-model checks against one server page.
 * @param page - page operations.
 * @param options - the run's fixed inputs.
 * @returns one outcome per model check, in report order.
 */
export async function runModelSteps(page: StepPage, options: ModelStepOptions): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  const opened = await startModelSession(page, options)
  if (!opened.started) {
    const detail = 'the lane could not open a Session to type into: ' + String(opened.reason)
    for (const id of MODEL_CHECK_IDS) outcomes.push(unreachable(id, detail))
    return outcomes
  }

  const streamed = await runTurn(page, STREAM_PROMPT, options)
  outcomes.push(streamingRoundTripCheck(streamed))
  if (streamed.record !== null && streamed.record.errorText !== null) {
    // A refused key or a failed request fails every later turn the same way, so
    // the run stops here and says what the turn's own notice said.
    const detail = 'the model turn ended on its own error notice, so the lane stopped: ' + streamed.record.errorText.slice(0, 200)
    outcomes.push(unreachable('layout.deliverables-card', detail))
    outcomes.push(unreachable('preview.pdf', detail))
    return outcomes
  }

  const wrote = await runTurn(page, DELIVERABLES_PROMPT, options)
  const presence = await awaitCards(page, options)
  if (presence.changed === 0 || presence.rows === 0) {
    const detail = 'the turn that was asked to write ' + DELIVERABLE_FILES.join(' and ') + ' and declare them left '
      + (presence.changed === 0 ? 'no changed-files card' : 'no declared-deliveries row') + ' in the page'
    outcomes.push({
      id: 'layout.deliverables-card',
      status: 'fail',
      detail,
      evidence: {
        changed: presence.changed,
        rows: presence.rows,
        turnText: wrote.record === null || wrote.record.last === null ? null : wrote.record.last.text.slice(0, 300),
        flowText: presence.flowText,
      },
    })
  } else {
    await setViewport(page, options.narrowWidth, options)
    outcomes.push(deliverablesCardCheck(await readPage(page), 'narrow', DELIVERABLE_FILES))
    await setViewport(page, options.wideWidth, options)
    await page.shot('04-deliverables-wide.png')
    outcomes.push(deliverablesCardCheck(await readPage(page), 'wide', DELIVERABLE_FILES))
  }

  const pdf = await runTurn(page, PDF_PROMPT, options)
  if (pdf.record !== null && pdf.record.errorText !== null) {
    outcomes.push(unreachable('preview.pdf', 'the model turn ended on its own error notice: ' + pdf.record.errorText.slice(0, 200)))
    return outcomes
  }
  const attempt = await openModelFile(page, PDF_FILE, options)
  if (attempt.opened) await awaitPdfBody(page, PDF_FILE, options)
  outcomes.push(pdfPreviewCheck(await readPage(page), attempt, PDF_FILE))
  await page.shot('05-pdf-preview.png')
  return outcomes
}

/**
 * Set one emulated viewport and let the client lay out for it.
 * @param page - page operations.
 * @param width - viewport width in CSS pixels.
 * @param options - the run's fixed inputs.
 */
async function setViewport(page: StepPage, width: number, options: ModelStepOptions): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: options.viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.sleep(options.settleMs)
}

/**
 * Wait until the pane's PDF body has either painted the document or refused it.
 *
 * The renderer is a lazy chunk that parses the bytes after the pane opened, so
 * a reading taken the instant the tab mounts reports a body that has not
 * decided yet. This waits for that decision and never decides it itself.
 * @param page - page operations.
 * @param fileName - basename of the file the pane opened.
 * @param options - the run's fixed inputs.
 */
async function awaitPdfBody(page: StepPage, fileName: string, options: ModelStepOptions): Promise<void> {
  const deadline = Date.now() + options.gestureTimeoutMs
  let previous: string | null = null
  for (;;) {
    const raw = await page.evaluate(pdfBodyExpression(fileName))
    const reading = typeof raw === 'string' ? raw : ''
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
    // The body can mount its pages and fail behind them a moment later, so a
    // decision is only read once the same one has been there for a full quiet
    // window: the failure the body renders is a fact this check must not miss.
    // A painted page is the decision this waits for: the canvas mounts before
    // the renderer draws on it, so a canvas alone is not a rendered document.
    const decided = isJsonObject(parsed)
      && (parsed.surfaceHidden === false && (numberAt(parsed, 'ink') ?? 0) > 0
        || textAt(parsed, 'alert') !== null || textAt(parsed, 'state') === 'unsupported')
    if (decided && reading === previous) return
    previous = decided ? reading : null
    if (Date.now() >= deadline) return
    await page.sleep(options.settleMs)
  }
}

/**
 * Open a workspace file the model wrote, asking the pane to reread its listing once.
 * @param page - page operations.
 * @param fileName - basename of the file to open.
 * @param options - the run's fixed inputs.
 * @returns what the gesture reported the second time it ran.
 */
async function openModelFile(page: StepPage, fileName: string, options: ModelStepOptions): Promise<FileOpenAttempt> {
  const first = fileOpenAttempt(await page.evaluate(openWorkspaceFileExpression(fileName, undefined, options.gestureTimeoutMs)))
  if (first.opened) return first
  await page.evaluate(RELOAD_FILES)
  return fileOpenAttempt(await page.evaluate(openWorkspaceFileExpression(fileName, undefined, options.gestureTimeoutMs)))
}
