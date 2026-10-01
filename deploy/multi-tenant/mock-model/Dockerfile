# Acceptance-only OpenAI-compatible stand-in for the private model service.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY server.js /app/server.js

EXPOSE 8080

CMD ["node", "/app/server.js"]
