# CLI

```bash
pnpm --filter @kairosdb/cli build
npm link            # from cli/, to get `kairos` on your PATH
```

Configuration lives at `~/.kairosdb/config.json` (directory `0700`, file `0600`) and holds the API URL, tokens and the currently selected project. Override the endpoint with `KAIROS_API_URL`.

## Auth

```bash
kairos login       # prompts for email and password; input is masked
kairos logout
```

## Projects

```bash
kairos projects list
kairos projects create <name>
kairos projects use <ref|name>     # sets the active project for later commands
```

## Database

```bash
kairos db url                      # print the connection string for the active project
kairos db connect                  # open psql against it
kairos db dump > backup.sql
kairos db backups                  # list backups recorded for the project
```

## Migrations

```bash
kairos migration create add_profiles   # scaffolds up/down files locally
kairos migration push                  # upload local migrations to the project
kairos migration up                    # apply pending migrations
kairos migration status                # show applied vs pending
```

Migrations are checksummed. Editing an already-applied migration and re-running it is rejected rather than silently ignored.

## Storage

```bash
kairos storage list [bucket]
```

## Types

```bash
kairos generate types > database.types.ts
```

Introspects `information_schema` for the active project and emits a `Database` interface:

```ts
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; email: string; name: string | null; active: boolean };
      };
    };
  };
}
```

## Help

```bash
kairos help
```
