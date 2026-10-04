import * as D1Client from '@effect/sql-d1/D1Client';
import { env, tracing } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { pgTable, text as pgText, serial } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import * as EffectD1Drizzle from 'drizzle-orm-v1/effect-d1';
import { integer as integerV1, sqliteTable as sqliteTableV1, text as textV1 } from 'drizzle-orm-v1/sqlite-core';
import * as Effect from 'effect/Effect';
import postgres from 'postgres';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import { instrumentDrizzle } from '../../src';
import { instrumentEffectDrizzle } from '../../src/effect';

import type { AttributeValue } from '../../src';

interface RuntimeSpan {
	name: string;
	parent: RuntimeSpan | undefined;
	attributes: Record<string, AttributeValue>;
	status: string | undefined;
}

const testEnv = env as unknown as { DB: D1Database; TEST_DATABASE_URL?: string; };
const databaseUrl = testEnv.TEST_DATABASE_URL;

let spans: RuntimeSpan[] = [];

// Drizzle spans share names, so match them by "INSERT users" style labels and runtime spans like d1_run by name
function labelOf(span: RuntimeSpan) {
	if (!span.name.startsWith('drizzle.')) {
		return span.name;
	}
	return [span.attributes['db.operation.name'], span.attributes['db.collection.name']].filter(Boolean).join(' ');
}

function spanNamed(label: string) {
	const span = spans.find(candidate => labelOf(candidate) === label);
	if (!span) {
		throw new Error(`No span labelled ${label}, got: ${spans.map(candidate => labelOf(candidate)).join(', ')}`);
	}
	return span;
}

// Records what the library sends to the real runtime tracer; spans are unsampled under test, so report them as traced to exercise attributes
beforeEach(() => {
	spans = [];
	const byRuntimeSpan = new Map<unknown, RuntimeSpan>();
	const enterSpan = tracing.enterSpan.bind(tracing);
	vi.spyOn(tracing, 'enterSpan').mockImplementation((name, callback) => {
		const record: RuntimeSpan = { name, parent: byRuntimeSpan.get(tracing.getActiveSpan()), attributes: {}, status: undefined };
		spans.push(record);
		return enterSpan(name, (span) => {
			byRuntimeSpan.set(tracing.getActiveSpan(), record);
			const recorder = {
				isTraced: true,
				setAttribute(key: string, value: AttributeValue) {
					record.attributes[key] = value;
					return span.setAttribute(key, value);
				},
				setAttributes(attributes: Record<string, AttributeValue | undefined>) {
					for (const [key, value] of Object.entries(attributes)) {
						if (value !== undefined) {
							record.attributes[key] = value;
						}
					}
					return span.setAttributes(attributes);
				},
				recordException: span.recordException.bind(span),
				setStatus(status: { code: 'error' | 'ok' | 'unset'; message?: string; }) {
					record.status = status.code;
					return span.setStatus(status);
				},
			};
			return callback(recorder as unknown as Span);
		});
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('D1 in workerd', () => {
	const users = sqliteTable('users', { id: integer().primaryKey(), email: text().notNull() });

	beforeEach(async () => {
		await testEnv.DB.exec('drop table if exists users; create table users (id integer primary key, email text not null)');
		spans = [];
	});

	it('uses the runtime tracer from cloudflare:workers by default', async () => {
		const db = instrumentDrizzle(drizzleD1(testEnv.DB));
		await db.insert(users).values({ email: 'a@example.com' });
		const rows = await db.select().from(users);

		expect(rows).toEqual([{ id: 1, email: 'a@example.com' }]);
		expect(spanNamed('SELECT users').attributes).toMatchObject({ 'db.system.name': 'sqlite', 'db.response.returned_rows': 1 });
	});

	it('parents the runtime D1 spans to the Drizzle query spans', async () => {
		const db = instrumentDrizzle(drizzleD1(testEnv.DB));
		await db.insert(users).values({ email: 'a@example.com' });
		await db.select().from(users);
		await db.batch([db.select().from(users), db.select().from(users)]);

		expect(spanNamed('d1_run').parent).toBe(spanNamed('INSERT users'));
		expect(spanNamed('d1_all').parent).toBe(spanNamed('SELECT users'));
		expect(spanNamed('d1_batch').parent).toBe(spanNamed('BATCH'));
		expect(spanNamed('BATCH').attributes['db.operation.batch.size']).toBe(2);
	});
});

describe('Effect D1 in workerd', () => {
	const users = sqliteTableV1('users', { id: integerV1().primaryKey(), email: textV1().notNull() });

	beforeEach(async () => {
		await testEnv.DB.exec('drop table if exists users; create table users (id integer primary key, email text not null)');
		spans = [];
	});

	function run(program: (db: Effect.Success<ReturnType<typeof EffectD1Drizzle.makeWithDefaults>>) => Effect.Effect<unknown, unknown>) {
		return Effect.runPromise(Effect.gen(function *() {
			yield* program(instrumentEffectDrizzle(yield* EffectD1Drizzle.makeWithDefaults({})));
		}).pipe(Effect.provide(D1Client.layer({ db: testEnv.DB }))));
	}

	// Effect schedules fibers itself, so this checks the runtime's async context still follows the spans
	it('parents the runtime D1 spans to the Drizzle query spans', async () => {
		await run(db => Effect.gen(function *() {
			yield* db.insert(users).values({ email: 'a@example.com' });
			yield* db.select().from(users);
		}));

		expect(spanNamed('INSERT users').parent).toBeUndefined();
		expect(spanNamed('SELECT users')).toMatchObject({ parent: undefined, attributes: { 'db.system.name': 'sqlite', 'db.response.returned_rows': 1 } });
		expect(spans.filter(span => span.name.startsWith('d1_')).map(span => span.parent && labelOf(span.parent))).toEqual(['INSERT users', 'SELECT users']);
	});

	it('keeps concurrent queries as siblings', async () => {
		await run(db => Effect.all([db.select().from(users), db.select({ id: users.id }).from(users)], { concurrency: 'unbounded' }));

		const queries = spans.filter(span => span.name === 'drizzle.execute');
		expect(queries).toHaveLength(2);
		expect(queries.every(span => span.parent === undefined)).toBe(true);
	});
});

// postgres.js over a TCP socket is the Hyperdrive path, which the runtime does not trace on its own
describe.skipIf(!databaseUrl)('postgres.js over TCP in workerd', () => {
	const users = pgTable('users', { id: serial().primaryKey(), email: pgText().notNull().unique() });

	async function withDb(run: (db: ReturnType<typeof drizzlePostgres>) => Promise<void>) {
		const client = postgres(databaseUrl as string, { max: 1 });
		try {
			await client.unsafe('drop table if exists users; create table users (id serial primary key, email text not null unique)');
			await run(instrumentDrizzle(drizzlePostgres(client)));
		} finally {
			await client.end();
		}
	}

	it('traces queries, transactions and savepoints with correct nesting', async () => {
		await withDb(async (db) => {
			await db.insert(users).values({ email: 'a@example.com' });
			await db.transaction(async (tx) => {
				await tx.update(users).set({ email: 'b@example.com' }).where(eq(users.id, 1));
				await tx.transaction(async (nested) => {
					await nested.select().from(users);
				});
			});
		});

		const transaction = spanNamed('TRANSACTION');
		const savepoint = spanNamed('SAVEPOINT');
		expect(spanNamed('INSERT users').attributes['db.system.name']).toBe('postgresql');
		expect(spanNamed('UPDATE users').parent).toBe(transaction);
		expect(savepoint.parent).toBe(transaction);
		expect(spanNamed('SELECT users')).toMatchObject({ parent: savepoint, attributes: { 'db.response.returned_rows': 1 } });
	});

	it('records the SQLSTATE of a failed query', async () => {
		await withDb(async (db) => {
			await db.insert(users).values({ email: 'a@example.com' });
			await expect(db.insert(users).values({ email: 'a@example.com' })).rejects.toThrow();
		});

		expect(spans.filter(span => labelOf(span) === 'INSERT users')[1]).toMatchObject({ status: 'error', attributes: { 'error.type': '23505' } });
	});
});
