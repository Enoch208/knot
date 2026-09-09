FROM node:24.14.1-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY ops/backend/tsconfig.runtime.json ops/backend/tsconfig.runtime.json
COPY apps apps
COPY packages packages
RUN npx tsc -p ops/backend/tsconfig.runtime.json

FROM node:24.14.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY packages/db/migrations ./dist/packages/db/migrations
USER node
