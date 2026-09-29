# Build from the repository root:  docker build -f apps/web/Dockerfile -t imageunit-web .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @imageunit/web --include-workspace-root
COPY apps/web apps/web
# API_URL is baked into the proxy rewrite at build time.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @imageunit/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4001 HOSTNAME=0.0.0.0
WORKDIR /repo
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 4001
CMD ["node", "apps/web/server.js"]
