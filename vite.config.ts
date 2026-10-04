import path from 'node:path';

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

import { versionPlugin } from './version-plugin';

export default defineConfig({
	plugins: [dts(), versionPlugin()],
	build: {
		sourcemap: true,
		emptyOutDir: true,
		minify: false,
		lib: {
			entry: {
				index: path.resolve(import.meta.dirname, 'src/index.ts'),
				effect: path.resolve(import.meta.dirname, 'src/effect.ts'),
			},
			formats: ['es'],
		},
		rollupOptions: {
			// drizzle-orm and effect are peer dependencies, and workerd provides cloudflare:workers at runtime
			external: id => id.startsWith('drizzle-orm') || id === 'effect' || id.startsWith('effect/') || id.startsWith('cloudflare:'),
		},
	},
});
