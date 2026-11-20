import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AdapterRegistry } from '@nicktcode/swissgroceries-mcp/dist/adapters/registry.js';
import { app, createApp } from '../src/app.js';
import { createCoopServer } from '../src/coop-server.js';
import { CoopLookupAdapter, MigrosLookupAdapter } from '../src/retailer-products.js';
import { createRetailerSearch } from '../src/retailer-search.js';

const contractBytes = readFileSync(new URL('./fixtures/contract-v1.json', import.meta.url));
const contract = JSON.parse(contractBytes);
const ajv = new Ajv2020({ allowUnionTypes: true });
addFormats(ajv);
const requestIsValid = ajv.compile(contract.schema.$defs.request);
const responseIsValid = ajv.compile(contract.schema.$defs.response);

const coopRow = { code: '3021253', name: 'Thai Kitchen Kokosnussmilch', content: '250', contentUnit: 'ml',
  price: { value: 2.8, currencyIso: 'CHF' }, originalPrice: { value: 4 } };
const migrosRow = { uid: 100006357, migrosId: '204003200000', name: 'Vollmilch',
  offer: { quantity: '1l', price: { effectiveValue: 2.3 }, promotionPrice: { effectiveValue: 1.9 } } };

function useFetch(fetchImpl) {
  const registry = new AdapterRegistry();
  registry.register(new CoopLookupAdapter(fetchImpl));
  registry.register(new MigrosLookupAdapter({ fetchImpl, region: '2' }));
  return { registry, search: createRetailerSearch(registry) };
}

function args(retailer, query = 'Milch', limit = 3) {
  return { retailer, query, limit };
}

function unwrap(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

function unwrapSearch(result) {
  const packet = unwrap(result);
  assert.equal(responseIsValid(packet), true, JSON.stringify(responseIsValid.errors));
  return packet;
}

function assertExample(packet, index) {
  assert.deepEqual({ ...packet, fetchedAt: contract.examples[index].fetchedAt }, contract.examples[index]);
}

function guest(token = 'fixture-token') {
  return new Response(null, { headers: { leshopch: token } });
}

function status(code, headers) {
  return new Response('private upstream debug data', { status: code, headers });
}

async function listen(t, expressApp) {
  const server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return new URL('/mcp', 'http://127.0.0.1:' + server.address().port);
}

async function connect(t, url) {
  const client = new Client({ name: 'retailer-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  t.after(() => client.close());
  return client;
}

test('uses the frozen request and response schema and example fixture bytes', async (t) => {
  const hash = createHash('sha256').update(contractBytes).digest('hex');
  assert.equal(hash, '4f1694a94010511a4ee9d304b94837302742fda119989675ad52ee84f414879e');
  for (const example of contract.examples) assert.equal(responseIsValid(example), true);
  const client = await connect(t, await listen(t, app));
  const { tools } = await client.listTools();
  const input = tools.find((tool) => tool.name === contract.tool).inputSchema;
  const { $schema, ...schema } = input;
  assert.deepEqual(schema, {
    ...contract.schema.$defs.request,
    properties: {
      ...contract.schema.$defs.request.properties,
      retailer: { type: 'string', ...contract.schema.$defs.request.properties.retailer },
    },
  });
});

test('exercises both contract products, the empty result and the upstream failure over MCP HTTP', async (t) => {
  let guestCalls = 0;
  let searchCalls = 0;
  const { registry, search } = useFetch(async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.equal(init.headers['user-agent'], undefined);
    if (url.hostname === 'www.coop.ch') {
      assert.equal(url.pathname, '/rest/v2/coopathome/products/search/Kokosnussmilch');
      assert.equal(url.searchParams.get('language'), 'de');
      return Response.json({ products: [coopRow] });
    }
    assert.equal(url.hostname, 'www.migros.ch');
    if (url.pathname.endsWith('/guest')) {
      guestCalls++;
      assert.equal(init.headers.leshopch, undefined);
      return guest();
    }
    assert.equal(init.headers.leshopch, 'fixture-token');
    if (url.pathname.endsWith('/search')) {
      searchCalls++;
      const body = JSON.parse(init.body);
      assert.equal(body.language, 'de');
      assert.equal(body.regionId, '2');
      if (body.query === 'missing') return Response.json({ productIds: [] });
      if (body.query === 'failure') return status(503);
      return Response.json({ productIds: [100006357] });
    }
    assert.equal(url.pathname, '/product-display/public/v2/product-detail');
    assert.equal(url.searchParams.get('uids'), '100006357');
    assert.equal(url.searchParams.get('region'), '2');
    assert.equal(url.searchParams.get('language'), 'de');
    return Response.json({ 0: migrosRow });
  });

  const url = await listen(t, createApp(() => createCoopServer(registry, search)));
  const bare = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: contract.tool, arguments: args('coop', 'Kokosnussmilch') },
    }),
  });
  assert.equal(bare.status, 200);
  const body = await bare.text();
  const payload = bare.headers.get('content-type')?.includes('text/event-stream')
    ? body.split(/\r?\n/).find((line) => line.startsWith('data:')).slice(5)
    : body;
  const reply = JSON.parse(payload);
  assert.equal(reply.id, 1);
  assertExample(unwrapSearch(reply.result), 0);
  const [one, two] = await Promise.all([connect(t, url), connect(t, url)]);
  const call = (client, input) => client.callTool({ name: contract.tool, arguments: input }).then(unwrapSearch);
  assert.equal(guestCalls, 0);
  assertExample(await call(one, args('coop', 'Kokosnussmilch')), 0);
  const [first, coalesced] = await Promise.all([call(one, args('migros')), call(two, args('migros'))]);
  assertExample(first, 1);
  assert.deepEqual(coalesced, first);
  assert.deepEqual(await call(two, args('migros', ' Milch ')), first);
  assertExample(await call(one, args('migros', 'missing')), 2);
  assertExample(await call(two, args('migros', 'failure')), 3);
  assert.equal(guestCalls, 1);
  assert.equal(searchCalls, 3);
});

test('rejects invalid arguments as sanitized MCP tool errors before any fetch', async (t) => {
  let calls = 0;
  const { registry, search } = useFetch(async () => {
    calls++;
    return Response.json({ products: [] });
  });
  const client = await connect(t, await listen(t, createApp(() => createCoopServer(registry, search))));
  for (const input of [
    { retailer: ['coop', 'migros'], query: 'x', limit: 3 },
    { retailer: 'migros', query: 'x' },
    args('migros', 'x'.repeat(121)),
    args('migros', 'x', 11),
    args('migros', 'x', 0.5),
    { ...args('coop'), region: '2' },
    args('coop', ''),
  ]) {
    assert.equal(requestIsValid(input), false);
    const result = await client.callTool({ name: contract.tool, arguments: input });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: 'bad_request' });
  }
  assert.equal(calls, 0);

  const unicode = args('coop', '🍐'.repeat(120), 10);
  assert.equal(requestIsValid(unicode), true);
  assertExample(unwrapSearch(await search(unicode)), 2);
  assert.equal(calls, 1);
});

test('returns partial Coop results with known product links and null for missing price', async () => {
  const { search } = useFetch(async () => Response.json({ products: [
    { ...coopRow, productUrl: 'https://www.coop.ch/de/asia/p/3021253' },
    { ...coopRow, code: '123', price: undefined, productUrl: 'https://www.coop.ch.evil.example/de/p/123' },
    { ...coopRow, code: '234', price: { value: 1.1, currencyIso: 'USD' }, productUrl: 'https://secret@coop.ch/de/p/234' },
    { code: '456' },
  ] }));
  const result = unwrapSearch(await search(args('coop', 'Kokosnussmilch', 4)));
  assert.deepEqual(result.errors, [{ retailer: 'coop', code: 'unavailable' }]);
  assert.deepEqual(result.products.map((p) => [p.productId, p.priceCHF, p.productUrl]), [
    ['3021253', 2.8, 'https://www.coop.ch/de/asia/p/3021253'],
    ['123', null, 'https://www.coop.ch/de/p/123'],
    ['234', null, 'https://www.coop.ch/de/p/234'],
  ]);
});

test('preserves search rank, skips missing Migros details and never estimates prices', async () => {
  const { search } = useFetch(async (url) => {
    if (url.pathname.endsWith('/guest')) return guest();
    if (url.pathname.endsWith('/search')) return Response.json({ productIds: [100006357, 12, 13, 14] });
    return Response.json([
      { ...migrosRow, uid: 12, migrosId: '111', offer: { quantity: '500g', price: { unitPrice: { value: 5, unit: '1kg' } } } },
      migrosRow,
      { ...migrosRow, uid: 13, migrosId: undefined },
    ]);
  });
  const result = unwrapSearch(await search(args('migros', 'Milch', 4)));
  assert.deepEqual(result.errors, [{ retailer: 'migros', code: 'unavailable' }]);
  assert.deepEqual(result.products.map((p) => [p.productId, p.detailId, p.priceCHF]), [
    ['204003200000', '100006357', 1.9],
    ['111', '12', null],
  ]);
});

test('shares one guest login and one refresh even with concurrent distinct searches', async () => {
  let guestCalls = 0;
  let expired = 0;
  let releaseExpired;
  const bothExpired = new Promise((resolve) => { releaseExpired = resolve; });
  const { search } = useFetch(async (url, init) => {
    if (url.pathname.endsWith('/guest')) return guest('token-' + ++guestCalls);
    if (init.headers.leshopch === 'token-1') {
      if (++expired === 2) releaseExpired();
      await bothExpired;
      return status(401);
    }
    assert.equal(init.headers.leshopch, 'token-2');
    return Response.json({ productIds: [] });
  });
  const results = await Promise.all([search(args('migros', 'a')), search(args('migros', 'b'))]);
  assert.equal(guestCalls, 2);
  assert.equal(expired, 2);
  for (const result of results) assertExample(unwrapSearch(result), 2);
});

test('an aborted lookup stops waiting without cancelling the shared guest session', async () => {
  let completeGuest;
  const blocked = new Promise((resolve) => { completeGuest = resolve; });
  let guestCalls = 0;
  let productCalls = 0;
  const adapter = new MigrosLookupAdapter({
    fetchImpl: async (url) => {
      if (url.pathname.endsWith('/guest')) {
        ++guestCalls;
        await blocked;
        return guest();
      }
      ++productCalls;
      return Response.json({ productIds: [] });
    },
  });
  const aborted = new AbortController();
  const active = new AbortController();
  const first = adapter.lookupProducts('Milch', 1, aborted.signal);
  const second = adapter.lookupProducts('Käse', 1, active.signal);
  aborted.abort(new DOMException('fixture deadline', 'TimeoutError'));

  try {
    await assert.rejects(first, { name: 'TimeoutError' });
    assert.equal(guestCalls, 1);
    assert.equal(productCalls, 0);
  } finally {
    completeGuest();
  }
  assert.deepEqual(await second, { products: [], partial: false });
  assert.equal(productCalls, 1);
});

test('stops after one 401 retry, never retries a 403, and clears failed guest sessions', async () => {
  let guestCalls = 0;
  let responseCode = 401;
  let productCalls = 0;
  const { search } = useFetch(async (url) => {
    if (url.pathname.endsWith('/guest')) {
      ++guestCalls;
      return guestCalls === 1 ? status(503) : guest();
    }
    ++productCalls;
    return status(responseCode);
  });
  assertExample(unwrapSearch(await search(args('migros', 'a'))), 3);
  assert.equal(guestCalls, 1);
  assert.equal(productCalls, 0);

  assertExample(unwrapSearch(await search(args('migros', 'b'))), 3);
  assert.equal(guestCalls, 3);
  assert.equal(productCalls, 2);

  responseCode = 403;
  assertExample(unwrapSearch(await search(args('migros', 'c'))), 3);
  assert.equal(guestCalls, 4);
  assert.equal(productCalls, 3);
  assertExample(unwrapSearch(await search(args('migros', 'another query'))), 3);
  assert.equal(guestCalls, 4);
  assert.equal(productCalls, 3);
});

test('a denied guest request puts later searches on cooldown', async () => {
  let calls = 0;
  const { search } = useFetch(async () => {
    calls++;
    return status(403);
  });
  for (const query of ['Milch', 'Reis']) {
    assertExample(unwrapSearch(await search(args('migros', query))), 3);
  }
  assert.equal(calls, 1);
});

test('bounds concurrent calls and respects a sanitized upstream 429 cooldown', async () => {
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { search } = useFetch(async () => {
    ++calls;
    await barrier;
    return status(429, { 'retry-after': '60' });
  });
  const admitted = ['a', 'b', 'c', 'd'].map((query) => search(args('coop', query)));
  const throttled = unwrapSearch(await search(args('coop', 'e')));
  assert.deepEqual(throttled.errors, [{ retailer: 'coop', code: 'rate_limited' }]);
  assert.equal(calls, 4);
  release();
  for (const result of await Promise.all(admitted)) {
    assert.deepEqual(unwrapSearch(result).errors, throttled.errors);
  }
  assert.deepEqual(unwrapSearch(await search(args('coop', 'later'))).errors, throttled.errors);
  assert.equal(calls, 4);
});

test('sanitizes transport errors, malformed data and upstream bad requests', async () => {
  const { search } = useFetch(async (url) => {
    if (url.pathname.endsWith('/timeout')) throw new DOMException('private upstream data', 'TimeoutError');
    if (url.pathname.endsWith('/bad')) return status(400);
    if (url.pathname.endsWith('/shape')) return Response.json({ error: 'private upstream data' });
    return new Response('private non-JSON content');
  });
  for (const [query, code] of [['timeout', 'timeout'], ['bad', 'bad_request'],
    ['shape', 'unavailable'], ['json', 'unavailable']]) {
    const packet = unwrapSearch(await search(args('coop', query)));
    assert.deepEqual(packet.products, []);
    assert.deepEqual(packet.errors, [{ retailer: 'coop', code }]);
  }
});

test('retains the three legacy input and output contracts over MCP HTTP', async (t) => {
  const registry = new AdapterRegistry();
  const product = { id: '3021253', name: coopRow.name, price: { current: 2.8, regular: 4, currency: 'CHF' },
    size: { value: 250, unit: 'ml' }, productUrl: 'https://www.coop.ch/de/p/3021253', department: 'Asian' };
  const ok = (data) => ({ ok: true, data });
  registry.register({
    chain: 'coop',
    capabilities: { productSearch: true, promotions: true },
    searchProducts: (query) => {
      assert.equal(query.query, 'Milch');
      assert.equal(query.limit, 10);
      assert.equal(query.maxPrice, 4);
      return ok([product]);
    },
    getProduct: (id) => {
      assert.equal(id, product.id);
      return ok(product);
    },
    getPromotions: (query) => {
      assert.equal(query.query, 'Käse');
      assert.equal(query.endingWithinDays, 7);
      return ok([{ productId: product.id, productName: product.name, price: product.price }]);
    },
  });
  const client = await connect(t, await listen(t, createApp(() => createCoopServer(registry))));
  const call = (name, input) => client.callTool({ name, arguments: input }).then(unwrap);
  const lookup = await call('resolve_ingredient_to_coop_products', { query: ' Milch ', maxPrice: 4 });
  const legacyProduct = {
    productNumber: product.id, name: product.name, price: product.price, discountPercent: 30,
    size: product.size, coopUrl: product.productUrl,
  };
  assert.deepEqual(Object.keys(lookup).sort(), ['products', 'query', 'source']);
  assert.deepEqual(lookup.products, [legacyProduct]);
  assert.equal(lookup.query, 'Milch');
  assert.equal(lookup.source.fromCache, false);

  const detail = await call('get_coop_product', { productNumber: product.id });
  assert.deepEqual(Object.keys(detail).sort(), ['fetchedAt', 'fromCache', 'product']);
  assert.deepEqual(detail.product, { ...legacyProduct, department: 'Asian' });
  assert.equal(detail.fromCache, false);

  const deals = await call('find_current_coop_discounts', { query: 'Käse', endingWithinDays: 7, limit: 1 });
  assert.deepEqual(Object.keys(deals).sort(), ['availableBeforeLimit', 'discounts', 'fetchedAt', 'query', 'returned']);
  assert.equal(deals.query, 'Käse');
  assert.equal(deals.returned, 1);
  assert.equal(deals.availableBeforeLimit, 1);
  assert.deepEqual(deals.discounts, [{
    productNumber: product.id, name: product.name, price: product.price, discountPercent: 30,
    coopUrl: 'https://www.coop.ch/de/search/?text=3021253',
  }]);
});

test('lookup logs contain only bounded outcome, retailer and duration', async () => {
  const entries = [];
  const registry = new Map([
    ['coop', { lookupProducts: async () => ({ products: [], partial: false }) }],
    ['migros', { lookupProducts: async () => { throw Error('private upstream detail'); } }],
  ]);
  const search = createRetailerSearch(registry, line => entries.push(JSON.parse(line)));
  await search(args('coop', 'private query'));
  await search(args('migros', 'private query'));
  assert.equal(entries.length, 2);
  for (const [index, [retailer, outcome]] of [['coop', 'empty'], ['migros', 'unavailable']].entries()) {
    const { latencyMs, ...fields } = entries[index];
    assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0);
    assert.deepEqual(fields, { event: 'retailer_lookup', retailer, outcome });
  }
});
