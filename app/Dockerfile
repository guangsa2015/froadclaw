# ========== 阶段1：安装依赖 + 构建 ==========
FROM node:22-alpine AS builder

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# 先复制依赖描述文件，利用 Docker 缓存层
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 复制源码 + 配置，执行构建
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN pnpm run build

# 生产依赖单独安装（不含 devDependencies）
RUN pnpm install --frozen-lockfile --prod

# ========== 阶段2：精简运行镜像 ==========
FROM node:22-alpine AS runner

WORKDIR /app

# 仅复制运行所需文件
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./

# 配置文件由 Volume 挂载，这里复制一份默认值作为兜底
COPY configs/ configs/

# 创建数据和日志目录（挂载点）
RUN mkdir -p data logs

ENV NODE_ENV=production
ENV DB_PATH=/app/data/froadclaw.db
ENV LOG_DIR=/app/logs

EXPOSE 3000

CMD ["node", "dist/index.js"]
