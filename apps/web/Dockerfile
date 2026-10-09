# Build from the repository root:  docker build -f apps/web/Dockerfile -t imageunit-web .
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
# --include=dev: the build needs TypeScript/Tailwind even if the platform injects NODE_ENV=production.
RUN npm ci -w @imageunit/web --include-workspace-root --include=dev
COPY apps/web apps/web
# API_URL is baked into the proxy rewrite at build time.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
# Platforms such as Coolify inject the app's NODE_ENV (often "development") as a build arg; Next.js crashes with a
# non-standard NODE_ENV, so the build is always run in production mode regardless.
RUN NODE_ENV=production npm run build -w @imageunit/web

FROM node:24-bookworm-slim
ARG API_URL=http://api:4000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4001 HOSTNAME=0.0.0.0 API_URL=$API_URL
WORKDIR /repo
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 4001
CMD ["node", "apps/web/server.js"]
