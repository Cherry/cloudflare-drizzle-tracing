import nodecraft from '@nodecraft/eslint-config';
import vitest from '@vitest/eslint-plugin';

const jsonIgnore = ['**/*.json'];
const withJsonIgnore = function(configs) {
	return configs.map(function(config) {
		return {
			...config,
			ignores: [...(config.ignores || []), ...jsonIgnore],
		};
	});
};

export default [
	// Global ignores
	{
		ignores: [
			'dist/**',
			'store/**',
		],
	},

	// TypeScript config (includes base), excluding JSON files
	...withJsonIgnore(nodecraft.configs.typescript),

	// JSON
	...nodecraft.configs.json,

	// Vitest test files
	{
		files: ['tests/**/*.{js,mjs,ts}'],
		plugins: {
			vitest,
		},
		rules: {
			...vitest.configs.recommended.rules,
			'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expectTypeOf'] }],
		},
		languageOptions: {
			globals: {
				...vitest.environments.env.globals,
			},
		},
	},
];
