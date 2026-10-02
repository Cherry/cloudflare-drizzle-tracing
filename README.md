# cloudflare-drizzle-tracing

Adds a [Cloudflare Workers tracing](https://developers.cloudflare.com/workers/observability/traces/) span to every query, transaction, and batch you run through [Drizzle ORM](https://orm.drizzle.team). It works with any Drizzle driver.

> [!NOTE]
> **Heads-up:** this project was primarily AI-authored. The library, tests, tooling, and this README were written by AI coding agents in interactive sessions, with a human operator directing the work, reviewing output, and validating it in local workerd and real applications. Read the code before trusting it in production.

## Why

Workers tracing automatically instruments D1, KV, `fetch()`, and more, but not [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) or TCP sockets. If you query Postgres or MySQL through `postgres`, `pg`, or `mysql2`, those queries are invisible in your traces. With this package installed, they look like this:

```
GET /users
├─ drizzle.execute        SELECT users, 1 row, 101ms
│  └─ connect
├─ drizzle.transaction    TRANSACTION
│  ├─ drizzle.execute     UPDATE users
│  └─ drizzle.transaction SAVEPOINT
│     └─ drizzle.execute  SELECT users
└─ drizzle.execute        INSERT users, error.type = 23505
```

On D1, the runtime's own `d1_*` spans nest under the matching Drizzle span, so you can see which query produced them.

### You may not need this forever

Drizzle already contains OpenTelemetry spans, but they're [switched off](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/tracing.ts), and Workers doesn't support the OpenTelemetry API yet. That support is on Cloudflare's [roadmap](https://blog.cloudflare.com/cloudflare-tracing/). Once both happen, Drizzle's own spans should replace this package.

To make that switch easy, this package uses Drizzle's names wherever Drizzle has one: the `drizzle.execute` span and the `drizzle.query.text` and `drizzle.query.params` attributes. Queries and dashboards built on those should keep working. Drizzle also adds spans this package doesn't, such as `drizzle.operation` and `drizzle.driver.execute`. Everything else follows the [OpenTelemetry database conventions](https://opentelemetry.io/docs/specs/semconv/database/), the same as Cloudflare's own D1 and KV spans.

## Usage

```sh
npm install cloudflare-drizzle-tracing
```

```ts
import { instrumentDrizzle } from 'cloudflare-drizzle-tracing';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const db = instrumentDrizzle(drizzle(postgres(env.HYPERDRIVE.connectionString)));
```

Then turn on traces in your Wrangler config:

```toml
[observability.traces]
enabled = true
```

`instrumentDrizzle` returns the same `db` with the same types, so nothing else in your code changes.

### Options

```ts
instrumentDrizzle(db, {
	attributes: { 'db.namespace': 'app' }, // added to every span
	captureQueryText: true, // parameterized SQL as drizzle.query.text (default true)
	captureParameters: false, // bound values as a JSON array in drizzle.query.params (default false, they often hold PII)
	dbSystem: 'postgresql', // overrides the db.system.name detected from the dialect
	tracer: ctx.tracing, // defaults to `tracing` from cloudflare:workers
});
```

## What you get

| Span | Attributes |
| --- | --- |
| `drizzle.execute`, one per query | `drizzle.query.text`, `drizzle.query.params`, `db.system.name`, `db.operation.name` (`SELECT`, `INSERT`, ...), `db.collection.name`, `db.response.returned_rows` |
| `drizzle.transaction` | `db.operation.name` (`TRANSACTION` or `SAVEPOINT`) |
| `drizzle.batch` | `db.operation.name`, `db.operation.batch.size` |

A failed query records the driver's error code as `error.type` (for example, Postgres `23505` or MySQL `ER_DUP_ENTRY`) and sets an error status.

Outside workerd, for example in a Node test suite, the package does nothing and queries run as usual.

## Compatibility

- Drizzle ORM 0.45+ and 1.0 prereleases.
- Any driver. The tests cover postgres.js, PGlite, D1, sql.js, and the pg, MySQL, and SQLite proxy drivers.
- Workers tracing features added on 2026-09-25 (`setAttributes`, `recordException`) are used when the runtime has them. Older runtimes still get spans.

## How it works

Every Drizzle driver runs queries through the same internal session methods. This package wraps them on your `db` instance and opens each span with `tracing.enterSpan()`. Nesting therefore follows the runtime's async context, which is how transactions, savepoints, and the runtime's own spans end up in the right place.

## Development

```sh
npm test
npm run lint
npm run check-types
```

`npm test` runs the Node suites and a workerd suite through [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/). To also run the Postgres-over-TCP tests, point them at a disposable database:

```sh
docker run -d --name cloudflare-drizzle-tracing-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:15433/postgres npm test
```

## License

[MIT](LICENSE)
