# Build from the repository root:  docker build -f apps/api/Dockerfile -t imageunit-api .
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# --include=dev: tsc is needed to build even if the platform injects NODE_ENV=production.
RUN npm ci -w @imageunit/api --include-workspace-root --include=dev
COPY apps/api apps/api
RUN npm run build -w @imageunit/api && npm prune --omit=dev -w @imageunit/api

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle
COPY --from=build /repo/apps/api/package.json apps/api/
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
# API:    node dist/server.js      Worker:  node dist/worker.js
CMD ["node", "dist/server.js"]
