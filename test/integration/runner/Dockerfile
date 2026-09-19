# 仅安装隔离的旧引擎依赖；上下文由 runIntegration.mjs 按白名单生成，不包含仓库或凭据。
FROM node:24-bookworm-slim@sha256:a9d7043680f11d1229c0db1900b7f916719b1f0e4b47ed14a8c881e99767b8d2
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
WORKDIR /opt/runner
COPY package.json package-lock.json .npmrc ./
# 安装脚本需要编译原生扩展，但此阶段没有业务源码、测试脚本或账户配置。
RUN npm ci --no-audit --no-fund
COPY --chown=node:node dist ./dist
COPY --chown=node:node scenarios ./test/integration/scenarios
COPY --chown=node:node support ./test/integration/support
COPY --chown=node:node screeps-integration.config.cjs ./screeps-integration.config.cjs
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/runner/node_modules/screeps-integration-tests/bin/screeps-integration-tests.js", "--config", "/opt/runner/screeps-integration.config.cjs"]
