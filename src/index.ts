import {
	createConfig,
	instrumentQueries,
	isEffectSession,
	runInSpan,
} from './core';

import type {
	Config,
	DrizzleTracingOptions,
	Method,
	Session,
} from './core';

export type { DrizzleTracingOptions } from './core';
export type { AttributeValue, SpanLike, TracerLike } from './tracer';

function instrumentSession(config: Config, session: Session | undefined) {
	if (!instrumentQueries(config, session)) {
		return;
	}

	// Each transaction and savepoint gets a fresh session, so instrument every level as Drizzle creates it
	function wrapTransaction(owner: Session, operation: string) {
		const transaction = owner.transaction;
		if (typeof transaction !== 'function') {
			return;
		}
		owner.transaction = function(this: Session, callback: Method, ...rest: unknown[]) {
			return runInSpan(
				config,
				'drizzle.transaction',
				() => {
					return { 'db.operation.name': operation };
				},
				() => transaction.call(this, (tx: Session) => {
					instrumentSession(config, tx.session as Session | undefined);
					wrapTransaction(tx, 'SAVEPOINT');
					return callback(tx);
				}, ...rest),
			);
		};
	}

	wrapTransaction(session as Session, 'TRANSACTION');
}

/**
 * Adds Cloudflare Workers tracing spans to every query, transaction and batch run through a Drizzle instance.
 * Works with any Promise-based Drizzle driver since it hooks the dialect-agnostic session layer. Mutates and returns `db`.
 * For Drizzle's Effect drivers, use `instrumentEffectDrizzle` from `cloudflare-drizzle-tracing/effect`.
 */
export function instrumentDrizzle<TDatabase extends object>(db: TDatabase, options: DrizzleTracingOptions = {}): TDatabase {
	const session = (db as Session).session as Session | undefined;
	// Effect queries only build an Effect when called, so spans opened here would end before the query runs
	if (isEffectSession(session)) {
		throw new TypeError('cloudflare-drizzle-tracing: this is an Effect Drizzle database, use instrumentEffectDrizzle from cloudflare-drizzle-tracing/effect instead');
	}
	instrumentSession(createConfig((db as Session).dialect, options, runInSpan), session);
	return db;
}
