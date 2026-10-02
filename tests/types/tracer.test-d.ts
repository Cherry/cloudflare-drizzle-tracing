/// <reference types="@cloudflare/workers-types" />
import { expectTypeOf, it } from 'vitest';

import type { TracerLike } from '../../src';

it('accepts the Workers runtime tracer, so ctx.tracing can be passed in', () => {
	expectTypeOf<Tracing>().toExtend<TracerLike>();
});
