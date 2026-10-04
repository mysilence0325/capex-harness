/**
 * Page-side probe for the Chromium 90 browser-floor lane.
 *
 * The driver evaluates this file as an expression with the floor's API list as
 * its only argument: "(<this file>)(["Object.hasOwn", ...])". It is page source
 * rather than a module, so it must stay parseable by the engine under test and
 * must not call the APIs the floor installs; a probe that did would report a
 * broken install by throwing instead of by reading it.
 */
((floorApis) => {
  const NATIVE_SOURCE = /\{\s*\[native code\]\s*\}/
  // A rendered document is far longer than the fact the preview check reads
  // from it, so the payload carries a capped prefix.
  const PREVIEW_TEXT_LIMIT = 4000
  const css = (element, property) => element === null ? null : getComputedStyle(element).getPropertyValue(property)
  const contentWidth = (element) => {
    if (element === null) return null
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return Math.round(box.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0))
  }
  const resolveApi = (path) => {
    const parts = path.split('.')
    let owner = globalThis
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (owner === null || owner === undefined) break
      owner = owner[parts[index]]
    }
    const value = (owner === null || owner === undefined) ? undefined : owner[parts[parts.length - 1]]
    const present = value !== undefined && value !== null
    let native = null
    if (present && typeof value === 'function') {
      try {
        native = NATIVE_SOURCE.test(Function.prototype.toString.call(value))
      } catch (error) {
        native = null
      }
    }
    return { name: path, present: present, kind: typeof value, native: native }
  }

  const shell = document.querySelector('[data-conversation-shell]')
  const scrollport = document.querySelector('[class*="_scrollBody"]')

  // The composer control row is the only parent of both control groups.
  const trailingGroups = Array.prototype.slice.call(document.querySelectorAll('[class*="_trailing"]'))
  let composerRow = null
  for (let index = 0; index < trailingGroups.length; index += 1) {
    const parent = trailingGroups[index].parentElement
    if (parent !== null && parent.querySelector('[class*="_tools"]') !== null) {
      composerRow = parent
      break
    }
  }
  const composer = composerRow === null ? null : {
    className: String(composerRow.className),
    contentWidth: contentWidth(composerRow),
    narrow: composerRow.hasAttribute('data-narrow'),
    tight: composerRow.hasAttribute('data-tight'),
    toolsGap: css(composerRow.querySelector('[class*="_tools"]'), 'column-gap'),
    trailingGap: css(composerRow.querySelector('[class*="_trailing"]'), 'column-gap'),
  }

  const titleRow = document.querySelector('header [class*="_titleRow"]')
  const title = titleRow === null ? null : {
    className: String(titleRow.className),
    contentWidth: contentWidth(titleRow),
    narrow: titleRow.hasAttribute('data-narrow'),
    tight: titleRow.hasAttribute('data-tight'),
  }

  // The rail band is the marked element. Its marks are read through the
  // virtualizer's own container, because the marked band hides the frame and a
  // hidden scrollport renders no mark buttons.
  const markCount = document.querySelectorAll('button[data-index]').length
  const marksContainer = document.querySelector('[class*="_marks"]')
  let frame = null
  if (marksContainer !== null && marksContainer.parentElement !== null) frame = marksContainer.parentElement.parentElement
  if (frame === null) {
    const firstMark = document.querySelector('button[data-index]')
    if (firstMark !== null) frame = firstMark.closest('[class*="_frame"]')
  }
  const band = frame === null ? null : frame.parentElement
  const rail = {
    marks: markCount,
    bandClassName: band === null ? null : String(band.className),
    bandNarrow: band === null ? null : band.hasAttribute('data-narrow'),
    bandWidth: band === null ? null : Math.round(band.getBoundingClientRect().width),
    frameDisplay: frame === null ? null : css(frame, 'display'),
  }

  // The event column is a <col>, whose computed width is 0px whatever the rule,
  // so the compact state is read from the kind label the marked pane collapses.
  const pane = document.querySelector('[class*="_tablePane"]')
  const kindLabel = document.querySelector('[class*="_kindTagLabel"]')
  const trajectory = pane === null ? null : {
    className: String(pane.className),
    width: Math.round(pane.getBoundingClientRect().width),
    narrow: pane.hasAttribute('data-narrow'),
    kindLabelOpacity: css(kindLabel, 'opacity'),
    kindLabelMaxWidth: css(kindLabel, 'max-width'),
  }

  const scroller = scrollport === null ? null : {
    className: String(scrollport.className),
    overflowY: css(scrollport, 'overflow-y'),
    clientWidth: scrollport.clientWidth,
    offsetWidth: scrollport.offsetWidth,
    scrollHeight: scrollport.scrollHeight,
    clientHeight: scrollport.clientHeight,
    composerOverlay: shell !== null && shell.hasAttribute('data-composer-overlay'),
  }

  // Every mounted document preview states what it is showing, and the tab that
  // holds it: the lane reads the one its own click opened. A preview that never
  // reached a document carries no body, so its own status text is what gets read.
  const previews = []
  const previewNodes = document.querySelectorAll('[data-textpreview-state]')
  for (let index = 0; index < previewNodes.length; index += 1) {
    const node = previewNodes[index]
    const body = node.querySelector('[data-textpreview-body]')
    const text = (body === null ? node : body).textContent || ''
    const host = node.closest('[data-sidebar-right-tab]')
    // A renderer that claimed the address is not a rendered document: the PDF
    // body reports itself once its own bytes parsed, and its failure line is
    // the only thing a reader gets when they did not.
    const pdfBody = node.querySelector('[data-pdf-preview]')
    const surface = node.querySelector('[data-document-zoom-surface]')
    const alert = node.querySelector('[role="alert"]')
    // A canvas element is not a painted page: every fourth pixel states whether
    // the renderer put ink on it.
    let ink = null
    let canvasSize = null
    const canvases = node.querySelectorAll('canvas')
    for (let canvasIndex = 0; canvasIndex < canvases.length; canvasIndex += 1) {
      const canvas = canvases[canvasIndex]
      try {
        const context = canvas.getContext('2d')
        if (context === null || canvas.width === 0 || canvas.height === 0) continue
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0
        for (let pixel = 0; pixel + 3 < pixels.length; pixel += 16) {
          if (pixels[pixel + 3] > 32 && (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3 < 200) dark += 1
        }
        ink = ink === null ? dark : Math.max(ink, dark)
        canvasSize = String(canvas.width) + 'x' + String(canvas.height)
      } catch (error) {
        ink = null
      }
    }
    previews.push({
      state: node.getAttribute('data-textpreview-state'),
      url: node.getAttribute('data-textpreview-url'),
      renderer: node.getAttribute('data-document-preview'),
      tab: host === null ? null : host.getAttribute('data-sidebar-right-tab'),
      shown: node.closest('[hidden]') === null,
      body: body !== null,
      textLength: text.length,
      text: text.slice(0, PREVIEW_TEXT_LIMIT),
      pdf: pdfBody !== null,
      pdfPages: pdfBody === null ? 0 : pdfBody.childElementCount,
      canvases: canvases.length,
      ink: ink,
      canvasSize: canvasSize,
      surfaceHidden: surface === null ? null : surface.hasAttribute('hidden'),
      alert: alert === null ? null : (alert.textContent || '').slice(0, 200),
    })
  }

  // The closing turn's file sections: the changed-files card, and the declared
  // deliveries grid whose container states its own width. The newest card is
  // the one this run's turn wrote, so the readings take the last of each.
  const changedCards = document.querySelectorAll('[data-changed-files]')
  const changedCard = changedCards.length === 0 ? null : changedCards[changedCards.length - 1]
  const presentedRows = document.querySelectorAll('[data-presented-files-row]')
  const presentedRow = presentedRows.length === 0 ? null : presentedRows[presentedRows.length - 1]
  const presentedContainer = presentedRow === null ? null : presentedRow.parentElement
  const deliverables = {
    changedCards: changedCards.length,
    changedVisible: changedCard !== null && changedCard.closest('[hidden]') === null,
    changedText: changedCard === null ? null : (changedCard.innerText || changedCard.textContent || '').slice(0, 400),
    presentedRows: presentedRows.length,
    containerPresent: presentedContainer !== null,
    containerNarrow: presentedContainer === null ? null : presentedContainer.hasAttribute('data-narrow'),
    containerClass: presentedContainer === null ? null : String(presentedContainer.className),
    columns: presentedRow === null ? null : css(presentedRow, 'grid-template-columns'),
    columnsRows: presentedRow === null ? null : css(presentedRow, 'grid-template-rows'),
    single: presentedRow === null ? null : presentedRow.getAttribute('data-single'),
    cards: presentedRow === null ? 0 : presentedRow.childElementCount,
    text: presentedRow === null ? null : (presentedRow.innerText || presentedRow.textContent || '').slice(0, 400),
  }

  // The experimental agent-team header action states its own collapse through
  // the title row's data-tight, so the label's computed display is the fact.
  const teamRoot = document.querySelector('[data-team-action]')
  const teamLabel = teamRoot === null ? null : teamRoot.querySelector('[class*="_triggerLabel"]')
  const teamTrigger = {
    present: teamRoot !== null,
    labelDisplay: teamLabel === null ? null : css(teamLabel, 'display'),
    labelText: teamLabel === null ? null : (teamLabel.textContent || ''),
    icons: teamRoot === null ? 0 : teamRoot.querySelectorAll('svg').length,
  }

  // Container queries are read from the mounted stylesheets, where a
  // reintroduced @container would land. A shadow root's own sheets are outside
  // this walk, and a cross-origin sheet reports through unreadable.
  const containerRules = []
  const sources = []
  for (let index = 0; index < document.styleSheets.length; index += 1) sources.push(document.styleSheets[index])
  if (document.adoptedStyleSheets !== undefined) {
    for (let index = 0; index < document.adoptedStyleSheets.length; index += 1) sources.push(document.adoptedStyleSheets[index])
  }
  const scanRules = (rules, href) => {
    if (rules === undefined || rules === null) return
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      const text = rule.cssText || ''
      const isContainer = rule.constructor !== undefined && rule.constructor.name === 'CSSContainerRule'
      if (isContainer || text.indexOf('@container') === 0) containerRules.push({ href: href, text: text.slice(0, 160) })
      if (rule.cssRules !== undefined && rule.cssRules !== null) scanRules(rule.cssRules, href)
    }
  }
  let readable = 0
  let unreadable = 0
  for (let index = 0; index < sources.length; index += 1) {
    try {
      const rules = sources[index].cssRules
      readable += 1
      scanRules(rules, sources[index].href || '(inline)')
    } catch (error) {
      unreadable += 1
    }
  }

  let iteratorStatics = { global: 'undefined', from: 'undefined', prototypeMap: 'undefined' }
  if (typeof Iterator !== 'undefined') {
    iteratorStatics = { global: 'function', from: typeof Iterator.from, prototypeMap: typeof Iterator.prototype.map }
  }

  const apis = []
  for (let index = 0; index < floorApis.length; index += 1) apis.push(resolveApi(floorApis[index]))

  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    userAgent: navigator.userAgent,
    title: document.title,
    shell: { present: shell !== null, phase: shell === null ? null : shell.getAttribute('data-phase') },
    composer: composer,
    titleRow: title,
    rail: rail,
    trajectory: trajectory,
    scroller: scroller,
    previews: previews,
    deliverables: deliverables,
    teamTrigger: teamTrigger,
    containerQueries: {
      stylesheets: sources.length,
      readable: readable,
      unreadable: unreadable,
      count: containerRules.length,
      samples: containerRules.slice(0, 3),
    },
    floorApis: apis,
    iteratorStatics: iteratorStatics,
  })
})
