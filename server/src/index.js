// Entry point: wires the store, mailer, egress guard, Chromium and the HTTP server together.
import { config } from './config.js';
import { Store } from './store.js';
import { createMailer } from './mailer.js';
import { createGuard } from './guard.js';
import { BrowserHub } from './browser.js';
import { createApp } from './app.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const store = await new Store(config.dataDir).load();
const mailer = createMailer({ apiKey: config.resendApiKey, from: config.mailFrom, to: config.ownerEmail, log });
const guard = createGuard({ allowPrivate: config.allowPrivate, log: config.dev ? log : () => {} });
const proxyServer = await guard.listen();
const hub = await new BrowserHub({ proxyServer, limits: config.limits, screen: config.screen, log }).start();
const { server } = createApp({ config, store, mailer, hub, log });

server.listen(config.port, config.host, () => {
  log(`[orbit] listening on ${config.host}:${config.port} (public URL ${config.publicUrl})`);
  if (config.allowPrivate) log('[orbit] WARNING: ORBIT_ALLOW_PRIVATE is on. Never use this on a public server.');
  if (!config.resendApiKey) log('[orbit] RESEND_API_KEY is not set: approval links are printed here instead of emailed.');
  if (config.admin.id && config.admin.password) log(`[orbit] admin login enabled for id "${config.admin.id}"`);
  else log('[orbit] admin login is OFF (set ORBIT_ADMIN_ID and ORBIT_ADMIN_PASSWORD to enable).');
});

async function shutdown(signal) {
  log(`[orbit] ${signal}, shutting down`);
  server.close();
  await hub.stop().catch(() => {});
  await guard.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
