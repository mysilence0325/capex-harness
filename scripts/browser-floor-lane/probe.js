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
