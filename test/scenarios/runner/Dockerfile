# 私服场景测试镜像：只安装锁定的场景框架及其引擎依赖，再放入构建产物与场景文件。
# 构建上下文由 scripts/scenarios/cli.ts 按白名单生成，不含仓库其余文件与任何凭据。
# 依赖层只依赖 package.json、package-lock.json 与 .npmrc，不变时直接命中缓存；产物与场景每次覆盖其后的层。
FROM node:24-bookworm-slim@sha256:a9d7043680f11d1229c0db1900b7f916719b1f0e4b47ed14a8c881e99767b8d2
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
WORKDIR /opt/runner
COPY package.json package-lock.json .npmrc ./
# isolated-vm 等依赖的安装脚本要编译原生扩展；此阶段只有依赖清单，没有产物、场景或凭据。
RUN npm ci --no-audit --no-fund
COPY --chown=node:node bot ./bot
COPY --chown=node:node scenarios ./scenarios
COPY --chown=node:node support ./support
COPY --chown=node:node scenarios.config.cjs ./scenarios.config.cjs
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/runner/node_modules/screeps-integration-tests/bin/screeps-integration-tests.js", "--config", "/opt/runner/scenarios.config.cjs"]
