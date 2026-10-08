import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ClaudeCodeAuthRequired, readClaudeCodeAccess, claudeCodeQuotaEntries, readClaudeCodeQuota, createClaudeCodeQuota } from '../dist/policy/claude-code-quota.js';

const time = 1700000000000;
const secret = 'SYNTHETIC_ACCESS_TOKEN_DO_NOT_FORWARD';
const credential = (overrides = {}) => ({ accessToken: secret, expiresAt: time + 3600000, scope: 'synthetic-store-scope', ...overrides });
const payload = { five_hour: { utilization: 12, resets_at: '2026-10-07T18:00:00Z' }, seven_day: { utilization: 34, resets_at: '2026-10-10T18:00:00Z' } };
const response = () => Response.json(payload);

test('the injected Keychain reader selects the normal CLI service without renewing or writing credentials', async () => {
  const calls = [];
  const execute = async (...input) => { calls.push(input); return { stdout: JSON.stringify({ claudeAiOauth: credential(), refreshToken: 'SYNTHETIC_REFRESH', accountId: 'SYNTHETIC_ACCOUNT' }) }; };
  // The normal CLI field uses expiresAt; the reader returns only access fields and a hashed scope.
  const normal = await readClaudeCodeAccess({ env: {}, platform: 'darwin', home: '/fixture-home', execute, read: async () => { throw new Error('File reads are forbidden on macOS'); } });
  assert.deepEqual(calls[0][1], ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  assert.equal(calls[0][0], '/usr/bin/security');
  assert.equal(calls[0][2].timeout, 3000);
  assert.equal(normal.accessToken, secret);
  assert.match(normal.scope, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(normal, 'refreshToken'), false);
  assert.equal(Object.hasOwn(normal, 'accountId'), false);
  const selected = 'relative-fixture-config';
  await readClaudeCodeAccess({ env: { CLAUDE_CONFIG_DIR: selected }, platform: 'darwin', home: '/fixture-home', execute });
  const suffix = createHash('sha256').update(selected).digest('hex').slice(0, 8);
  assert.equal(calls[1][1][2], 'Claude Code-credentials-' + suffix);
  assert.equal(calls.length, 2, 'only read-only security lookups occurred');
});

test('the injected file reader uses the selected CLI configuration directory and sanitizes every failure', async () => {
  let selected;
  const value = await readClaudeCodeAccess({ env: { CLAUDE_CONFIG_DIR: 'fixture-claude' }, platform: 'linux', home: '/fixture-home', read: async file => { selected = file; return JSON.stringify({ claudeAiOauth: credential() }); }, execute: async () => { throw new Error('Keychain is not used'); } });
  assert.equal(selected, path.resolve('fixture-claude', '.credentials.json'));
  assert.equal(value.accessToken, secret);
  for (const raw of ['not-json-' + secret, '{}', JSON.stringify({ claudeAiOauth: { accessToken: secret, expiresAt: 'not-a-number' } })]) {
    await assert.rejects(readClaudeCodeAccess({ env: {}, platform: 'linux', home: '/fixture-home', read: async () => raw }), error => error instanceof ClaudeCodeAuthRequired && error.code === 'claude_auth_required' && !error.message.includes(secret));
  }
  await assert.rejects(readClaudeCodeAccess({ env: {}, platform: 'darwin', home: '/fixture-home', execute: async () => { throw new Error('Raw command diagnostic: ' + secret); } }), error => error.code === 'claude_auth_required' && !error.message.includes(secret));
});

test('quota windows accept both public response formats while dropping identities and arbitrary labels', () => {
  assert.deepEqual(claudeCodeQuotaEntries(payload).map(({ name, percentRemaining }) => ({ name, percentRemaining })), [{ name: '5h', percentRemaining: 88 }, { name: 'Weekly', percentRemaining: 66 }]);
  const entries = claudeCodeQuotaEntries({ accountId: 'SYNTHETIC_ACCOUNT', limits: [
    { kind: 'session', percent: 10, resets_at: '2026-10-07T18:00:00Z' },
    { kind: 'weekly_all', percent: 20 },
    { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: 'Claude Sonnet 4.6' } } },
    { kind: 'weekly_scoped', percent: 40, scope: { model: { display_name: 'Claude Opus 4.6' } } },
    { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: secret } } },
    { kind: 'session', percent: 101 },
  ] });
  assert.deepEqual(entries.map(entry => entry.name), ['5h', 'Weekly', 'Sonnet Weekly', 'Opus Weekly']);
  assert.equal(entries[0].resetTimeIso, '2026-10-07T18:00:00.000Z');
  assert.ok(!JSON.stringify(entries).includes(secret));
  assert.ok(!JSON.stringify(entries).includes('SYNTHETIC_ACCOUNT'));
});

test('concurrent probes coalesce and a one-minute cached result remains account-scoped and immutable', async () => {
  let clock = time;
  let reads = 0;
  let fetches = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const store = new Map();
  const lookup = createClaudeCodeQuota({ store, now: () => clock, readCredential: async () => { reads++; return credential(); }, fetchImpl: async (url, input) => {
    fetches++;
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(new Headers(input.headers).get('authorization'), 'Bearer ' + secret);
    assert.equal(input.redirect, 'error');
    await gate;
    return response();
  } });
  const first = lookup();
  const second = lookup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);
  finish();
  const results = await Promise.all([first, second]);
  results[0].entries[0].percentRemaining = 0;
  results[0].errors.push('caller mutation');
  assert.equal(results[1].entries[0].percentRemaining, 88);
  clock += 59999;
  const cached = await lookup();
  assert.equal(cached.cached, true);
  assert.equal(cached.fetchedAt, time);
  assert.equal(cached.entries[0].percentRemaining, 88);
  assert.deepEqual(cached.errors, []);
  assert.equal(fetches, 1);
  assert.equal(reads, 3, 'credential validity is checked even before cache reuse');
  clock++;
  await lookup();
  assert.equal(fetches, 2, 'exactly one minute expires the successful cache');
  assert.ok(!JSON.stringify([...store]).includes(secret));
  assert.ok(!JSON.stringify(cached).includes('scope'));
  assert.ok([...store.values()].every(entry => entry.pending === undefined));
});

test('the five-minute expiry guard prevents probes and overrides a previously successful cached result', async () => {
  let expiresAt = time + 3600000;
  let fetches = 0;
  const options = { store: new Map(), now: () => time, readCredential: async () => credential({ expiresAt }), fetchImpl: async () => { fetches++; return response(); } };
  assert.deepEqual((await readClaudeCodeQuota(options)).errors, []);
  for (const remaining of [-1, 0, 299999, 300000]) {
    expiresAt = time + remaining;
    const result = await readClaudeCodeQuota(options);
    assert.equal(result.errorCode, 'claude_auth_required');
    assert.equal(result.authExpired, true);
    assert.deepEqual(result.entries, []);
  }
  assert.equal(fetches, 1, 'the SDK refresh window is never entered by a quota probe');
});

test('token rotation and credential-store changes cannot reuse another account probe', async () => {
  let value = credential();
  let fetches = 0;
  const options = { store: new Map(), now: () => time, readCredential: async () => value, fetchImpl: async () => { fetches++; return response(); } };
  await readClaudeCodeQuota(options);
  await readClaudeCodeQuota(options);
  assert.equal(fetches, 1);
  value = credential({ accessToken: 'SYNTHETIC_ROTATED_TOKEN' });
  await readClaudeCodeQuota(options);
  assert.equal(fetches, 2);
  value = { ...value, scope: 'another-synthetic-store' };
  await readClaudeCodeQuota(options);
  assert.equal(fetches, 3);
});

test('a credential entering the refresh window while the response is read cannot admit SDK execution', async () => {
  let clock = time;
  const result = await readClaudeCodeQuota({ store: new Map(), now: () => clock, readCredential: async () => credential({ expiresAt: time + 300001 }), fetchImpl: async () => { clock += 10; return response(); } });
  assert.equal(result.errorCode, 'claude_auth_required');
  assert.deepEqual(result.entries, []);
});

test('authentication failures stop that credential without invoking renewal and token replacement unblocks it', async t => {
  for (const status of [401, 403]) await t.test(String(status), async () => {
    let value = credential();
    let fetches = 0;
    let renewals = 0;
    const options = { store: new Map(), now: () => time, readCredential: async () => value, authRefresh: async () => { renewals++; }, fetchImpl: async () => { fetches++; return fetches === 1 ? new Response(secret, { status }) : response(); } };
    const failed = await readClaudeCodeQuota(options);
    assert.equal(failed.errorCode, 'claude_auth_required');
    assert.equal(failed.authExpired, true);
    const held = await readClaudeCodeQuota(options);
    assert.equal(held.cached, true);
    assert.equal(fetches, 1);
    assert.equal(renewals, 0);
    assert.ok(!JSON.stringify(failed).includes(secret));
    value = credential({ accessToken: 'SYNTHETIC_RECONNECTED_TOKEN' });
    assert.deepEqual((await readClaudeCodeQuota(options)).errors, []);
    assert.equal(fetches, 2);
    assert.equal(renewals, 0);
  });
});

test('429 holds the account closed with exponential cooldown, longer Retry-After and success reset', async () => {
  let clock = time;
  let fetches = 0;
  let succeed = false;
  let retryAfter = '120';
  const options = { store: new Map(), now: () => clock, readCredential: async () => credential({ expiresAt: clock + 3600000 }), fetchImpl: async () => { fetches++; return succeed ? response() : new Response('Rate-limited body: ' + secret, { status: 429, headers: { 'retry-after': retryAfter } }); } };
  const first = await readClaudeCodeQuota(options);
  assert.equal(first.errorCode, 'http_429');
  assert.equal(first.authExpired, false);
  assert.equal(first.retryAt - clock, 300000);
  assert.deepEqual(first.entries, []);
  assert.ok(!JSON.stringify(first).includes(secret));
  clock++;
  assert.equal((await readClaudeCodeQuota(options)).cached, true);
  assert.equal(fetches, 1);
  clock = first.retryAt;
  const second = await readClaudeCodeQuota(options);
  assert.equal(second.retryAt - clock, 600000);
  clock = second.retryAt;
  retryAfter = new Date(clock + 3600000).toUTCString();
  const longer = await readClaudeCodeQuota(options);
  assert.equal(longer.retryAt - clock, 3600000);
  clock = longer.retryAt;
  succeed = true;
  assert.deepEqual((await readClaudeCodeQuota(options)).errors, []);
  clock += 60000;
  succeed = false;
  retryAfter = '0';
  const reset = await readClaudeCodeQuota(options);
  assert.equal(reset.retryAt - clock, 300000);
  assert.equal(fetches, 5);
});

test('429 backoff caps at thirty minutes without retrying during the cooldown', async () => {
  let clock = time;
  let fetches = 0;
  const options = { store: new Map(), now: () => clock, readCredential: async () => credential({ expiresAt: clock + 3600000 }), fetchImpl: async () => { fetches++; return new Response('', { status: 429 }); } };
  for (const delay of [300000, 600000, 1200000, 1800000, 1800000]) {
    const result = await readClaudeCodeQuota(options);
    assert.equal(result.retryAt - clock, delay);
    clock = result.retryAt;
  }
  assert.equal(fetches, 5);
});

test('malformed payloads, unavailable credentials and transport errors fail closed with safe codes', async () => {
  const cases = [
    [async () => new Response(secret, { status: 503 }), 'http_503'],
    [async () => new Response('broken-json-' + secret, { status: 200 }), 'quota_invalid_response'],
    [async () => Response.json({ five_hour: { utilization: 12 }, opaqueAccount: secret }), 'quota_missing_windows'],
    [async () => { throw new Error('Raw network diagnostic: ' + secret); }, 'quota_unavailable'],
    [async () => { throw Object.assign(new Error(secret), { name: 'TimeoutError' }); }, 'timeout'],
  ];
  for (const [fetchImpl, code] of cases) {
    const result = await readClaudeCodeQuota({ store: new Map(), now: () => time, readCredential: async () => credential(), fetchImpl });
    assert.equal(result.errorCode, code);
    assert.deepEqual(result.entries, []);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  let fetches = 0;
  const auth = await readClaudeCodeQuota({ store: new Map(), now: () => time, readCredential: async () => { throw new Error('Credential diagnostic: ' + secret); }, fetchImpl: async () => { fetches++; return response(); } });
  assert.equal(auth.errorCode, 'claude_auth_required');
  assert.equal(fetches, 0);
  assert.ok(!JSON.stringify(auth).includes(secret));
});
