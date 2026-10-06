import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAPI, connect, snapshot, createObserver } from '../dist/opencode/observer.js';

const baseUrl = 'http://127.0.0.1:4096';
const directory = '/workspace';
const connection = { baseUrl, passwordEnvironmentVariable: 'TEST_OPENCODE_PASSWORD', environment: { TEST_OPENCODE_PASSWORD: 'synthetic-test-password' } };
const info = () => ({ version: '2.0.22', pid: 44 });
const session = () => ({ id: 'ses_child', parentID: 'ses_parent', location: { directory }, time: { idle: 10 }, outcome: 'succeeded' });

test('configured local HTTP uses environment credentials in memory and preserves pagination', async () => {
  const calls = [];
  const api = createAPI({ baseUrl, password: 'synthetic-test-password', directory, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: [{ id: 'message' }], cursor: { next: 'more' } });
  } });
  assert.deepEqual(await api.request('/api/session/ses_child/message'), [{ id: 'message' }]);
  assert.deepEqual((await api.request('/api/session/ses_child/message', { raw: true })).cursor, { next: 'more' });
  assert.equal(calls[0].url.searchParams.get('location[directory]'), directory);
  assert.equal(calls[0].options.headers['x-opencode-directory'], encodeURIComponent(directory));
  assert.equal(calls[0].options.headers.Authorization, 'Basic ' + Buffer.from('opencode:synthetic-test-password').toString('base64'));
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(api.password, undefined);
  assert.ok(!JSON.stringify(api).includes('synthetic-test-password'));
  await assert.rejects(api.request('/session/status'), /V2 API route/);
});

test('connection uses the selected server and verifies the matching version and saved project', async () => {
  const routes = [];
  const fetchImpl = async url => {
    routes.push(url.pathname);
    return Response.json(url.pathname === '/api/info' ? info() : { data: session() });
  };
  const api = await connect(directory, 'ses_child', { ...connection, fetchImpl });
  assert.equal(api.version, '2.0.22');
  assert.equal(api.pid, 44);
  assert.deepEqual(routes, ['/api/info', '/api/session/ses_child']);
  await assert.rejects(connect('/different', 'ses_child', { ...connection, fetchImpl }), /different project/);
  for (const server of [{ ...info(), pid: 0 }, { ...info(), version: '1.2.0' }, { ...info(), version: '2.0.23' }]) {
    await assert.rejects(connect(directory, undefined, { ...connection, fetchImpl: async () => Response.json(server) }), /supported OpenCode 2.0.22/);
  }
});

test('only explicitly configured loopback endpoints and credentials are accepted', async () => {
  const fetchImpl = async () => assert.fail('Invalid configuration must not make a request');
  await assert.rejects(connect(directory, undefined, { environment: {}, fetchImpl }), /opencode.baseUrl/);
  await assert.rejects(connect(directory, undefined, { baseUrl, environment: {}, fetchImpl }), /password environment/);
  for (const value of ['https://external.example', 'http://user:password@127.0.0.1:4096', 'http://localhost:4096/api/', 'http://localhost:4096?password=test', 'file:///tmp/server']) {
    assert.throws(() => createAPI({ baseUrl: value, password: 'synthetic', directory, fetchImpl }), /local OpenCode HTTP/);
  }
});

test('session identity and directory fail closed; canonical project aliases remain usable', async () => {
  const fake = value => async url => Response.json(url.pathname === '/api/info' ? info() : { data: value });
  await assert.rejects(connect(directory, 'ses_child', { ...connection, fetchImpl: fake({ ...session(), id: 'different' }) }), /identity/);
  await assert.rejects(connect(directory, 'ses_child', { ...connection, fetchImpl: fake({ ...session(), location: {} }) }), /project could not be verified/);
  const readFS = { realpath: async value => ['/alias/workspace', '/real/workspace'].includes(value) ? '/real/workspace' : value };
  const api = await connect('/alias/workspace', 'ses_child', { ...connection, readFS, fetchImpl: fake({ ...session(), location: { directory: '/real/workspace' } }) });
  assert.equal(api.pid, 44);
});

test('transport failures report safe status and never disclose credentials or arbitrary response bodies', async () => {
  const create = fetchImpl => createAPI({ baseUrl, password: 'synthetic-test-password', directory, fetchImpl });
  for (const fetchImpl of [async () => { throw new Error('synthetic-test-password'); }, async () => new Response('synthetic-test-password', { status: 401 }), async () => new Response('synthetic-test-password', { status: 200 })]) {
    await assert.rejects(create(fetchImpl).request('/api/info'), error => !error.message.includes('synthetic-test-password') && !JSON.stringify(error).includes('synthetic-test-password'));
  }
  await assert.rejects(create(async () => new Response('', { status: 404 })).request('/api/info'), error => error.status === 404);
});

test('complete observation includes active execution, inbox, permissions, forms, and recent messages', async () => {
  const routes = [];
  const api = { request: async (route, options) => {
    routes.push({ route, options });
    if (route.endsWith('/ses_child')) return session();
    if (route === '/api/session/active') return {};
    return [];
  } };
  const signal = new AbortController().signal;
  assert.deepEqual(await snapshot(api, 'ses_child', { signal }), { session: session(), active: false, inbox: [], permissions: [], forms: [], messages: [] });
  assert.equal(routes.length, 6);
  assert.ok(routes.every(call => call.options.signal === signal));
  assert.ok(routes.some(call => call.route.endsWith('/message?order=desc&limit=5')));
  await assert.rejects(snapshot({ request: async () => null }, 'ses_child'), /complete V2 session state/);
  await assert.rejects(snapshot({ request: async route => route.endsWith('/ses_child') ? session() : route === '/api/session/active' ? { ses_child: { type: 'unexpected' } } : [] }, 'ses_child'), /Unknown V2 execution status/);
});

test('observer connects lazily and verifies session project before every complete observation', async () => {
  const routes = [];
  const observe = createObserver({ directory, ...connection, fetchImpl: async url => {
    routes.push(url.pathname);
    if (url.pathname === '/api/info') return Response.json(info());
    if (url.pathname.endsWith('/ses_child')) return Response.json({ data: session() });
    return Response.json({ data: url.pathname === '/api/session/active' ? {} : [] });
  } });
  assert.deepEqual(routes, []);
  assert.equal((await observe('ses_child')).active, false);
  assert.equal(routes.filter(route => route === '/api/info').length, 1);
  assert.equal(routes.filter(route => route === '/api/session/ses_child').length, 2);
});


test('explicit no-auth omits Authorization and never accesses a password environment', async () => {
  const environment = new Proxy({}, { get: () => assert.fail('No-auth must not read password variables') });
  const calls = [];
  const api = await connect(directory, 'ses_child', { baseUrl, authentication: 'none', environment, fetchImpl: async (url, options) => {
    calls.push(options);
    return Response.json(url.pathname === '/api/info' ? info() : { data: session() });
  } });
  assert.equal(api.version, '2.0.22');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(options => !Object.hasOwn(options.headers, 'Authorization')));
  const direct = createAPI({ baseUrl, authentication: 'none', directory, fetchImpl: async (url, options) => {
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    return Response.json(info());
  } });
  await direct.request('/api/info');
});

test('basic mode still requires a nonblank password; invalid auth or remote no-auth never requests', async () => {
  const fetchImpl = async () => assert.fail('Invalid connection must not make a request');
  for (const password of [undefined, '', '   ']) {
    assert.throws(() => createAPI({ baseUrl, password, authentication: 'basic', directory, fetchImpl }), /Invalid configured/);
    await assert.rejects(connect(directory, undefined, { baseUrl, authentication: 'basic', environment: { OPENCODE_PASSWORD: password }, fetchImpl }), /password environment/);
  }
  await assert.rejects(connect(directory, undefined, { baseUrl, authentication: 'disabled', environment: {}, fetchImpl }), /authentication mode/);
  await assert.rejects(connect(directory, undefined, { baseUrl: 'http://external.example', authentication: 'none', environment: {}, fetchImpl }), /local OpenCode HTTP/);
});
