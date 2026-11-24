import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store } from '../src/store.js';
import { createMailer } from '../src/mailer.js';
import { createApp } from '../src/app.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-'));
  const config = {
    dev: false, secret: 'test-secret', publicUrl: 'http://orbit.test', allowedOrigins: ['https://site.example'],
    trustProxy: false, staticDir: null,
    limits: { applyPerHour: 3, loginPerMinute: 50, pendingMax: 5, tokenMs: 60_000, tabsTotal: 10, passwordMinLength: 8 },
  };
  const store = await new Store(dir).load();
  const mailer = createMailer({ apiKey: '', from: 'x', to: 'owner@example.com', log: () => {} });
  const { server } = createApp({ config, store, mailer, hub: null, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example', ...headers }, body: JSON.stringify(body),
  });
  const form = (p, fields) => fetch(base + p, {
    method: 'POST', body: new URLSearchParams(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return { dir, store, mailer, server, base, post, form };
}

test('apply -> pending -> approve by email link -> login -> revoke', async () => {
  const { store, mailer, server, base, post, form, dir } = await setup();
  const password = 'ロケット大好き2026';
  try {
    const r1 = await post('/api/apply', { id: 'Starman', password });
    assert.equal(r1.status, 201);
    assert.deepEqual(await r1.json(), { status: 'pending' });
    // The password is stored only as a salted hash.
    const raw = await fs.readFile(path.join(dir, 'applications.json'), 'utf8');
    assert.ok(!raw.includes('ロケット') && !raw.includes('2026'));
    assert.match(raw, /"id": "starman"/);
    // The same ID cannot be taken twice.
    assert.equal((await post('/api/apply', { id: 'starman', password: 'another-pass' })).status, 409);

    assert.equal(mailer.sent.length, 1);
    assert.match(mailer.sent[0].text, /ID: starman/);
    assert.ok(!mailer.sent[0].text.includes('ロケット'), 'the email never contains the password');
    const link = mailer.sent[0].text.match(/http:\/\/orbit\.test(\/admin\/review\?\S+)/)[1];

    // A wrong password does not reveal that the ID is waiting for approval.
    let r = await post('/api/login', { id: 'starman', password: 'wrong-password' });
    assert.equal(r.status, 401);
    r = await post('/api/login', { id: 'starman', password });
    assert.deepEqual(await r.json(), { status: 'pending' });

    // GET shows the page but never approves (mail scanners open links).
    const page = await fetch(base + link);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /starman/);
    assert.equal(store.data.applications[0].status, 'pending');

    const u = new URL(base + link);
    const fields = { app: u.searchParams.get('app'), sig: u.searchParams.get('sig'), decision: 'approved' };
    assert.match(await (await form('/admin/decide', fields)).text(), /入れるようになりました/);

    r = await post('/api/login', { id: 'STARMAN', password });
    const ok = await r.json();
    assert.equal(ok.status, 'approved');
    assert.ok(ok.token);

    assert.match(await (await form('/admin/decide', { ...fields, decision: 'rejected' })).text(), /利用を止めました/);
    r = await post('/api/login', { id: 'starman', password });
    assert.equal((await r.json()).status, 'rejected');
  } finally {
    server.close();
  }
});

test('unknown IDs and wrong passwords get the same answer', async () => {
  const { server, post } = await setup();
  try {
    await post('/api/apply', { id: 'someone', password: 'long-enough-pass' });
    const a = await post('/api/login', { id: 'nobody', password: 'long-enough-pass' });
    const b = await post('/api/login', { id: 'someone', password: 'not-the-password' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
  } finally {
    server.close();
  }
});

test('an ID is locked after 10 wrong passwords, even from different IPs', async () => {
  const { server, post } = await setup();
  try {
    await post('/api/apply', { id: 'target', password: 'the-real-pass' });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await post('/api/login', { id: 'target', password: `guess-${i}-xx` })).status);
    assert.deepEqual(codes, [...Array(10).fill(401), 429]);
    assert.equal((await post('/api/login', { id: 'target', password: 'the-real-pass' })).status, 429);
  } finally {
    server.close();
  }
});

test('a forged review link is refused', async () => {
  const { server, store, post, form } = await setup();
  try {
    await post('/api/apply', { id: 'someone', password: 'long-enough-pass' });
    const r = await form('/admin/decide', { app: store.data.applications[0].appId, sig: 'nope', decision: 'approved' });
    assert.equal(r.status, 403);
    assert.equal(store.data.applications[0].status, 'pending');
  } finally {
    server.close();
  }
});

test('bad input, foreign origins and floods are refused', async () => {
  const { server, post } = await setup();
  try {
    assert.equal((await post('/api/apply', { id: 'ok-id', password: 'short' })).status, 400);
    assert.equal((await post('/api/apply', { id: 'ok-id', password: 'ok-id-password' })).status, 400);
    assert.equal((await post('/api/apply', { id: 'valid1', password: 'long-enough-pass' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/apply', { id: 'valid2', password: 'long-enough-pass' })).status, 201);
    assert.equal((await post('/api/apply', { id: 'valid3', password: 'long-enough-pass' })).status, 429); // 3 per hour
  } finally {
    server.close();
  }
});
