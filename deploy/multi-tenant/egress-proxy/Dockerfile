# 租户出口代理：跑在宿主网络命名空间里（bridge 容器没有外网出口），
# 只监听宿主防火墙未放行的端口，因此只有租户容器能连上它。
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY server.js /app/server.js

EXPOSE 3128

CMD ["node", "/app/server.js"]
