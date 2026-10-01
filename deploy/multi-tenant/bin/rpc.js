/**
 * Call one DSH Remote method through the control plane, using the cookies curl
 * stored during login and activation.
 *
 * Usage:
 *   node bin/rpc.js --base http://127.0.0.1:8090 --jar /tmp/jar \
 *        --method session/modelCatalog [--args '{"sessionId":"..."}']
 *
 * Prints the RPC `result` as JSON. Exits non-zero when the call fails, unless
 * --allow-error is passed (then the failure is printed and exit stays 0).
 */

'use strict'

const fs = require('node:fs')
const http = require('node:http')

function parseArgs(argv) {
  const out = { base: 'http://127.0.0.1:8090', jar: '', method: '', args: '{}', allowError: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--allow-error') { out.allowError = true; continue }
    const key = token.replace(/^--/u, '')
    if (!['base', 'jar', 'method', 'args'].includes(key)) throw new Error(`unknown flag ${token}`)
    out[key] = argv[index + 1]
    index += 1
  }
  if (out.method === '') throw new Error('--method is required')
  return out
}

/** Netscape cookie jar → one Cookie header value. */
function jarCookies(file) {
  const pairs = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const fields = line.replace(/^#HttpOnly_/u, '').split('\t')
    if (fields.length < 7) continue
    pairs.push(`${fields[5]}=${fields[6]}`)
  }
  return pairs.join('; ')
}

function call({ base, jar, method, args }) {
  const url = new URL(`/api/${method}`, base)
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `accept-${String(Date.now())}`,
    method,
    payload: { args: JSON.parse(args) },
  })
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(jar === '' ? {} : { cookie: jarCookies(jar) }),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${String(response.statusCode)}: ${text.slice(0, 300)}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`unparsable response (${error.message}): ${text.slice(0, 300)}`))
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

const options = parseArgs(process.argv.slice(2))
call(options).then((envelope) => {
  const result = envelope?.result
  if (result?.ok === true) {
    console.log(JSON.stringify(result.value))
    return
  }
  console.log(JSON.stringify(result ?? envelope))
  if (!options.allowError) process.exitCode = 1
}).catch((error) => {
  console.error(String(error.message ?? error))
  process.exitCode = 1
})
