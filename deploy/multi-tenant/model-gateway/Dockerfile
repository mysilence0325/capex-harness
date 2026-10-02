# 模型网关：真凭据的唯一持有者。租户容器里只有按租户生成的占位 key。
#
# 它需要出网，但本机 ip_forward=0，bridge 容器没有外网路由，所以它经出口代理
# （mt-egress-proxy）转发，而不是自己占一个宿主端口。
#
# 构建上下文是项目根目录（见 bin/render.js 与根目录的 .dockerignore），因为用量日志
# 的轮转要和控制面用同一份实现，而不是各写一份、日后各自跑偏。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY model-gateway/server.js /app/server.js
COPY gateway/rotate.js /app/rotate.js

EXPOSE 8080

CMD ["node", "/app/server.js"]
