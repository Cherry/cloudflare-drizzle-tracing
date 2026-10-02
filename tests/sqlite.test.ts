import * as legacyOrm from 'drizzle-orm';
import { drizzle as legacySqlJs } from 'drizzle-orm/sql-js';
import * as legacyCore from 'drizzle-orm/sqlite-core';
import { drizzle as legacyProxy } from 'drizzle-orm/sqlite-proxy';
import * as orm from 'drizzle-orm-v1';
import { drizzle as sqlJs } from 'drizzle-orm-v1/sql-js';
import * as core from 'drizzle-orm-v1/sqlite-core';
import { drizzle as proxy } from 'drizzle-orm-v1/sqlite-proxy';
import initSqlJs from 'sql.js';
import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { instrumentDrizzle } from '../src';
import { createTracer, label } from './helpers';

import type { Database, SqlJsStatic } from 'sql.js';

const versions = [
	{ version: '0.x', orm: legacyOrm, core: legacyCore, connect: (client: Database) => legacySqlJs(client), connectProxy: legacyProxy },
	{ version: '1.x', orm, core, connect: (client: Database) => sqlJs(client), connectProxy: proxy },
] as const;

let SQL: SqlJsStatic;
beforeAll(async () => {
	SQL = await initSqlJs();
});

function createClient() {
	const client = new SQL.Database();
	client.run('create table users (id integer primary key, email text not null unique)');
	return client;
}

describe.each(versions)('sqlite (drizzle $version)', ({ orm, core, connect, connectProxy }) => {
	const users = core.sqliteTable('users', {
		id: core.integer().primaryKey(),
		email: core.text().notNull().unique(),
	});

	function setup() {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(connect(createClient()), { tracer });
		return { db, spans };
	}

	it('traces queries with the sqlite system name', async () => {
		const { db, spans } = setup();
		await db.insert(users).values({ email: 'a@example.com' });
		const rows = await db.select().from(users);

		expect(rows).toEqual([{ id: 1, email: 'a@example.com' }]);
		expect(spans.map(span => label(span))).toEqual(['INSERT users', 'SELECT users']);
		expect(spans[1].attributes).toMatchObject({ 'db.system.name': 'sqlite', 'db.response.returned_rows': 1 });
	});

	it('creates one span when awaiting a query, which routes execute through all', async () => {
		const { db, spans } = setup();
		await db.select().from(users);
		expect(spans).toHaveLength(1);
	});

	it('nests transaction queries under the transaction span', async () => {
		const { db, spans } = setup();
		await db.transaction(async (tx) => {
			await tx.insert(users).values({ email: 'a@example.com' });
		});
		const transaction = spans.find(span => label(span) === 'TRANSACTION');
		expect(spans.find(span => label(span) === 'INSERT users')?.parent).toBe(transaction);
	});

	it('wraps batches in a single span', async () => {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(connectProxy(
			async () => { return { rows: [] }; },
			async queries => queries.map(() => { return { rows: [] }; }),
		), { tracer });
		await db.batch([db.select().from(users), db.delete(users).where(orm.eq(users.id, 1))]);

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ name: 'drizzle.batch', attributes: { 'db.operation.batch.size': 2 } });
	});
});

// Drizzle 1.x exposes every sqlite driver through the async API, so only 0.x has sync queries (e.g. durable-sqlite)
describe('sqlite sync queries (drizzle 0.x)', () => {
	const users = legacyCore.sqliteTable('users', {
		id: legacyCore.integer().primaryKey(),
		email: legacyCore.text().notNull().unique(),
	});

	function setup() {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(legacySqlJs(createClient()), { tracer });
		return { db, spans };
	}

	it('traces synchronous queries without turning them into promises', () => {
		const { db, spans } = setup();
		db.insert(users).values({ email: 'a@example.com' }).run();
		const rows = db.select().from(users).all();

		expect(rows).toEqual([{ id: 1, email: 'a@example.com' }]);
		expect(spans.map(span => label(span))).toEqual(['INSERT users', 'SELECT users']);
		expect(spans.every(span => span.ended)).toBe(true);
	});

	it('nests synchronous transaction queries under the transaction span', () => {
		const { db, spans } = setup();
		db.transaction((tx) => {
			tx.insert(users).values({ email: 'a@example.com' }).run();
		});
		const transaction = spans.find(span => label(span) === 'TRANSACTION');
		expect(spans.find(span => label(span) === 'INSERT users')?.parent).toBe(transaction);
	});

	it('records synchronous driver errors and still throws', () => {
		const { db, spans } = setup();
		db.insert(users).values({ email: 'a@example.com' }).run();
		expect(() => db.insert(users).values({ email: 'a@example.com' }).run()).toThrow();
		expect(spans[1]).toMatchObject({ status: 'error', ended: true });
	});
});
