FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

ENV NODE_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1

CMD ["node", "server.js"]
