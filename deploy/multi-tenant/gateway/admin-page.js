/**
 * Administrator console pages.
 *
 * Server-rendered HTML with plain browser JavaScript and no build step, matching
 * the rest of the gateway: the console has to work on a control plane that was
 * deployed by copying files, with no toolchain on the host.
 *
 * @module mt/gateway/admin-page
 */

'use strict'

/** Shared stylesheet. Kept inline so the page has no request of its own. */
const STYLES = `
:root { color-scheme: light dark; --fg: #1f2328; --bg: #fff; --muted: #656d76; --line: #d0d7de;
  --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --accent: #0969da; --panel: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #8b949e;
  --line: #30363d; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #2f81f7; --panel: #161b22; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  color: var(--fg); background: var(--bg); }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
.sub { color: var(--muted); margin: 0 0 20px; }
table { border-collapse: collapse; width: 100%; margin-top: 4px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
code { background: var(--panel); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
button { font: inherit; padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--panel); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { opacity: .9; color: #fff; }
button.danger:hover { border-color: var(--bad); color: var(--bad); }
input { font: inherit; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--fg); }
.tag { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 12px; border: 1px solid; }
.tag.ok { color: var(--ok); border-color: var(--ok); }
.tag.warn { color: var(--warn); border-color: var(--warn); }
.tag.bad { color: var(--bad); border-color: var(--bad); }
.tag.muted { color: var(--muted); border-color: var(--line); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-top: 12px; }
.msg { margin-top: 12px; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); }
.msg.bad { border-color: var(--bad); color: var(--bad); }
.msg.ok { border-color: var(--ok); color: var(--ok); }
.wrap { max-width: 1100px; margin: 0 auto; }
.login { max-width: 340px; margin: 10vh auto; }
.login input { width: 100%; margin-bottom: 10px; }
.login button { width: 100%; }
.muted { color: var(--muted); }
`

/** Escape text for HTML context. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

/** One page shell. */
function shell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>
`
}

/**
 * Sign-in page.
 * @param options - page facts.
 * @param options.error - message to show, when the last attempt failed.
 * @param options.locked - seconds the caller must wait, when throttled.
 * @param options.configured - whether an administrator password exists yet.
 * @returns the HTML.
 */
function loginPage({ error, locked, configured }) {
  const notice = error === undefined ? '' : `<div class="msg bad">${escapeHtml(error)}</div>`
  const setup = configured ? '' : `<div class="msg">还没有设置管理员密码。在部署机上执行 <code>bin/mt.sh admin-passwd</code> 设置后再登录。</div>`
  return shell('管理控制台 · 登录', `<div class="wrap login">
<h1>DSH 多租户管理控制台</h1>
<p class="sub">仅管理员使用</p>
${locked !== undefined && locked > 0 ? `<div class="msg bad">尝试次数过多，请 ${String(locked)} 秒后再试。</div>` : ''}
${notice}
${setup}
<form method="post" action="login" class="card">
  <input name="user" placeholder="管理员用户名" value="admin" autocomplete="username" autofocus>
  <input name="password" type="password" placeholder="密码" autocomplete="current-password">
  <button class="primary" type="submit">登录</button>
</form>
</div>`)
}

/** Badge for one tenant's runtime state. */
function statusTag(entry) {
  if (entry === undefined) return '<span class="tag muted">未注册</span>'
  if (entry.ready === true) return '<span class="tag ok">运行中</span>'
  if (entry.hasToken === false) return '<span class="tag bad">缺启动 token</span>'
  if (entry.reachable === false) return '<span class="tag bad">连不上</span>'
  return '<span class="tag warn">未知</span>'
}

/**
 * Console page. The table is filled by the page's own script from
 * `/__mt/admin/api/state`, so status shown here is always live.
 * @param options - page facts.
 * @param options.user - the signed-in administrator.
 * @returns the HTML.
 */
function consolePage({ user }) {
  return shell('DSH 多租户管理控制台', `<div class="wrap">
<div class="row" style="justify-content: space-between">
  <div>
    <h1>DSH 多租户管理控制台</h1>
    <p class="sub">管理员 ${escapeHtml(user)} · 数据来自控制面实时状态</p>
  </div>
  <form method="post" action="logout"><button type="submit">退出</button></form>
</div>

<h2>租户</h2>
<table id="tenants">
  <thead><tr>
    <th>租户</th><th>状态</th><th>入口</th><th>用户</th><th>模型用量</th><th>操作</th>
  </tr></thead>
  <tbody><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
</table>
<div id="notice"></div>

<h2>新增租户</h2>
<div class="card">
  <div class="row">
    <input id="new-id" placeholder="租户 id（小写字母/数字/短横线）" size="30">
    <input id="new-user" placeholder="首个用户名" size="18">
    <input id="new-title" placeholder="显示名（可选）" size="22">
    <button class="primary" onclick="addTenant()">创建并开通</button>
  </div>
  <p class="muted" style="margin: 10px 0 0">创建后会为新租户生成 profile 配置与容器，通常需要十几秒。初始密码只显示一次。</p>
</div>

<script>
const $ = (id) => document.getElementById(id)
const notice = (text, bad) => {
  $('notice').className = 'msg ' + (bad ? 'bad' : 'ok')
  $('notice').textContent = text
}
const post = async (path, body) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return response.json()
}
const action = async (tenant, verb, extra) => {
  notice('正在执行 ' + verb + ' …')
  const answer = await post('api/tenant', Object.assign({ tenant, action: verb }, extra || {}))
  notice(answer.message || answer.error || (answer.ok ? '完成' : '失败'), answer.ok !== true)
  if (answer.password) notice(tenant + ' 的初始密码：' + answer.password + '（请立即保存，只显示这一次）', false)
  await load()
}
const resetPassword = async (tenant, user) => {
  if (!confirm('为 ' + tenant + '/' + user + ' 生成新密码？旧密码立即失效。')) return
  const answer = await post('api/tenant', { tenant, action: 'passwd', user })
  if (answer.password) notice(user + ' 的新密码：' + answer.password + '（请立即交给用户，只显示这一次）', false)
  else notice(answer.error || '失败', true)
  await load()
}
const removeTenant = async (tenant) => {
  const name = prompt('删除租户 ' + tenant + '。输入租户 id 确认；数据会保留在磁盘上。\\n\\n如需连数据一起删除，请改在部署机上执行 bin/mt.sh remove ' + tenant + ' --purge')
  if (name !== tenant) return
  notice('正在删除 ' + tenant + ' …')
  const answer = await post('api/tenant', { tenant, action: 'remove' })
  notice(answer.message || answer.error || '完成', answer.ok !== true)
  await load()
}
const addTenant = async () => {
  const id = $('new-id').value.trim()
  const user = $('new-user').value.trim()
  const title = $('new-title').value.trim()
  if (!id || !user) { notice('租户 id 与用户名都要填', true); return }
  notice('正在创建 ' + id + '，可能需要十几秒 …')
  const answer = await post('api/tenant', { tenant: id, action: 'add', user, title })
  if (answer.password) {
    notice('已创建 ' + id + '。初始密码：' + answer.password + '（只显示这一次，请立即保存）', false)
    $('new-id').value = ''; $('new-user').value = ''; $('new-title').value = ''
  } else notice(answer.error || '创建失败', true)
  await load()
}
async function load() {
  const response = await fetch('api/state')
  if (response.status === 401) { location.reload(); return }
  const data = await response.json()
  const rows = data.tenants.map((tenant) => {
    const usage = tenant.usage
    const usageText = usage && usage.calls > 0
      ? usage.calls + ' 次 · ' + usage.input + '/' + usage.output + ' tokens'
      : '<span class="muted">—</span>'
    const entry = tenant.edgePort ? tenant.origin + ':' + tenant.edgePort + '/'
      : tenant.hosts && tenant.hosts.length ? tenant.hosts[0] + ':' + data.edgePort + '/'
      : data.origin + ':' + data.edgePort + '/'
    const buttons = [
      '<button onclick="action(\\'' + tenant.id + '\\', \\'restart\\')">重启</button>',
      tenant.agent
        ? '<button onclick="action(\\'' + tenant.id + '\\', \\'stop\\')">停止</button>'
        : '<button disabled title="该租户不是通过节点代理注册的，无法在此操作容器">停止</button>',
      '<button onclick="resetPassword(\\'' + tenant.id + '\\', \\'' + tenant.users[0] + '\\')">改密码</button>',
      '<button class="danger" onclick="removeTenant(\\'' + tenant.id + '\\')">删除</button>',
    ].join(' ')
    const agentNote = tenant.agent ? '' : ' <span class="tag muted" title="没有节点代理，容器操作需在部署机上执行">无代理</span>'
    return '<tr>' +
      '<td><b>' + tenant.id + '</b><br><span class="muted">' + (tenant.title || '') + '</span></td>' +
      '<td>' + tenant.status + agentNote + '</td>' +
      '<td><code>' + entry + '</code></td>' +
      '<td>' + tenant.users.join(', ') + '</td>' +
      '<td>' + usageText + '</td>' +
      '<td class="row">' + buttons + '</td>' +
      '</tr>'
  })
  document.querySelector('#tenants tbody').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="6" class="muted">还没有租户</td></tr>'
}
load()
</script>
</div>`)
}

module.exports = { loginPage, consolePage, statusTag }
