# sub2api-custom：嵌入 sub2api 的 Nova Studio 镜像（ghcr.io/qlqqs/nova-image-studio:custom-*）
# 与上游 Dockerfile 的区别：前端以 NEXT_PUBLIC_NOVA_EMBED=1 构建（basePath /_nova），默认开启 NOVA_EMBED_MODE，
# 数据统一放 /data，以 node 用户运行。环境变量见 docs/sub2api-embed.md。
FROM node:24-slim AS frontend-builder

WORKDIR /app/frontend
# next.config 从根目录 package.json 读取版本号
COPY package.json /app/package.json
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ENV NEXT_PUBLIC_NOVA_EMBED=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS backend-deps

WORKDIR /app/backend
# better-sqlite3 没有匹配的预编译包时需要现场编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim AS production

WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NOVA_EMBED_MODE=1 \
    NOVA_CDP_ENABLED=false \
    NOVA_TASK_DB=/data/nova-tasks.sqlite \
    NOVA_IMAGE_DIR=/data/images

COPY --chown=node:node backend/ ./backend/
COPY --from=backend-deps --chown=node:node /app/backend/node_modules/ ./backend/node_modules/
COPY --from=frontend-builder --chown=node:node /app/frontend/out/ ./frontend/out/
RUN rm -rf backend/test && mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "backend/server.js"]
