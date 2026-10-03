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
      <input id="login-code" placeholder="验证码（开启 MFA 后必填）" size="18" inputmode="numeric" autocomplete="one-time-code">
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
function consolePage({ user, role }) {
  return shell('DSH 多租户管理控制台', `<div class="wrap">
<div class="row" style="justify-content: space-between">
  <div>
    <h1>DSH 多租户管理控制台</h1>
    <p class="sub">${role === 'admin' ? '管理员' : '只读账号'} ${escapeHtml(user)} · 数据来自控制面实时状态${role === 'admin' ? '' : '（只读账号只能查看，运维操作会被拒绝）'}</p>
  </div>
  <form method="post" action="logout"><button type="submit">退出</button></form>
</div>

<h2>租户</h2>
<div class="row" style="margin-bottom: 8px">
  <input id="filter" placeholder="搜索租户、用户或显示名" size="28" oninput="render()">
  <span class="muted">每页</span>
  <select id="page-size" onchange="render()" style="font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg)">
    <option>10</option><option selected>20</option><option>50</option><option value="0">全部</option>
  </select>
  <span id="count" class="muted"></span>
</div>
<div id="batch" class="card" style="display: none; margin-bottom: 10px">
  <div class="row" style="justify-content: space-between; align-items: center">
    <b id="batch-count">已选 0 个租户</b>
    <span>
      <button onclick="selectAll(true)">全选</button>
      <button onclick="selectAll(false)">清空选择</button>
    </span>
  </div>
  <div class="row" style="margin-top: 10px; align-items: center">
    <span class="muted">模型限额</span>
    <input id="batch-rpm" placeholder="每分钟请求（留空不改）" size="20">
    <input id="batch-daily" placeholder="每天 token（留空不改）" size="20">
    <button class="primary" onclick="applyLimit(false)">应用到选中</button>
    <button onclick="applyLimit(true)">应用到全部租户</button>
    <button onclick="clearLimit()">取消限额</button>
  </div>
  <p class="muted" style="margin: 10px 0 0">
    留空 = 不改这一项；填 0 = 取消这一项。限额写入注册表，模型网关自动重载，无需重启。
  </p>
</div>
<table id="tenants">
  <thead><tr>
    <th style="width: 28px"><input type="checkbox" id="select-all" onclick="selectAll(this.checked)" title="全选"></th>
    <th>租户</th><th>状态</th><th>入口</th><th>用户</th><th>模型用量</th><th>操作</th>
  </tr></thead>
  <tbody><tr><td colspan="7" class="muted">加载中…</td></tr></tbody>
</table>
<div class="row" style="margin-top: 10px; justify-content: space-between">
  <span id="pager" class="muted"></span>
  <span><button id="prev" onclick="step(-1)">上一页</button> <button id="next" onclick="step(1)">下一页</button></span>
</div>
<div id="notice"></div>

<h2>节点</h2>
<table id="nodes">
  <thead><tr><th>节点</th><th>租户</th><th>就绪</th><th>节点代理</th></tr></thead>
  <tbody><tr><td colspan="4" class="muted">加载中…</td></tr></tbody>
</table>

<h2>运维</h2>
<div class="card">
  <div class="row">
    <button onclick="opsRun('disk-report','磁盘报告')">磁盘报告</button>
    <button onclick="opsRun('backup','立即备份')">立即备份</button>
    <button onclick="listBackups()">备份列表</button>
    <button class="danger" onclick="pruneImages()">回收镜像层</button>
  </div>
  <div class="row" style="margin-top: 10px; align-items: center">
    <span class="muted">会话清理</span>
    <input id="prune-days" placeholder="多少天前" size="10" value="90">
    <button onclick="pruneSessions(true)">预览会删什么</button>
    <button class="danger" onclick="pruneSessions(false)">归档并清理</button>
  </div>
  <div class="row" style="margin-top: 10px; align-items: center">
    <span class="muted">升级镜像</span>
    <input id="upgrade-image" placeholder="新镜像引用（如 dsh-web:local-20261002T1323）" size="36">
    <button onclick="upgradeTenants(false)">升级选中</button>
    <button onclick="upgradeTenants(true)">升级全部</button>
  </div>
  <div class="row" style="margin-top: 10px; align-items: center">
    <span class="muted">出口白名单</span>
    <input id="egress-allow" placeholder="逗号分隔的域名后缀；留空 = 允许任意公网" size="40">
    <button class="primary" onclick="saveEgressAllow()">保存</button>
    <button onclick="loadConfig()">读取当前配置</button>
  </div>
  <p class="muted" style="margin: 10px 0 0">
    宿主操作经节点代理执行（固定的操作白名单，不接受任意命令）。升级与清理是重操作，会逐个租户进行。
  </p>
</div>
<pre id="ops-out" style="display: none; max-height: 340px; overflow: auto; white-space: pre-wrap; font-size: 12px; background: #0b1020; color: #d6e2ff; padding: 12px; border-radius: 8px"></pre>

<h2>配额与限速</h2>
<div class="card">
  <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap">
    <input id="lim-tenant" placeholder="租户名" size="12">
    <button onclick="limitsReport()">查看当前</button>
    <span class="muted">限速在容器重建后需要重新应用；bin/mt.sh up 会自动恢复。</span>
  </div>
  <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px">
    <input id="lim-rate" placeholder="速率，例如 10mbit" size="16">
    <select id="lim-dir">
      <option value="up">上行（容器发出）</option>
      <option value="down">下行（容器下载）</option>
      <option value="both">两个方向</option>
    </select>
    <button onclick="bandwidthSet()">限速</button>
    <button onclick="bandwidthClear()">取消限速</button>
  </div>
  <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px">
    <input id="lim-size" placeholder="配额，例如 2g" size="16">
    <button onclick="quotaSet()">设磁盘配额</button>
    <button onclick="quotaClear()">取消配额</button>
    <span class="muted">配额要文件系统以 prjquota 挂载才能强制；未启用时只记下意图，指标与告警照样工作。</span>
  </div>
</div>

<h2>租户移交</h2>
<div class="card">
  <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap">
    <input id="tr-tenant" placeholder="租户名" size="12">
    <button onclick="tenantExport()">导出为归档</button>
    <span class="muted">写出 exports/&lt;租户&gt;-&lt;时间&gt;.tar.gz（含口令哈希与模型凭据，权限 0600）</span>
  </div>
  <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px">
    <input id="tr-archive" placeholder="归档文件名" size="34">
    <input id="tr-as" placeholder="导入为（新租户名）" size="14">
    <button onclick="tenantImport()">导入</button>
    <span class="muted">只能是 exports/ 里的文件名；导入会分配新端口与服务名，口令不变</span>
  </div>
</div>

<h2>操作历史</h2>
<div class="card">
  <div class="row" style="justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
    <span class="muted">谁在什么时候做了什么。两份审计合在一起：控制台自己的操作，以及网关替租户用户做的事。</span>
    <span class="row" style="gap: 8px; align-items: center">
      <select id="hist-tenant" onchange="loadHistory()"><option value="">全部租户</option></select>
      <input id="hist-q" placeholder="搜索（动作/用户/结果）" size="22" onkeydown="if (event.key === 'Enter') loadHistory()">
      <button onclick="loadHistory()">查询</button>
    </span>
  </div>
  <table id="history" style="margin-top: 10px">
    <thead><tr><th style="width: 180px">时间</th><th style="width: 120px">来源</th><th style="width: 160px">动作</th><th style="width: 150px">对象</th><th>结果</th></tr></thead>
    <tbody><tr><td colspan="4" class="muted">点上面按钮加载</td></tr></tbody>
  </table>
</div>

<h2>两步验证</h2>
<div class="card">
  <p class="muted" style="margin: 0 0 10px">
    开启后，登录这个控制台需要再输一次验证器里的六位码。恢复码只在开启时显示一次，
    每个只能用一次 —— 请当场存到安全的地方。
  </p>
  <div id="mfa-state" class="muted" style="margin-bottom: 10px">读取中…</div>
  <div id="mfa-setup-row" class="row" style="align-items: center; gap: 8px; flex-wrap: wrap">
    <button onclick="mfaSetup()">开始绑定</button>
  </div>
  <div id="mfa-secret-row" class="row" style="display: none; flex-direction: column; gap: 6px; margin-top: 10px">
    <div class="muted">把下面这串密钥加进验证器（或粘贴链接），然后用它当前的六位码确认：</div>
    <code id="mfa-secret" style="word-break: break-all"></code>
    <code id="mfa-uri" class="muted" style="word-break: break-all"></code>
    <div class="row" style="gap: 8px; align-items: center">
      <input id="mfa-code" placeholder="六位验证码" size="10" inputmode="numeric" autocomplete="one-time-code">
      <button class="primary" onclick="mfaConfirm()">确认并开启</button>
      <span class="muted">没确认之前不算开启，密钥随时可以重来。</span>
    </div>
  </div>
  <div id="mfa-recovery-row" style="display: none; margin-top: 10px">
    <div class="muted">恢复码（<b>只显示这一次</b>，每个只能用一次）：</div>
    <pre id="mfa-recovery" style="margin: 6px 0 0"></pre>
  </div>
  <div id="mfa-active-row" class="row" style="display: none; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px">
    <input id="mfa-code2" placeholder="六位验证码" size="10" inputmode="numeric" autocomplete="one-time-code">
    <button onclick="mfaRegenerate()">重新生成恢复码</button>
    <button onclick="mfaDisable()">关闭两步验证</button>
    <span class="muted">这两件事都要先输当前验证码（或用掉一个恢复码）。</span>
  </div>
</div>

<h2>我的账号</h2>
<div class="card">
  <div class="row">
    <input id="cur-pass" type="password" placeholder="当前密码" size="20" autocomplete="current-password">
    <input id="new-pass" type="password" placeholder="新密码（至少 12 位）" size="24" autocomplete="new-password">
    <input id="new-pass2" type="password" placeholder="再输一次新密码" size="24" autocomplete="new-password">
    <button class="primary" onclick="changeOwnPassword()">修改密码</button>
  </div>
  <p class="muted" style="margin: 10px 0 0">
    改完其它已登录的管理员会话立即失效，<b>当前这个会话保持登录</b>。
    忘了密码就只能到部署机上执行 <code>bin/mt.sh admin-passwd</code>。
  </p>
</div>

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
// Selection lives outside the render so filtering, paging and the refresh do not
// drop what the operator ticked. It holds ids rather than rows: a tenant that
// scrolled out of view stays selected, and one deleted elsewhere is dropped on
// the next render because nothing redraws it.
const selected = new Set()

function toggleSelect(id, on) {
  if (on) selected.add(id)
  else selected.delete(id)
  render()
}

// "All" means every row the filter currently shows, so it composes with the
// search box: filter to a group, select all, act on that group — which is the
// usual case, since ceilings are normally set for everyone at once.
function selectAll(on) {
  const needle = ($('filter').value || '').trim().toLowerCase()
  for (const tenant of snapshot.tenants) {
    if (!matches(tenant, needle)) continue
    if (on) selected.add(tenant.id)
    else selected.delete(tenant.id)
  }
  render()
}

/**
 * Apply model ceilings to the selection, or to every tenant.
 *
 * Blank fields mean "leave this one alone" and 0 means "drop this ceiling", which
 * is what the server expects; the two differ by absent versus explicit.
 */
async function applyLimit(all) {
  if (!all && selected.size === 0) { notice('先选中至少一个租户，或用"应用到全部租户"', true); return }
  const rpm = $('batch-rpm').value.trim()
  const daily = $('batch-daily').value.trim()
  if (rpm === '' && daily === '') { notice('每分钟请求和每天 token 至少填一个（填 0 表示取消该项）', true); return }
  const body = { action: 'limit' }
  if (all) body.all = true
  else body.tenants = Array.from(selected)
  if (rpm !== '') body.rpm = Number(rpm)
  if (daily !== '') body.dailyTokens = Number(daily)
  notice('正在应用…')
  const answer = await post('api/tenant', body)
  if (answer.ok) {
    $('batch-rpm').value = ''
    $('batch-daily').value = ''
    notice(answer.message || '已应用')
    await load()
  } else {
    notice(answer.error || '应用失败', true)
  }
}

async function clearLimit() {
  if (!confirm('取消选中租户的模型限额？他们之后不再受每分钟/每天限制。')) return
  const body = { action: 'limit', rpm: 0, dailyTokens: 0 }
  if (selected.size > 0) body.tenants = Array.from(selected)
  else body.all = true
  notice('正在取消…')
  const answer = await post('api/tenant', body)
  if (answer.ok) { notice(answer.message || '已取消限额'); await load() }
  else notice(answer.error || '取消失败', true)
}

/**
 * Run one host operation through a node's agent and show what it said.
 *
 * The node is picked rather than asked for: with one deployment there is one
 * answer, and when there are several the interesting one is whichever has an
 * agent answering. Ask the agent, not the browser, which node that is.
 */
async function opsRun(op, label, params, node) {
  const target = node || agentNode()
  if (target === undefined) { notice('没有节点代理在跑，宿主操作无法执行', true); return }
  $('ops-out').style.display = 'block'
  $('ops-out').textContent = '正在执行 ' + label + ' …'
  const answer = await post('api/tenant', { action: 'ops', node: target, op, params: params || {} })
  if (answer.ok) {
    $('ops-out').textContent = answer.output || '（没有输出）'
    notice(label + ' 完成')
  } else {
    $('ops-out').textContent = (answer.error || '失败') + (answer.output ? '\n\n' + answer.output : '')
    notice(label + ' 失败：' + (answer.error || ''), true)
  }
}

/** The node whose agent is answering, or undefined when none is. */
function agentNode() {
  const up = (snapshot.nodes || []).find((entry) => entry.agent === 'up')
  if (up !== undefined) return up.node
  return (snapshot.nodes || []).length > 0 ? undefined : 'local'
}

async function pruneImages() {
  if (!confirm('回收没有被任何镜像引用的层？这台机器上还有别的栈，但悬空层不属于任何镜像或容器，删除不会影响正在运行的东西。')) return
  await opsRun('disk-prune-images', '回收镜像层')
}

async function pruneSessions(dryRun) {
  const days = $('prune-days').value.trim()
  if (!/^\d+$/.test(days)) { notice('填一个整数天（注意：N 表示超过 N×24 小时，0 表示超过一天）', true); return }
  if (!dryRun && !confirm('归档并删除超过 ' + days + ' 天的会话？会先打包到 backups/，打包失败则跳过该租户。')) return
  const tenants = selected.size > 0 ? Array.from(selected) : undefined
  if (tenants === undefined && !confirm('没有选中租户，将对全部租户执行。继续？')) return
  // The agent's op takes one tenant at a time when given one; run per tenant so a
  // partial failure names the tenant it failed on.
  const list = tenants || (snapshot.tenants || []).map((tenant) => tenant.id)
  $('ops-out').style.display = 'block'
  $('ops-out').textContent = '会话清理（' + (dryRun ? '预览' : '执行') + '）…\n'
  for (const id of list) {
    const answer = await post('api/tenant', { action: 'ops', node: agentNode(), op: 'disk-prune-sessions', params: { olderThan: Number(days), tenant: id, dryRun } })
    $('ops-out').textContent += '\n=== ' + id + ' ===\n' + (answer.ok ? answer.output : '失败：' + answer.error)
  }
  notice('会话清理' + (dryRun ? '预览' : '') + '完成')
}

/**
 * Upgrade tenants one at a time, reporting each as it finishes.
 *
 * Per tenant rather than one request for the set, because the operator is waiting
 * on a rebuild that takes a while and the useful information — which tenant is
 * being worked on and which one failed — only exists between the steps. The
 * script's own rolling behaviour still applies within each call; this adds the
 * progress the console can show.
 */
async function upgradeTenants(all) {
  const image = $('upgrade-image').value.trim()
  if (image === '') { notice('填要升级到的镜像引用', true); return }
  const list = all ? (snapshot.tenants || []).map((tenant) => tenant.id) : Array.from(selected)
  if (list.length === 0) { notice(all ? '没有租户' : '先选中租户，或用"升级全部"', true); return }
  if (!confirm('把 ' + list.join('、') + ' 升级到 ' + image + '？\n会逐个重建容器，任一租户起不来就回滚它并停止。')) return
  $('ops-out').style.display = 'block'
  $('ops-out').textContent = '升级到 ' + image + '\n'
  const target = agentNode()
  if (target === undefined) { notice('没有节点代理在跑，升级无法执行', true); return }
  let done = 0
  for (const id of list) {
    $('ops-out').textContent += '\n=== ' + id + ' （' + (done + 1) + '/' + list.length + '）===\n正在重建…\n'
    const answer = await post('api/tenant', { action: 'ops', node: target, op: 'upgrade', params: { image, tenants: id } })
    $('ops-out').textContent += (answer.ok ? answer.output : '失败：' + (answer.error || '')) + '\n'
    if (!answer.ok) {
      notice(id + ' 升级失败，已停止；该租户已回滚', true)
      $('ops-out').textContent += '\n已停止：' + id + ' 未能就绪，脚本已把它回滚。\n'
      await load()
      return
    }
    done += 1
  }
  notice('升级完成：' + done + ' 个租户')
  await load()
}

/** Show the archives, each with a restore button. */
async function listBackups() {
  const answer = await post('api/tenant', { action: 'ops', node: agentNode(), op: 'backup-list' })
  $('ops-out').style.display = 'block'
  if (!answer.ok) { notice('读取备份失败：' + (answer.error || ''), true); return }
  $('ops-out').textContent = answer.output || ''
  // The names come back structured as well, so the restore button can only offer
  // archives the agent itself listed — which is also what its validation accepts.
  const archives = (answer.backups || [])
  if (archives.length === 0) return
  $('ops-out').textContent += '\n\n恢复某个归档（会先把现有数据移到 restore-aside-<时间戳>/）：\n'
  window.__backups = archives
  $('ops-out').textContent += archives.map((name, index) => '  [' + (index + 1) + '] ' + name).join('\n')
  const which = prompt('输入要恢复的归档编号（留空取消）：')
  if (which === null || which.trim() === '') return
  const index = Number(which.trim()) - 1
  if (!Number.isInteger(index) || index < 0 || index >= archives.length) { notice('编号不对', true); return }
  await restoreBackup(archives[index])
}

async function restoreBackup(archive) {
  // Typing the name is the confirmation: this replaces every tenant's data with
  // the archive's contents, and a stray click should not be able to do that.
  const typed = prompt('恢复 ' + archive + ' 会用它覆盖当前所有租户的数据（现有数据会先移到 restore-aside-<时间戳>/）。\n\n确认请输入归档名：')
  if (typed === null) return
  if (typed.trim() !== archive) { notice('名字不匹配，已取消', true); return }
  await opsRun('restore', '恢复 ' + archive, { archive })
  await load()
}

async function loadConfig() {
  const answer = await post('api/tenant', { action: 'ops', node: agentNode(), op: 'config-get' })
  if (!answer.ok) { notice('读取配置失败：' + (answer.error || ''), true); return }
  $('ops-out').style.display = 'block'
  $('ops-out').textContent = answer.output || ''
  try {
    const values = JSON.parse(answer.output)
    if (typeof values.MT_EGRESS_ALLOW === 'string') $('egress-allow').value = values.MT_EGRESS_ALLOW
  } catch { /* the panel already shows the raw text */ }
}

async function saveEgressAllow() {
  const value = $('egress-allow').value.trim()
  if (!confirm(value === '' ? '清空白名单后，租户可以访问任意公网地址（私网仍然拒绝）。继续？' : '把出口白名单设为：' + value + '？出口代理会自动读取，无需重启。')) return
  await opsRun('config-set-egress-allow', '保存出口白名单', { value })
}

/**
 * Show what has been done to this deployment.
 *
 * Read from the audit log rather than assembled in the browser: an operator looking
 * up "who restarted that tenant" needs the record the control plane wrote, not what
 * this tab happens to have seen.
 */
/**
 * Export one tenant to an archive, through the node agent.
 *
 * The console has no Docker access, so this is a host operation like the others: it goes
 * to the agent as a named operation, and the agent validates the tenant id.
 */
async function tenantExport() {
  const tenant = document.querySelector('#tr-tenant').value.trim()
  if (tenant === '') { showOps('导出', { ok: false, error: '先填租户名' }); return }
  showOps('导出租户 ' + tenant, await post('api/tenant', { action: 'ops', node: 'local', op: 'tenant-export', params: { tenant } }))
}

/**
 * Import a tenant from an archive in exports/.
 *
 * The archive is named, never a path: the agent rejects anything that is not a bare
 * file name, because this field arrives from a browser session.
 */
async function tenantImport() {
  const archive = document.querySelector('#tr-archive').value.trim()
  const tenant = document.querySelector('#tr-as').value.trim()
  if (archive === '' || tenant === '') { showOps('导入', { ok: false, error: '归档名与新租户名都要填' }); return }
  if (!confirm('把 ' + archive + ' 导入为租户 ' + tenant + '？\n导入后还需要 render + up 才会启动它。')) return
  showOps('导入 ' + archive + ' → ' + tenant,
    await post('api/tenant', { action: 'ops', node: 'local', op: 'tenant-import', params: { archive, tenant } }))
}

/**
 * Run one host operation for the quota/rate card and show what it printed.
 *
 * These go through the node agent like every other host operation: the console has no
 * Docker access, and the agent is where the tenant's filesystem and network actually are.
 *
 * @param label - what to call the operation in the output panel.
 * @param op - the agent operation name.
 * @param params - its validated parameters.
 */
async function limitsOp(label, op, params) {
  showOps(label, await post('api/tenant', { action: 'ops', node: 'local', op, params }))
}

/** @returns the tenant the card is pointed at, or shows why it cannot proceed. */
function limitsTenant() {
  const tenant = document.querySelector('#lim-tenant').value.trim()
  if (tenant === '') { showOps('配额与限速', { ok: false, error: '先填租户名' }); return undefined }
  return tenant
}

async function limitsReport() {
  const tenant = limitsTenant()
  if (tenant === undefined) return
  await limitsOp('租户 ' + tenant + ' 的配额与限速', 'limits-report', { tenant })
}

async function bandwidthSet() {
  const tenant = limitsTenant()
  if (tenant === undefined) return
  const rate = document.querySelector('#lim-rate').value.trim()
  const direction = document.querySelector('#lim-dir').value
  if (rate === '') { showOps('限速', { ok: false, error: '先填速率，例如 10mbit' }); return }
  await limitsOp('限速 ' + tenant + ' → ' + rate + '（' + direction + '）', 'bandwidth-set', { tenant, rate, direction })
}

async function bandwidthClear() {
  const tenant = limitsTenant()
  if (tenant === undefined) return
  await limitsOp('取消 ' + tenant + ' 的限速', 'bandwidth-clear', { tenant })
}

async function quotaSet() {
  const tenant = limitsTenant()
  if (tenant === undefined) return
  const size = document.querySelector('#lim-size').value.trim()
  if (size === '') { showOps('配额', { ok: false, error: '先填配额，例如 2g' }); return }
  await limitsOp('给 ' + tenant + ' 设配额 ' + size, 'quota-set', { tenant, size })
}

async function quotaClear() {
  const tenant = limitsTenant()
  if (tenant === undefined) return
  await limitsOp('取消 ' + tenant + ' 的配额', 'quota-clear', { tenant })
}

/** 显示当前的两步验证状态，并只露出该用的那几行。 */
async function mfaStatus() {
  const answer = await post('api/tenant', { action: 'mfa-status' })
  const state = document.querySelector('#mfa-state')
  if (!answer.ok) { state.textContent = '读不到状态：' + (answer.error || ''); return }
  if (answer.active) {
    state.textContent = '已开启。恢复码还剩 ' + answer.recoveryLeft + ' 个。'
  } else if (answer.pending) {
    state.textContent = '有一个还没确认的密钥 —— 输入验证码确认，或重新开始绑定。'
  } else {
    state.textContent = '未开启。'
  }
  document.querySelector('#mfa-setup-row').style.display = answer.active ? 'none' : 'flex'
  document.querySelector('#mfa-active-row').style.display = answer.active ? 'flex' : 'none'
  if (answer.active) {
    document.querySelector('#mfa-secret-row').style.display = 'none'
  }
}

/** 生成待确认的密钥。没有确认之前它不算数，所以随手重来是安全的。 */
async function mfaSetup() {
  const answer = await post('api/tenant', { action: 'mfa-setup' })
  if (!answer.ok) { showOps('两步验证', answer); return }
  document.querySelector('#mfa-secret').textContent = answer.secret
  document.querySelector('#mfa-uri').textContent = answer.uri
  document.querySelector('#mfa-secret-row').style.display = 'flex'
  document.querySelector('#mfa-recovery-row').style.display = 'none'
  showOps('两步验证', { ok: true, output: '已生成密钥。用验证器读出当前六位码后确认。' })
}

/** 用当前验证码确认。成功时返回的恢复码只在这里出现一次。 */
async function mfaConfirm() {
  const code = document.querySelector('#mfa-code').value.trim()
  const answer = await post('api/tenant', { action: 'mfa-confirm', code })
  if (!answer.ok) { showOps('两步验证', answer); return }
  if (Array.isArray(answer.recovery)) {
    document.querySelector('#mfa-recovery').textContent = answer.recovery.join('\n')
    document.querySelector('#mfa-recovery-row').style.display = 'block'
  }
  showOps('两步验证', { ok: true, output: '已开启。恢复码只显示这一次，请立刻保存。' })
  mfaStatus()
}

/** 换一批恢复码。旧的立刻作废 —— 这正是"恢复码用完了"的出路。 */
async function mfaRegenerate() {
  const code = document.querySelector('#mfa-code2').value.trim()
  if (!confirm('旧的恢复码会立刻作废，确定重新生成 10 个？')) return
  const answer = await post('api/tenant', { action: 'mfa-recovery', code })
  if (!answer.ok) { showOps('两步验证', answer); return }
  document.querySelector('#mfa-recovery').textContent = answer.recovery.join('\n')
  document.querySelector('#mfa-recovery-row').style.display = 'block'
  showOps('两步验证', { ok: true, output: '已生成新的恢复码，旧的已作废。' })
  mfaStatus()
}

/** 关闭两步验证。需要当前验证码，或一个还没用过的恢复码。 */
async function mfaDisable() {
  const code = document.querySelector('#mfa-code2').value.trim()
  if (!confirm('关闭后登录只需要密码，确定？')) return
  const answer = await post('api/tenant', { action: 'mfa-disable', code })
  showOps('两步验证', answer.ok ? { ok: true, output: '已关闭。' } : answer)
  mfaStatus()
}

async function loadHistory() {
  const picker = document.querySelector('#hist-tenant')
  const tenantFilter = picker ? picker.value : ''
  const q = (document.querySelector('#hist-q') || {}).value || ''
  // 筛选交给服务端：这里只拿到 limit 条，在窗口内筛选会把"没有"和"不在最近一百条里"混为一谈。
  const answer = await post('api/tenant', { action: 'ops-history', limit: 100, tenantFilter, q })
  const body = document.querySelector('#history tbody')
  if (!answer.ok) {
    body.innerHTML = '<tr><td colspan="5" class="muted">读取失败：' + escapeHtml(answer.error || '') + '</td></tr>'
    return
  }
  // 下拉框选项来自服务端返回的租户清单，这样筛选中也会包含 '-'（未归属请求）。
  if (picker !== null && picker.options.length <= 1 && Array.isArray(answer.tenants)) {
    for (const id of answer.tenants) {
      const option = document.createElement('option')
      option.value = id
      option.textContent = id === '-' ? '（未归属）' : id
      picker.appendChild(option)
    }
  }
  const entries = answer.entries || []
  if (entries.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="muted">' + (answer.total === 0 ? '还没有记录' : '没有匹配的记录（共 ' + answer.total + ' 条）') + '</td></tr>'
    return
  }
  body.innerHTML = entries.map((entry) => {
    const when = typeof entry.ts === 'string' ? entry.ts.replace('T', ' ').replace(/\..*$/u, '') : ''
    const who = entry.user ? ' · ' + entry.user : ''
    const what = entry.node ? '（节点 ' + entry.node + '）' : ''
    const outcome = entry.error !== undefined ? '失败：' + entry.error
      : entry.status !== undefined ? 'HTTP ' + entry.status
        : entry.result !== undefined ? entry.result
          : entry.note !== undefined ? entry.note : '—'
    // 两份审计合在一起，所以要说清每条来自哪一边：控制台自己的操作，还是网关
    // 替租户用户做的事（登录、改密、跨租户拒绝）。后者以前根本看不到。
    const from = entry.source === 'gateway' ? '网关' : '控制台'
    return '<tr><td class="muted">' + escapeHtml(when) + '</td><td class="muted">' + from + '</td><td>' + escapeHtml(entry.action || '?')
      + '</td><td>' + escapeHtml(entry.tenant || '-') + what + '</td><td>' + escapeHtml(String(outcome)) + who + '</td></tr>'
  }).join('')
}

const post = async (path, body) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return response.json()
}
// Changing our own password signs out every other administrator session, and the
// server hands back a fresh cookie for this one. The new password is entered twice
// on purpose: a typo here locks the only administrator out until somebody reaches
// the host, and the console cannot be the thing that does that.
async function changeOwnPassword() {
  const current = $('cur-pass').value
  const next = $('new-pass').value
  const again = $('new-pass2').value
  if (current === '' || next === '') { notice('三个框都要填', true); return }
  if (next !== again) { notice('两次输入的新密码不一致', true); return }
  if (next.length < 12) { notice('新密码至少 12 位', true); return }
  notice('正在修改…')
  const answer = await post('api/tenant', { action: 'own-passwd', currentPassword: current, newPassword: next })
  if (answer.ok) {
    $('cur-pass').value = ''
    $('new-pass').value = ''
    $('new-pass2').value = ''
    notice(answer.message || '密码已修改')
  } else {
    notice(answer.error || '修改失败', true)
  }
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
const kickSessions = async (tenant, user) => {
  if (!confirm('让 ' + tenant + '/' + user + ' 重新登录？已登录的浏览器会立刻失效（密码不变）。')) return
  const answer = await post('api/tenant', { tenant, action: 'kick', user })
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
  snapshot = data
  render()
  // 顺手把两步验证的状态读出来，否则卡片会一直停在「读取中…」。
  mfaStatus()
}

// The whole list is kept and filtered here rather than re-fetched: status comes
// from a live probe on the server side, so re-fetching on every keystroke would
// hit every tenant runtime.
let snapshot = { tenants: [], edgePort: 0, origin: '' }
let page = 0

const matches = (tenant, needle) => {
  if (!needle) return true
  const haystack = [tenant.id, tenant.title, tenant.users.join(' '), tenant.node].join(' ').toLowerCase()
  return haystack.includes(needle)
}

const step = (delta) => { page += delta; render() }

function render() {
  const needle = ($('filter').value || '').trim().toLowerCase()
  const size = Number($('page-size').value)
  const all = snapshot.tenants
  const filtered = all.filter((tenant) => matches(tenant, needle))
  const pages = size === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / size))
  if (page > pages - 1) page = pages - 1
  if (page < 0) page = 0
  const shown = size === 0 ? filtered : filtered.slice(page * size, page * size + size)

  $('count').textContent = needle
    ? filtered.length + ' / ' + all.length + ' 个租户匹配'
    : all.length + ' 个租户'
  $('pager').textContent = pages > 1 ? '第 ' + (page + 1) + ' / ' + pages + ' 页' : ''
  $('prev').disabled = page <= 0
  $('next').disabled = page >= pages - 1

  // The batch bar only exists when something is ticked, and it reports the count
  // from the set rather than from the visible rows: a selection survives paging,
  // so "已选 5 个" must not shrink when the operator turns the page.
  const live = new Set(snapshot.tenants.map((tenant) => tenant.id))
  for (const id of Array.from(selected)) if (!live.has(id)) selected.delete(id)
  $('batch').style.display = selected.size > 0 ? 'block' : 'none'
  $('batch-count').textContent = '已选 ' + selected.size + ' 个租户'
  const allVisible = filtered.length > 0 && filtered.every((tenant) => selected.has(tenant.id))
  $('select-all').checked = allVisible

  // Node rows carry the one fact the tenant table cannot: whether that node's
  // agent answers, which is what every maintenance button depends on.
  const nodeRows = (snapshot.nodes || []).map((entry) => {
    const tag = entry.agent === 'up' ? '<span class="tag ok">在线</span>'
      : entry.agent === 'down' ? '<span class="tag bad">无响应</span>'
        : '<span class="tag muted">未配置</span>'
    // An operation in flight is why a maintenance button will refuse, so it belongs
    // where the operator is looking rather than only in the error they get later.
    const doing = entry.busy ? '<br><span class="tag warn">正在 ' + escapeHtml(entry.busy) + '</span>' : ''
    return '<tr><td><b>' + entry.node + '</b></td><td>' + entry.tenants + '</td><td>'
      + entry.ready + ' / ' + entry.tenants + '</td><td>' + tag + doing + '</td></tr>'
  })
  document.querySelector('#nodes tbody').innerHTML = nodeRows.length
    ? nodeRows.join('')
    : '<tr><td colspan="4" class="muted">没有节点</td></tr>'

  const rows = shown.map((tenant) => {
    const usage = tenant.usage
    const usageText = usage && usage.calls > 0
      ? usage.calls + ' 次 · ' + usage.input + '/' + usage.output + ' tokens'
      : '<span class="muted">—</span>'
    const ceiling = []
    if (tenant.limits && tenant.limits.rpm) ceiling.push(tenant.limits.rpm + ' 次/分')
    if (tenant.limits && tenant.limits.dailyTokens) ceiling.push(tenant.limits.dailyTokens + ' tokens/天')
    const limitsText = ceiling.length
      ? '<br><span class="tag warn" title="模型限额">限额 ' + ceiling.join(' · ') + '</span>'
      : ''
    const entry = tenant.edgePort ? snapshot.origin + ':' + tenant.edgePort + '/'
      : tenant.hosts && tenant.hosts.length ? tenant.hosts[0] + ':' + snapshot.edgePort + '/'
      : snapshot.origin + ':' + snapshot.edgePort + '/'
    const buttons = [
      '<button onclick="action(\\'' + tenant.id + '\\', \\'restart\\')">重启</button>',
      tenant.agent
        ? '<button onclick="action(\\'' + tenant.id + '\\', \\'stop\\')">停止</button>'
        : '<button disabled title="该租户不是通过节点代理注册的，无法在此操作容器">停止</button>',
      '<button onclick="resetPassword(\\'' + tenant.id + '\\', \\'' + tenant.users[0] + '\\')">改密码</button>',
      '<button onclick="kickSessions(\\'' + tenant.id + '\\', \\'' + tenant.users[0] + '\\')" title="让已登录的浏览器失效，不改密码">踢下线</button>',
      '<button class="danger" onclick="removeTenant(\\'' + tenant.id + '\\')">删除</button>',
    ].join(' ')
    const agentNote = tenant.agent ? '' : ' <span class="tag muted" title="没有节点代理，容器操作需在部署机上执行">无代理</span>'
    return '<tr>' +
      '<td><input type="checkbox"' + (selected.has(tenant.id) ? ' checked' : '') + ' onclick="toggleSelect(''' + tenant.id + ''', this.checked)"></td>' +
      '<td><b>' + tenant.id + '</b><br><span class="muted">' + (tenant.title || '') + '</span></td>' +
      '<td>' + tenant.status + agentNote + '</td>' +
      '<td><code>' + entry + '</code></td>' +
      '<td>' + tenant.users.join(', ') + '</td>' +
      '<td>' + usageText + limitsText + '</td>' +
      '<td class="row">' + buttons + '</td>' +
      '</tr>'
  })
  document.querySelector('#tenants tbody').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="7" class="muted">' + (all.length === 0 ? '还没有租户' : '没有匹配的租户') + '</td></tr>'
}

// First paint, then the live snapshot: load() renders again once it arrives.
render()
load()
</script>
</div>`)
}

module.exports = { loginPage, consolePage, statusTag }
