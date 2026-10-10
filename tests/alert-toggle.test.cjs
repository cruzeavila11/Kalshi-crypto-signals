const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const position = { asset: 'BTC', side: 'YES', entryPrice: 50, contracts: 2, openedAt: 1 };
function browser(store = new Map(), permission = 'granted', answer = 'granted', supported = true) {
  const notifications = [], warnings = [], messages = [];
  let requests = 0;
  const button = { textContent: '', setAttribute(name, value) { this[name] = value; } };
  class Notification {
    static permission = permission;
    static async requestPermission() { requests++; this.permission = answer; return answer; }
    constructor(title, options) { notifications.push({ title, options }); }
  }
  const c = { console: { warn: (...args) => warnings.push(args) }, Date, URLSearchParams, AbortSignal,
    document: { querySelector: id => id === '#notifyBtn' ? button : null, getElementById: () => null },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    alert: message => messages.push(message), ...(supported ? { Notification } : {}) };
  vm.createContext(c);
  vm.runInContext(source.slice(0, source.lastIndexOf('\nrenderTrackedPosition();')).replace(/^import .*;\n/gm, ''), c);
  const evaluate = (status, p = position) => c.notifyPositionTransition(p, status, 75, 0.50, 50, 'Test reason');
  return { c, store, button, notifications, evaluate, messages, requests: () => requests };
}
test('ON notifies actionable transitions once; HOLD/CLOSED and unchanged refreshes do not notify', async () => {
  const b = browser();
  await b.button.onclick();
  assert.equal(b.requests(), 0);
  assert.equal(b.button.textContent, 'Alerts ON');
  assert.equal(b.button['aria-pressed'], 'true');
  b.evaluate('HOLD');
  for (const status of ['TAKE PROFIT', 'CLOSE', 'RISK EXIT']) {
    b.evaluate(status); b.evaluate(status);
  }
  assert.equal(b.notifications.length, 3);
  b.evaluate('CLOSED'); b.evaluate('HOLD'); b.evaluate('RISK EXIT');
  assert.equal(b.notifications.length, 4);
  const reloaded = browser(b.store);
  reloaded.evaluate('RISK EXIT');
  assert.equal(reloaded.notifications.length, 0);
});
test('OFF suppresses alerts, persists on reload, and ON resumes later transitions', async () => {
  const b = browser();
  await b.button.onclick(); await b.button.onclick();
  assert.equal(b.requests(), 0);
  assert.equal(b.store.get('kalshiAlertsEnabled'), 'false');
  assert.equal(b.button.textContent, 'Alerts OFF');
  b.evaluate('TAKE PROFIT');
  assert.equal(b.notifications.length, 0);
  const reloaded = browser(b.store);
  assert.equal(reloaded.button.textContent, 'Alerts OFF');
  reloaded.evaluate('CLOSE');
  assert.equal(reloaded.notifications.length, 0);
  await reloaded.button.onclick();
  reloaded.evaluate('CLOSE'); // Enabling does not repeat an already evaluated state.
  assert.equal(reloaded.notifications.length, 0);
  reloaded.evaluate('HOLD'); reloaded.evaluate('CLOSE');
  assert.equal(reloaded.notifications.length, 1);
});
test('saving and clearing positions preserve global ON and OFF preferences', async () => {
  for (const enabled of [false, true]) {
    const b = browser(new Map([['kalshiAlertsEnabled', String(enabled)]]));
    b.c.savePosition(position); b.c.clearSavedPosition();
    assert.equal(b.store.get('kalshiAlertsEnabled'), String(enabled));
    assert.equal(b.button.textContent, enabled ? 'Alerts ON' : 'Alerts OFF');
    b.c.savePosition({ ...position, openedAt: 2 }); b.evaluate('CLOSE', { ...position, openedAt: 2 });
    assert.equal(b.notifications.length, enabled ? 1 : 0);
  }
});
test('permission requested only on enable; denied permission stays OFF', async () => {
  const allowed = browser(new Map(), 'default', 'granted');
  await allowed.button.onclick();
  assert.equal(allowed.requests(), 1);
  assert.equal(allowed.store.get('kalshiAlertsEnabled'), 'true');
  await allowed.button.onclick();
  assert.equal(allowed.requests(), 1);
  const denied = browser(new Map(), 'denied', 'denied');
  await denied.button.onclick(); denied.evaluate('CLOSE');
  assert.equal(denied.requests(), 1);
  assert.equal(denied.button.textContent, 'Alerts OFF');
  assert.equal(denied.notifications.length, 0);
  const revoked = browser(new Map([['kalshiAlertsEnabled', 'true']]), 'denied');
  revoked.evaluate('CLOSE');
  assert.equal(revoked.notifications.length, 0);
  assert.equal(revoked.requests(), 0);
});
test('unsupported notifications and failed storage remain safe', async () => {
  const unsupported = browser(new Map(), 'default', 'granted', false);
  await unsupported.button.onclick(); unsupported.evaluate('CLOSE');
  assert.equal(unsupported.messages.length, 1);
  assert.equal(unsupported.notifications.length, 0);
  const b = browser();
  b.c.localStorage.getItem = () => { throw new Error('unavailable'); };
  b.c.localStorage.setItem = () => { throw new Error('unavailable'); };
  await b.button.onclick();
  b.evaluate('CLOSE'); b.evaluate('CLOSE');
  assert.equal(b.notifications.length, 1);
  await b.button.onclick(); b.evaluate('RISK EXIT');
  assert.equal(b.notifications.length, 1);
});
test('stale persisted state cannot override session deduplication after writes fail', async () => {
  const b = browser(new Map([['kalshiAlertsEnabled', 'true']]));
  b.evaluate('HOLD');
  b.c.localStorage.setItem = () => { throw new Error('write failed'); };
  b.evaluate('CLOSE'); b.evaluate('CLOSE'); b.evaluate('CLOSE');
  assert.equal(b.notifications.length, 1);
  b.evaluate('HOLD'); b.evaluate('CLOSE');
  assert.equal(b.notifications.length, 2);
});
