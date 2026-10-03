# DSH multi-tenant control plane image.
# It needs no dependencies beyond the Node standard library.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY server.js /app/server.js
COPY admin.js /app/admin.js
COPY admin-page.js /app/admin-page.js
COPY mfa.js /app/mfa.js
COPY throttle.js /app/throttle.js
COPY rotate.js /app/rotate.js
COPY metrics.js /app/metrics.js
COPY tenant-lock.js /app/tenant-lock.js
COPY keys.js /app/keys.js

# 8090: public entry. Tenant runtimes are reachable only on the compose network.
EXPOSE 8090

# Runs as root only to write its own state (session key, runtime table) and the
# logs it rotates. It deliberately holds no Docker access: tenant runtimes are
# located through registrations a node posts, not by inspecting containers.
CMD ["node", "/app/server.js"]
