FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/types/package.json packages/types/
RUN pnpm install --filter @kairosdb/dashboard... --no-frozen-lockfile
COPY apps/dashboard apps/dashboard
COPY packages/types packages/types
RUN pnpm --filter @kairosdb/dashboard build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/apps/dashboard/.next/standalone ./
COPY --from=build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /app/apps/dashboard/public ./apps/dashboard/public
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
