import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db/pool.js'

async function main() {
  const config = loadConfig();
  const db = createPool(config);
  const app = await buildApp({ config, db });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ host: config.HOST, port: config.PORT });
}
main().catch(error => {
  console.error('APEX API failed to start:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});