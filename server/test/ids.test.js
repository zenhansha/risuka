import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkId, checkPassword, normalizeId, hashPassword, verifyPassword, sign, verifySignature, issueToken, readToken,
} from '../src/ids.js';

test('IDs are checked for length and characters', () => {
  assert.equal(checkId('starman'), null);
  assert.equal(checkId('Starman.2026_x'), null);
  assert.match(checkId('ya'), /3 文字以上/);
  assert.match(checkId('x'.repeat(30)), /24 文字まで/);
  assert.match(checkId('ロケット'), /英数字/);
  assert.match(checkId('has space'), /英数字/);
});

test('IDs match however they are typed', () => {
  assert.equal(normalizeId('  Starman '), 'starman');
  assert.equal(normalizeId('ｓｔａｒｍａｎ'), 'starman');
});

test('weak passwords are refused', () => {
  assert.equal(checkPassword('correct horse', 'starman'), null);
  assert.match(checkPassword('short', 'starman'), /8 文字以上/);
  assert.match(checkPassword('aaaaaaaaaa', 'starman'), /同じ文字/);
  assert.match(checkPassword('Starman1234', 'starman'), /ID を入れない/);
  assert.match(checkPassword('x'.repeat(200), 'starman'), /128 文字まで/);
});

test('passwords are salted and verify only with the right password', async () => {
  const a = await hashPassword('ロケット大好き2026');
  const b = await hashPassword('ロケット大好き2026');
  assert.notEqual(a, b); // different salt each time
  assert.ok(!a.includes('ロケット'));
  assert.equal(await verifyPassword('ロケット大好き2026', a), true);
  assert.equal(await verifyPassword('ロケット大好き2027', a), false);
  assert.equal(await verifyPassword('', a), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'garbage'), false);
});

test('signatures verify and reject tampering', () => {
  const sig = sign('review:abc', 'k');
  assert.ok(verifySignature('review:abc', sig, 'k'));
  assert.ok(!verifySignature('review:abd', sig, 'k'));
  assert.ok(!verifySignature('review:abc', sig, 'other'));
  assert.ok(!verifySignature('review:abc', undefined, 'k'));
});

test('tokens expire and cannot be forged', () => {
  const t = issueToken('app1', 1000, 'k', 0);
  assert.equal(readToken(t, 'k', 500).sub, 'app1');
  assert.equal(readToken(t, 'k', 1500), null);
  assert.equal(readToken(t, 'wrong', 500), null);
  const sig = t.split('.')[1];
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e15 })).toString('base64url');
  assert.equal(readToken(`${forged}.${sig}`, 'k', 500), null);
  assert.equal(readToken('garbage', 'k'), null);
});
