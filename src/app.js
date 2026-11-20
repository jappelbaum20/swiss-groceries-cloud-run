import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCoopServer } from './coop-server.js';

export function createApp(createMcpServer = createCoopServer) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_request, response) => {
    response.json({
      service: 'Swiss Groceries Coop MCP',
      status: 'ok',
      mcpEndpoint: '/mcp',
    });
  });

  app.get(['/health', '/healthz'], (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/version', (_request, response) => {
    const { SOURCE_SHA, CLOUD_BUILD_ID, K_REVISION } = process.env;
    response.set('Cache-Control', 'no-store').json({
      sourceSha: /^[0-9a-f]{40}$/i.test(SOURCE_SHA ?? '') ? SOURCE_SHA : null,
      buildId: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(CLOUD_BUILD_ID ?? '') ? CLOUD_BUILD_ID : null,
      revision: /^[a-z][a-z0-9-]{0,62}$/.test(K_REVISION ?? '') ? K_REVISION : null,
    });
  });

  app.post('/mcp', async (request, response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } catch (error) {
        console.error('Failed to close MCP server cleanly', error);
      }
    };

    response.on('close', () => void close());

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  function methodNotAllowed(_request, response) {
    response
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
  }

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

export const app = createApp();
