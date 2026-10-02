import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

import { versionPlugin } from './version-plugin';

export default defineConfig({
	test: {
		// postgres.js's workerd socket polyfill rejects its read loop when client.end() closes the socket; harmless
		onUnhandledError(error) {
			if (error.message === 'This socket has been closed.' && error.stack?.includes('postgres/cf/polyfills.js')) {
				return false;
			}
		},
		projects: [
			{
				plugins: [versionPlugin()],
				test: {
					name: 'node',
					include: ['tests/*.test.ts', 'tests/types/*.test-d.ts'],
					typecheck: {
						enabled: true,
						include: ['tests/types/*.test-d.ts'],
					},
				},
			},
			{
				plugins: [versionPlugin(), cloudflareTest({
					wrangler: { configPath: './tests/workers/wrangler.toml' },
					// Postgres tests run only when a database is provided, e.g. the CI service container
					miniflare: { bindings: process.env.TEST_DATABASE_URL ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL } : {} },
				})],
				test: {
					name: 'workers',
					include: ['tests/workers/*.test.ts'],
				},
			},
		],
	},
});
