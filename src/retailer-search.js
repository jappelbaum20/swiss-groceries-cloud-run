import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RetailerError } from './retailer-http.js';

const MAX_QUERY_LENGTH = 120;
const CACHE_TTL_MS = 120_000;
const CACHE_SIZE = 128;
const MAX_CONCURRENT = 4;
const REFILL_MS = 500;
const LOOKUP_TIMEOUT_MS = 3_500;
const DENIED_COOLDOWN_MS = 30 * 60_000;
const MAX_RATE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

const argsSchema = z.object({
  retailer: z.enum(['coop', 'migros']),
  query: z.string().min(1).refine((query) =>
    query.trim().length > 0 && query.isWellFormed() && [...query].length <= MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(10),
}).strict();

const inputSchema = zodToJsonSchema(argsSchema);
inputSchema.properties.query.maxLength = MAX_QUERY_LENGTH;

export const retailerSearchTool = {
  name: 'search_retailer_products',
  description: 'Find current Coop or Migros products in German. Choose one retailer per search.',
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

function errorResult(retailer, code) {
  return { products: [], errors: [{ retailer, code }], fetchedAt: new Date().toISOString() };
}

function cooldownMs(retryAfter) {
  if (!retryAfter) return DEFAULT_COOLDOWN_MS;
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1_000;
  const absolute = Date.parse(retryAfter);
  return Number.isFinite(absolute) ? Math.max(0, absolute - Date.now()) : DEFAULT_COOLDOWN_MS;
}

export function createRetailerSearch(registry) {
  const states = new Map(['coop', 'migros'].map((retailer) => [retailer, {
    cache: new Map(), pending: new Map(), tokens: MAX_CONCURRENT,
    lastRefill: performance.now(), blockedUntil: 0, deniedUntil: 0,
  }]));

  async function search({ retailer, query, limit }) {
    const state = states.get(retailer);
    const key = JSON.stringify([query, limit]);
    const now = performance.now();
    if (state.deniedUntil > now) return errorResult(retailer, 'unavailable');
    const cached = state.cache.get(key);
    if (cached && cached.expires > now) return cached.result;
    state.cache.delete(key);

    const pending = state.pending.get(key);
    if (pending) return pending;

    state.tokens = Math.min(MAX_CONCURRENT, state.tokens + (now - state.lastRefill) / REFILL_MS);
    state.lastRefill = now;
    if (state.blockedUntil > now || state.pending.size >= MAX_CONCURRENT || state.tokens < 1) {
      return errorResult(retailer, 'rate_limited');
    }
    state.tokens -= 1;

    const run = async () => {
      const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
      try {
        const { products, partial } = await registry.get(retailer).lookupProducts(query, limit, signal);
        const result = {
          products,
          errors: partial ? [{ retailer, code: 'unavailable' }] : [],
          fetchedAt: new Date().toISOString(),
        };
        if (!partial) {
          state.cache.set(key, { result, expires: performance.now() + CACHE_TTL_MS });
          if (state.cache.size > CACHE_SIZE) state.cache.delete(state.cache.keys().next().value);
        }
        return result;
      } catch (error) {
        if (error instanceof RetailerError) {
          if (error.status === 403) state.deniedUntil = performance.now() + DENIED_COOLDOWN_MS;
          if (error.code === 'rate_limited') {
            state.blockedUntil = Math.max(state.blockedUntil, performance.now() + Math.min(MAX_RATE_COOLDOWN_MS, cooldownMs(error.retryAfter)));
          }
          return errorResult(retailer, error.code);
        }
        return errorResult(retailer, signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'unavailable');
      }
    };

    const job = run().finally(() => state.pending.delete(key));
    state.pending.set(key, job);
    return job;
  }

  return async (args) => {
    const parsed = argsSchema.safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: '{"error":"bad_request"}' }] };

    const result = await search({ ...parsed.data, query: parsed.data.query.trim() });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };
}
