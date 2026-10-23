// A5: the account page's hub calls go through the shared client, so a failed load is an error and
// not an empty list - and every route can be driven by a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submissions, HubError } from '../src/social/api.js';

const res = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('the routes call the right place with the right method', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push([url, opts.method]); return res(200, []); };
  await submissions.mine({ fetchFn });
  await submissions.admin({ fetchFn });
  await submissions.patch('h1', { name: 'x' }, { fetchFn });
  await submissions.remove('h1', { fetchFn });
  assert.deepEqual(calls.map((c) => c[1]), ['GET', 'GET', 'PATCH', 'DELETE']);
  assert.match(calls[0][0], /\/api\/me\/submissions$/);
  assert.match(calls[1][0], /\/api\/admin\/submissions$/);
  assert.match(calls[2][0], /\/api\/submissions\/h1$/);
  assert.match(calls[3][0], /\/api\/submissions\/h1$/);
});

test('a 401 says to sign in and keeps the status', async () => {
  const err = await submissions.mine({ fetchFn: async () => res(401, {}) }).catch((e) => e);
  assert.ok(err instanceof HubError);
  assert.equal(err.status, 401);
  assert.match(err.message, /log in/i);
});

test('a 429 carries the retry hint', async () => {
  const err = await submissions.mine({ fetchFn: async () => res(429, { retry_after: 30 }) }).catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 30);
  assert.match(err.message, /30 seconds/);
});

test('a hub that is down says so', async () => {
  const err = await submissions.mine({ fetchFn: async () => { throw new Error('offline'); } }).catch((e) => e);
  assert.equal(err.status, 0);
  assert.match(err.message, /Couldn't reach the Recharge hub/);
});

test('a broken upload is reported the same way', async () => {
  const err = await submissions.remove('h1', { fetchFn: async () => res(500, {}) }).catch((e) => e);
  assert.equal(err.status, 500);
  assert.match(err.message, /Request failed/);
});

test('the account page does not call fetch itself', () => {
  const src = readFileSync(new URL('../src/account/script.js', import.meta.url), 'utf8');
  assert.ok(!/\bfetch\(/.test(src), 'the account page must go through social/api.js');
  assert.match(src, /submissions\.mine\(\)/);
  assert.match(src, /submissions\.patch\(/);
  assert.match(src, /submissions\.remove\(/);
});

test('the other pages load their upload ids the same way', () => {
  for (const f of ['maps/script.js', 'mods/script.js']) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    assert.match(src, /submissions\.mine\(\)/, f);
    assert.ok(!/\/api\/me\/submissions/.test(src), `${f} still fetches the submissions route itself`);
  }
});

test('a failed load is shown as an error with a Retry, not as an empty account', () => {
  const src = readFileSync(new URL('../src/account/script.js', import.meta.url), 'utf8');
  assert.match(src, /loadError/);
  assert.match(src, /Couldn't load your uploads/);
  assert.match(src, /window\.__acctRetryUploads\(\)/);
  // The edit and delete failures are shown in the page, not in an alert.
  assert.match(src, /showInlineError\('account-edit-error'/);
  assert.match(src, /showInlineError\('account-uploads-error'/);
});
