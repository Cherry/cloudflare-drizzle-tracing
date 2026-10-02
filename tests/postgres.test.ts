import { PGlite } from '@electric-sql/pglite';
import * as legacyOrm from 'drizzle-orm';
import * as legacyCore from 'drizzle-orm/pg-core';
import { drizzle as legacyDrizzle } from 'drizzle-orm/pglite';
import * as orm from 'drizzle-orm-v1';
import * as core from 'drizzle-orm-v1/pg-core';
import { drizzle } from 'drizzle-orm-v1/pglite';
import {
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';

import packageJson from '../package.json';
import { instrumentDrizzle } from '../src';
import { createTracer, label } from './helpers';

import type { DrizzleTracingOptions } from '../src';

const versions = [
	{ version: '0.x', orm: legacyOrm, core: legacyCore, connect: (client: PGlite) => legacyDrizzle({ client }) },
	{ version: '1.x', orm, core, connect: (client: PGlite) => drizzle({ client }) },
] as const;

describe.each(versions)('postgres (drizzle $version)', ({ orm, core, connect }) => {
	const users = core.pgTable('users', {
		id: core.serial().primaryKey(),
		email: core.text().notNull().unique(),
	});
	let client: PGlite;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec('create table users (id serial primary key, email text not null unique)');
	});

	function setup(options: Omit<DrizzleTracingOptions, 'tracer'> = {}) {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(connect(client), { tracer, ...options });
		return { db, spans };
	}

	it('names spans after the operation and table, with OTel attributes', async () => {
		const { db, spans } = setup({ attributes: { 'db.namespace': 'app' } });
		await db.insert(users).values([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
		const rows = await db.select().from(users);

		expect(rows).toHaveLength(2);
		expect(spans.map(span => label(span))).toEqual(['INSERT users', 'SELECT users']);
		expect(spans[1].attributes).toEqual({
			'otel.scope.name': 'cloudflare-drizzle-tracing',
			'otel.scope.version': packageJson.version,
			'db.system.name': 'postgresql',
			'db.namespace': 'app',
			'db.operation.name': 'SELECT',
			'db.collection.name': 'users',
			'drizzle.query.text': 'select "id", "email" from "users"',
			'db.response.returned_rows': 2,
		});
		expect(spans.every(span => span.ended)).toBe(true);
	});

	it('uses Drizzle\'s own span names so traces survive a move to its OpenTelemetry spans', async () => {
		const { db, spans } = setup();
		await db.transaction(async (tx) => {
			await tx.select().from(users);
		});
		expect(spans.map(span => span.name)).toEqual(['drizzle.transaction', 'drizzle.execute']);
	});

	it('serializes bigint parameters instead of failing the query', async () => {
		const { db, spans } = setup({ captureParameters: true });
		await db.execute(orm.sql`select ${12_345_678_901_234_567_890n}::numeric as value`);
		expect(spans[0].attributes['drizzle.query.params']).toBe('["12345678901234567890"]');
	});

	it('traces update, delete and raw sql', async () => {
		const { db, spans } = setup();
		await db.insert(users).values({ email: 'a@example.com' });
		await db.update(users).set({ email: 'c@example.com' }).where(orm.eq(users.id, 1));
		await db.execute(orm.sql`select count(*) from users`);
		await db.delete(users);

		expect(spans.map(span => label(span))).toEqual(['INSERT users', 'UPDATE users', 'SELECT', 'DELETE users']);
	});

	it('creates one span per query even when drivers call execute methods internally', async () => {
		const { db, spans } = setup();
		await db.select().from(users);
		await db.execute(orm.sql`select 1`);
		expect(spans).toHaveLength(2);
	});

	it('omits bound values unless captureParameters is on', async () => {
		const quiet = setup();
		await quiet.db.insert(users).values({ email: 'secret@example.com' });
		expect(Object.keys(quiet.spans[0].attributes).includes('drizzle.query.params')).toBe(false);

		const verbose = setup({ captureParameters: true });
		await verbose.db.select().from(users).where(orm.eq(users.email, 'secret@example.com'));
		expect(verbose.spans[0].attributes['drizzle.query.params']).toBe('["secret@example.com"]');
	});

	it('fills placeholders of prepared statements from the values passed at execution', async () => {
		const { db, spans } = setup({ captureParameters: true });
		const byEmail = db.select().from(users).where(orm.eq(users.email, orm.sql.placeholder('email')))
			.prepare('by_email');
		await byEmail.execute({ email: 'a@example.com' });
		await byEmail.execute({ email: 'b@example.com' });

		expect(spans.map(span => span.attributes['drizzle.query.params'])).toEqual(['["a@example.com"]', '["b@example.com"]']);
	});

	it('omits query text when captureQueryText is off', async () => {
		const { db, spans } = setup({ captureQueryText: false });
		await db.select().from(users);
		expect(spans[0].attributes['drizzle.query.text']).toBeUndefined();
	});

	it('nests transaction queries and savepoints under their transaction span', async () => {
		const { db, spans } = setup();
		await db.transaction(async (tx) => {
			await tx.insert(users).values({ email: 'a@example.com' });
			await tx.transaction(async (nested) => {
				await nested.select().from(users);
			});
		});

		const transaction = spans.find(span => label(span) === 'TRANSACTION');
		const savepoint = spans.find(span => label(span) === 'SAVEPOINT');
		expect(spans.find(span => label(span) === 'INSERT users')?.parent).toBe(transaction);
		expect(savepoint?.parent).toBe(transaction);
		expect(spans.find(span => label(span) === 'SELECT users')?.parent).toBe(savepoint);
	});

	it('records driver errors on the span and still rejects', async () => {
		const { db, spans } = setup();
		await db.insert(users).values({ email: 'a@example.com' });
		await expect(db.insert(users).values({ email: 'a@example.com' })).rejects.toThrow();

		expect(spans[1]).toMatchObject({
			status: 'error',
			attributes: { 'error.type': '23505', 'db.response.status_code': '23505' },
			ended: true,
		});
		expect(spans[1].exceptions).toHaveLength(1);
	});

	it('marks a transaction span as failed when its callback throws', async () => {
		const { db, spans } = setup();
		await expect(db.transaction(async () => {
			throw new Error('boom');
		})).rejects.toThrow('boom');
		expect(spans.find(span => label(span) === 'TRANSACTION')).toMatchObject({ status: 'error', attributes: { 'error.type': 'Error' } });
	});

	it('does not double-wrap when instrumented twice', async () => {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(instrumentDrizzle(connect(client), { tracer }), { tracer });
		await db.select().from(users);
		expect(spans).toHaveLength(1);
	});

	it('skips building attributes for unsampled requests', async () => {
		const { tracer, spans } = createTracer({ traced: false });
		const db = instrumentDrizzle(connect(client), { tracer });
		await db.select().from(users);
		expect(spans[0].attributes).toEqual({});
	});

	it('runs queries untraced when no tracer is available', async () => {
		const db = instrumentDrizzle(connect(client));
		await db.insert(users).values({ email: 'a@example.com' });
		await expect(db.select().from(users)).resolves.toHaveLength(1);
	});
});

describe('postgres relational queries (drizzle 0.x)', () => {
	it('traces db.query lookups', async () => {
		const client = new PGlite();
		await client.exec('create table users (id serial primary key, email text not null unique)');
		const users = legacyCore.pgTable('users', {
			id: legacyCore.serial().primaryKey(),
			email: legacyCore.text().notNull(),
		});
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(legacyDrizzle({ client, schema: { users } }), { tracer });
		await db.query.users.findMany();

		expect(spans).toHaveLength(1);
		expect(spans[0].attributes['db.operation.name']).toBe('SELECT');
	});
});
