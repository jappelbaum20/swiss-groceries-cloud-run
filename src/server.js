import { app } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = '0.0.0.0';

const httpServer = app.listen(port, host, () => {
  console.log(`Swiss Groceries Coop MCP listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  httpServer.close((error) => {
    if (error) {
      console.error('HTTP shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
