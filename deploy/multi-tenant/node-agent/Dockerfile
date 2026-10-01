# 节点代理：跑在节点宿主网络里，负责发现/上报/转发该节点的租户运行时。
#
# 它是这套部署里"有特权"的那一半：需要 Docker socket 才能发现容器地址与启动 token。
# 控制面则完全不碰 Docker，只代理注册进来的地址。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY server.js /app/server.js

EXPOSE 3199

CMD ["node", "/app/server.js"]
