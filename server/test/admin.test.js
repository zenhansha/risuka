import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from '../src/store.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-adm-'));
  const config = {
    dev: false, secret: 'test-secret', publicUrl: 'http://orbit.test', allowedOrigins: ['https://site.example'],
    trustProxy: false, staticDir: null,
    admin: { id: 'rootadmin', password: 'admin-test-pass' },
    limits: {
      applyPerHour: 50, loginPerMinute: 200, pendingMax: 50, tokenMs: 60_000, tabsTotal: 10,
      passwordMinLength: 8, tabsPerUser: 3, idleMs: 600_000, sessionMs: 3_600_000,
    },
  };
  const store = await new Store(dir).load();
  const mailer = createMailer({ apiKey: '', from: 'x', to: 'o@e.com', log: () => {} });
  const { server } = createApp({ config, store, mailer, hub: null, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', ...headers }, body: JSON.stringify(body),
  });
  const authed = (tok) => ({
    get: (p) => fetch(base + p, { headers: { Authorization: `Bearer ${tok}` } }),
    post: (p, body) => post(p, body, { Authorization: `Bearer ${tok}` }),
  });
  return { dir, store, config, server, base, post, authed };
}

async function adminToken(post) {
  const r = await post('/api/login', { id: 'rootadmin', password: 'admin-test-pass' });
  const data = await r.json();
  assert.equal(data.status, 'admin');
  return data.token;
}

test('admin logs in via the gate and gets a control token', async () => {
  const { server, post } = await setup();
  try {
    // Wrong admin password is refused like any other login.
    assert.equal((await post('/api/login', { id: 'rootadmin', password: 'wrong' })).status, 401);
    // Case-insensitive id works.
    const r = await post('/api/login', { id: 'ROOTADMIN', password: 'admin-test-pass' });
    const d = await r.json();
    assert.equal(d.status, 'admin');
    assert.equal(d.id, 'rootadmin');
    assert.ok(d.token);
  } finally { server.close(); }
});

test('admin endpoints reject non-admins and bad tokens', async () => {
  const { server, authed } = await setup();
  try {
    assert.equal((await authed('garbage').get('/api/admin/overview')).status, 401);
    assert.equal((await authed('').post('/api/admin/decide', { appId: 'x', decision: 'approved' })).status, 401);
  } finally { server.close(); }
});

test('overview lists applications and the admin can approve / reject / delete', async () => {
  const { server, store, post, authed } = await setup();
  try {
    await post('/api/apply', { id: 'alice', password: 'long-enough-pass' });
    await post('/api/apply', { id: 'bob', password: 'long-enough-pass' });
    const a = authed(await adminToken(post));

    let o = await (await a.get('/api/admin/overview')).json();
    assert.equal(o.apps.length, 2);
    assert.ok(o.admins.some((x) => x.id === 'rootadmin' && x.bootstrap));
    assert.ok(o.settings.tabsPerUser === 3);

    const alice = o.apps.find((x) => x.id === 'alice');
    assert.equal((await a.post('/api/admin/decide', { appId: alice.appId, decision: 'approved' })).status, 200);
    assert.equal(store.findById('alice').status, 'approved');

    // Approved user can now log in.
    assert.equal((await (await post('/api/login', { id: 'alice', password: 'long-enough-pass' })).json()).status, 'approved');

    const bob = o.apps.find((x) => x.id === 'bob');
    await a.post('/api/admin/decide', { appId: bob.appId, decision: 'delete' });
    o = await (await a.get('/api/admin/overview')).json();
    assert.equal(o.apps.length, 1);
    assert.equal(store.findById('bob'), null);
  } finally { server.close(); }
});

test('admins can be added and removed, but not the bootstrap admin', async () => {
  const { server, store, post, authed } = await setup();
  try {
    const a = authed(await adminToken(post));
    // Add a second admin.
    assert.equal((await a.post('/api/admin/admins', { action: 'add', id: 'mod1', password: 'moderator-pass' })).status, 200);
    const stored = store.findAdmin('mod1');
    assert.ok(stored && !String(stored.password).includes('moderator-pass')); // hashed, not plaintext

    // The new admin can log in and use the panel.
    const t2 = await adminTokenFor(post, 'mod1', 'moderator-pass');
    assert.equal((await authed(t2).get('/api/admin/overview')).status, 200);

    // Weak password and duplicate id are refused.
    assert.equal((await a.post('/api/admin/admins', { action: 'add', id: 'mod2', password: 'short' })).status, 400);
    assert.equal((await a.post('/api/admin/admins', { action: 'add', id: 'mod1', password: 'another-pass' })).status, 409);

    // The bootstrap admin cannot be removed; a runtime admin can.
    assert.equal((await a.post('/api/admin/admins', { action: 'remove', id: 'rootadmin' })).status, 400);
    assert.equal((await a.post('/api/admin/admins', { action: 'remove', id: 'mod1' })).status, 200);
    assert.equal(store.findAdmin('mod1'), null);
  } finally { server.close(); }
});

async function adminTokenFor(post, id, password) {
  const d = await (await post('/api/login', { id, password })).json();
  assert.equal(d.status, 'admin');
  return d.token;
}

test('settings are validated, applied live and persisted', async () => {
  const { server, store, config, post, authed } = await setup();
  try {
    const a = authed(await adminToken(post));
    // Out of range is refused.
    assert.equal((await a.post('/api/admin/settings', { settings: { tabsPerUser: 999 } })).status, 400);
    // Valid change applies to the live config and is saved.
    const r = await a.post('/api/admin/settings', { settings: { tabsPerUser: 5, idleMinutes: 20 } });
    assert.equal(r.status, 200);
    assert.equal(config.limits.tabsPerUser, 5);
    assert.equal(config.limits.idleMs, 20 * 60_000);
    assert.equal(store.getSettings().tabsPerUser, 5);
  } finally { server.close(); }
});

test('an id taken by a user cannot become an admin, and vice versa', async () => {
  const { server, post, authed } = await setup();
  try {
    await post('/api/apply', { id: 'carol', password: 'long-enough-pass' });
    const a = authed(await adminToken(post));
    assert.equal((await a.post('/api/admin/admins', { action: 'add', id: 'carol', password: 'moderator-pass' })).status, 409);
  } finally { server.close(); }
});
