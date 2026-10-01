# 迁移到 Docker Swarm

这份文档把租户运行时从"每台机器上跑 compose"迁到 Swarm。**控制面不变，注册协议不变**——
这正是上一步把控制面与运行时解耦换来的。

## 为什么 Swarm 够用，以及为什么不是 K8s

这套部署的形态是**静态绑定**：每个租户一个长期存在的运行时，数据在这台机器的磁盘上。
Swarm 擅长的正是这个——多节点调度、服务名解析、secret 管理、滚动更新，运维成本大约是 K8s 的零头。
K8s 多出来的是有状态负载的调度、PV/StorageClass、Ingress 那一整套，对这个规模不划算。

**先做的判断**：如果你现在的瓶颈是"控制面被绑在单机上"，上一步已经解决了，不需要集群。
只有当你要**跨机器调度**（而不是手工指定租户住哪台）时，才值得上 Swarm。

## 变化清单

| 环节 | compose（现在） | Swarm | 说明 |
|---|---|---|---|
| 创建容器 | `docker-compose up -d dsh-<租户>` | `docker stack deploy -c swarm/stack.tenant.yml.example dsh-<租户>` | 每租户一个 stack，或一个 stack 里多个 service |
| 容器命名 | `mt-dsh-<租户>`（可控） | `<stack>_<service>.<slot>.<id>`（不可控） | **所以发现必须靠标签**，已实现并验证 |
| 租户数据 | 本机 bind mount | bind mount + `placement.constraints` 钉住节点 | 静态绑定的必然结果 |
| 镜像分发 | 本机 `publish-image` | 每台节点都要有该镜像 | 用你们已有的 Harbor，或 `docker save \| ssh docker load` |
| 网络 | compose 建的 `mt-net` | 同名 overlay 网络（`--attachable`） | 容器之间仍要能互通 |
| 出口代理 | 每台一份（host 网络） | **仍然每台一份** | 容器出不了本机，这点不因 Swarm 改变 |
| 模型网关 | 每台一份或控制面一份 | 每台一份（同理由） | 用量日志需要汇总 |
| **控制面网关** | host 网络 | **不变** | 它不参与编排 |
| **注册协议** | HTTP + 密钥 | **不变** | 节点代理照原样上报 |
| **authority / trustedHosts** | `dsh-<租户>.internal` | **不变** | 与运行位置无关 |

## 迁移步骤

```bash
# ① 在每台节点上初始化集群（只做一次；管理节点可以就是控制面所在的机器）
docker swarm init --advertise-addr <本机局域网IP>
docker swarm join --token <worker-token> <管理节点IP>:2377   # 在其它节点上执行

# ② 建一个可附加的 overlay 网络，名字与现在保持一致
docker network create --driver overlay --attachable mt-net

# ③ 每个节点都要有运行时镜像（走你们的 Harbor 最省事）
docker tag dsh-web:local-<标签> <harbor>/dsh-web:<标签>
docker push <harbor>/dsh-web:<标签>
# 或者离线：docker save dsh-web:local-<标签> | ssh <节点> docker load

# ④ 每台节点起节点代理与出口代理（它们不是 Swarm 服务：需要宿主网络与 Docker socket）
#    照 README §1.1 的命令，把 MT_NETWORK 指向同一个 overlay 网络名

# ⑤ 逐租户迁移：先在控制面把它标成远端，再在目标节点起 stack
bin/mt.sh unregister <租户>                      # 让控制面先忘掉旧地址
bin/mt.sh remove <租户>                          # 从本机 compose 中摘掉（数据保留）
#   —— 注意：这一步只是让控制面不再为它生成本地服务；数据目录要拷到目标节点
scp -r /home/dsh-mt/tenants/<租户> <节点>:<DATA_ROOT>/
docker stack deploy -c swarm/stack.tenant.yml.example dsh-<租户>
bin/mt.sh runtimes                               # 等代理上报后应能看到它

# ⑥ 回滚：docker stack rm dsh-<租户>，把数据拷回，bin/mt.sh up
```

租户数据迁移期间该租户不可用（几十 MB 到几 GB，取决于会话量）。**先备份再搬**：

```bash
bin/mt.sh backup                # 归档里有全部租户数据与 state/
```

## 已在真实环境验证的部分

| 项 | 状态 |
|---|---|
| 标签发现（Swarm 容器名变化的关键前提） | ✅ 实测：名为 `dshstack_dsh-gamma.1.abcdef` 的容器被正确识别为租户 |
| 注册协议、authority、trustedHosts 与运行位置无关 | ✅ 实测：模拟的第二台机器上的租户端到端可用 |
| 节点代理的发现/上报/转发 | ✅ 实测（宿主网络 + 独立网桥） |
| 出口代理必须在每台节点各一份 | ✅ 由 `ip_forward=0` 推导，并已在节点上验证 |

## 尚未验证的部分（需要真正的集群）

下面的内容**没有在本环境执行过**——共享宿主上跑着 Harbor、Nexus、Nacos 等系统，
`docker swarm init` 属于全机范围的变更，我不会未经许可去动它：

1. `docker stack deploy` 的实际行为（overlay 网络、placement 约束、滚动更新）；
2. 容器在 overlay 网络里能否被节点代理按同一套逻辑发现与转发；
3. 镜像从 Harbor 拉取（本机 Docker Hub 不可达，但 Harbor 在内网可用）；
4. Swarm 的 `secrets` 是否可以替代现在把密钥写进 env 的做法。

**建议的验证顺序**：先在一台**空闲**机器上 `docker swarm init`（单节点集群也足以验证 1–3），
把 `swarm/stack.tenant.yml.example` 部署起来，确认节点代理能发现并上报、控制面能代理过去；
确认无误后再把生产节点加进集群。
