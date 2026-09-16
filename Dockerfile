# ===== Stage 1: 构建 =====
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 workspace 配置
COPY package.json package-lock.json* ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# 按锁文件安装依赖（--ignore-scripts 跳过 Prisma 的联网 postinstall）
RUN npm config set registry https://registry.npmmirror.com && \
    npm ci --no-audit --no-fund --ignore-scripts

# 复制源码
COPY . .

# 生成 Prisma WASM client（使用镜像源加速引擎下载）
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
RUN cd apps/server && npx prisma generate

# 构建后端 + 前端
RUN npm run build -w apps/server && npm run build -w apps/web

# ===== Stage 2: 运行时 =====
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl libc6-compat tzdata

WORKDIR /app

# 复制依赖与构建产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/src/schema.prisma ./apps/server/src/schema.prisma
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/package.json ./package.json

# 数据持久化
RUN mkdir -p /data
ENV DATABASE_URL="file:/data/tagtime.db"
ENV HOST=0.0.0.0
ENV PORT=3000

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1));req.on('error',()=>process.exit(1))"

# 启动：首次运行自动创建/更新数据库表（失败时保留日志便于排查），然后启动服务
CMD ["sh", "-c", "cd apps/server && npx prisma db push --skip-generate; cd /app && node apps/server/dist/index.js"]

