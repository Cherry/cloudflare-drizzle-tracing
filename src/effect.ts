import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import {
	createConfig,
	instrumentQueries,
	isEffectSession,
	recordFailure,
	setSpanAttributes,
} from './core';

import type {
	Config,
	DrizzleTracingOptions,
	Method,
	Session,
	SpanRunner,
} from './core';
import type { SpanLike } from './tracer';

export type { DrizzleTracingOptions } from './core';
export type { AttributeValue, SpanLike, TracerLike } from './tracer';

type AnyEffect = Effect.Effect<unknown, unknown, unknown>;
type AnyExit = Exit.Exit<unknown, unknown>;

// Nested Effect transactions go back through session.transaction, so this is how a savepoint tells itself apart
const InTransaction = Context.Reference<boolean>('cloudflare-drizzle-tracing/InTransaction', { defaultValue: () => false });

// Effect drivers keep the driver error deeper than DrizzleQueryError: in EffectDrizzleQueryError's Cause, then SqlError's reason
function driverError(cause: Cause.Cause<unknown>): unknown {
	let error = Cause.squash(cause) as { cause?: unknown; } | undefined;
	if (Cause.isCause(error?.cause)) {
		error = Cause.squash(error.cause) as { cause?: unknown; } | undefined;
	}
	const reason = (error as { reason?: { cause?: unknown; }; } | undefined)?.reason;
	return reason?.cause ?? error?.cause ?? error;
}

function recordExit(span: SpanLike, exit: AnyExit, onResult: ((span: SpanLike, result: unknown) => void) | undefined) {
	if (Exit.isSuccess(exit)) {
		onResult?.(span, exit.value);
	} else if (!Cause.hasInterruptsOnly(exit.cause)) {
		recordFailure(span, driverError(exit.cause));
	}
}

// Opens the span when the Effect runs rather than when it's built, running it in a child fiber inside enterSpan so nested spans parent correctly
const runInEffectSpan: SpanRunner = (config, name, attributes, run, onResult) => {
	const effect = run();
	if (!Effect.isEffect(effect)) {
		return effect;
	}
	const traced = Effect.suspend(() => {
		const tracer = config.tracer;
		if (!tracer) {
			return effect as AnyEffect;
		}
		return Effect.flatMap(Effect.context<unknown>(), context => Effect.callback<unknown, unknown, unknown>((resume) => {
			let fiber: { interruptUnsafe(): void; } | undefined;
			const settled = tracer.enterSpan(name, (span) => {
				setSpanAttributes(config, span, attributes);
				return new Promise<AnyExit>((resolve) => {
					const child = Effect.runForkWith(context)(effect as AnyEffect);
					fiber = child;
					child.addObserver((exit) => {
						try {
							recordExit(span, exit, onResult);
						} finally {
							resolve(exit);
						}
					});
				});
			});
			// Resuming from a reaction registered out here keeps the caller in its own async context instead of the ended span's
			settled.then(exit => resume(exit));
			return Effect.sync(() => fiber?.interruptUnsafe());
		}));
	});
	return traced as typeof effect;
};

function wrapTransaction(config: Config, session: Session) {
	const transaction = session.transaction;
	if (typeof transaction !== 'function') {
		return;
	}
	session.transaction = function(this: Session, callback: Method, ...rest: unknown[]) {
		// Effect transactions reuse this session, so their queries are already instrumented
		const effect = transaction.call(this, callback, ...rest) as AnyEffect;
		return Effect.flatMap(Effect.context<unknown>(), (context) => {
			const operation = Context.get(context, InTransaction) ? 'SAVEPOINT' : 'TRANSACTION';
			return config.runInSpan(
				config,
				'drizzle.transaction',
				() => {
					return { 'db.operation.name': operation };
				},
				() => Effect.provideService(effect, InTransaction, true),
			);
		});
	};
}

/**
 * Adds Cloudflare Workers tracing spans to every query, transaction and batch run through a Drizzle Effect driver,
 * such as `drizzle-orm/effect-postgres` or `drizzle-orm/effect-d1`. Spans cover the Effect's execution, not its construction.
 * Mutates and returns `db`.
 */
export function instrumentEffectDrizzle<TDatabase extends object>(db: TDatabase, options: DrizzleTracingOptions = {}): TDatabase {
	const session = (db as Session).session as Session | undefined;
	if (!isEffectSession(session)) {
		throw new TypeError('cloudflare-drizzle-tracing: this is not an Effect Drizzle database, use instrumentDrizzle from cloudflare-drizzle-tracing instead');
	}
	const config = createConfig((db as Session).dialect, options, runInEffectSpan);
	if (instrumentQueries(config, session)) {
		wrapTransaction(config, session as Session);
	}
	return db;
}
