import { CoopAdapter } from '@nicktcode/swissgroceries-mcp/dist/adapters/coop/index.js';
import { normalizeProduct as normalizeCoopProduct } from '@nicktcode/swissgroceries-mcp/dist/adapters/coop/normalize.js';
import { readRetailerJson, RetailerError, retailerFetch } from './retailer-http.js';

const headers = { accept: 'application/json', 'accept-language': 'de-CH,de;q=0.9' };
const coopOrigin = 'https://www.coop.ch';
const migrosOrigin = 'https://www.migros.ch';
const retailerHosts = {
  coop: new Set(['www.coop.ch', 'coop.ch']),
  migros: new Set(['www.migros.ch', 'migros.ch']),
};

function nonempty(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

function opaqueId(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : nonempty(value);
}

function chfPrice(value, currency) {
  if (currency != null && currency !== 'CHF') return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sizeLabel(size) {
  if (!Number.isFinite(size?.value) || size.value <= 0 || !nonempty(size.unit)) return null;
  return `${size.value} ${size.unit === 'piece' ? 'Stk.' : size.unit}`;
}

function productUrl(retailer, productId, provided) {
  if (typeof provided === 'string') {
    try {
      const url = new URL(provided);
      const pathParts = url.pathname.replace(/\/$/, '').split('/');
      const productPath = retailer === 'coop' ? 'p' : 'product';
      if (url.protocol === 'https:' && retailerHosts[retailer].has(url.hostname) &&
          !url.username && !url.password && !url.port && pathParts.at(-2) === productPath &&
          decodeURIComponent(pathParts.at(-1)) === productId) {
        url.search = '';
        url.hash = '';
        return url.href;
      }
    } catch {
      // Use the canonical retail URL when the source value cannot be parsed.
    }
  }
  if (!/^\d+$/.test(productId)) return null;
  return retailer === 'coop'
    ? `${coopOrigin}/de/p/${productId}`
    : `${migrosOrigin}/de/product/${productId}`;
}

function coopProduct(raw) {
  const productId = opaqueId(raw?.code);
  if (!productId) return null;
  // The legacy normalizer supplies pack sizes and category paths. Use the raw
  // checkout price because the normalizer uses zero for a missing price.
  const normalized = normalizeCoopProduct(raw);
  const name = nonempty(normalized.name);
  if (!name) return null;
  return {
    retailer: 'coop',
    productId,
    detailId: productId,
    name,
    size: sizeLabel(normalized.size),
    priceCHF: chfPrice(raw.price?.value, raw.price?.currencyIso ?? raw.price?.currency),
    productUrl: productUrl('coop', productId, raw.productUrl ?? normalized.productUrl),
  };
}

function migrosProduct(raw) {
  const productId = opaqueId(raw?.migrosId);
  const name = nonempty(raw?.name) ?? nonempty(raw?.title);
  if (!productId || !name) return null;
  const offer = raw.offer;
  const quantity = nonempty(offer?.quantity);
  const price = offer?.promotionPrice ?? offer?.price;
  return {
    retailer: 'migros',
    productId,
    detailId: opaqueId(raw.uid),
    name,
    size: quantity?.replace(/^(\d+(?:[.,]\d+)?)(kg|g|ml|cl|dl|l)$/i, '$1 $2') ?? null,
    priceCHF: chfPrice(price?.effectiveValue, price?.currency ?? price?.currencyIso),
    productUrl: productUrl('migros', productId, raw.productUrl ?? raw.productUrls),
  };
}

export class CoopLookupAdapter extends CoopAdapter {
  constructor(fetchImpl = globalThis.fetch) {
    super();
    this.fetch = fetchImpl;
  }

  async lookupProducts(query, limit, signal) {
    // URL parsers resolve dot segments instead of sending them to the search route.
    if (query === '.' || query === '..') return { products: [], partial: false };
    const url = new URL(`${coopOrigin}/rest/v2/coopathome/products/search/${encodeURIComponent(query)}`);
    url.search = new URLSearchParams({
      currentPage: '0', pageSize: String(limit), query: 'availableOnline:false', language: 'de',
    });
    const body = await readRetailerJson(await retailerFetch(this.fetch, url, signal, { headers }));
    if (!Array.isArray(body?.products)) throw new RetailerError('unavailable');

    const products = [];
    let partial = false;
    for (const row of body.products.slice(0, limit)) {
      let product;
      try {
        product = coopProduct(row);
      } catch {
        // A malformed upstream row must not hide the rest of the results.
      }
      if (product) products.push(product);
      else partial = true;
    }
    return { products, partial };
  }
}

function awaitGuestSession(session, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void session.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// The v0.9.0 adapter's pinned SDK uses these public guest, search and
// product-detail routes. Use ordinary HTTPS with an abort signal for each
// request. A denied guest request or a 403 ends the lookup.
export class MigrosLookupAdapter {
  chain = 'migros';
  #auth;

  constructor({
    fetchImpl = globalThis.fetch,
    region = process.env.SWISSGROCERIES_MIGROS_REGION_ID || '2',
  } = {}) {
    this.fetch = fetchImpl;
    this.region = region;
  }

  async #login() {
    const url = new URL('/authentication/public/v1/api/guest', migrosOrigin);
    url.searchParams.set('authorizationNotRequired', 'true');
    const response = await retailerFetch(this.fetch, url, AbortSignal.timeout(4_000), { headers });
    const token = nonempty(response.headers.get('leshopch'));
    await response.body?.cancel().catch(() => {});
    if (!token) throw new RetailerError('unavailable');
    return token;
  }

  #guestSession() {
    this.#auth ??= this.#login().catch((error) => {
      this.#auth = undefined;
      throw error;
    });
    return this.#auth;
  }

  async lookupProducts(query, limit, signal) {
    let retried = false;
    const getJson = async (url, init) => {
      for (;;) {
        signal.throwIfAborted();
        const session = this.#guestSession();
        const token = await awaitGuestSession(session, signal);
        signal.throwIfAborted();
        try {
          const response = await retailerFetch(this.fetch, url, signal, {
            ...init,
            headers: { ...headers, ...init?.headers, leshopch: token },
          });
          return readRetailerJson(response);
        } catch (error) {
          if (error.status !== 401) throw error;
          // A late 401 from an older token must not invalidate a newer session.
          if (this.#auth === session) this.#auth = undefined;
          if (retried) throw error;
          retried = true;
        }
      }
    };

    const searchUrl = new URL('/onesearch-oc-seaapi/public/v5/search', migrosOrigin);
    const search = await getJson(searchUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        regionId: this.region, language: 'de', productIds: [], query,
        sortFields: [], sortOrder: 'asc', algorithm: 'DEFAULT',
      }),
    });
    if (!Array.isArray(search?.productIds)) throw new RetailerError('unavailable');

    const hits = search.productIds.slice(0, limit).map(opaqueId);
    const validUids = hits.filter((id) => /^\d+$/.test(id ?? ''));
    const uids = [...new Set(validUids)];
    const partial = validUids.length < hits.length;
    if (uids.length === 0) return { products: [], partial };

    const detailsUrl = new URL('/product-display/public/v2/product-detail', migrosOrigin);
    detailsUrl.search = new URLSearchParams({
      warehouseId: '1', storeType: 'OFFLINE', region: this.region, language: 'de', uids: uids.join(','),
    });
    const details = await getJson(detailsUrl);
    if (!details || typeof details !== 'object') throw new RetailerError('unavailable');

    const productsByUid = new Map();
    for (const row of Object.values(details)) {
      const product = migrosProduct(row);
      if (product) productsByUid.set(product.detailId, product);
    }
    const products = uids.map((uid) => productsByUid.get(uid)).filter(Boolean);
    return { products, partial: partial || products.length < uids.length };
  }
}
