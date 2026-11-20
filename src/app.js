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
