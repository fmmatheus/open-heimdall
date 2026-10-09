import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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

test('basic mode preserves passwords exactly; missing auth or remote no-auth never requests', async () => {
  const fetchImpl = async () => assert.fail('Invalid connection must not make a request');
  for (const password of [undefined, '']) {
    assert.throws(() => createAPI({ baseUrl, password, authentication: 'basic', directory, fetchImpl }), /Invalid configured/);
    await assert.rejects(connect(directory, undefined, { baseUrl, authentication: 'basic', environment: { OPENCODE_PASSWORD: password }, fetchImpl }), /password environment/);
  }
  await assert.rejects(connect(directory, undefined, { baseUrl, authentication: 'disabled', environment: {}, fetchImpl }), /authentication mode/);
  await assert.rejects(connect(directory, undefined, { baseUrl: 'http://external.example', authentication: 'none', environment: {}, fetchImpl }), /local OpenCode HTTP/);
  await connect(directory, undefined, { baseUrl, environment: { OPENCODE_PASSWORD: '   ' }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('opencode:   ').toString('base64'));
    return Response.json(info());
  } });
});


const desktopSettings = overrides => JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: 'synthetic-desktop-token', ...overrides });
const desktopConnection = overrides => ({ baseUrl, authentication: 'openchamber', environment: {}, openchamber: { homeDirectory: '/synthetic/home', readFile: async () => desktopSettings() }, ...overrides });

test('Desktop connection uses its selected settings and forwards authenticated native requests intact', async () => {
  const calls = [], files = [];
  const worktree = '/workspace/social feed_日本';
  const environment = new Proxy({ OPENCHAMBER_DATA_DIR: '  /synthetic/desktop-profile  ' }, { get(target, key) {
    assert.equal(key, 'OPENCHAMBER_DATA_DIR', 'Desktop auth never reads an OpenCode password');
    return target[key];
  } });
  const api = await connect(worktree, 'ses_child', desktopConnection({ environment,
    openchamber: { readFile: async (file, encoding) => { files.push({ file, encoding }); return desktopSettings({ desktopLocalClientToken: ' synthetic-desktop-token ' }); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname === '/api/info') return Response.json(info());
      if (url.pathname === '/api/session/ses_child') return Response.json({ data: { ...session(), location: { directory: worktree } } });
      return Response.json({ data: [{ id: 'msg_reserved', metadata: { heimdallRunId: 'run_reserved' } }], cursor: { next: 'native-cursor' } });
    },
  }));
  const body = { id: 'msg_reserved', text: 'Feature', metadata: { heimdallRunId: 'run_reserved' }, delivery: 'queue', resume: false };
  assert.deepEqual(await api.request('/api/session/ses_child/prompt', { method: 'POST', body }), [{ id: 'msg_reserved', metadata: { heimdallRunId: 'run_reserved' } }]);
  assert.deepEqual((await api.request('/api/session/ses_child/message', { raw: true })).cursor, { next: 'native-cursor' });
  assert.deepEqual(files, [{ file: path.join('/synthetic/desktop-profile', 'settings.json'), encoding: 'utf8' }]);
  assert.equal(api.version, '2.0.22');
  assert.equal(api.pid, 44, 'metadata belongs to the native server, not the Desktop proxy');
  assert.equal(JSON.parse(calls[2].options.body).metadata.heimdallRunId, body.metadata.heimdallRunId);
  assert.deepEqual(JSON.parse(calls[2].options.body), body);
  for (const call of calls) {
    assert.equal(call.url.origin, new URL(baseUrl).origin);
    assert.equal(call.url.searchParams.get('location[directory]'), worktree);
    assert.equal(call.options.headers.Authorization, 'Bearer synthetic-desktop-token');
    assert.equal(call.options.headers['x-opencode-directory'], encodeURIComponent(worktree));
    assert.equal(call.options.headers['x-opencode-directory-encoding'], 'uri');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(api).includes('synthetic-desktop-token'));
});

test('Desktop uses the default settings path and rejects another local port before any request', async () => {
  let selected;
  const options = desktopConnection({ openchamber: { homeDirectory: '/synthetic/home', readFile: async file => { selected = file; return desktopSettings(); } }, fetchImpl: async () => Response.json(info()) });
  await connect(directory, undefined, options);
  assert.equal(selected, path.join('/synthetic/home', '.config', 'openchamber', 'settings.json'));
  await assert.rejects(connect(directory, undefined, { ...options, baseUrl: 'http://127.0.0.1:4321', fetchImpl: async () => assert.fail('Mismatched Desktop port must not request') }), /match the Desktop local port/);
  for (const port of [0, 65536, 4096.5, '4096', null]) {
    await assert.rejects(connect(directory, undefined, desktopConnection({ openchamber: { readFile: async () => desktopSettings({ desktopLocalPort: port }) }, fetchImpl: async () => assert.fail('Invalid Desktop port must not request') })), /match the Desktop local port/);
  }
});

test('Desktop rejects invalid origins before accessing its settings or transmitting its token', async () => {
  for (const value of ['http://external.example:4096', 'https://127.0.0.1:4096', 'http://user:password@localhost:4096', 'http://localhost:4096/api/', 'http://localhost:4096?token=secret']) {
    await assert.rejects(connect(directory, undefined, desktopConnection({ baseUrl: value, openchamber: { readFile: async () => assert.fail('Invalid origin must not read Desktop settings') }, fetchImpl: async () => assert.fail('Invalid origin must not request') })), /local .*HTTP/);
  }
});

test('missing Desktop settings or token fails safely without an unauthenticated fallback', async () => {
  const read = async () => { throw new Error('synthetic-desktop-token'); };
  for (const readFile of [read, async () => '{synthetic-desktop-token', async () => '[]', ...[undefined, '', '   ', 'unsafe\ntoken'].map(token => async () => desktopSettings({ desktopLocalClientToken: token }))]) {
    await assert.rejects(connect(directory, undefined, desktopConnection({ openchamber: { readFile }, fetchImpl: async () => assert.fail('Missing Desktop credentials must not request') })), error => {
      assert.match(error.message, /OpenChamber Desktop/);
      assert.ok(!error.message.includes('synthetic-desktop-token'));
      assert.ok(!JSON.stringify(error).includes('synthetic-desktop-token'));
      return true;
    });
  }
});

test('Desktop transport retains safe native HTTP errors and server/session validation', async () => {
  for (const status of [401, 403, 404, 503]) {
    await assert.rejects(connect(directory, undefined, desktopConnection({ fetchImpl: async () => new Response('synthetic-desktop-token', { status }) })), error => error.status === status && error.message === 'OpenCode API HTTP ' + status && !JSON.stringify(error).includes('synthetic-desktop-token'));
  }
  await assert.rejects(connect(directory, undefined, desktopConnection({ fetchImpl: async () => { throw new Error('synthetic-desktop-token'); } })), /unreachable or timed out/);
  await assert.rejects(connect(directory, undefined, desktopConnection({ fetchImpl: async () => Response.json({ ...info(), version: 'different' }) })), /supported OpenCode/);
  await assert.rejects(connect(directory, 'ses_child', desktopConnection({ fetchImpl: async url => Response.json(url.pathname === '/api/info' ? info() : { data: { ...session(), id: 'another' } }) })), /identity/);
  await assert.rejects(connect(directory, 'ses_child', desktopConnection({ fetchImpl: async url => Response.json(url.pathname === '/api/info' ? info() : { data: { ...session(), location: { directory: '/other' } } }) })), /different project/);
});

test('Basic and no-auth do not access Desktop settings or add its directory encoding marker', async () => {
  for (const authentication of ['basic', 'none']) {
    await connect(directory, undefined, { ...connection, authentication, openchamber: { readFile: async () => assert.fail('Other authentication modes must not read Desktop settings') }, fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, 'x-opencode-directory-encoding'), false);
      return Response.json(info());
    } });
  }
});
