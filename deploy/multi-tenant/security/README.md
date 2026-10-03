# 租户容器的 seccomp 策略

`seccomp-tenant.json` 是在 **Docker 默认策略之上追加拒绝** 的一份策略：默认策略继续负责
那份长长的允许清单，这份只额外拒绝 20 个租户容器用不到的系统调用（内核模块、内核密钥环、
固件与引导相关）。它们只在容器已经拿到高权限时才有意义，所以拒绝它们是零成本的。

## 怎么启用

在 `.env` 里列出要启用的租户，然后渲染并重建：

```bash
MT_SECCOMP_TENANTS=alpha,beta        # 逗号分隔；留空 = 全部用默认策略
bin/mt.sh render
bin/mt.sh up
```

**按租户启用是刻意的**：先放一个租户，看它跑得正常，再放开下一个。策略出问题时，
坏的是**一个**租户，而不是全部。

## 改这份策略之前请先读这三条

1. **`archMap` 里不要写 `subArchitectures`。** 声明 32 位兼容子架构会让 glibc 走 32 位
   路径去设置线程本地存储的 `%fs` 基址，结果是**每个进程**都以
   `cannot set up thread-local storage` 起不来（退出码 127）。Docker 默认策略也只声明
   `SCMP_ARCH_X86_64`。
2. **不要拒绝运行库与容器入口可能用到的系统调用。** 曾经把 `mount`、`personality`、
   NUMA 系列（`mbind`/`get_mempolicy`/`set_mempolicy`/`move_pages`）、`name_to_handle_at`、
   `setns`、`perf_event_open` 一起拒掉，租户直接崩溃循环。现在这份只保留明确无关的那批。
3. **先在一次性容器里验证，再碰线上租户。** 这一条挡得住上面两类错误：

   ```bash
   IMAGE=$(docker inspect mt-dsh-alpha --format '{{.Config.Image}}')
   docker run --rm --security-opt seccomp=$PWD/security/seccomp-tenant.json "$IMAGE" \
     node -e 'const http=require("node:http");const s=http.createServer((q,r)=>r.end("ok"));s.listen(0,()=>s.close())'
   ```

   能跑通再改 `.env`。渲染之后还要 `docker-compose config` 校验一次——它只能发现
   "配置不合法"，发现不了"配置合法但把容器弄崩"，所以两件事都要做。

## 怎么确认它真的生效

```bash
# 策略是否应用到这个容器
docker inspect mt-dsh-alpha --format '{{range .HostConfig.SecurityOpt}}{{.}}{{end}}' | head -c 60

# 策略机制本身是否被执行：用一个故意拒绝 write 的临时策略跑同一镜像，
# 它应当起不来；不加策略时应当正常。这个对照是本仓库验证 seccomp 的方式。
```

**策略在跑并不意味着拒绝项都被触发过** —— 这 20 个系统调用正常运行时本来就不会被调用，
所以"租户照常工作"与"策略确实拦得住"是两件事：前者靠四个租户的冒烟（各 15/15），
后者靠上面那个 `write` 对照实验。
