# 控制面高可用（两网关 + 入口 nginx）

## 形态

```
浏览器 / 节点代理
      │  https://<入口>/ai/harness/
      ▼
入口机 nginx  ── upstream dsh_control ──┬─► 主网关 A :8090（控制面）
   （唯一入口，健康检查自动切换）        └─► 备用网关 B :8090（backup）
                                              ▲
                        bin/mt.sh ha-sync ────┘  每 60 秒单向同步状态
```

两台网关跑的是**同一套部署**（同样的 `tenants.json`、同样的 `state/`），所以浏览器会话
（`session.key` 签的名）与运行时表（`runtimes.json`，含租户激活需要的启动 token）在切换后
都还在；节点代理指向前端，切换后 15 秒内自动跟着走。

## 一台备用网关怎么加

```bash
# 在备用机上（部署目录已就位：离线包或从主网关拷一份）
bin/node-install.sh --standby --node standby1 \
  --control-plane https://<入口>/ai/harness --fetch-from <主网关地址>
bin/mt.sh up                       # 网关 + 出口代理 + 模型网关；不跑租户、不跑备份
bin/mt.sh ha-sync --from <主网关地址> --install-timer   # 每 60 秒同步状态，开机自启
```

入口机 nginx 把备用机加进 `upstream`（`ha/nginx.conf`：`server <B>:8090 backup;`）后 reload。

入口机自己这一层 TLS 用部署的同一套自签证书即可（`state/tls/server.crt|server.key`，只读挂进去）。
起法（名字**不要**用 `mt-` 开头：那会混进 `bin/acceptance.sh` 的容器计数，被当成部署的一部分）：

```bash
docker run -d --name dsh-front --network host --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v /path/ha/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /path/state/tls:/etc/nginx/tls:ro nginx:1.28-alpine
```

`ha-sync` 同步的是：`tenants.json` 与 `state/{session.key,keys.json,registry.key,register.key,
ops.key,admin.json,admin.key,runtimes.json,bandwidth.json,quota.json,tls}`。**不含 `logs/`**。

## 切换时会发生什么（预期行为，别当成故障）

| 现象 | 说明 |
|---|---|
| 入口停几秒后恢复 | nginx 的 `max_fails=2 fail_timeout=5s` 决定；实测窗口见《离线部署手册》 |
| 已登录的用户不用重新登录 | 两台共用 `state/session.key`；DSH 的租户 cookie 由网关侧维护 |
| 迁移/重启过的租户仍能进 | 运行时的启动 token 在 `runtimes.json` 里，已同步 |
| 控制台"历史"只看到本实例那段 | `logs/` 不合并（两台各写各的）；指标与告警不受影响 |
| 租户的**专属入口端口**在这一段时间不可用 | 专属端口只在主网关开（备用机 `MT_EDGE_LISTEN=0`）；共享入口按会话路由，不受影响 |

## 回退到单机

删掉 nginx `upstream` 里的 `backup` 那一行并 reload；备用机上 `bin/mt.sh down` 即可（它的数据
目录只有同步过来的状态，没有租户数据）。

## 前置条件

- 两台机器能互相免密 ssh（`ha-sync` 要拉主网关的 `state/`）。
- 备用机的镜像与主网关一致（同一个离线包 `install-offline.sh` 装出来即可）。
- 备用机的 `MT_BASE_PATH`、`MT_KEY_LOGIN_*`、`MT_EDGE_PORT`、TLS 证书与主网关**完全一致**
  （`node-install.sh` 只写角色相关的那几个键；其余从 `.env.example`/离线包来，天然一致）。
- 入口机 → 两台网关的 `MT_EDGE_PORT` 放通；**承载租户的每台机器 → `bin/mt.sh agent allow <两台网关地址>`**
  （租户请求是网关转到节点 3199 的，只放主网关时切换过去就是 502）。
