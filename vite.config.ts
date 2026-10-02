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
			entry: path.resolve(import.meta.dirname, 'src/index.ts'),
			formats: ['es'],
			fileName: 'index',
		},
		rollupOptions: {
			// drizzle-orm is a peer dependency, and workerd provides cloudflare:workers at runtime
			external: id => id.startsWith('drizzle-orm') || id.startsWith('cloudflare:'),
		},
	},
});
