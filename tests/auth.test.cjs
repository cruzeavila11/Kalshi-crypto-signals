const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
let modules, env;
const ready = (async () => {
  const [express, auth, argon2, jose] = await Promise.all([import('express'), import('../auth.js'), import('argon2'), import('jose')]);
  modules = { express: express.default, ...auth, argon2, jose };
  // Ephemeral test credentials only; never printed or persisted.
  const password = randomBytes(24).toString('base64url');
  env = { NODE_ENV: 'production', AUTH_USERNAME: 'test-owner',
    AUTH_PASSWORD_HASH: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    AUTH_SESSION_SECRET: randomBytes(32).toString('base64url'), AUTH_SESSION_VERSION: 'test-v1', APP_ORIGIN: 'https://test.example' };
  return password;
})();
async function server(t, overrides = {}) {
  await ready;
  const app = modules.express();
  let upstream = 0;
  await modules.installAuthentication(app, modules.express, { ...env, ...overrides });
  app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'READ_ONLY', tradingEnabled: false }));
  app.get('/api/markets', (req, res) => { upstream++; res.json({ markets: [] }); });
  app.post('/api/state', (req, res) => res.json({ ok: true }));
  app.get('/api/proxy-test', (req, res) => res.json({ ip: req.ip, ips: req.ips, protocol: req.protocol }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const login = (username = env.AUTH_USERNAME, password) => request('/auth/login', {
    method: 'POST', headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }) });
  return { request, login, upstream: () => upstream };
}
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }
async function token(overrides = {}, configuration = env) {
  const now = Math.floor(Date.now() / 1000);
  return '__Host-kalshi_session=' + await new modules.jose.SignJWT({ sub: 'owner', iss: env.APP_ORIGIN,
    aud: env.APP_ORIGIN, iat: now, exp: now + 28800, sessionVersion: env.AUTH_SESSION_VERSION, ...overrides })
    .setProtectedHeader({ alg: 'HS256' }).sign(Buffer.from(configuration.AUTH_SESSION_SECRET, 'base64url'));
}
test('fails closed for missing/invalid settings; Argon2id hash verifies test password only', async () => {
  const password = await ready;
  for (const key of ['AUTH_USERNAME', 'AUTH_PASSWORD_HASH', 'AUTH_SESSION_SECRET', 'AUTH_SESSION_VERSION', 'APP_ORIGIN']) {
    assert.throws(() => modules.readAuthConfig({ ...env, [key]: '' }));
  }
  for (const override of [{ APP_ORIGIN: 'http://test.example' }, { AUTH_PASSWORD_HASH: 'plaintext' },
    { AUTH_SESSION_SECRET: 'too-short' }, { NODE_ENV: undefined }, { APP_ORIGIN: 'https://test.example/path' }]) {
    assert.throws(() => modules.readAuthConfig({ ...env, ...override }));
  }
  assert.equal(await modules.argon2.verify(env.AUTH_PASSWORD_HASH, password), true);
  assert.equal(await modules.argon2.verify(env.AUTH_PASSWORD_HASH, 'wrong-test-input'), false);
});
test('anonymous dashboard redirects; every API returns 401 before upstream; public liveness is minimal', async t => {
  const s = await server(t);
  for (const url of ['/', '/index.html', '/app.js', '/manifest.json']) {
    const r = await s.request(url); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/login');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  for (const url of ['/api/health', '/api/markets', '/api/market-outcomes', '/api/discover-series', '/api/unknown']) {
    const r = await s.request(url); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'Authentication required' });
  }
  assert.equal(s.upstream(), 0);
  assert.deepEqual(await (await s.request('/live')).json(), { ok: true });
});
test('owner login cookie claims/flags, authenticated allowlist and READ_ONLY health; repository files forbidden', async t => {
  const s = await server(t), r = await s.login(undefined, await ready);
  assert.equal(r.status, 200);
  const header = r.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(header.includes(flag));
  assert.ok(!header.includes('Domain='));
  const c = cookie(r), claims = modules.jose.decodeJwt(c.slice(c.indexOf('=') + 1));
  assert.equal(claims.sub, 'owner'); assert.equal(claims.sessionVersion, env.AUTH_SESSION_VERSION);
  assert.equal(claims.exp - claims.iat, 28800);
  for (const url of ['/', '/index.html', '/app.js', '/signal-engine.js', '/manifest.json', '/api/health']) {
    const result = await s.request(url, { headers: { Cookie: c } }); assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  const health = await (await s.request('/api/health', { headers: { Cookie: c } })).json();
  assert.deepEqual(health, { ok: true, mode: 'READ_ONLY', tradingEnabled: false });
  for (const url of ['/server.js', '/auth.js', '/package.json', '/package-lock.json', '/README.md', '/tests/auth.test.cjs', '/.env', '/node_modules/express/package.json']) {
    assert.equal((await s.request(url, { headers: { Cookie: c } })).status, 404, url);
  }
});
test('wrong username/password return identical generic failures', async t => {
  const s = await server(t);
  const wrongUser = await s.login('wrong-user', await ready);
  const wrongPassword = await s.login(undefined, 'wrong-test-password');
  assert.equal(wrongUser.status, 401); assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await wrongUser.json(), { error: 'Invalid credentials' });
  assert.deepEqual(await wrongPassword.json(), { error: 'Invalid credentials' });
  assert.equal(wrongPassword.headers.get('set-cookie'), null);
});
test('tampering, expiry, future issuance, wrong owner and wrong version reject cookies', async t => {
  const s = await server(t); const now = Math.floor(Date.now() / 1000);
  const valid = await token();
  const cookies = [valid.slice(0, -8) + 'tampered', await token({ iat: now - 28801, exp: now - 1 }),
    await token({ iat: now + 100, exp: now + 28900 }), await token({ sub: 'someone-else' }),
    await token({ sessionVersion: 'old' }), await token({ exp: now + 60 })];
  for (const c of cookies) assert.equal((await s.request('/api/health', { headers: { Cookie: c } })).status, 401);
});
test('stateless session survives restart; version and secret rotations revoke it', async t => {
  const first = await server(t), c = cookie(await first.login(undefined, await ready));
  const restarted = await server(t);
  assert.equal((await restarted.request('/api/health', { headers: { Cookie: c } })).status, 200);
  const version = await server(t, { AUTH_SESSION_VERSION: 'test-v2' });
  assert.equal((await version.request('/api/health', { headers: { Cookie: c } })).status, 401);
  const rotated = await server(t, { AUTH_SESSION_SECRET: randomBytes(32).toString('base64url') });
  assert.equal((await rotated.request('/api/health', { headers: { Cookie: c } })).status, 401);
});
test('logout expires browser cookie; login/logout and future writes require exact origin', async t => {
  const s = await server(t), c = await token();
  for (const Origin of [undefined, 'https://attacker.example', 'null']) for (const url of ['/auth/login', '/auth/logout', '/api/state']) {
    const r = await s.request(url, { method: 'POST', headers: { Cookie: c, ...(Origin ? { Origin } : {}) } });
    assert.equal(r.status, 403);
  }
  assert.equal((await s.request('/auth/logout', { headers: { Cookie: c } })).status, 404);
  const r = await s.request('/auth/logout', { method: 'POST', headers: { Cookie: c, Origin: env.APP_ORIGIN } });
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await s.request('/api/health')).status, 401);
});
test('rate limiting occurs before more password verification attempts', async t => {
  const s = await server(t);
  for (let i = 0; i < 5; i++) assert.equal((await s.login(undefined, 'wrong-test-password')).status, 401);
  const r = await s.login(undefined, await ready);
  assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
});
test('mixed-case API paths return JSON 401 before handlers and retain authenticated access', async t => {
  const s = await server(t), c = await token();
  for (const url of ['/API/markets', '/Api/markets', '/aPi/health', '/API/market-outcomes', '/Api/unknown']) {
    const r = await s.request(url);
    assert.equal(r.status, 401, url);
    assert.deepEqual(await r.json(), { error: 'Authentication required' });
  }
  assert.equal(s.upstream(), 0);
  for (const url of ['/API/markets', '/Api/markets', '/aPi/health']) {
    assert.equal((await s.request(url, { headers: { Cookie: c } })).status, 200);
  }
  assert.equal(s.upstream(), 2);
});
test('rotating spoofed forwarding headers cannot bypass peer limit, even behind an explicitly trusted proxy', async t => {
  for (const configuration of [{}, { AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }]) {
    const s = await server(t, configuration);
    for (let i = 0; i < 8; i++) {
      const r = await s.request('/auth/login', { method: 'POST', headers: {
        Origin: env.APP_ORIGIN, 'Content-Type': 'application/json',
        'X-Forwarded-For': ['198.51.100.1', '198.51.100.2:1234', 'garbage', '2001:db8::1',
          '198.51.100.5, 198.51.100.6', '::ffff:198.51.100.7', '198.51.100.8', '198.51.100.9'][i],
        Forwarded: `for=192.0.2.${i + 1};proto=https`, 'X-Real-IP': `192.0.2.${i + 10}`,
        'X-Forwarded-Proto': i % 2 ? 'http' : 'https'
      }, body: JSON.stringify({ username: env.AUTH_USERNAME, password: 'wrong-test-password' }) });
      assert.equal(r.status, i < 5 ? 401 : 429);
    }
  }
});
test('only explicitly trusted immediate proxy identifies forwarded client; arbitrary chains and direct clients are untrusted', async t => {
  const c = await token(), headers = { Cookie: c, 'X-Forwarded-For': '192.0.2.99, 198.51.100.7', 'X-Forwarded-Proto': 'https' };
  const direct = await server(t);
  const d = await (await direct.request('/api/proxy-test', { headers })).json();
  assert.equal(d.ip, '127.0.0.1'); assert.deepEqual(d.ips, []); assert.equal(d.protocol, 'http');
  const trusted = await server(t, { AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' });
  const p = await (await trusted.request('/api/proxy-test', { headers })).json();
  assert.equal(p.ip, '198.51.100.7'); assert.deepEqual(p.ips, ['198.51.100.7']); assert.equal(p.protocol, 'https');
  const wrongPeer = await server(t, { AUTH_TRUSTED_PROXY_CIDRS: '192.0.2.1/32' });
  assert.equal((await (await wrongPeer.request('/api/proxy-test', { headers })).json()).ip, '127.0.0.1');
  for (const value of ['', '0.0.0.0/0', '::/0', 'loopback', 'garbage', '127.0.0.1/99']) {
    await assert.rejects(() => server(t, { AUTH_TRUSTED_PROXY_CIDRS: value }), /Invalid trusted proxy configuration/);
  }
});
test('peer address normalization handles IPv4, IPv6, mapped addresses, ports and malformed inputs consistently', async () => {
  await ready;
  for (const [input, expected] of [['127.0.0.1:1234', '127.0.0.1'], ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'], ['[2001:0db8::1]:1234', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'], ['fe80::1%eth0', 'fe80::1'], ['garbage', 'unknown-peer'], [null, 'unknown-peer'],
    ['198.51.100.1, 198.51.100.2', 'unknown-peer']]) {
    assert.equal(modules.normalizeClientAddress(input), expected);
  }
});
test('public login/cache migration resources are no-store and never contain configuration or credentials', async t => {
  const s = await server(t);
  for (const url of ['/login', '/login.js', '/auth-client.js', '/styles.css', '/sw.js']) {
    const r = await s.request(url); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.text(); assert.ok(!body.includes(env.AUTH_PASSWORD_HASH)); assert.ok(!body.includes(env.AUTH_SESSION_SECRET));
  }
  const worker = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  assert.doesNotMatch(worker, /addEventListener\(['"]fetch|cache\.put|addAll/);
  assert.match(worker, /registration\.unregister/);
  const client = fs.readFileSync(path.join(__dirname, '../auth-client.js'), 'utf8');
  assert.doesNotMatch(client, /localStorage\.(clear|removeItem)/);
  for (const behavior of ['BroadcastChannel', 'visibilitychange', 'pageshow', "response.status === 401", "location.replace('/login')"]) assert.ok(client.includes(behavior));
});

test('unauthenticated POST APIs also return 401 without invoking upstream', async t => {
  const s = await server(t);
  assert.equal((await s.request('/api/state', { method: 'POST' })).status, 401);
  assert.equal(s.upstream(), 0);
});

test('real server fails closed and preserves protected READ_ONLY health with test configuration', async t => {
  await ready;
  const { spawn } = require('node:child_process');
  const failed = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env, AUTH_SESSION_SECRET: '' }, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.notEqual(await new Promise(resolve => failed.once('exit', resolve)), 0);
  // Report the ephemeral bound port without modifying production code.
  const code = `import express from 'express'; const listen=express.application.listen;
    express.application.listen=function(...args){const s=listen.apply(this,args); s.on('listening',()=>process.stdout.write('BOUND '+s.address().port+'\\n'));return s;}; await import('./server.js');`;
  const running = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => running.kill());
  const port = await new Promise((resolve, reject) => {
    let output = '';
    running.stdout.on('data', data => { output += data; const match = output.match(/BOUND (\d+)/); if (match) resolve(match[1]); });
    running.once('error', reject); running.once('exit', () => reject(new Error('Test server exited')));
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/api/markets')).status, 401);
  const r = await fetch(base + '/api/health', { headers: { Cookie: await token() } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, mode: 'READ_ONLY', tradingEnabled: false });
});
