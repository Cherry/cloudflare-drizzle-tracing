import { readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; };

// Bakes the package.json version into src, which semantic-release sets before publishing. A transform rather than
// `define`, since Vitest's workerd pool doesn't apply define replacements.
export function versionPlugin(): Plugin {
	return {
		name: 'version',
		transform(code, id) {
			if (id.includes('/src/') && code.includes('__VERSION__')) {
				return code.replaceAll('__VERSION__', () => JSON.stringify(version));
			}
		},
	};
}
