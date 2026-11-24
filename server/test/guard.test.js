import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createGuard, isPrivateAddress } from '../src/guard.js';
import { isTrackerHost } from '../src/trackers.js';

test('private and special addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.ok(!isPrivateAddress(ip), ip);
  }
});

test('tracker matching covers subdomains only', () => {
  assert.ok(isTrackerHost('www.google-analytics.com'));
  assert.ok(isTrackerHost('doubleclick.net'));
  assert.ok(!isTrackerHost('google.com'));
  assert.ok(!isTrackerHost('notdoubleclick.net'));
});

test('resolve() blocks internal targets, bad ports and trackers', async () => {
  const g = createGuard();
  await assert.rejects(g.resolve('localhost', 80));
  await assert.rejects(g.resolve('127.0.0.1', 443));
  await assert.rejects(g.resolve('169.254.169.254', 80));
  await assert.rejects(g.resolve('[::1]', 443));
  await assert.rejects(g.resolve('metadata.google.internal', 80));
  await assert.rejects(g.resolve('8.8.8.8', 25)); // mail port
  await assert.rejects(g.resolve('www.google-analytics.com', 443), /tracker/);
  assert.equal(await g.resolve('8.8.8.8', 443), '8.8.8.8');
});

function connectThrough(proxyUrl, target) {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
    s.on('error', reject);
  });
}

test('the proxy refuses CONNECT to loopback', async () => {
  const target = http.createServer((q, s) => s.end('secret')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const g = createGuard();
  const url = await g.listen();
  const line = await connectThrough(url, `127.0.0.1:${target.address().port}`);
  assert.match(line, /403/);
  await g.close();
  target.close();
});

test('with allowPrivate (tests only) loopback is reachable', async () => {
  const target = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const g = createGuard({ allowPrivate: true });
  const url = await g.listen();
  const line = await connectThrough(url, `127.0.0.1:${target.address().port}`);
  assert.match(line, /200/);
  await g.close();
  target.close();
});
