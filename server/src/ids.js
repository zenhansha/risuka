// IDs, passwords, signatures and session tokens.
//
// The ID is a public name the person picks ("starman"). The password is the secret.
// Passwords are stored only as salted scrypt hashes, so even a leaked data file
// does not reveal them.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const ID_MIN = 3;
export const ID_MAX = 24;
export const PASSWORD_MAX = 128;
const ID_CHARS = /^[a-z0-9._-]+$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Full-width to half-width, trimmed, lowercase: "Starman" and "ｓｔａｒｍａｎ" are the same ID. */
export function normalizeId(input) {
  return String(input ?? '').normalize('NFKC').trim().toLowerCase();
}

/** Returns a message explaining what is wrong with the ID, or null when it is fine. */
export function checkId(input) {
  const id = normalizeId(input);
  if (id.length < ID_MIN) return `ID は ${ID_MIN} 文字以上にしてください`;
  if (id.length > ID_MAX) return `ID は ${ID_MAX} 文字までです`;
  if (!ID_CHARS.test(id)) return 'ID に使えるのは英数字と - _ . だけです';
  return null;
}

/** Returns a message explaining what is wrong with the password, or null when it is fine. */
export function checkPassword(password, id, minLength = 8) {
  const pw = String(password ?? '');
  if (pw.length < minLength) return `パスワードは ${minLength} 文字以上にしてください`;
  if (pw.length > PASSWORD_MAX) return `パスワードは ${PASSWORD_MAX} 文字までです`;
  if (/^(.)\1+$/.test(pw)) return '同じ文字だけのパスワードは使えません';
  if (id && pw.toLowerCase().includes(normalizeId(id))) return 'パスワードに ID を入れないでください';
  return null;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Used when the ID does not exist, so a wrong ID takes as long as a wrong password.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));

export async function verifyPassword(password, stored) {
  try {
    const record = stored || (await DUMMY);
    const [kind, N, r, p, saltB64, hashB64] = String(record).split('$');
    if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(String(password ?? '').normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual) && Boolean(stored);
  } catch {
    return false;
  }
}

export function newApplicationId() {
  return crypto.randomBytes(9).toString('base64url');
}

/** Constant-time compare of two strings (via HMAC, so length never leaks). */
export function constantEquals(a, b, secret) {
  const ha = crypto.createHmac('sha256', secret).update(String(a ?? '')).digest();
  const hb = crypto.createHmac('sha256', secret).update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function verifySignature(data, signature, secret) {
  const expected = Buffer.from(sign(data, secret));
  const given = Buffer.from(String(signature ?? ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Signed, expiring session token: base64url(payload).signature */
export function issueToken(sub, ttlMs, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(`token:${payload}`, secret)}`;
}

export function readToken(token, secret, now = Date.now()) {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig || !verifySignature(`token:${payload}`, sig, secret)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.sub !== 'string' || typeof data.exp !== 'number' || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}
