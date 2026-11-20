const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class RetailerError extends Error {
  constructor(code, status, retryAfter) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function statusCode(status) {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 422) return 'bad_request';
  return 'unavailable';
}

export async function retailerFetch(fetchImpl, url, signal, init) {
  const response = await fetchImpl(url, { ...init, signal, redirect: 'error' });
  if (response.ok) return response;
  await response.body?.cancel().catch(() => {});
  throw new RetailerError(statusCode(response.status), response.status, response.headers.get('retry-after'));
}

export async function readRetailerJson(response) {
  if (!response.body) throw new RetailerError('unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new RetailerError('unavailable');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
