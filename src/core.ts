import { getRuntimeTracer, setAttributes } from './tracer';

import type { AttributeValue, SpanLike, TracerLike } from './tracer';

export interface DrizzleTracingOptions {
	/** Defaults to `tracing` from `cloudflare:workers`. Pass `ctx.tracing` or a test double to override. */
	tracer?: TracerLike;
	/** Static attributes added to every span, e.g. `db.namespace` or `server.address`. */
	attributes?: Record<string, AttributeValue>;
	/** Overrides the `db.system.name` detected from the Drizzle dialect. */
	dbSystem?: string;
	/** Record the parameterized SQL as `drizzle.query.text`. Defaults to `true`. */
	captureQueryText?: boolean;
	/** Record bound values as a JSON array in `drizzle.query.params`. Defaults to `false` since values often hold PII. */
	captureParameters?: boolean;
}

interface QueryMetadata {
	type: string;
	tables: string[];
}

interface DrizzleQuery {
	sql: string;
	params: unknown[];
}

type Attributes = () => Record<string, AttributeValue | undefined>;
type OnResult = (span: SpanLike, result: unknown) => void;
export type Method = (this: unknown, ...args: unknown[]) => unknown;
export type Session = Record<string | symbol, unknown>;

/** Opens a span around `run`, and decides when it ends, which differs between Promise and Effect drivers. */
export type SpanRunner = <T>(config: Config, name: string, attributes: Attributes, run: () => T, onResult?: OnResult) => T;

export interface Config {
	tracer: TracerLike | undefined;
	baseAttributes: Record<string, AttributeValue>;
	captureQueryText: boolean;
	captureParameters: boolean;
	runInSpan: SpanRunner;
}

const entityKind = Symbol.for('drizzle:entityKind');
const instrumented = Symbol.for('cloudflare-drizzle-tracing');
const executeMethods = new Set(['execute', 'all', 'get', 'values', 'run']);
// Keeps large queries well inside the 64 KB of attributes a Workers span holds
const maxAttributeLength = 8192;

// OTel `db.system.name` values keyed by the Drizzle dialect's entity kind
const dbSystems: Record<string, string> = {
	PgDialect: 'postgresql',
	MySqlDialect: 'mysql',
	SQLiteDialect: 'sqlite',
	SQLiteSyncDialect: 'sqlite',
	SQLiteAsyncDialect: 'sqlite',
	SingleStoreDialect: 'singlestore',
	CockroachDialect: 'cockroachdb',
	MsSqlDialect: 'microsoft.sql_server',
	GelDialect: 'gel',
};

function kindOf(value: unknown): string | undefined {
	return (value as { constructor?: Record<symbol, string>; })?.constructor?.[entityKind];
}

// Every Effect driver's session kind names it, e.g. EffectPgSession, PgEffectSession or SQLiteEffectSession
export function isEffectSession(session: unknown): boolean {
	return kindOf(session)?.includes('Effect') ?? false;
}

function isQuery(value: unknown): value is DrizzleQuery {
	return typeof(value as DrizzleQuery)?.sql === 'string' && Array.isArray((value as DrizzleQuery).params);
}

// Argument positions differ across dialects and Drizzle majors, so find these by shape instead
function isQueryMetadata(value: unknown): value is QueryMetadata {
	return typeof(value as QueryMetadata)?.type === 'string' && Array.isArray((value as QueryMetadata).tables);
}

// Read from the SQL since Drizzle 0.x tags updates as "insert" in its cache metadata
function getOperation(query: DrizzleQuery): string | undefined {
	const match = /^\s*([a-z]+)/i.exec(query.sql);
	if (match) {
		return match[1].toUpperCase();
	}
	return undefined;
}

// Matches Drizzle's JSON.stringify(params), with bigints as strings since JSON.stringify throws on them
function serializeParams(params: unknown[]): string {
	return JSON.stringify(params, (_key, value: unknown) => {
		if (typeof value === 'bigint') {
			return value.toString();
		}
		return value;
	}).slice(0, maxAttributeLength);
}

function fillPlaceholder(param: unknown, placeholderValues: unknown): unknown {
	if (kindOf(param) === 'Placeholder') {
		return (placeholderValues as Record<string, unknown> | undefined)?.[(param as { name: string; }).name];
	}
	return param;
}

function countRows(result: unknown): number | undefined {
	if (Array.isArray(result)) {
		return result.length;
	}
	const rows = (result as { rows?: unknown; })?.rows;
	if (Array.isArray(rows)) {
		return rows.length;
	}
	return undefined;
}

/** Records a driver error, which should already be unwrapped from Drizzle's own error types. */
export function recordFailure(span: SpanLike, cause: unknown) {
	if (!span.isTraced) {
		return;
	}
	const code = (cause as { code?: unknown; })?.code;
	const name = (cause as Error)?.name ?? 'Error';
	const message = (cause as Error)?.message ?? String(cause);
	const hasCode = typeof code === 'string' || typeof code === 'number';
	setAttributes(span, {
		'error.type': hasCode ? String(code) : name,
		'db.response.status_code': hasCode ? String(code) : undefined,
	});
	span.recordException?.({ name, message, stack: (cause as Error)?.stack });
	span.setStatus?.({ code: 'error', message });
}

function recordError(span: SpanLike, error: unknown) {
	// Drizzle wraps driver errors in DrizzleQueryError, the driver error holds the useful code
	recordFailure(span, (error as { cause?: unknown; })?.cause ?? error);
}

// Attributes are built lazily so unsampled requests skip the work
export function setSpanAttributes(config: Config, span: SpanLike, attributes: Attributes) {
	if (span.isTraced) {
		setAttributes(span, { ...config.baseAttributes, ...attributes() });
	}
}

// Ends with the callback's result, recording errors from both sync throws and rejected promises
export function runInSpan<T>(config: Config, name: string, attributes: Attributes, run: () => T, onResult?: OnResult): T {
	const tracer = config.tracer;
	if (!tracer) {
		return run();
	}
	return tracer.enterSpan(name, (span) => {
		setSpanAttributes(config, span, attributes);
		let result: T;
		try {
			result = run();
		} catch (error) {
			recordError(span, error);
			throw error;
		}
		if (result instanceof Promise) {
			// A trailing .catch() would also record errors thrown by onResult, which the sync path doesn't do
			// eslint-disable-next-line unicorn/prefer-then-catch
			return result.then((value) => {
				onResult?.(span, value);
				return value;
			}, (error) => {
				recordError(span, error);
				throw error;
			}) as T;
		}
		onResult?.(span, result);
		return result;
	});
}

function queryAttributes(config: Config, query: DrizzleQuery, operation: string | undefined, metadata: QueryMetadata | undefined, placeholderValues: unknown) {
	const attributes: Record<string, AttributeValue | undefined> = {
		'db.operation.name': operation,
		'db.collection.name': metadata?.tables.length === 1 ? metadata.tables[0] : undefined,
	};
	if (config.captureQueryText) {
		attributes['drizzle.query.text'] = query.sql.slice(0, maxAttributeLength);
	}
	if (config.captureParameters) {
		attributes['drizzle.query.params'] = serializeParams(query.params.map(param => fillPlaceholder(param, placeholderValues)));
	}
	return attributes;
}

function recordRows(span: SpanLike, result: unknown) {
	const rows = countRows(result);
	if (span.isTraced && rows !== undefined) {
		span.setAttribute('db.response.returned_rows', rows);
	}
}

function instrumentPreparedQuery<T extends object>(config: Config, prepared: T, query: DrizzleQuery, metadata: QueryMetadata | undefined): T {
	const operation = getOperation(query);
	// SQLite's execute() only forwards to this[executeMethod], and for sync drivers does so lazily, so trace the method it forwards to instead
	const forwardsExecute = typeof(prepared as { executeMethod?: unknown; }).executeMethod === 'string';
	// Counts synchronous nesting so a driver method calling a sibling, like all() calling execute(), yields one span
	let depth = 0;

	const proxy: T = new Proxy(prepared, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			const traced = typeof prop === 'string' && executeMethods.has(prop) && !(prop === 'execute' && forwardsExecute);
			// Everything else passes through untouched, since fields like postgres.js's `client` are functions with their own properties
			if (!traced || typeof value !== 'function') {
				return value;
			}
			const method = value as Method;
			// Runs against the proxy so calls it makes on `this`, including deferred ones, are traced too
			return (...args: unknown[]) => {
				if (depth > 0) {
					return method.apply(proxy, args);
				}
				// Drizzle's own name for the span around one prepared query run, so traces keep matching once its OTel spans ship
				return config.runInSpan(
					config,
					'drizzle.execute',
					() => queryAttributes(config, query, operation, metadata, args[0]),
					() => {
						depth++;
						try {
							return method.apply(proxy, args);
						} finally {
							depth--;
						}
					},
					recordRows,
				);
			};
		},
	});
	return proxy;
}

/** Wraps a session's queries and batches. Returns false when the session was already instrumented. */
export function instrumentQueries(config: Config, session: Session | undefined): boolean {
	if (!session || session[instrumented]) {
		return false;
	}
	session[instrumented] = true;

	const prepareQuery = session.prepareQuery;
	if (typeof prepareQuery === 'function') {
		session.prepareQuery = function(this: Session, ...args: unknown[]) {
			const prepared: unknown = prepareQuery.apply(this, args);
			const query = args.find(isQuery);
			if (!prepared || typeof prepared !== 'object' || !query) {
				return prepared;
			}
			return instrumentPreparedQuery(config, prepared, query, args.find(isQueryMetadata));
		};
	}

	const batch = session.batch;
	if (typeof batch === 'function') {
		session.batch = function(this: Session, queries: unknown, ...rest: unknown[]) {
			return config.runInSpan(
				config,
				'drizzle.batch',
				() => {
					return { 'db.operation.name': 'BATCH', 'db.operation.batch.size': Array.isArray(queries) ? queries.length : undefined };
				},
				() => batch.call(this, queries, ...rest),
			);
		};
	}
	return true;
}

export function createConfig(dialect: unknown, options: DrizzleTracingOptions, runInSpan: SpanRunner): Config {
	return {
		// Read on each call rather than captured, since the runtime tracer resolves asynchronously
		get tracer() {
			return options.tracer ?? getRuntimeTracer();
		},
		baseAttributes: {
			// OTel's instrumentation scope, the same pair Drizzle's own tracer reports as drizzle-orm and its version
			'otel.scope.name': 'cloudflare-drizzle-tracing',
			'otel.scope.version': __VERSION__,
			'db.system.name': options.dbSystem ?? dbSystems[kindOf(dialect) ?? ''] ?? 'other_sql',
			...options.attributes,
		},
		captureQueryText: options.captureQueryText ?? true,
		captureParameters: options.captureParameters ?? false,
		runInSpan,
	};
}
