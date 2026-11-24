// HTTP API, the email review pages and the WebSocket that carries the remote browser.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  normalizeId, checkId, checkPassword, hashPassword, verifyPassword, newApplicationId,
  constantEquals, sign, verifySignature, issueToken, readToken,
} from './ids.js';
import { RateLimiter } from './ratelimit.js';
import { reviewPage, messagePage, approvalEmail } from './html.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function createApp({ config, store, mailer, hub, log = console.log }) {
  const applyLimit = new RateLimiter(config.limits.applyPerHour, 3_600_000);
  const loginLimit = new RateLimiter(config.limits.loginPerMinute, 60_000);
  const idLimit = new RateLimiter(10, 15 * 60_000); // wrong passwords per ID, whatever the IP
  const decideLimit = new RateLimiter(30, 60_000);

  const reviewUrl = (appId) =>
    `${config.publicUrl}/admin/review?app=${encodeURIComponent(appId)}&sig=${sign(`review:${appId}`, config.secret)}`;

  // ---- settings the admin panel can change at runtime -----------------------------------------
  // Each reads/writes config.limits live, so changes take effect without a restart. idle and
  // session are shown in minutes; everything else is a plain count.
  const SETTINGS = {
    tabsPerUser: { min: 1, max: 10, get: () => config.limits.tabsPerUser, set: (v) => { config.limits.tabsPerUser = v; } },
    tabsTotal: { min: 1, max: 50, get: () => config.limits.tabsTotal, set: (v) => { config.limits.tabsTotal = v; } },
    idleMinutes: { min: 1, max: 180, get: () => Math.round(config.limits.idleMs / 60000), set: (v) => { config.limits.idleMs = v * 60000; } },
    sessionMinutes: { min: 5, max: 600, get: () => Math.round(config.limits.sessionMs / 60000), set: (v) => { config.limits.sessionMs = v * 60000; } },
    passwordMinLength: { min: 4, max: 64, get: () => config.limits.passwordMinLength, set: (v) => { config.limits.passwordMinLength = v; } },
    applyPerHour: { min: 1, max: 100, get: () => config.limits.applyPerHour, set: (v) => { config.limits.applyPerHour = v; applyLimit.limit = v; } },
    pendingMax: { min: 1, max: 500, get: () => config.limits.pendingMax, set: (v) => { config.limits.pendingMax = v; } },
  };

  function currentSettings() {
    const out = {};
    for (const [k, spec] of Object.entries(SETTINGS)) out[k] = spec.get();
    return out;
  }

  // Apply any settings the admin saved earlier over the environment defaults, once at startup.
  for (const [k, v] of Object.entries(store.getSettings())) {
    const spec = SETTINGS[k];
    const n = Math.round(Number(v));
    if (spec && Number.isFinite(n) && n >= spec.min && n <= spec.max) spec.set(n);
  }

  // ---- admin accounts -------------------------------------------------------------------------
  const bootstrapAdminId = config.admin?.id || ''; // already normalized; '' when admin login is disabled
  const bootstrapAdminPassword = config.admin?.password || '';

  function isAdminId(id) {
    const n = normalizeId(id);
    return Boolean(n) && ((bootstrapAdminId && n === bootstrapAdminId) || Boolean(store.findAdmin(n)));
  }

  async function authAdmin(id, password) {
    const n = normalizeId(id);
    if (bootstrapAdminId && n === bootstrapAdminId) {
      return constantEquals(password, bootstrapAdminPassword, config.secret) ? { id: n, bootstrap: true } : null;
    }
    const a = store.findAdmin(n);
    if (a && (await verifyPassword(password, a.password))) return { id: n, bootstrap: false };
    return null;
  }

  function adminList() {
    const list = [];
    if (bootstrapAdminId) list.push({ id: bootstrapAdminId, bootstrap: true, addedAt: null });
    for (const a of store.listAdmins()) list.push({ id: a.id, bootstrap: false, addedAt: a.addedAt ?? null });
    return list;
  }

  function requireAdmin(req) {
    const header = String(req.headers['authorization'] ?? '');
    const m = /^Bearer (.+)$/.exec(header);
    const tok = m && readToken(m[1], config.secret);
    if (!tok || typeof tok.sub !== 'string' || !tok.sub.startsWith('admin:')) {
      throw new HttpError(401, '管理者のログインが必要です');
    }
    const id = tok.sub.slice('admin:'.length);
    if (!isAdminId(id)) throw new HttpError(401, 'この管理者はもう存在しません');
    return id;
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? '?';
  }

  function originAllowed(origin) {
    if (!origin) return true; // same-origin navigation, curl, etc.
    const o = origin.replace(/\/+$/, '');
    if (config.allowedOrigins.includes(o)) return true;
    if (o === config.publicUrl) return true;
    if (config.dev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
    return false;
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function html(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  async function readBody(req, limit = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, '送信内容が大きすぎます');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] ?? '');
    if (type.includes('application/json')) {
      try {
        return JSON.parse(raw || '{}');
      } catch {
        throw new HttpError(400, 'JSON の形式が正しくありません');
      }
    }
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    throw new HttpError(415, 'Content-Type が正しくありません');
  }

  // ---- API handlers -------------------------------------------------------------------------

  async function apply(req, res) {
    if (!applyLimit.take(clientIp(req))) throw new HttpError(429, '申請が多すぎます。1時間ほど待ってからもう一度試してください');
    const body = await readBody(req);
    const id = normalizeId(body.id);
    const problem = checkId(id) || checkPassword(body.password, id, config.limits.passwordMinLength);
    if (problem) throw new HttpError(400, problem);
    if (store.findById(id)) throw new HttpError(409, 'この ID はもう使われています。別の ID にしてください');
    if (store.countPending() >= config.limits.pendingMax) {
      throw new HttpError(503, '審査待ちの申請がいっぱいです。しばらくしてから試してください');
    }
    const app = await store.add({
      appId: newApplicationId(),
      id,
      password: await hashPassword(body.password),
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: null,
      lastLoginAt: null,
    });
    try {
      await mailer.send(approvalEmail(app, reviewUrl(app.appId)));
    } catch (err) {
      log(`[mail] failed: ${err.message}`);
    }
    log(`[apply] new application ${app.appId}`);
    json(res, 201, { status: 'pending' });
  }

  async function login(req, res) {
    if (!loginLimit.take(clientIp(req))) throw new HttpError(429, '試行が多すぎます。1分待ってください');
    const body = await readBody(req);
    const id = normalizeId(body.id);
    if (idLimit.isLimited(id)) throw new HttpError(429, 'パスワードの間違いが多すぎます。15分ほど待ってください');
    // Admin login: the same gate, but admins get a control panel instead of a browser.
    if (isAdminId(id)) {
      const admin = await authAdmin(id, body.password);
      if (!admin) {
        idLimit.take(id);
        throw new HttpError(401, 'ID かパスワードが違います');
      }
      return json(res, 200, {
        status: 'admin',
        id: admin.id,
        token: issueToken(`admin:${admin.id}`, config.limits.tokenMs, config.secret),
        expiresIn: config.limits.tokenMs,
      });
    }
    const app = id ? store.findById(id) : null;
    // Same answer, and about the same time, for an unknown ID and a wrong password.
    const ok = await verifyPassword(body.password, app?.password);
    if (!app || !ok) {
      idLimit.take(id);
      throw new HttpError(401, 'ID かパスワードが違います');
    }
    if (app.status === 'pending') return json(res, 200, { status: 'pending' });
    if (app.status === 'rejected') return json(res, 200, { status: 'rejected' });
    await store.update(app.appId, { lastLoginAt: Date.now() });
    json(res, 200, {
      status: 'approved',
      token: issueToken(app.appId, config.limits.tokenMs, config.secret),
      expiresIn: config.limits.tokenMs,
    });
  }

  function reviewGet(req, res, url) {
    const appId = url.searchParams.get('app') ?? '';
    const sig = url.searchParams.get('sig') ?? '';
    if (!verifySignature(`review:${appId}`, sig, config.secret)) {
      return html(res, 403, messagePage('リンクが正しくありません', 'メールのリンクをそのまま開いてください。'));
    }
    const app = store.get(appId);
    if (!app) return html(res, 404, messagePage('申請が見つかりません', 'この申請は削除されています。'));
    // GET only shows the page. Approval needs the button (POST), so mail scanners that
    // pre-open links cannot approve anyone by accident.
    html(res, 200, reviewPage(app, sig));
  }

  async function reviewPost(req, res) {
    if (!decideLimit.take(clientIp(req))) throw new HttpError(429, '操作が多すぎます');
    const body = await readBody(req);
    const appId = String(body.app ?? '');
    if (!verifySignature(`review:${appId}`, body.sig, config.secret)) {
      return html(res, 403, messagePage('リンクが正しくありません', 'メールのリンクから開き直してください。'));
    }
    const decision = body.decision === 'approved' ? 'approved' : 'rejected';
    const prevStatus = store.get(appId)?.status;
    const app = await store.update(appId, { status: decision, decidedAt: Date.now() });
    if (!app) return html(res, 404, messagePage('申請が見つかりません', 'この申請は削除されています。'));
    if (decision === 'rejected') {
      // Kick the user out right away if they are browsing.
      hub?.sessions.get(appId)?.close('revoked');
    }
    log(`[review] ${appId} -> ${decision}`);
    html(res, 200, messagePage(
      decision === 'approved' ? '承認しました' : (prevStatus === 'approved' ? '利用を止めました' : '却下しました'),
      decision === 'approved'
        ? `${app.id} さんは Orbit に入れるようになりました。`
        : `${app.id} さんは Orbit を使えません。あとで気が変わったら、メールのリンクから承認できます。`,
    ));
  }

  // ---- admin panel API ------------------------------------------------------------------------

  function adminOverview(req, res) {
    requireAdmin(req);
    const apps = store.data.applications.map((a) => ({
      appId: a.appId, id: a.id, status: a.status,
      createdAt: a.createdAt, decidedAt: a.decidedAt, lastLoginAt: a.lastLoginAt,
      online: Boolean(hub?.sessions.get(a.appId)),
    }));
    const sessions = hub
      ? [...hub.sessions.values()].map((s) => ({
        appId: s.userKey, id: store.get(s.userKey)?.id ?? '?', tabs: s.tabs.size, since: s.startedAt,
      }))
      : [];
    json(res, 200, {
      apps,
      admins: adminList(),
      settings: currentSettings(),
      settingRanges: Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, { min: s.min, max: s.max }])),
      sessions,
      stats: { tabs: hub ? hub.totalTabs() : 0, maxTabs: config.limits.tabsTotal },
    });
  }

  async function adminDecide(req, res) {
    requireAdmin(req);
    const body = await readBody(req);
    const appId = String(body.appId ?? '');
    if (body.decision === 'delete') {
      hub?.sessions.get(appId)?.close('revoked');
      if (!(await store.removeApplication(appId))) throw new HttpError(404, '申請が見つかりません');
      log(`[admin] deleted ${appId}`);
      return json(res, 200, { ok: true, deleted: true });
    }
    const decision = body.decision === 'approved' ? 'approved' : 'rejected';
    const app = await store.update(appId, { status: decision, decidedAt: Date.now() });
    if (!app) throw new HttpError(404, '申請が見つかりません');
    if (decision === 'rejected') hub?.sessions.get(appId)?.close('revoked');
    log(`[admin] ${appId} -> ${decision}`);
    json(res, 200, { ok: true, status: app.status });
  }

  async function adminAdmins(req, res) {
    requireAdmin(req);
    const body = await readBody(req);
    const id = normalizeId(body.id);
    if (body.action === 'add') {
      const problem = checkId(id) || checkPassword(body.password, id, config.limits.passwordMinLength);
      if (problem) throw new HttpError(400, problem);
      if ((bootstrapAdminId && id === bootstrapAdminId) || store.findAdmin(id)) {
        throw new HttpError(409, 'その管理者 ID はもう使われています');
      }
      if (store.findById(id)) throw new HttpError(409, 'その ID は利用者が使っています');
      await store.addAdmin({ id, password: await hashPassword(body.password), addedAt: Date.now() });
      log(`[admin] added admin ${id}`);
      return json(res, 200, { ok: true });
    }
    if (body.action === 'remove') {
      if (bootstrapAdminId && id === bootstrapAdminId) throw new HttpError(400, 'メインの管理者は削除できません');
      if (!(await store.removeAdmin(id))) throw new HttpError(404, '管理者が見つかりません');
      log(`[admin] removed admin ${id}`);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(400, '不明な操作です');
  }

  async function adminSettings(req, res) {
    requireAdmin(req);
    const body = await readBody(req);
    const incoming = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const toSave = store.getSettings();
    for (const [k, spec] of Object.entries(SETTINGS)) {
      if (!(k in incoming)) continue;
      const v = Math.round(Number(incoming[k]));
      if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
        throw new HttpError(400, `${k} は ${spec.min}〜${spec.max} の範囲で入れてください`);
      }
      spec.set(v);
      toSave[k] = v;
    }
    await store.setSettings(toSave);
    log('[admin] settings updated');
    json(res, 200, { ok: true, settings: currentSettings() });
  }

  async function adminSessions(req, res) {
    requireAdmin(req);
    const body = await readBody(req);
    const session = hub?.sessions.get(String(body.appId ?? ''));
    if (session) session.close('admin');
    json(res, 200, { ok: true });
  }

  async function serveStatic(req, res, url) {
    if (!config.staticDir) return false;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(config.staticDir, rel);
    if (!file.startsWith(config.staticDir + path.sep) || rel.includes('..') || /\/(server|deploy|\.git)\//.test(rel)) return false;
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    cors(req, res);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(originAllowed(req.headers.origin) ? 204 : 403).end();
        return;
      }
      if (url.pathname.startsWith('/api/') && req.method === 'POST' && !originAllowed(req.headers.origin)) {
        throw new HttpError(403, 'このページからは使えません');
      }
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/health':
          return json(res, 200, { ok: true, tabs: hub ? hub.totalTabs() : 0, max: config.limits.tabsTotal });
        case 'POST /api/apply': return await apply(req, res);
        case 'POST /api/login': return await login(req, res);
        case 'GET /admin/review': return reviewGet(req, res, url);
        case 'POST /admin/decide': return await reviewPost(req, res);
        case 'GET /api/admin/overview': return adminOverview(req, res);
        case 'POST /api/admin/decide': return await adminDecide(req, res);
        case 'POST /api/admin/admins': return await adminAdmins(req, res);
        case 'POST /api/admin/settings': return await adminSettings(req, res);
        case 'POST /api/admin/sessions': return await adminSessions(req, res);
      }
      if (req.method === 'GET' && (await serveStatic(req, res, url))) return;
      throw new HttpError(404, 'ページが見つかりません');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`[http] ${err.stack || err}`);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'サーバーでエラーが起きました' : err.message });
      else res.end();
    }
  });

  // ---- WebSocket: the remote browser ---------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || !originAllowed(req.headers.origin) || !hub) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  function onSocket(ws) {
    let session = null;
    let opening = false;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!session) {
        if (msg.t !== 'auth' || opening) return;
        opening = true;
        clearTimeout(authTimer);
        const tok = readToken(msg.token, config.secret);
        const app = tok && store.get(tok.sub);
        if (!app || app.status !== 'approved') {
          ws.send(JSON.stringify({ t: 'bye', reason: 'auth' }));
          ws.close(4001, 'auth');
          return;
        }
        try {
          session = await hub.open(app.appId, ws, { width: msg.w, height: msg.h });
          await session.newTab(typeof msg.url === 'string' ? msg.url : '');
        } catch (err) {
          log(`[ws] could not open session: ${err.message}`);
          ws.send(JSON.stringify({ t: 'bye', reason: 'busy' }));
          ws.close(4002, 'busy');
        }
        return;
      }
      try {
        await session.handle(msg);
      } catch (err) {
        log(`[ws] ${msg.t}: ${err.message}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      session?.close('disconnected');
    });
    ws.on('error', () => {});
  }

  return { server, wss };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanText(v, max) {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}
