const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../auth-client.js'), 'utf8').replace(/^export /gm, '');
function browser() {
  const events = new Map(), navigation = [], posts = [], requests = [];
  let stopped = 0, response = { ok: true, status: 200 };
  const c = { navigator: {}, URL, location: { origin: 'https://test.example', replace: url => navigation.push(url) },
    document: { body: { textContent: 'dashboard', style: {} }, hidden: false,
      querySelector: () => ({ addEventListener: (name, fn) => events.set('logout', fn) }),
      addEventListener: (name, fn) => events.set(name, fn) },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    BroadcastChannel: class { constructor() { c.channel = this; } postMessage(message) { posts.push(message); } },
    fetch: async (...args) => { requests.push(args); return response; } };
  vm.createContext(c); vm.runInContext(source, c);
  const lifecycle = c.installAuthLifecycle(() => stopped++);
  return { c, lifecycle, events, navigation, posts, requests, stopped: () => stopped,
    response: r => { response = r; } };
}
test('401 blanks dashboard, stops polling, broadcasts logout and prevents further guarded requests', async () => {
  const b = browser(); b.response({ ok: false, status: 401 });
  await assert.rejects(b.lifecycle.fetch('/api/markets'));
  assert.equal(b.stopped(), 1); assert.equal(b.navigation[0], '/login');
  assert.ok(!b.c.document.body.textContent.includes('dashboard'));
  assert.equal(b.posts[0], 'logout');
  const count = b.requests.length;
  await assert.rejects(b.lifecycle.fetch('/api/markets')); assert.equal(b.requests.length, count);
});
test('logout POST and cross-tab logout stop polling; restored pages verify before display', async () => {
  const b = browser(); await b.events.get('logout')();
  assert.equal(b.requests[0][0], '/auth/logout'); assert.equal(b.requests[0][1].method, 'POST');
  assert.equal(b.navigation[0], '/login');
  const other = browser(); other.c.channel.onmessage({ data: 'logout' });
  assert.equal(other.stopped(), 1); assert.equal(other.navigation[0], '/login'); assert.equal(other.posts.length, 0);
  const restore = browser(); await restore.events.get('pageshow')();
  assert.equal(restore.requests[0][0], '/auth/session');
  assert.equal(restore.c.document.body.style.visibility, '');
  restore.response({ ok: false, status: 401 }); await restore.events.get('visibilitychange')();
  assert.equal(restore.navigation[0], '/login');
});
test('cleanup removes app caches/root worker only, preserving unrelated caches and local history', async () => {
  const b = browser(), removed = [], unregistered = [];
  b.c.navigator.serviceWorker = { getRegistrations: async () => [
    { scope: 'https://test.example/', unregister: () => unregistered.push('root') },
    { scope: 'https://test.example/other/', unregister: () => unregistered.push('other') }
  ] };
  b.c.caches = { keys: async () => ['kalshi-old', 'unrelated'], delete: name => removed.push(name) };
  b.c.localStorage = { clear: () => assert.fail('History wiped'), removeItem: () => assert.fail('History removed') };
  await b.c.cleanupAppCaches(); assert.deepEqual(removed, ['kalshi-old']); assert.deepEqual(unregistered, ['root']);
});

test('logout suspends guarded requests immediately and rejects responses already in flight', async () => {
  const b = browser(); let finish;
  b.c.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = b.lifecycle.fetch('/api/markets');
  const finishMarket = finish;
  const logout = b.events.get('logout')();
  const finishLogout = finish;
  assert.equal(b.lifecycle.isActive(), false);
  finishMarket({ ok: true, status: 200 });
  await assert.rejects(pending);
  finishLogout({ ok: true, status: 200 }); await logout;
  assert.equal(b.navigation[0], '/login');
});
