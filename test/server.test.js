import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../src/app.js';

let httpServer;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
});

test('health endpoint reports ready', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('MCP endpoint exposes the three legacy Coop tools and shared retailer search', async () => {
  const client = new Client({ name: 'wrapper-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

  try {
    await client.connect(transport);
    const result = await client.listTools();

    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      [
        'resolve_ingredient_to_coop_products',
        'get_coop_product',
        'find_current_coop_discounts',
        'search_retailer_products',
      ],
    );
    for (const tool of result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, true);
    }
  } finally {
    await client.close();
  }
});

test('MCP endpoint rejects unsupported HTTP methods', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${baseUrl}/mcp`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
});
