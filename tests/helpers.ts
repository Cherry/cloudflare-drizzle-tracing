import { AsyncLocalStorage } from 'node:async_hooks';

import type { AttributeValue, SpanLike, TracerLike } from '../src';

export interface RecordedSpan {
	name: string;
	parent: RecordedSpan | undefined;
	attributes: Record<string, AttributeValue>;
	exceptions: { name: string; message: string; }[];
	status: string | undefined;
	ended: boolean;
}

// Mirrors workerd's enterSpan: parents follow the async context, and the span ends when the callback's promise settles
export function createTracer({ traced = true } = {}) {
	const spans: RecordedSpan[] = [];
	const active = new AsyncLocalStorage<RecordedSpan>();

	const tracer: TracerLike = {
		enterSpan(name, callback) {
			const record: RecordedSpan = { name, parent: active.getStore(), attributes: {}, exceptions: [], status: undefined, ended: false };
			spans.push(record);
			const span: SpanLike = {
				isTraced: traced,
				setAttribute(key, value) {
					record.attributes[key] = value;
				},
				setAttributes(attributes) {
					for (const [key, value] of Object.entries(attributes)) {
						if (value !== undefined) {
							record.attributes[key] = value;
						}
					}
				},
				recordException(exception) {
					record.exceptions.push({ name: exception.name, message: exception.message });
				},
				setStatus(status) {
					record.status = status.code;
				},
			};
			const end = () => {
				record.ended = true;
			};
			return active.run(record, () => {
				try {
					const result = callback(span);
					if (result instanceof Promise) {
						return result.finally(end) as typeof result;
					}
					end();
					return result;
				} catch (error) {
					end();
					throw error;
				}
			});
		},
	};

	return { tracer, spans };
}

// Readable identity for assertions, e.g. "INSERT users" or "TRANSACTION", since every query span shares Drizzle's span name
export function label(span: RecordedSpan) {
	return [span.attributes['db.operation.name'], span.attributes['db.collection.name']].filter(Boolean).join(' ');
}
