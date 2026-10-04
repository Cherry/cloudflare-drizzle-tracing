import * as PgliteClient from '@effect/sql-pglite/PgliteClient';
import { PGlite } from '@electric-sql/pglite';
import * as PgDrizzle from 'drizzle-orm-v1/effect-pglite';
import * as core from 'drizzle-orm-v1/pg-core';
import { drizzle } from 'drizzle-orm-v1/pglite';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';

import { instrumentDrizzle } from '../src';
import { createTracer, label } from './helpers';
import { instrumentEffectDrizzle } from '../src/effect';

import type { RecordedSpan } from './helpers';

const users = core.pgTable('users', {
	id: core.serial().primaryKey(),
	email: core.text().notNull().unique(),
});

type Database = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

// Runs against a fresh in-memory database, with spans recorded by a tracer that nests like workerd's
async function withDb(run: (db: Database, spans: RecordedSpan[]) => Effect.Effect<unknown, unknown>, options: { traced?: boolean; } = {}) {
	const { tracer, spans } = createTracer({ traced: options.traced });
	const program = Effect.gen(function *() {
		const db = instrumentEffectDrizzle(yield* PgDrizzle.makeWithDefaults(), { tracer });
		yield* db.execute('create table users (id serial primary key, email text not null unique)');
		spans.length = 0;
		yield* run(db, spans);
	});
	await Effect.runPromise(program.pipe(Effect.provide(PgliteClient.layer({}))));
	return spans;
}

function find(spans: RecordedSpan[], name: string) {
	return spans.find(span => label(span) === name);
}

describe('effect-pglite (drizzle 1.x)', () => {
	it('opens spans when the Effect runs, not when it is built', async () => {
		let afterBuild = -1;
		const spans = await withDb((db, recorded) => Effect.gen(function *() {
			yield* db.insert(users).values([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
			const query = db.select().from(users);
			afterBuild = recorded.length;
			yield* query;
		}));

		expect(afterBuild).toBe(1);
		expect(spans.map(span => label(span))).toEqual(['INSERT users', 'SELECT users']);
		expect(spans[1].attributes).toMatchObject({
			'db.system.name': 'postgresql',
			'drizzle.query.text': 'select "id", "email" from "users"',
			'db.response.returned_rows': 2,
		});
		expect(spans.every(span => span.ended)).toBe(true);
	});

	it('traces each run of a reused query', async () => {
		const spans = await withDb(db => Effect.gen(function *() {
			const query = db.select().from(users);
			yield* query;
			yield* query;
		}));
		expect(spans.map(span => label(span))).toEqual(['SELECT users', 'SELECT users']);
	});

	it('keeps sequential and concurrent queries as siblings', async () => {
		const spans = await withDb(db => Effect.gen(function *() {
			yield* db.insert(users).values({ email: 'a@example.com' });
			yield* Effect.all([db.select().from(users), db.execute('select 1')], { concurrency: 'unbounded' });
			yield* db.delete(users);
		}));
		expect(spans).toHaveLength(4);
		expect(spans.every(span => span.parent === undefined)).toBe(true);
	});

	it('nests transaction queries and savepoints under their transaction span', async () => {
		const spans = await withDb(db => db.transaction(tx => Effect.gen(function *() {
			yield* tx.insert(users).values({ email: 'a@example.com' });
			yield* Effect.all([tx.select().from(users), tx.select({ id: users.id }).from(users)], { concurrency: 'unbounded' });
			yield* tx.transaction(nested => nested.update(users).set({ email: 'b@example.com' }));
		})));

		const transaction = find(spans, 'TRANSACTION');
		const savepoint = find(spans, 'SAVEPOINT');
		expect(spans.map(span => span.name).filter(name => name === 'drizzle.transaction')).toHaveLength(2);
		expect(find(spans, 'INSERT users')?.parent).toBe(transaction);
		expect(spans.filter(span => label(span) === 'SELECT users').every(span => span.parent === transaction)).toBe(true);
		expect(savepoint?.parent).toBe(transaction);
		expect(find(spans, 'UPDATE users')?.parent).toBe(savepoint);
		expect(transaction?.parent).toBeUndefined();
	});

	it('records the SQLSTATE of a failed query and still fails the Effect', async () => {
		let failed = false;
		const spans = await withDb(db => Effect.gen(function *() {
			yield* db.insert(users).values({ email: 'a@example.com' });
			failed = yield* db.insert(users).values({ email: 'a@example.com' }).pipe(Effect.isFailure);
		}));

		expect(failed).toBe(true);
		expect(spans[1]).toMatchObject({
			status: 'error',
			attributes: { 'error.type': '23505', 'db.response.status_code': '23505' },
			ended: true,
		});
		expect(spans[1].exceptions).toHaveLength(1);
	});

	it('marks a transaction span as failed when its Effect fails', async () => {
		const spans = await withDb(db => db.transaction(() => Effect.fail(new Error('boom'))).pipe(Effect.ignore));
		expect(find(spans, 'TRANSACTION')).toMatchObject({ status: 'error', attributes: { 'error.type': 'Error' } });
	});

	it('skips building attributes for unsampled requests', async () => {
		const spans = await withDb(db => db.select().from(users), { traced: false });
		expect(spans[0].attributes).toEqual({});
	});

	it('runs queries untraced when no tracer is available', async () => {
		const program = Effect.gen(function *() {
			const db = instrumentEffectDrizzle(yield* PgDrizzle.makeWithDefaults());
			yield* db.execute('create table users (id serial primary key, email text not null unique)');
			yield* db.insert(users).values({ email: 'a@example.com' });
			return yield* db.select().from(users);
		});
		await expect(Effect.runPromise(program.pipe(Effect.provide(PgliteClient.layer({}))))).resolves.toHaveLength(1);
	});

	it('points each entry point at the other when given the wrong kind of database', async () => {
		const effectDb = await Effect.runPromise(PgDrizzle.makeWithDefaults().pipe(Effect.provide(PgliteClient.layer({}))));
		expect(() => instrumentDrizzle(effectDb)).toThrow('cloudflare-drizzle-tracing/effect');
		expect(() => instrumentEffectDrizzle(drizzle({ client: new PGlite() }))).toThrow('use instrumentDrizzle');
	});
});
