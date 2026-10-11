/**
 * Check one entry URL the way a browser uses it.
 *
 * Run it against the deployment's own public entry, and — the reason it exists —
 * against the front proxy's sub-path (`https://officeai.301.avic:496/ai/harness/`).
 * Only the deployment's own checks can pass while the proxy is misconfigured:
 * a preserved `Host` without its port, an upgrade that is not forwarded, or a
 * bare mount the proxy does not normalize all show up here and nowhere else.
 *
 * Usage:
 *   bin/mt.sh mount-check https://officeai.301.avic:496/ai/harness/ [--insecure]
 *   bin/mt.sh mount-check https://officeai.301.avic:496/ai/harness/ --tenant alpha
 *   bin/mt.sh mount-check https://officeai.301.avic:496/ai/harness/ --key-user alice
 *
 * Without `--tenant` it checks addressing only, and needs no credentials: the
 * bare mount, where the login form posts, whether POST survives the proxy, the
 * console's document base, and whether the proxy forwards WebSocket upgrades.
 * With `--tenant <id>` it signs that tenant in — reading the password from the
 * credentials file `bin/acceptance.sh` already uses, never from the command
 * line — and follows the browser through to its own DSH: the shell document,
 * one RPC call, and the Remote stream's upgrade.
 *
 * `--key-user <name>` sends the USB-Key identity cookie a real browser would
 * arrive with, so the passwordless path can be measured from here instead of
 * from a browser: the login must answer 303, the entry must then serve that
 * tenant's DSH, and the same endpoint without the cookie must refuse. Set
 * `--key-cookie <name>` when the deployment renamed the identity cookie.
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const insecure = argv.includes('--insecure')
const readFlag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const tenantId = readFlag('--tenant')
const userOverride = readFlag('--user')
const keyUser = readFlag('--key-user')
const keyCookieName = readFlag('--key-cookie') ?? 'KOAL_CERT_E'
/** Positional arguments, ignoring each flag's value. */
const positional = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--tenant' || arg === '--user' || arg === '--key-user' || arg === '--key-cookie') { index += 1; continue }
  if (!arg.startsWith('--')) positional.push(arg)
}
const entry = positional[0]
if (entry === undefined) {
  console.error('用法: node bin/mount-check.mjs <入口 URL> [--insecure] [--tenant <租户>] [--user <用户名>] [--key-user <用户名>] [--key-cookie <名>]')
  process.exit(2)
}

const target = new URL(entry)
const mount = target.pathname.replace(/\/+$/u, '')
const origin = target.origin
const transport = target.protocol === 'https:' ? https : http

let pass = 0
let fail = 0
function ck(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS ${label}${detail === undefined ? '' : `（${detail}）`}`) } else { fail += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : `：${detail}`}`) }
}

/** Cookies this run has collected, so the signed-in phase carries the session. */
const jar = new Map()
function absorb(headers) {
  const raw = headers['set-cookie'] ?? []
  for (const line of Array.isArray(raw) ? raw : [raw]) {
    const pair = line.split(';')[0]
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}

/** One request; resolves on response, and on an upgrade when asked for one. */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: {
        ...(options.headers ?? {}),
        ...(options.noCookies === true || jar.size === 0
          ? {}
          : { cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ') }),
      },
      rejectUnauthorized: !insecure,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        absorb(res.headers)
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    if (options.upgrade === true) {
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve({ status: res.statusCode, headers: res.headers, body: '' })
      })
    }
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** Where a browser would go after resolving one reference in a page. */
const resolved = (page, reference) => new URL(reference, page)
const formAction = (html) => /<form[^>]*action="([^"]+)"/u.exec(html)?.[1]
const consoleBase = (html) => /<base href="([^"]+)"/u.exec(html)?.[1]

console.log(`入口: ${entry}`)
console.log(`挂载前缀: ${mount === '' ? '（根路径）' : mount}\n`)

// 1. 裸前缀（无尾斜杠）必须走到带斜杠的形式：页面的相对地址按目录解析，
//    少了斜杠整页资源都会解析到上一级。
if (mount !== '') {
  const bare = await request(new URL(mount, origin))
  ck('裸前缀规范化到带斜杠', bare.status === 301 || bare.status === 308 || bare.status === 302, `HTTP ${String(bare.status)}`)
}

// 2. 入口页：未登录时是租户登录页，且表单提交地址解析后仍在挂载点下
const entryUrl = new URL(`${mount}/`, origin)
const page = await request(entryUrl)
ck('入口返回 200', page.status === 200, `HTTP ${String(page.status)}`)
ck('入口是租户登录页', page.body.includes('name="password"'))
const action = formAction(page.body)
const actionUrl = action === undefined ? undefined : resolved(entryUrl, action).toString()
ck('登录表单提交到挂载点之下', actionUrl === `${origin}${mount}/__mt/login`, actionUrl ?? '（页面里没有表单）')

// 3. POST 也要过：有的代理会把 POST 变成 GET 或丢掉 body。
if (actionUrl !== undefined) {
  const denied = await request(new URL(actionUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: 'mount-check', password: 'not-a-password' }).toString(),
  })
  ck('口令错误的登录被拒（401）', denied.status === 401, `HTTP ${String(denied.status)}`)
  ck('拒绝后仍是登录页', denied.body.includes('name="password"'))
}

// 4. 控制台：页内相对地址（它靠 <base> 解析）必须落在挂载点之下
const adminUrl = new URL(`${mount}/__mt/admin`, origin)
const admin = await request(adminUrl)
ck('控制台页面返回 200', admin.status === 200, `HTTP ${String(admin.status)}`)
ck('控制台 <base> 在挂载点之下', consoleBase(admin.body) === `${mount}/__mt/admin/`, consoleBase(admin.body) ?? '（页面里没有 base）')
const adminAction = formAction(admin.body)
ck('控制台登录表单在挂载点之下',
  adminAction !== undefined && resolved(adminUrl, adminAction).pathname === `${mount}/__mt/admin/login`,
  adminAction ?? '（页面里没有表单）')

// 5. WebSocket：DSH 的会话流全靠它，而代理默认不转发 Upgrade。
//    转发时升级处理器先答 401（没有会话）；没转发时请求落到普通路由，答 303。
const upgrade = await request(new URL(`${mount}/api/remote.mux`, origin), {
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  },
})
ck('代理转发了 WebSocket 升级（401=转到升级处理器）', upgrade.status === 401,
  `HTTP ${String(upgrade.status)}${upgrade.status === 303 ? '（303 说明 Upgrade 没被转发：会话流会连不上）' : ''}`)

// 6. 带一个租户的真实会话走到底：登录 -> 自己的 DSH -> 调一次 API -> 开会话流。
//    凭据从 bin/acceptance.sh 用的那个文件读，不放命令行（命令行会进 ps 与历史）。
if (tenantId !== undefined) {
  console.log(`\n-- 租户 ${tenantId} 的完整会话 --`)
  const credentialsFile = process.env.MT_CREDENTIALS_FILE ?? '.acceptance-credentials.json'
  let account
  try {
    account = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).tenants?.[tenantId]
  } catch {
    account = undefined
  }
  if (account?.password === undefined) {
    ck(`读到 ${tenantId} 的凭据`, false, `${credentialsFile} 里没有 tenants.${tenantId}.password`)
  } else {
    const user = userOverride ?? account.user
    const login = await request(new URL(`${mount}/__mt/login`, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tenant: tenantId, user, password: account.password }).toString(),
      noCookies: true,
    })
    ck('子路径下登录返回 303', login.status === 303, `HTTP ${String(login.status)}`)
    ck('登录后跳回挂载点', login.headers.location === `${mount}/`, String(login.headers.location))

    const app = await request(entryUrl)
    ck('已登录时同一地址直接进自己的 DSH', app.status === 200, `HTTP ${String(app.status)}`)
    ck('DSH 文档带 <base href="./">', app.body.includes('<base href="./">'))
    ck('DSH 资源是相对地址', /src="\.\/assets\//u.test(app.body))
    ck('DSH 文档没有根绝对资源地址', !/src="\/assets\//u.test(app.body))

    const rpc = await request(new URL(`${mount}/api/account/getState`, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'mount-check-1', method: 'account/getState', payload: { args: {} } }),
    })
    ck('DSH RPC 返回服务端响应', rpc.status === 200 && rpc.body.includes('"type":"server-response"'), `HTTP ${String(rpc.status)}`)

    const stream = await request(new URL(`${mount}/api/remote.mux`, origin), {
      upgrade: true,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    ck('带会话的 Remote 流完成升级', stream.status === 101, `HTTP ${String(stream.status)}`)
  }
}

// 7. USB Key 免口令登录：模拟身份网关已经注入的那条 cookie。
if (keyUser !== undefined) {
  console.log(`\n-- Key 免口令登录（${keyCookieName}=${keyUser}）--`)
  const denied = await request(new URL(`${mount}/__mt/key-login`, origin), {})
  ck('没有 Key 身份时拒绝（401）', denied.status === 401, `HTTP ${String(denied.status)}`)

  const login = await request(new URL(`${mount}/__mt/key-login`, origin), {
    headers: { cookie: `${keyCookieName}=${keyUser}` },
    noCookies: true,
  })
  ck('带 Key 身份登录返回 303', login.status === 303, `HTTP ${String(login.status)}`)
  ck('登录后跳回挂载点', login.headers.location === `${mount}/`, String(login.headers.location))

  const app = await request(entryUrl)
  ck('同一地址直接进入自己的 DSH', app.status === 200, `HTTP ${String(app.status)}`)
  ck('DSH 文档带 <base href="./">', app.body.includes('<base href="./">'))

  // 用户名只能来自 cookie：查询参数不许换人。
  const forged = await request(new URL(`${mount}/__mt/key-login?user=mount-check`, origin), {})
  ck('查询参数里的用户名不作数', forged.status === 401, `HTTP ${String(forged.status)}`)
}

console.log(`\n== 入口检查：${pass} 通过 / ${fail} 失败 ==`)
process.exit(fail === 0 ? 0 : 1)
