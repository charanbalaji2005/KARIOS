# Contributing

## Setup

```bash
pnpm install
cp .env.example .env     # then fill in the three secrets
docker compose up -d
pnpm db:migrate
pnpm dev
```

## Before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Integration tests in `tests/integration/api.test.ts` run against a live stack — bring up Docker Compose and run migrations first. `tests/integration/sql-guard.test.ts` is pure unit testing of the identifier/type/statement guards and needs nothing running.

## Conventions

- TypeScript strict mode, ESM, `noUncheckedIndexedAccess`. No unnecessary `any`.
- Routes live in `services/api/src/modules/`. Do not add business logic to `app.ts`.
- Any new SQL that interpolates an identifier must go through `lib/sql.ts`. Values are always parameters.
- Every new privileged action writes an audit row.
- New endpoints declare a Zod schema and a required permission — no exceptions.

## Things worth building

The README lists what is scaffolded but unimplemented: OAuth, invitations, the admin surface, GraphQL, OpenAPI, observability export, CSV/JSON import-export, the visual query builder, the API explorer, the relationship diagram, and production deployment manifests. Any of those is a reasonable first contribution.
