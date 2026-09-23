FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY services/api/package.json services/api/
COPY packages/types/package.json packages/types/
RUN pnpm install --filter @kairosdb/api... --no-frozen-lockfile

FROM deps AS build
COPY services/api services/api
COPY packages/types packages/types
RUN pnpm --filter @kairosdb/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/services/api/node_modules /app/services/api/node_modules
COPY --from=build /app/services/api/dist /app/services/api/dist
COPY --from=build /app/services/api/package.json /app/services/api/package.json
WORKDIR /app/services/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
