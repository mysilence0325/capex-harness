/**
 * Minimal HTTP client for the operations scripts.
 *
 * `bin/mt.sh` used to shell out to curl, which is not always there: the node
 * agent's container has no curl and cannot install one, and a host curl is
 * commonly linked against distribution-specific TLS libraries. Node is always
 * present — the scripts already use it for every registry and render step — so
 * they use this instead.
 *
 * Usage:
 *   node bin/http.js <METHOD> <URL> [--header 'Name: value']... [--data <body>]
 *                    [--status] [--max-time <seconds>] [--insecure]
 *
 * Prints the response body, or only the status code with --status. Exits non-zero
 * when the request fails, or when --fail is given and the status is >= 400.
 *
 * @module mt/bin/http
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('usage: node bin/http.js <METHOD> <URL> [--header K:V] [--data body] [--status] [--max-time s] [--insecure] [--fail]')
  process.exit(2)
}

const method = args[0].toUpperCase()
const target = args[1]
const headers = {}
let body
let statusOnly = false
let failOnError = false
let maxTime = 15
let insecure = false

for (let index = 2; index < args.length; index += 1) {
  const flag = args[index]
  if (flag === '--header') {
    index += 1
    const raw = args[index] ?? ''
    const colon = raw.indexOf(':')
    if (colon > 0) headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim()
  } else if (flag === '--data') {
    index += 1
    body = args[index] ?? ''
  } else if (flag === '--status') {
    statusOnly = true
  } else if (flag === '--fail') {
    failOnError = true
  } else if (flag === '--max-time') {
    index += 1
    maxTime = Number(args[index] ?? '15')
  } else if (flag === '--insecure') {
    insecure = true
  } else if (flag === '--cacert') {
    index += 1
    const path = args[index]
    if (path !== undefined && fs.existsSync(path)) headers['x-mt-ca'] = path
  }
}

let url
try {
  url = new URL(target)
} catch {
  console.error(`http: not a URL: ${target}`)
  process.exit(2)
}

const caPath = headers['x-mt-ca']
delete headers['x-mt-ca']
const transport = url.protocol === 'https:' ? https : http
const request = transport.request({
  host: url.hostname,
  port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
  method,
  path: `${url.pathname}${url.search}`,
  headers: body === undefined
    ? headers
    : { ...headers, 'content-length': Buffer.byteLength(body) },
  agent: false,
  timeout: maxTime * 1000,
  ...(url.protocol === 'https:' && insecure ? { rejectUnauthorized: false } : {}),
  ...(url.protocol === 'https:' && caPath !== undefined ? { ca: fs.readFileSync(caPath) } : {}),
}, (response) => {
  const chunks = []
  response.on('data', (chunk) => chunks.push(chunk))
  response.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    if (statusOnly) process.stdout.write(String(response.statusCode))
    else process.stdout.write(text)
    const failed = (response.statusCode ?? 0) >= 400
    process.exit(failOnError && failed ? 1 : 0)
  })
})
request.on('timeout', () => { request.destroy(new Error('timeout')) })
request.on('error', (error) => {
  console.error(`http: ${error.message}`)
  process.exit(1)
})
request.end(body)
