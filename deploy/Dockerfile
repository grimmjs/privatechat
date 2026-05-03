FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Native build tools for sqlite3; wget for healthcheck
RUN apk add --no-cache python3 make g++ sqlite wget

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --build-from-source

FROM base AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /app/data /app/uploads /app/backups && \
    chown -R node:node /app/data /app/uploads /app/backups

EXPOSE 3000
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

USER node
CMD ["node", "server.js"]
