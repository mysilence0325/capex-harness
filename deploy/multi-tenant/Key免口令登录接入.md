# Key 免口令登录（USB Key 单点登录）

> 这份文档讲清三件事：**身份从哪来**、**怎么开**、**出问题先看哪里**。
> 参考实现是 Capex/QwenPaw 的 `KEY_LOGIN_INTEGRATION_zh.md`，本部署按同一套链路复刻，
> 并按我们"一个租户 = 一个账号 = 一个独占空间"的模型做了简化。

## 1. 它是什么

装了 Key 的浏览器打开租户入口地址，**不用输口令**直接进自己的 DSH；没有 Key（或这台机器的
Key 用户没有绑定本部署账号）时，看到的仍是原来的登录页，用户名 + 口令照旧可用。
两种方式**并存**，口令那条路径一行没改。

因为这里是一个账号一个租户，Key 里的用户名直接决定了进哪个租户：没有租户选择框，用户也
不需要知道自己属于哪个租户。

## 2. 链路

```
浏览器（装了 Key 中间件）
   │ ① TLS 握手：中间件自动提交 Key 里的客户端证书
   ▼
身份网关 trp  https://<域名>:496
   │ ② 校验证书 → 把用户名写进 Cookie: KOAL_CERT_E=<用户名>
   │    只对**已授权路径前缀**做这件事
   ▼
入口机 nginx（/ai/harness/ 转发给本部署）
   │ ③ 保留前缀转发到 mt-gateway:8090
   ▼
mt-gateway
   │ ④ 只读 Cookie → 在租户注册表里找同名用户 → 签发自己的会话（与口令登录同一个 cookie）
   ▼
该租户的 DSH
```

第 ④ 步没有"补齐用户"的动作：租户容器在开通时就建好了，不存在参考实现里"新账号第一次
Key 登录 500"那一类问题。本部署对应的坑是**租户运行时还没注册**，那会走已有的 503 页面
（`bin/mt.sh doctor` 的"运行时注册"一段会先报出来）。

## 3. 安全模型（这一段是全部安全性所在）

1. **身份只来自 Cookie。** 查询参数、请求体里的用户名一律不作数——否则这个接口就是一条
   免密登录通道。`bin/acceptance.sh` 每轮都断言 `?user=<别人>` 拿不到会话。
2. **Cookie 只从信任来源接受。** 这个 Cookie 本身就是一份凭据（后面没有口令跟着），谁能把
   它递到网关，谁就能成为那个用户。所以网关只认：
   - **loopback**（运维端口与本机脚本，本来就处在这台机器的信任里），以及
   - `MT_KEY_LOGIN_FROM` 里列出的地址（**填入口机/代理的地址**）。

   可选的第二道锁 `MT_KEY_LOGIN_SECRET`：要求代理转发时带上 `X-MT-Key-Auth` 头，网关常数
   时间比对。代理地址不固定时可以只配它。
3. **账号校验**＝租户注册表里存在这个用户。删掉账号，Key 登录立刻失效；不存在、名字对不上，
   一律 401（不对外区分原因）。
4. **会话与口令登录完全同源**：同一个 `mt_session` cookie、同样的 12 小时有效期；
   `bin/mt.sh passwd` / `kick` 递增 `sessionEpoch` 之后，Key 签发的会话**同样立即失效**
   （`verifySession()` 比对 epoch，与签发方式无关）。
5. **审计**：`logs/access.jsonl` 里 `note` 为 `key-login`（成功）、`key-login-unknown-user`、
   `key-login-untrusted-source`、`key-login-bad-secret`、`key-login-no-identity`（拒绝，含
   原因与来源地址）；**不记录 Cookie 原文**。
6. **限流**：按来源地址计数，20 次"带着身份但认不出来"的失败锁 10 分钟。没带身份的请求
   不计数（没插 Key 的正常用户不该被罚），成功一次即清零。它与口令登录各自独立，互不挤占
   对方的预算。

### 因此，端口不要对客户端网段敞开

信任列表是第一道门，别把第二道门拆了：网关的公开端口只应让入口机访问，客户端一律走代理。

```bash
# 本部署自己的隔离规则（bin/isolate.sh）管的是**租户容器**对宿主端口的访问，
# 不管客户端网段，这一条要在防火墙上做。
bin/mt.sh doctor | sed -n '/Key 免口令登录/,/运行时注册/p'   # 会报出当前信任的是谁
```

## 4. 开启（三步）

```bash
# ① .env：填入口机的地址（多个用逗号分隔，支持 CIDR）
MT_KEY_LOGIN_FROM=15.11.40.44
# 可选第二道锁：代理转发时加 X-MT-Key-Auth 头
#MT_KEY_LOGIN_SECRET=<一段随机串>

# ② 重建网关并切换（改了 .env 必须 up；gateway/ 里的代码改过要先 build）
bin/mt.sh up

# ③ 量一次：模拟身份网关注入的那条 cookie，走完整条链路
bin/mt.sh mount-check https://officeai.301.avic:496/ai/harness/ --key-user alice
```

其它可调项（默认值就能用）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MT_KEY_LOGIN_COOKIE` | `KOAL_CERT_E` | 身份网关写用户名的 Cookie 名 |
| `MT_KEY_LOGIN_AUTO` | `1` | 装了 Key 的浏览器打开入口页是否自动免口令登录（`0` = 只留按钮） |

## 5. 前置条件：身份网关得为这个前缀注入身份

trp 只对**它已授权的前缀**做证书校验并写 Cookie。所以：

1. 确认 `/ai`（或 `/ai/harness`）在身份网关那边是**前缀匹配**授权；不确定就临时加一个探测
   用的 location（`/ai/harness-probe/` 返回固定文本），用浏览器访问到就说明放行。
2. **一条命令定性**（绕过代理，直连本机入口，自造 cookie）：

```bash
curl -sSk -o /dev/null -w '%{http_code}\n' \
  -H 'Cookie: KOAL_CERT_E=alice' \
  https://127.0.0.1:8090/ai/harness/__mt/key-login     # 303 = 本部署这一侧通路正常
```

直连正常、走代理失败 → 问题在"网关有没有写这条 Cookie"，不在本部署。浏览器 F12 里看
**请求头有没有 `Cookie:`** 是最快的一步。

## 6. 入口机 nginx 增量

在 README「4. 用户怎么访问」那份片段的基础上，如果配了 `MT_KEY_LOGIN_SECRET`，再加一行：

```nginx
location ^~ /ai/harness/ {
  proxy_pass https://<部署机IP>:8090;
  proxy_set_header Host $http_host;          # 必须带端口（控制台的同源校验要靠它）
  proxy_set_header X-MT-Key-Auth <密钥>;      # 只在配了 MT_KEY_LOGIN_SECRET 时需要
  # …其余（Upgrade、proxy_buffering off、超时）见 README 同一节…
}
```

## 7. 验证

**自动**（都不需要真 Key）：

```bash
bin/mt.sh mount-check <入口 URL> --key-user <注册表里的用户名>   # 地址、登录、直接进 DSH
bin/acceptance.sh      # Key 一段 10 项；未开启时会明确 SKIP，不当成通过
bin/mt.sh doctor       # "Key 免口令登录"一段：开关、容器里的配置、登录页有没有这条入口
```

**手工**（浏览器，判断观感）：

1. 带 Key 打开入口地址 → 应直接进自己的 DSH，中间只闪一下。
2. 换一台没有 Key 的机器打开同一地址 → 应是登录页，且 **Key 与口令两种方式都在**。
3. 必验一条：**一个刚建好的账号直接走 Key 登录**。老账号能过不代表新账号能过——参考实现
   就在这一步踩过坑（那边是新账号 500；这边对应的是租户运行时没注册 → 503）。

## 8. 故障对照表

| 现象 | 先看这里 |
| --- | --- |
| 登录页上没有 Key 按钮 | `.env` 没配 `MT_KEY_LOGIN_FROM`/`SECRET`，或改了没 `bin/mt.sh up`（doctor 会报） |
| 点 Key 登录得到 403「这个入口没有开启 Key 登录」 | 请求不是从信任地址来的：客户端**直连**了 8090，没走入口机 |
| 页面说「未检测到有效的 Key 身份」 | 三选一：本机没有 Key／身份网关没为这个前缀注入 Cookie（F12 看 `Cookie:`）／用户名不在租户注册表里 |
| 登录成功却进不去，看到 503 | 该租户的运行时没注册：`bin/mt.sh runtimes`、`bin/mt.sh register <租户>` |
| 反复刷新之后变成 429 | 20 次带身份的失败把来源锁 10 分钟；成功登录一次即清零，或改用口令方式 |
| 插着 Key 却被要求输口令 | `MT_KEY_LOGIN_AUTO=0`，或浏览器没把 Cookie 带过来（见上表第 3 行） |
| 想查谁登录了 | `logs/access.jsonl` 按 `note: key-login` 过滤；里面只有用户名与来源地址，没有 Cookie 原文 |

## 9. 这一轮没做的（集群部署再谈）

- **多入口机**：`MT_KEY_LOGIN_FROM` 要把每台的地址都列上（或改用共享密钥），否则从没列上的
  那台进来的 Key 请求一律 403。控制面与运行时的注册机制不变。
- **按账号开关**：现在只有全局开关；要让某些账号强制口令，需要给用户记录加字段并在控制台
  给出入口（当前没有）。
- **身份网关侧的设备与证书策略**（有效期、吊销、哪些 Key 能用）不在本部署范围内。
