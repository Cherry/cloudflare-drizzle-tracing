// Minimal declaration so the package builds without pulling the global workers-types into consumers
declare module 'cloudflare:workers' {
	export const tracing: import('./tracer').TracerLike | undefined;
}

// Replaced with the package.json version at build time
declare const __VERSION__: string;
