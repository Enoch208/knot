FROM node:24.14.1-bookworm-slim AS build

ENV CI=true
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/agent/package.json app/agent/pnpm-workspace.yaml ./app/agent/
RUN pnpm install --frozen-lockfile
COPY app/agent ./app/agent
RUN pnpm --dir app/agent build

FROM node:24.14.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace/app/agent
COPY --from=build --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=build --chown=node:node /workspace/app/agent/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/app/agent/dist ./dist
COPY --from=build --chown=node:node /workspace/app/agent/package.json ./package.json
COPY --from=build --chown=node:node /workspace/app/agent/studio.toml ./studio.toml
USER node
CMD ["node", "dist/unifiedMain.js"]
