# DSH multi-tenant control plane image.
# It needs no dependencies beyond the Node standard library.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY server.js /app/server.js

# 8090: public entry. Tenant runtimes are reachable only on the compose network.
EXPOSE 8090

# Runs as root because it reads the Docker socket to resolve each tenant's
# current launch token. The gateway is the trusted control plane; tenants are
# the untrusted side of that boundary.
CMD ["node", "/app/server.js"]
