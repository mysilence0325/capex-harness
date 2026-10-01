/**
 * Minimal OpenAI-compatible chat endpoint used by the acceptance test.
 *
 * It exists so the acceptance run can prove the whole chain — gateway login,
 * tenant runtime, admin-configured model catalog, prompt, streamed reply —
 * without depending on a real inference service. It always answers with a
 * fixed marker plus the text it received, so the test can assert both that a
 * reply arrived and that the prompt actually reached the model.
 *
 * Not part of the production stack: it is started only by `bin/mt.sh accept`.
 */

'use strict'

const http = require('node:http')

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 8080)
const MARKER = 'MULTITENANT-OK'
const MODELS = [
  { id: 'mock-cheap', object: 'model', owned_by: 'acceptance' },
  { id: 'mock-strong', object: 'model', owned_by: 'acceptance' },
]

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
        .join(' ')
    }
  }
  return ''
}

function replyFor(body, model) {
  const asked = lastUserText(body?.messages).replaceAll(/\s+/gu, ' ').trim().slice(0, 200)
  return `多租户验收通过：${MARKER}（模型 ${model}）。收到的问题：${asked === '' ? '(空)' : asked}`
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock.invalid')

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    sendJson(res, 200, { object: 'list', data: MODELS })
    return
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { error: { message: `invalid JSON body: ${error.message}` } })
        return
      }
      const created = Math.floor(Date.now() / 1000)
      const model = typeof body.model === 'string' ? body.model : MODELS[0].id
      const reply = replyFor(body, model)
      console.log(`chat/completions model=${model} stream=${String(body.stream === true)} messages=${String(Array.isArray(body.messages) ? body.messages.length : 0)}`)

      if (body.stream !== true) {
        sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const piece = (delta) => `data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`
      res.write(piece({ role: 'assistant' }))
      // Emit in a few pieces so the client exercises its own streaming path.
      const step = Math.max(1, Math.ceil(reply.length / 4))
      for (let at = 0; at < reply.length; at += step) {
        res.write(piece({ content: reply.slice(at, at + step) }))
      }
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }

  sendJson(res, 404, { error: { message: `no route for ${req.method ?? '?'} ${url.pathname}` } })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock model listening on :${String(PORT)} with models ${MODELS.map((m) => m.id).join(', ')}`)
})
