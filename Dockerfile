# AI Art Frame 一体化镜像：Fastify 服务端 + Vue 前端静态托管 + SQLite，单容器运行。
# 数据（SQLite 库 / 漫画图 / 自定义字体）全部在 /app/server/data，挂载卷即可持久化。

# ---------- 构建阶段：装依赖、编译前后端、裁剪生产依赖 ----------
FROM docker.m.daocloud.io/library/node:20-bookworm-slim AS build
# better-sqlite3 / sharp 优先用预编译二进制；下载不到时源码编译兜底需要这套工具链
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable \
 && pnpm config set registry https://registry.npmmirror.com
WORKDIR /app

# 只先拷贝依赖清单，源码变化时仍可复用这一层缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

# 拷贝源码并构建（server → server/dist，web → web/dist）
COPY server server
COPY web web
RUN pnpm --filter server build && pnpm --filter web build

# 只导出 server 的生产依赖（含 better-sqlite3/sharp 的原生模块），扔掉全部 devDependencies
RUN pnpm deploy --filter=server --prod /prod/server

# ---------- 运行阶段 ----------
FROM docker.m.daocloud.io/library/node:20-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000
WORKDIR /app
# 运行路径约定：server/dist/index.js 里按 ../../web/dist 找前端产物、按 ../data 找数据目录
COPY --from=build /prod/server/node_modules ./server/node_modules
COPY --from=build /prod/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# SQLite 库 app.db、漫画图 cartoon/、自定义字体 fonts/ 都落在数据目录
VOLUME ["/app/server/data"]
EXPOSE 3000
# 单进程即可：better-sqlite3 是同步驱动，无多进程竞争问题
CMD ["node", "server/dist/index.js"]
