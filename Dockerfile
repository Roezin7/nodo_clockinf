# NODO CLOCK-IN — imagen única para Coolify: API Express + cliente estático.
# La base de datos es un recurso Postgres de Coolify, inyectado vía DATABASE_URL.

# ---------- Build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY shared shared
COPY server server
COPY client client
RUN npm run build

# ---------- Runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY server/migrations server/migrations

# app.ts resuelve ../client/dist relativo al cwd: debe ser /app/server
WORKDIR /app/server

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/api/health" || exit 1

CMD ["sh", "-c", "npm run migrate && npm start"]
