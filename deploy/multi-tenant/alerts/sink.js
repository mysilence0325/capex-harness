/**
 * Alert receiver: writes what Alertmanager delivers, so alerts stop being dropped.
 *
 * This deployment has no mail server or alert platform of its own, and Alertmanager
 * with an empty receiver accepts alerts and discards them. That is the worst possible
 * state: the rules run, Prometheus evaluates them, alerts arrive, and nobody ever
 * learns. This writes each one to a file and to its container's log, which makes the
 * chain visible and testable. Pointing it at a real destination is one line in
 * alertmanager.yml.
 *
 * @module mt/alerts/sink
 */

'use strict'

const fs = require('node:fs')
const http = require('node:http')

/** Where received alerts are appended. Mounted from the deployment's state directory. */
const FILE = process.env.MT_ALERT_SINK_FILE ?? '/data/alerts.jsonl'

/** Port Alertmanager posts to. */
const PORT = Number(process.env.MT_ALERT_SINK_PORT ?? 9110)

/**
 * Reduce one Alertmanager webhook payload entry to the fields worth keeping.
 *
 * The payload carries the full label and annotation sets; the ones recorded here are
 * the ones a person reads first. The raw payload is not kept, so this is lossy on
 * purpose — a log nobody parses is worse than a smaller one somebody does.
 *
 * @param alert - one entry from the webhook body.
 * @returns the record to append.
 */
function record(alert) {
  return {
    receivedAt: new Date().toISOString(),
    status: alert?.status,
    name: alert?.labels?.alertname,
    severity: alert?.labels?.severity,
    instance: alert?.labels?.instance,
    job: alert?.labels?.job,
    tenant: alert?.labels?.tenant,
    node: alert?.labels?.node,
    summary: alert?.annotations?.summary,
    description: alert?.annotations?.description,
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const alert of list) {
        const line = JSON.stringify(record(alert))
        fs.appendFileSync(FILE, `${line}\n`)
        // Also on stdout, so `docker logs` shows alerts as they arrive.
        console.log(`ALERT ${line}`)
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    } catch (error) {
      // A payload this cannot parse is not worth failing the request over: Alertmanager
      // would retry it forever. Record the fact and accept it.
      console.error(`unparsable alert payload: ${error.message}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":false,"reason":"unparsable"}')
    }
  })
})

server.listen(PORT, '0.0.0.0', () => {
  fs.mkdirSync(require('node:path').dirname(FILE), { recursive: true })
  console.log(`alert sink listening on ${String(PORT)}, appending to ${FILE}`)
})
