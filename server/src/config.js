// All settings come from environment variables so that nothing secret lives in the repository.
import crypto from 'node:crypto';
import path from 'node:path';

const env = process.env;

function int(name, fallback) {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name) {
  return env[name] === '1' || env[name] === 'true';
}

const dev = bool('ORBIT_DEV');

let secret = env.ORBIT_SECRET;
if (!secret) {
  if (!dev) {
    throw new Error('ORBIT_SECRET is required (use a long random string, e.g. `openssl rand -hex 32`).');
  }
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] ORBIT_SECRET is not set; using a random one for this run (dev mode).');
}

export const config = {
  dev,
  port: int('PORT', 8080),
  host: env.HOST || '0.0.0.0',
  // Public URL of this server, used for the approve link in the email.
  publicUrl: (env.ORBIT_PUBLIC_URL || `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, ''),
  // Origins (front-end pages) that may call the API, comma separated.
  allowedOrigins: (env.ORBIT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  secret,
  dataDir: path.resolve(env.ORBIT_DATA_DIR || path.join(process.cwd(), 'data')),
  staticDir: env.ORBIT_STATIC_DIR ? path.resolve(env.ORBIT_STATIC_DIR) : null,
  trustProxy: bool('ORBIT_TRUST_PROXY'),

  ownerEmail: env.ORBIT_OWNER_EMAIL || '',
  mailFrom: env.ORBIT_MAIL_FROM || 'Orbit <onboarding@resend.dev>',
  resendApiKey: env.RESEND_API_KEY || '',

  // The built-in (bootstrap) admin. Credentials come from the environment, never the repo,
  // so this public code carries no password. Set ORBIT_ADMIN_ID and ORBIT_ADMIN_PASSWORD in .env.
  admin: {
    id: (env.ORBIT_ADMIN_ID || '').normalize('NFKC').trim().toLowerCase(),
    password: env.ORBIT_ADMIN_PASSWORD || '',
  },

  // Only for local tests: lets the remote browser open localhost / LAN pages.
  allowPrivate: bool('ORBIT_ALLOW_PRIVATE'),

  // Trade isolation and speed for RAM, for a tiny server such as a 1 GB free instance.
  lowMemory: bool('ORBIT_LOW_MEMORY'),

  limits: {
    tabsPerUser: int('ORBIT_TABS_PER_USER', 3),
    tabsTotal: int('ORBIT_TABS_TOTAL', 10),
    idleMs: int('ORBIT_IDLE_MINUTES', 10) * 60_000,
    sessionMs: int('ORBIT_SESSION_MINUTES', 60) * 60_000,
    tokenMs: int('ORBIT_TOKEN_HOURS', 12) * 3_600_000,
    applyPerHour: int('ORBIT_APPLY_PER_HOUR', 3),
    loginPerMinute: int('ORBIT_LOGIN_PER_MINUTE', 10),
    pendingMax: int('ORBIT_PENDING_MAX', 30),
    passwordMinLength: int('ORBIT_PASSWORD_MIN_LENGTH', 8),
  },

  screen: {
    quality: int('ORBIT_JPEG_QUALITY', 60),
    maxWidth: int('ORBIT_MAX_WIDTH', 1600),
    maxHeight: int('ORBIT_MAX_HEIGHT', 1000),
  },
};
