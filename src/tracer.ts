export type AttributeValue = boolean | number | string;

/** The subset of the Workers `Span` this library uses; newer methods are optional so older runtimes still work. */
export interface SpanLike {
	readonly isTraced: boolean;
	setAttribute(key: string, value: AttributeValue): unknown;
	setAttributes?(attributes: Record<string, AttributeValue | undefined>): unknown;
	recordException?(exception: { name: string; message: string; stack?: string; }): void;
	setStatus?(status: { code: 'error' | 'ok' | 'unset'; message?: string; }): unknown;
}

/** The subset of the Workers `Tracing` API this library uses, so `ctx.tracing` or a test double can be passed in. */
export interface TracerLike {
	enterSpan<T>(name: string, callback: (span: SpanLike) => T): T;
}

let runtimeTracer: TracerLike | undefined;

// Resolved lazily so importing this package outside workerd (e.g. Node test suites) does not throw
import('cloudflare:workers').then((module: { tracing?: TracerLike; }) => {
	runtimeTracer = module.tracing;
}).catch(() => {
	// Not running in workerd, queries run untraced
});

export function getRuntimeTracer(): TracerLike | undefined {
	return runtimeTracer;
}

export function setAttributes(span: SpanLike, attributes: Record<string, AttributeValue | undefined>) {
	if (span.setAttributes) {
		span.setAttributes(attributes);
		return;
	}
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== undefined) {
			span.setAttribute(key, value);
		}
	}
}
