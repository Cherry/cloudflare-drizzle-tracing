import * as legacyCore from 'drizzle-orm/mysql-core';
import { drizzle as legacyProxy } from 'drizzle-orm/mysql-proxy';
import * as core from 'drizzle-orm-v1/mysql-core';
import { drizzle as proxy } from 'drizzle-orm-v1/mysql-proxy';
import { describe, expect, it } from 'vitest';

import { instrumentDrizzle } from '../src';
import { createTracer } from './helpers';

const versions = [
	{ version: '0.x', core: legacyCore, connect: legacyProxy },
	{ version: '1.x', core, connect: proxy },
] as const;

describe.each(versions)('mysql (drizzle $version)', ({ core, connect }) => {
	const users = core.mysqlTable('users', {
		id: core.int().primaryKey().autoincrement(),
		email: core.varchar({ length: 255 }).notNull(),
	});

	it('traces queries with the mysql system name', async () => {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(connect(async () => {
			return { rows: [[1, 'a@example.com']] };
		}), { tracer });
		await db.select().from(users);

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			name: 'drizzle.execute',
			attributes: { 'db.system.name': 'mysql', 'db.operation.name': 'SELECT', 'db.collection.name': 'users', 'db.response.returned_rows': 1 },
		});
	});

	it('uses the driver error code as the error type', async () => {
		const { tracer, spans } = createTracer();
		const db = instrumentDrizzle(connect(async () => {
			throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
		}), { tracer });
		await expect(db.insert(users).values({ email: 'a@example.com' })).rejects.toThrow();

		expect(spans[0]).toMatchObject({ status: 'error', attributes: { 'error.type': 'ER_DUP_ENTRY' } });
	});
});
