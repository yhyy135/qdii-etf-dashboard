# 构建上下文是仓库根目录（见 docker-compose.yml 的 context: ..），
# 这样看板 HTML 直接从仓库根拷贝，不需要在 server/public/ 下再存一份副本 ——
# 维护两份同内容文件、然后忘记同步，是这类项目最常见的低级错误。
#
# Node 24：node:sqlite 已内置，不需要 npm 依赖，也不用编译原生模块。
# 因此镜像里没有 node_modules，构建只是一次文件拷贝，秒级完成。
FROM node:24-alpine

RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app

WORKDIR /app
COPY --chown=app:app server/package.json ./
COPY --chown=app:app server/src/ ./src/
COPY --chown=app:app etf-dashboard.html ./public/etf-dashboard.html

# 数据卷：SQLite 库文件放这里，容器重建不丢基线
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]

USER app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_FILE=/data/buypoint.db
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
