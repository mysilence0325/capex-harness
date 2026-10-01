# DSH 多租户部署（形态 C：共享控制面 + 每租户隔离运行时）

在一台 Docker 主机上把 DeepSeek Harness 变成"一个入口、多个互相隔离的租户"。

```
                        ┌─────────────────────────── mt-gateway（控制面，唯一对外端口 8090）───────────────────────────┐
  浏览器 ──────────────▶│ 登录页 · 会话 cookie · 租户路由 · 自动激活 DSH cookie · HTTP/WebSocket 反向代理 · 审计日志 │
                        └───────────────┬──────────────────────┬──────────────────────┬─────────────────────────────┘
                                        │ mt-net（内部 bridge，不对外发布）           │
                        ┌───────────────▼──────┐  ┌────────────▼─────────┐  ┌─────────▼────────────┐
                        │ mt-dsh-alpha :3181   │  │ mt-dsh-beta :3182    │  │ mt-dsh-gamma :3183   │
                        │ DSH_HOME=租户 A 私有 │  │ DSH_HOME=租户 B 私有 │  │ DSH_HOME=租户 C 私有 │
                        └──────────┬───────────┘  └──────────┬───────────┘  └──────────┬──────────┘
                                   └─────────────────┬───────┴─────────────────────────┘
                                        ┌────────────▼─────────────┐
                                        │ mt-egress-proxy :3128    │──▶ 模型 API 等公网目标
                                        │ 私网/回环目标一律拒绝     │
                                        └──────────────────────────┘
```

公开端口默认是 **HTTPS**（自签 CA，见「传输加密」）；本机运维脚本另走 loopback 明文端口 8099。

## 0. 首次部署

版本库里只有 `*.example` 模板，真实配置与租户数据不进库：

```bash
cp .env.example .env              # 端口、镜像、权限模式
cp model.env.example model.env    # 模型凭据（apiKeyEnv 引用的环境变量）
echo '{"tenants": []}' > tenants.json
bin/mt.sh add alpha --user alice --title Alpha --edge-port 8091   # 生成随机密码并打印
bin/mt.sh add beta  --user bob   --title Beta  --edge-port 8092
bin/mt.sh up                      # 渲染 + 构建网关 + 启动 + 等待就绪
bin/mt.sh url                     # 打印入口地址
```

前置条件：宿主已装 Docker 与 compose v2；有一个可用的 DSH 运行时镜像（见 `.env` 的 `DSH_IMAGE`，
例如从 npm 安装构建：`node:22-bookworm-slim` + `npm i -g @deepseek-ai/dsh@<版本>`）。

## 0.0 模型接入

管理员统一配置模型，租户在界面里自选。

**真凭据只放在 `.env`，只注入模型网关容器：**

```bash
# .env
MT_UPSTREAM_API_KEY=sk-...                  # 管理员自己的 key，租户永远拿不到
#MT_UPSTREAM_BASE=https://api.deepseek.com  # 换成私有化端点时改这里
```

DSH 内置的 `deepseek-official` 卡片提供两个模型（`deepseek-flash` = DeepSeek-V41-Flash、
`deepseek-v4-pro` = DeepSeek-V4-Pro），配好 key 后租户在模型选择器里直接能看到，
不需要写 `model.patch.yml`。要接**别的** OpenAI 兼容端点时写 `model.patch.yml` 再 `bin/mt.sh model`。

### 为什么需要一个模型网关

租户的 agent 以 `danger-full-access` 运行（内核 3.10 跑不了 DSH 自带沙箱），**容器里的任何凭据
都等于租户手里的凭据**。原先真 key 通过 `env_file` 注入每个租户容器，一条 `env` 就能读走，
还能经出口代理外发。

现在租户容器里只有一个**按租户生成的占位 key**（`sk-mt-<租户>-…`），请求发往 `mt-model-gateway`：

```
租户容器 ──x-api-key: sk-mt-alpha-…──▶ mt-model-gateway ──x-api-key: <真 key>──▶ 出口代理 ──▶ api.deepseek.com
             （占位，读走也没用）          （唯一持有真凭据）        （容器出网的唯一通道）
```

网关做的事：

- 用占位 key 认出是哪个租户；**认不出的 key 一律 401**（否则网关就是任何人可用的中转）；
- 换成真 key 转发上游，路径与方法原样透传，所以 Messages API、文件上传、流式响应都照常；
- 按租户记录 token 用量到 `logs/model-usage.jsonl`。

网关不占宿主端口：它在 `mt-net` 上，经出口代理出网（这也是本机 `ip_forward=0` 下 bridge 容器
唯一的出网方式）。

**注意**：租户要访问网关，所以 `mt-model-gateway` 必须在 `NO_PROXY` 里，否则请求会被出口代理
按"私网地址"拒掉——默认值已经包含它。

### 用量账本

```bash
bin/mt.sh usage                  # 按租户汇总：调用次数、输入/输出 token、缓存命中、平均耗时
bin/mt.sh usage --tail 20        # 再看最近 20 条明细
bin/mt.sh usage --tenant alpha
```

因为真凭据只在网关，这份账本是可信的：租户绕不过它（除非管理员另外给它一把真 key）。

### 验证某个租户真的能对话

```bash
bin/model-check.sh --tenant alpha --user alice --password <pw>
bin/model-check.sh --tenant alpha --user alice --password <pw> --model deepseek-v4-pro
```

固定选 `deepseek-flash` 做测试，不依赖会话默认值，避免测试打到更贵的模型上；它会核对回复
确实来自选定的那个模型。

### 租户怎么出网：出口代理

**本机 `net.ipv4.ip_forward=0`，bridge 容器没有任何外网路由**——连公网 DNS 都解析不了。
`mt-egress-proxy` 跑在宿主网络命名空间里（用宿主的出口），监听一个**宿主防火墙未放行**的端口，
所以只有容器连得上，局域网连不上。租户容器的 `HTTPS_PROXY`/`HTTP_PROXY` 由 `bin/mt.sh up`
自动探测并写入 `.env` 的 `MT_EGRESS_PROXY`。

它同时是租户的**出网边界**：目标是私网、回环、链路本地地址时一律 403。要限制只能访问特定域名，
设 `MT_EGRESS_ALLOW`。本部署自己的内网服务（模型网关、验收用的假模型）要放进 `MT_NO_PROXY`。

`bin/mt.sh doctor` 会实测：从租户容器经代理访问公网应通、访问内网地址应被拒。

## 0.1 用本地源码构建运行时镜像

默认的 `DSH_IMAGE` 是 npm 发行版。要让部署跑**你改过的源码**，把本地构建产物做成覆盖层叠到基础镜像上：

```bash
# ① 源码检出里：构建三个面（宿主 lib、客户端 bundle、Web dist）
pnpm run build:lib && pnpm run build:web        # 或 Windows 上的 build-dsh.ps1

# ② 生成覆盖层（目录结构 = 容器内安装路径）
node deploy/multi-tenant/bin/make-image-overlay.mjs --src . --out image-overlay
tar -czf image-overlay.tar.gz -C image-overlay .

# ③ 上传到部署机并发布镜像
scp image-overlay.tar.gz root@<主机>:/tmp/
ssh root@<主机> 'cd /home/dsh-mt && bin/mt.sh publish-image "" /tmp/image-overlay.tar.gz'

# ④ 切换租户到新镜像
ssh root@<主机> 'cd /home/dsh-mt && bin/mt.sh up'
```

`publish-image.sh` 会在构建后**核对镜像内的 `index.html` 哈希与覆盖层一致**，不一致直接失败——
避免出现"以为部署了新代码、其实没有"。

刻意不做的事：原生插件（`build:native-system`）产出的是构建机的 `.node`，不能跨平台塞进 Linux 容器；
Electron 桌面包与 Web 部署无关。两者都不影响 Web GUI。

## 0.2 传输加密

```bash
bin/mt.sh cert                     # 生成自签 CA + 服务端证书
bin/mt.sh up                       # 重新渲染：公开端口切到 HTTPS
```

- 为什么是**两级链**而不是一张自签证书：客户端要导入签发者，而宿主 curl 用 NSS，它拒绝把
  `CA:TRUE` 的证书当服务器证书用；一级自签在 OpenSSL 下又会报 `Issuer certificate is invalid`。
- 产物：`state/tls/ca.crt` 导入客户端信任库；`server.crt`（叶子+CA 链）与 `server.key` 由网关加载。
- SAN 自动覆盖：本机局域网 IP、`localhost`/`127.0.0.1`、注册表里每个租户的 hosts 条目；
  额外的主机名用 `bin/mt.sh cert "dsh.example.com,10.0.0.9"` 追加。
- 启用后：公开端口（8090 及每个租户的专属端口）只说 HTTPS，明文请求被拒；
  网关为每个响应的 `dsh-auth-*` 与 `mt_session` cookie 补上 `Secure`（DSH 自己不知道它在 TLS 终结之后）。
- 本机运维脚本改走 loopback 明文端口 `${MT_HTTP_PORT:-8099}`，它只绑定 127.0.0.1。
- 换用你们 CA 签发的证书：替换 `server.crt` / `server.key` 两个文件即可，网关只读它们。

## 0.3 日志上限

```bash
# .env
MT_LOG_MAX_SIZE=10m     # 单个日志文件上限
MT_LOG_MAX_FILE=3       # 保留份数
```

Docker 的 `json-file` 驱动**默认不封顶**：容器一直往 stdout 写就会把磁盘写满——崩溃重启循环、
或者每次请求写一行的代理都会这样。`bin/render.js` 因此给每个容器（租户、网关、出口代理、
模型网关、验收假模型）都写上 `logging.options`，单容器最多占用 `上限 × 份数`（默认 30 MB）。

DSH 本身几乎不往 stdout 写（实测一个租户跑了几轮对话只有 1 行 236 字节，它写的是会话文件），
所以这个上限主要防病态情况；真正话痨的是每次请求写一行的出口代理和模型网关。

`bin/mt.sh doctor` 逐个容器核实上限是否生效，并报出当前占用。

**注意**：这是本部署的容器。宿主 `daemon.json` 没有全局 `log-opts`，**其它系统的容器仍然无上限**，
那不属于本部署的范围。

## 0.4 运行时注册（控制面与运行时解耦）

控制面**不再自己找容器**：它不挂 Docker socket，也不读容器日志。租户运行时的地址和启动
token 由**运行它的那台机器**注册进来。

```bash
bin/mt.sh runtimes              # 控制面当前认识哪些运行时
bin/mt.sh register <租户>        # 注册本机上的某个租户（自动取地址与 token）
bin/mt.sh register <租户> --endpoint=http://10.0.0.9:3181 --token=<启动token> --node=node2
bin/mt.sh unregister <租户>      # 让控制面忘掉它（数据不动）
```

`bin/mt.sh up` / `add` / `restart` / `model` 都会自动重新注册——**容器重建会换掉 bridge 地址，
重启会换掉启动 token**，两者都必须重新上报，否则控制面会代理到旧地址，或拿着上一次的 token
去激活（DSH 每次启动都会换 token，用旧的会被拒）。

**协议**（节点 → 控制面，用 `state/registry.key` 认证）：

```
POST /__mt/registry/register    {"tenant":"alpha","endpoint":"http://…","token":"…","node":"node2"}
POST /__mt/registry/unregister  {"tenant":"alpha"}
GET  /__mt/registry             列出全部（loopback 免密钥，远端需要密钥）
```

**为什么这样设计**：

| | 以前 | 现在 |
|---|---|---|
| 控制面怎么找运行时 | 读本地 Docker API 查容器 IP、读容器日志取 token | 只读注册表 |
| 控制面权限 | 挂 `/var/run/docker.sock`（只读）——攻破网关等同于拿到宿主 root | 不挂任何 Docker |
| 运行时在哪 | 必须与控制面同机 | 任意机器，只要能注册进来 |
| 出故障时的可诊断性 | 容器不在本机就无从查起 | 未注册时页面直接提示该执行哪条命令 |

**新增一个节点的三件事**：

1. 该节点的租户容器要能被控制面连上；
2. 租户的 profile patch 里必须有 `connection.trustedHosts`，值是控制面代理时使用的 authority
   （`dsh-<租户>.internal`）——**DSH 的 Host/Origin 防护网拒绝它没被告知的非 loopback authority，
   会对所有 `/api/*` 回 403**，表现为"界面能打开但什么都点不动"。`bin/render.js` 自动维护这个块，
   老租户下次渲染时自动补上，不需要 `--force-patch`；
3. 在该节点执行 `bin/mt.sh register <租户> --endpoint=… --node=<节点名>`。

## 1. 隔离模型

| 维度 | 隔离方式 |
|---|---|
| 身份 | 网关按租户校验用户名/密码（scrypt），签发只属于该租户的会话 cookie |
| 会话 | 每个租户一个容器，`DSH_HOME`、`workspace`、`profiles` 都是独立目录 |
| DSH cookie | DSH 的浏览器 cookie 名由 Host authority 派生；网关对每个租户改写为 `dsh-<租户>.internal`（稳定名字，与运行位置无关），因此 **一个租户的 cookie 在另一个租户那里必然 401** |
| 凭据 | 每个租户自己的 `.credentials.yaml`（各自随机签名密钥），模型 key 按租户注入 |
| 执行 | 每租户一个容器（独立 PID/挂载/网络命名空间）+ 内存/CPU/PID 限额；宿主内核 3.10 无法跑 DSH 自带文件沙箱，容器即边界 |
| 网络 | 租户容器不发布任何端口，只有网关能被访问；出网必须经 `mt-egress-proxy`，私网目标被拒 |
| 宿主端口 | **默认不设防，必须显式收紧**：Docker 把网桥放进 firewalld 的 `docker` 区域，而该区域是 `target: ACCEPT`，容器因此能直达宿主上任何监听端口（Harbor、Nexus、Nacos、Prometheus、Grafana…）。`bin/mt.sh isolate apply` 给自己的网桥加 direct 规则，只放行出口代理端口（见 §1.2） |
| 审计 | 网关按请求写 `logs/access.jsonl`（租户、用户、方法、URL、状态码、耗时） |

## 1.1 多机部署（节点代理 + 节点自建容器）

控制面与运行时解耦之后，租户可以分布在多台机器上。**每台节点跑同一套项目**，靠 `MT_NODE_NAME`
决定自己该管哪些租户。

### 控制面：登记一个住在别处的租户

```bash
bin/mt.sh add gamma2 --user gina --node node2   # 只登记，不会在本机建容器
bin/mt.sh render                                 # 不会为它生成 compose 服务
```

`node` 不是 `local` 的租户，控制面不建 home、不建容器、不生成专用入口；它只保留登录与路由所需的
注册表条目。查状态用 `bin/mt.sh runtimes`（等节点上报后出现）。

### 节点：自己把分配给它的租户拉起来

```bash
# 项目目录（bin/ gateway/ egress-proxy/ model-gateway/ node-agent/）放到节点上，
# 然后从控制面取两份东西：租户注册表、注册密钥。
scp <控制面>:/home/dsh-mt/tenants.json        /home/dsh-node/tenants.json
scp <控制面>:/home/dsh-mt/state/registry.key  /home/dsh-node/state/registry.key

cd /home/dsh-node
MT_NODE_NAME=node2 bin/mt.sh up      # 只渲染/创建属于 node2 的租户 + 本机出口代理与模型网关
```

节点侧的 `up` 会为这些租户生成 home 与 profile patch（含 `webserver.port` 与
`connection.trustedHosts`），然后建容器——**控制面从头到尾没有碰过它们的容器**。

同一台机器上模拟多个节点时需要区分，这三个变量就是为此（真实分机不需要）：

| 变量 | 作用 |
|---|---|
| `MT_NETWORK` | 容器加入的 Docker 网络名（默认 `mt-net`；Swarm 下改成 overlay 名） |
| `MT_NETWORK_EXTERNAL=1` | 网络已存在、不是 compose 建的（共享宿主、overlay） |
| `MT_CONTAINER_NAME_PREFIX` | 本机容器名前缀（默认 `mt-`），避免同机多节点撞名 |

### 节点代理：发现 → 上报 → 转发

```bash
docker build -t mt-node-agent:local ./node-agent
docker run -d --name mt-node-agent --network host --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /home/dsh-node/state:/key:ro -v /home/dsh-node/ca.crt:/ca/ca.crt:ro \
  -e MT_NODE_NAME=node2 -e MT_NODE_ADDRESS=<本机局域网IP> \
  -e MT_CONTROL_PLANE=https://<控制面>:8090 -e MT_CONTROL_PLANE_CA=/ca/ca.crt \
  -e MT_REGISTRY_KEY_FILE=/key/registry.key -e MT_NETWORK=mt-net \
  mt-node-agent:local
```

代理做三件事：**发现**本机租户容器（按 `mt.tenant` 标签，不看容器名）、**上报**给控制面
（地址 + 启动 token，变了就重报——重启会换 token，重建会换地址）、**转发**控制面发来的请求
（保留控制面的 Host/Origin，DSH 的 cookie 名依赖它）。

**为什么必须经过代理**：租户容器不发布端口，而 `ip_forward=0` 的机器上发布了也到不了；
只有节点宿主自己能"本地投递"到容器。代理跑在宿主网络里，正好是这一跳。

**端点可以带路径**：代理注册的是 `http://<节点>:3199/proxy/<租户>`，控制面会把这段前缀
拼在转发路径前面——少了它请求会打到代理根路径（404）。

## 1.2 限制租户对宿主端口的访问

```bash
bin/mt.sh isolate status     # 查看状态（doctor 每次也会实测）
bin/mt.sh isolate apply      # 应用（bin/mt.sh up 会自动执行）
bin/mt.sh isolate remove     # 撤销
```

租户的 agent 以 `danger-full-access` 运行（宿主内核 3.10 跑不了 DSH 自带沙箱），
它能敲到的每个宿主端口就等于交给了租户。宿主上跑着别的系统，从局域网访问它们被
`public` 区域挡着，**从我们的容器里却不设防**。

做法：给本部署的网桥在 firewalld 里加两条 `--direct` 规则——放行出口代理端口，其余丢弃。

挂在 `INPUT_direct` 的原因：firewalld 的评估顺序是

```
INPUT: 1 ESTABLISHED,RELATED → 2 lo → 3 INPUT_direct → 4 ZONES_SOURCE → 5 INPUT_ZONES → …
```

docker 区域的 ACCEPT 在第 5 步，规则必须挂在第 3 步才拦得住。`--direct` 规则写进 firewalld
的**永久配置**，所以 `firewall-cmd --reload`（`bin/mt.sh add` 每次开端口都会触发）和主机重启
都不会丢。

只匹配本部署网桥的入向流量：其它系统的容器不受影响，租户之间的流量也不经过这条链。

## 2. 目录

| 路径 | 作用 |
|---|---|
| `tenants.json` | 租户注册表：用户、端口、限额（唯一事实来源） |
| `.env` | 端口、镜像、每个租户的模型 key（0600） |
| `docker-compose.yml` | **生成物**，由 `bin/render.js` 从 `tenants.json` 渲染 |
| `gateway/server.js` | 控制面（仅用 Node 标准库） |
| `tenants/<id>/home` | 该租户的 `DSH_HOME`：会话、设置、凭据（备份这里＝备份该租户的全部数据） |
| `tenants/<id>/workspace` | 该租户 agent 的工作目录 |
| `state/session.key` | 网关会话签名密钥（删除＝所有人重新登录） |
| `logs/access.jsonl` | 访问审计 |
| `build/`、`entry-urls.txt` | 生成物 |
| `state/tls/` | TLS 证书与私钥（`ca.crt` 给客户端导入） |
| `egress-proxy/server.js` | 租户出口代理：宿主网络 + 未放行端口 = 只有容器可达 |
| `bin/isolate.sh` | 租户→宿主 端口限制（firewalld direct 规则） |
| `model-gateway/server.js` | 模型网关：真凭据的唯一持有者，按租户的占位 key 识别、换成真 key、计量 |
| `logs/model-usage.jsonl` | 按租户的模型用量账本（`bin/mt.sh usage` 读它） |
| `backups/` | `bin/mt.sh backup` 的归档 |

## 3. 日常操作

```bash
bin/mt.sh up                       # 渲染 + 构建 + 启动 + 等待就绪 + 打印入口
bin/mt.sh status                   # 容器状态 + 就绪情况
bin/mt.sh doctor                   # 自检：前置条件/配置/租户/控制面/防火墙/模型/资源/备份
bin/mt.sh url                      # 打印入口地址
bin/mt.sh logs alpha               # 看某个租户的运行日志
bin/mt.sh add delta --user dave    # 开通新租户（一条命令走完全流程，见下）
bin/mt.sh remove delta             # 摘除租户（保留数据）；--purge 连数据一起删
bin/mt.sh passwd alpha alice       # 重置密码（会打印新密码）
bin/mt.sh key alpha sk-xxxx        # 写入该租户的模型 key，然后 bin/mt.sh up
bin/mt.sh smoke --tenant alpha --user alice --password <pw>   # 隔离性冒烟测试
bin/mt.sh accept --tenant alpha --user alice --password <pw>  # 端到端验收（含一次真实模型调用）
bin/mt.sh backup                   # 备份全部租户数据 + 控制面状态（默认冻结快照）
bin/mt.sh restore <归档>           # 恢复；现有数据挪到 restore-aside-<时间戳>/ 而不删除
bin/mt.sh publish-image            # 用已上传的覆盖层构建本地源码镜像
bin/mt.sh cert [额外SAN]           # 生成自签 CA + 服务端证书，之后 bin/mt.sh up 切到 HTTPS
bin/mt.sh model                    # 应用 model.patch.yml / model.env 到全部租户
bin/mt.sh isolate [apply|remove|status]   # 限制租户可访问的宿主端口
bin/mt.sh usage [--tenant <id>] [--tail <n>]   # 按租户汇总模型用量
```

### 开通新租户

```bash
bin/mt.sh add delta --user dave
```

这一条命令做的事：

1. 写注册表：自动分配内部端口（3181 起）和**专属入口端口**（8091 起），随机生成密码；
2. 渲染 compose 与 `tenants/<id>/home/profiles/web/cordis.patch.yml`；
3. 防火墙放行新的专属端口；
4. **只启动这一个 service**，已有租户不受影响；
5. 等它就绪（轮询网关健康接口），失败会提示看日志；
6. 打印用户名、密码、统一入口与专属入口。

**网关不需要重启**：它每 2 秒轮询 `tenants.json`，热加载新增/删除的租户、自动为新租户开专属端口监听、
并在租户被删除时关掉对应监听、清掉它的地址与 token 缓存。因此开通/摘除过程中，
其它租户正在使用的 WebSocket 与页面不会断。

`bin/mt.sh list` 可查看当前所有租户及其端口分配。

### 摘除租户

```bash
bin/mt.sh remove delta            # 停容器、删容器、从注册表摘除，数据留在 tenants/delta/
bin/mt.sh remove delta --purge    # 连数据一起删除（不可恢复，先确保有备份）
```

### 备份与恢复

```bash
bin/mt.sh backup                       # → backups/dsh-mt-<UTC 时间戳>.tar.gz，保留最近 7 份
bin/mt.sh backup --live                # 不冻结（打包期间 agent 继续跑）
bin/mt.sh backup --out /mnt/backup     # 换备份目录
bin/mt.sh restore backups/dsh-mt-xxx.tar.gz
```

- 归档含 `tenants/`（全部 `DSH_HOME` 与 workspace）、`state/`（网关会话密钥）、`tenants.json`、`.env`、`MANIFEST.txt`。
- 默认先用 `docker pause` 冻结各租户再打包（几秒），避免抓到写了一半的会话日志；`--live` 跳过冻结。
- 恢复**不会删除**现有数据：先整体挪到 `restore-aside-<时间戳>/`，确认无误后再手动删。
- 内存密钥（`state/session.key`）也在归档里，恢复后原有浏览器会话继续有效。


## 4. 用户怎么访问

1. 打开 `http://<主机IP>:8090/`；
2. 只填**用户名 + 密码**（登录页没有租户选项）；
3. 网关自动完成 DSH 的 token 交换并把界面交给你 —— 用户看不到 token，**整个过程零重定向**；
4. 也可以给租户配专属端口（`--edge-port`）或 `hosts` 条目（`alpha.dsh.local`），走同一个控制面。

租户是怎么定出来的（按顺序）：

1. 表单里显式带了 `tenant` 字段（脚本和旧书签用得到，普通用户不需要）；
2. 请求到达的地址能对应到某个租户（专属端口 8091 / `alpha.dsh.local`）；
3. 否则按**用户名**在注册表里找唯一拥有者。同名用户在多个租户下时共享入口无法判定，会提示改用专属入口——`bin/mt.sh add` 与 `bin/mt.sh render` 都会就此告警。

**退出 / 切换用户**：直接访问 `http://<主机IP>:8090/__mt/logout`。

- 它同时清掉网关会话和该浏览器持有的**所有**租户 DSH cookie，所以换用户不会串；
- 控制面自己的 `/__mt/` 页面上也有"退出登录 / 切换用户"链接，但登录后你人在 DSH 界面里看不到那个页面，所以请用上面的地址（可存书签）。

DSH 的 cookie 默认 30 天，期间不用重复登录网关也会自动续上；清除浏览器 cookie 或换浏览器时会重新激活一次。

## 5. 为什么控制面用 host 网络

宿主 `net.ipv4.ip_forward = 0`，从局域网进来的包被 DNAT 到 bridge 网段后无法被转发，因此**这台机器上任何 bridge 网络映射的端口对外都不通**（同机的 Harbor 18083、Grafana 13000、Nacos 18081、capex 18000/8089 实测同样超时；只有 host 网络的 3080 通）。VM 自己访问这些端口会走本地路径，所以在本机上自测永远是通的——这正是最初遗漏外部验证的原因。

处理方式（不改宿主全局设置）：

- **控制面 `mt-gateway` 用 `network_mode: host`**，直接监听宿主 8090–8093；对外访问走 INPUT 路径，不需要转发。
- **租户容器仍留在 `mt-net`**，不发布任何宿主端口；控制面只按注册进来的地址代理（`tenantAddress()`），Host 与 Origin 一并改写为租户的 authority（`dsh-<租户>.internal`），cookie 语义不变。
- 如果你希望整机恢复标准的 Docker 端口映射行为，可以自行执行 `sysctl -w net.ipv4.ip_forward=1` 并持久化——但那会同时把上面列出的其它服务端口暴露给网段，属于全机范围的变更，本部署刻意没有替你做。

## 6. 模型接入

两种方式，可混用：

**A. 一处配置、所有租户共用**（适合内网统一网关）

```bash
vi model.patch.yml     # 填 baseURL / 模型 id（把 CHANGE-ME 全部替换掉）
vi model.env           # 填 GATEWAY_API_KEY=<key>
bin/mt.sh model        # 渲染 + 应用到所有租户 + 重启
```

`model.patch.yml` 的内容会被写进每个租户 profile patch 的标记块里；标记块之外是租户自己的设置，重新渲染不会覆盖。
只要文件里还有 `CHANGE-ME`，渲染就跳过它。

**B. 租户各自配置**（适合每个租户自带 key）

让租户在自己的 Web UI 里进 Settings → Models 填写，key 存进该租户的 `home/.credentials.yaml`，其它租户看不到。

单个租户单独给 key：`bin/mt.sh key <租户> <key>` 后 `bin/mt.sh up`。

## 7. 验证过的行为

`bin/mt.sh smoke` 在部署上实测通过（15/15）：

| 检查 | 结果 |
|---|---|
| 未登录访问统一入口 | 200 登录页，页面不含任何 DSH cookie 名 |
| 登录 | 303 + 网关会话 cookie |
| 首次访问自动激活 | 302 → token 交换 → 200 DSH 前端 |
| 经网关调用 API | `account/getState` 返回 `ok:true` |
| 跨租户访问 | 以 A 的身份访问 B 的专属入口 → 403 并记入审计 |
| 租户 cookie 复用 | A 的 DSH cookie：A 的运行时 200，B 的运行时 401 |
| 状态隔离 | 每租户独立 `.credentials.yaml`，签名密钥互不相同 |

另外核对过：前端 shell 引用的 10 个资源（含 10.4 MB 的插件包）经网关全部 200 且字节数与直连容器一致；
`/api/remote.mux` WebSocket 经网关升级返回 101，未登录时为 401。

`bin/mt.sh accept --tenant <id> --user <u> --password <pw>` 跑的是**端到端验收**：临时接一个 OpenAI 兼容的假模型，
走完"管理员模型目录 → 租户登录 → 看到可选模型 → 选模型 → 建会话 → 发消息 → 收到回复落进自己的会话日志"整条链路，
跑完自动把租户的模型配置恢复原状并移除假模型。实测 11/11 通过：

| 检查 | 证据 |
|---|---|
| 模型目录 | `session/modelCatalog` 返回管理员配的 provider 与其两个模型 |
| 选择模型 | `session/selectModel` 回执为所选 `mock-strong` |
| 发消息 | `session/prompt` 返回 `accepted: true` |
| 模型被真实调用 | 假模型日志出现 `model=mock-strong` 的请求 |
| 回复落盘 | 该租户 `home/sessions/.../session.v4.jsonl.zstd` 里出现回复文本 |
| 跨租户 | 另一个租户的 `home` 里找不到这次会话的任何痕迹 |

## 8. 安全边界与已知限制

- **控制面是唯一的对外入口，但不再是宿主 root 等价物**：它只监听公开端口、按注册表代理，**不挂 Docker socket、不读容器日志**。需要宿主级权限的是**节点代理**（它要发现本机容器并读它们的启动 token），而节点代理不对外提供任何用户入口。
- **/__mt/health 只答 loopback**：它会列出全部租户与用户名，因此外部访问返回 404；in/mt.sh status/smoke/accept 都在本机跑，不受影响。
- **租户之间不共享任何进程状态**：不共享 cookie 密钥、不共享会话、不共享凭据、不共享文件系统。
- **租户内部的 agent 拥有其容器的完全权限**（可 `rm -rf /` 于容器内、可访问网络）。这是形态 C 的设计：容器即隔离边界；`DSH_PERMISSION_MODE=danger-full-access` 是宿主内核不支持 DSH 文件沙箱时的必然选择。
- **没有 TLS**：如需 HTTPS，在网关前面再加一层 TLS 终结（nginx/Caddy），或给网关加证书。
- **没有租户自助管理**：新增租户由运维执行 `bin/mt.sh add`。
- **配额是容器级的**（内存/CPU/PID），磁盘配额需要宿主的 project quota 或独立卷。
- **默认不共享模型凭据**：每个租户在 `.env` 里独立配置；留空则租户启动后无可用模型。
- **`model.env` 变了必须让 compose 重建容器**（内容参与服务哈希，`bin/mt.sh up` 会重建；只 `docker restart` 不会）。

## 9. 与单租户部署的关系

本目录是独立的一套 compose 项目（网络 `mt-net`、容器名前缀 `mt-`），与 `/opt/dsh-vm`、`/opt/dsh-offline` 的单租户部署互不影响，可以并存。

## 10. 本次部署记录

| 项 | 值 |
|---|---|
| 部署目录 | `/home/dsh-mt` |
| 镜像 | `dsh-web:0.2.0-rc.2`（宿主已有），网关镜像 `mt-gateway:local` |
| 统一入口 | `http://<部署主机>:8090/` |
| 租户专属入口 | alpha `:8091`、beta `:8092`、gamma `:8093` |
| 租户与用户 | alpha/alice、beta/bob、gamma/carol（密码在创建时打印，可用 `bin/mt.sh passwd` 重置） |
| 防火墙 | 已放行 8090-8093/tcp |
| 内存占用 | 网关约 28 MB，每个租户运行时约 95-100 MB |
| 构建注意 | 本机 Docker Hub 不可达，网关镜像用 `DOCKER_BUILDKIT=0` 经典构建器构建（`bin/mt.sh` 已内置） |

租户数据目录：`/home/dsh-mt/tenants/<租户>/{home,workspace}`；备份 `home` 即备份该租户的全部会话与设置。
