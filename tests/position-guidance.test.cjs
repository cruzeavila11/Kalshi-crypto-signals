const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = Date.now();
function browser(store = new Map()) {
  let clock = start;
  const nodes = new Map(['positionStatus', 'savePosition', 'clearPosition', 'positionAsset', 'positionSide', 'entryPrice', 'positionSize']
    .map(id => [id, { textContent: '', value: '', innerHTML: '' }]));
  const messages = [];
  const c = { Date: class extends Date { static now() { return clock; } }, console, URLSearchParams, AbortSignal,
    document: { querySelector: id => nodes.get(id.slice(1)) || null, getElementById: id => nodes.get(id) || null },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    alert: text => messages.push(text) };
  vm.createContext(c);
  vm.runInContext(source.slice(0, source.lastIndexOf('\nrenderTrackedPosition();')).replace(/^import .*;\n/gm, ''), c);
  c.mockSignal = { label: 'WATCH YES', strength: 88 };
  vm.runInContext('buildSignal = () => mockSignal;', c);
  return { c, nodes, store, messages, time: t => { clock = t; },
    snapshot(m, signal, time = clock) {
      clock = time; c.mockSignal = signal; c.markets = [m];
      vm.runInContext('latestMarkets = markets;', c); c.evaluatePositionMarkets([m], time);
    } };
}
function position(side = 'YES', extra = {}) {
  return { asset: 'BTC', ticker: 'KXBTC15M-A', side, entryPrice: 50, contracts: 10,
    openedAt: start - 1000, closeTimestamp: start + 600000, ...extra };
}
function market(side = 'YES', cents = 60, minutes = 10, extra = {}) {
  const yes = side === 'YES' ? cents / 100 : 1 - cents / 100;
  return { asset: 'BTC', ticker: 'KXBTC15M-A', status: 'active',
    yes_bid_dollars: side === 'YES' ? yes : yes - .01,
    yes_ask_dollars: side === 'NO' ? yes : yes + .01,
    last_price_dollars: yes, close_time: new Date(start + minutes * 60000).toISOString(), ...extra };
}
function signal(side, opposing = false, strength = 88) {
  return { label: (side === 'YES') !== opposing ? 'WATCH YES' : 'WATCH NO', strength };
}
function evaluate(b, p, m, s, time = start, id = 1) {
  return b.c.positionGuidance(p, m, s, { id, time }, time);
}
for (const side of ['YES', 'NO']) test(`${side}: valuation, thresholds, supporting/neutral/missing signals and reasons`, () => {
  const b = browser(), p = position(side);
  const cases = [
    [60, 10, signal(side), 'HOLD', 'supporting signal'],
    [45, 10, signal(side), 'HOLD', 'supporting signal'],
    [75, 10, signal(side), 'TAKE PROFIT', '+50%'],
    [35, 10, signal(side), 'RISK EXIT', '-25%'],
    [40, 1, { label: 'WATCH', strength: 49 }, 'RISK EXIT', 'at most 2 minutes'],
    [92, 10, signal(side), 'TAKE PROFIT', '+50%'],
    [60, 1, signal(side), 'TAKE PROFIT', 'at most 2 minutes'],
    [62.5, 4, signal(side), 'TAKE PROFIT', '+25%'],
    [60, 10, signal(side, true, 79), 'HOLD', 'weak opposing signal'],
    [60, 10, { label: 'WATCH', strength: 49 }, 'HOLD', 'neutral signal'],
    [60, 10, { label: 'NO SIGNAL', strength: 0 }, 'HOLD', 'missing signal'],
    [60, 10, null, 'HOLD', 'missing signal']
  ];
  for (const [cents, minutes, s, expected, reason] of cases) {
    const result = evaluate(b, p, market(side, cents, minutes), s);
    assert.equal(result.status, expected);
    assert.ok(Math.abs(result.currentCents - cents) < 1e-8);
    assert.ok(Math.abs(result.pnlDollars - (cents - 50) / 10) < 1e-8);
    assert.ok(Math.abs(result.returnPct - (cents - 50) * 2) < 1e-8);
    assert.match(result.reason, new RegExp(reason.replace(/[+¢]/g, '\\$&')));
    for (const text of ['Gross P/L', 'return', 'remaining', 'evidence', 'opposition', 'fees excluded']) assert.ok(result.reason.includes(text));
  }
  const nearMax = evaluate(b, position(side, { entryPrice: 80 }), market(side, 92), signal(side));
  assert.equal(nearMax.status, 'TAKE PROFIT'); assert.match(nearMax.reason, /90¢/);
});
for (const side of ['YES', 'NO']) test(`${side}: first vs confirmed opposition for profit, small loss and moderate loss`, () => {
  for (const [cents, expected] of [[60, 'TAKE PROFIT'], [45, 'CLOSE'], [40, 'RISK EXIT'], [50, 'CLOSE']]) {
    const b = browser(), p = position(side), m = market(side, cents), s = signal(side, true, 80);
    assert.equal(evaluate(b, p, m, s).status, 'HOLD');
    assert.match(evaluate(b, p, m, s).reason, /unconfirmed/);
    const after = evaluate(b, p, m, s, start + 30000, 2);
    assert.equal(after.status, expected); assert.match(after.reason, /opposition confirmed/);
  }
});
test('confirmation requires successive distinct evaluations at least 30s apart; duplicate renders do not count', () => {
  const b = browser(), p = position(), m = market(), s = signal('YES', true);
  b.c.savePosition(p); b.snapshot(m, s); b.c.renderTrackedPosition();
  b.time(start + 30000); b.c.renderTrackedPosition(); b.c.renderTrackedPosition();
  assert.match(b.nodes.get('positionStatus').textContent, /HOLD/);
  b.snapshot(m, s, start + 30000); b.c.renderTrackedPosition();
  assert.match(b.nodes.get('positionStatus').textContent, /TAKE PROFIT/);
  const fast = browser();
  evaluate(fast, p, m, s);
  assert.equal(evaluate(fast, p, m, s, start + 10000, 2).status, 'HOLD');
  assert.equal(evaluate(fast, p, m, s, start + 30000, 3).status, 'HOLD');
  assert.equal(evaluate(fast, p, m, s, start + 60000, 4).status, 'TAKE PROFIT');
});
test('supporting, neutral, missing, weak and unavailable inputs reset confirmation', () => {
  for (const reset of [signal('YES'), { label: 'WATCH', strength: 49 }, null, signal('YES', true, 79)]) {
    const b = browser(), p = position(), m = market(), s = signal('YES', true);
    evaluate(b, p, m, s);
    evaluate(b, p, m, reset, start + 30000, 2);
    assert.equal(evaluate(b, p, m, s, start + 60000, 3).status, 'HOLD');
    assert.equal(evaluate(b, p, m, s, start + 90000, 4).status, 'TAKE PROFIT');
  }
  const b = browser(), p = position(), m = market(), s = signal('YES', true);
  evaluate(b, p, m, s);
  evaluate(b, p, { ...m, yes_bid_dollars: null }, s, start + 30000, 2);
  assert.equal(evaluate(b, p, m, s, start + 60000, 3).status, 'HOLD');
});
test('legacy positions, mismatched tickers/assets and rollover never borrow another contract', () => {
  const b = browser(); const p = position();
  assert.match(evaluate(b, { ...p, ticker: undefined }, market(), signal('YES')).reason, /Legacy position/);
  assert.equal(evaluate(b, p, market('YES', 60, 10, { ticker: 'KXBTC15M-B' }), signal('YES')).status, 'UNAVAILABLE');
  assert.equal(evaluate(b, p, market('YES', 60, 10, { asset: 'ETH' }), signal('YES')).status, 'UNAVAILABLE');
  b.c.savePosition(p); b.snapshot(market('YES', 90, 10, { ticker: 'KXBTC15M-B' }), signal('YES'));
  b.c.renderTrackedPosition(); assert.match(b.nodes.get('positionStatus').textContent, /Exact tracked ticker is unavailable/);
  const again = browser(b.store); again.snapshot(market('YES', 90, 10, { ticker: 'KXBTC15M-B' }), signal('YES'));
  again.c.renderTrackedPosition(); assert.match(again.nodes.get('positionStatus').textContent, /No other contract/);
});
test('missing/null/malformed/crossed/non-executable quotes cannot create guidance', () => {
  for (const side of ['YES', 'NO']) for (const field of ['yes_bid_dollars', 'yes_ask_dollars']) {
    for (const value of [null, undefined, '', ' ', 'bad', NaN, Infinity, -1, 2, false, []]) {
      const result = evaluate(browser(), position(side), market(side, 60, 10, { [field]: value }), signal(side));
      assert.equal(result.status, 'UNAVAILABLE', `${side} ${field} ${String(value)}`);
    }
  }
  assert.equal(evaluate(browser(), position(), market('YES', 60, 10, { yes_bid_dollars: .8, yes_ask_dollars: .7 }), signal('YES')).status, 'UNAVAILABLE');
  assert.equal(evaluate(browser(), position(), market('YES', 0), signal('YES')).status, 'UNAVAILABLE');
  assert.equal(evaluate(browser(), position('NO'), market('NO', 0), signal('NO')).status, 'UNAVAILABLE');
});
test('invalid position inputs, missing expiry and stale evaluations are unavailable; expired contract stays expired', () => {
  const b = browser(), p = position(), m = market(), s = signal('YES');
  for (const overrides of [{ entryPrice: null }, { entryPrice: 0 }, { entryPrice: 100 }, { contracts: null },
    { contracts: 1.5 }, { contracts: -1 }, { side: 'invalid' }, { asset: 'invalid' }, { openedAt: null }, { ticker: 'bad ticker' }]) {
    assert.equal(evaluate(b, { ...p, ...overrides }, m, s).status, 'UNAVAILABLE');
  }
  assert.equal(evaluate(b, p, { ...m, close_time: 'bad' }, s).status, 'UNAVAILABLE');
  assert.equal(b.c.positionGuidance(p, m, s, null, start).status, 'UNAVAILABLE');
  assert.equal(b.c.positionGuidance(p, m, s, { id: 1, time: start - 60001 }, start).status, 'UNAVAILABLE');
  assert.equal(evaluate(b, p, market('YES', 90, 0), s).status, 'EXPIRED');
  assert.equal(evaluate(b, p, { ...m, status: 'closed' }, s).status, 'EXPIRED');
  assert.equal(evaluate(b, { ...p, closeTimestamp: start - 1 }, undefined, s).status, 'EXPIRED');
});
test('saving binds exact ticker/expiry, rejects unavailable contract, and preserves global alert preference', () => {
  const b = browser(new Map([['kalshiAlertsEnabled', 'true']]));
  for (const [id, value] of [['positionAsset', 'BTC'], ['positionSide', 'YES'], ['entryPrice', '50'], ['positionSize', '10']]) b.nodes.get(id).value = value;
  b.snapshot(market(), signal('YES'));
  b.nodes.get('savePosition').onclick();
  const saved = b.c.loadPosition();
  assert.equal(saved.ticker, 'KXBTC15M-A'); assert.equal(saved.closeTimestamp, start + 600000);
  assert.equal(b.store.get('kalshiAlertsEnabled'), 'true');
  b.snapshot(market('YES', 60, 10, { yes_bid_dollars: null }), signal('YES'));
  b.nodes.get('savePosition').onclick();
  assert.equal(b.messages.length, 1); assert.equal(b.c.loadPosition().openedAt, saved.openedAt);
  b.nodes.get('clearPosition').onclick(); assert.equal(b.c.loadPosition(), null);
  assert.equal(b.store.get('kalshiAlertsEnabled'), 'true');
});
test('new position identity, save/clear and reload reset pending opposition', () => {
  const b = browser(), p = position(), m = market(), s = signal('YES', true);
  evaluate(b, p, m, s);
  assert.equal(evaluate(b, { ...p, openedAt: start + 30000 }, m, s, start + 30000, 2).status, 'HOLD');
  b.c.savePosition(p);
  assert.equal(evaluate(b, p, m, s, start + 60000, 3).status, 'HOLD');
  b.c.clearSavedPosition();
  assert.equal(evaluate(b, p, m, s, start + 90000, 4).status, 'HOLD');
  assert.equal(evaluate(browser(), p, m, s, start + 90000, 4).status, 'HOLD');
});

test('exact -25/-15/+50/+25%, 2/5-minute and 90-cent boundaries apply equally to YES and NO', () => {
  for (const side of ['YES', 'NO']) {
    const b = browser(), p = position(side), s = signal(side);
    assert.equal(evaluate(b, p, market(side, 37.5), s).status, 'RISK EXIT');
    assert.equal(evaluate(b, p, market(side, 42.5, 2), s).status, 'RISK EXIT');
    assert.equal(evaluate(b, p, market(side, 42.5, 2.001), s).status, 'HOLD');
    assert.equal(evaluate(b, p, market(side, 75), s).status, 'TAKE PROFIT');
    assert.equal(evaluate(b, p, market(side, 62.5, 5), s).status, 'TAKE PROFIT');
    assert.equal(evaluate(b, p, market(side, 62.5, 5.001), s).status, 'HOLD');
    assert.equal(evaluate(b, position(side, { entryPrice: 80 }), market(side, 90), s).status, 'TAKE PROFIT');
    assert.equal(evaluate(b, position(side, { entryPrice: 80 }), market(side, 89.99), s).status, 'HOLD');
  }
});

test('failed refresh invalidates guidance and pending opposition instead of reusing cached quotes', async () => {
  const b = browser(), p = position(), m = market(), s = signal('YES', true);
  b.c.savePosition(p); b.snapshot(m, s); b.c.renderTrackedPosition();
  b.c.console = { error() {}, warn() {} };
  b.c.fetch = async () => { throw new Error('offline'); };
  b.c.resolveSignalOutcomes = () => {};
  await b.c.loadLiveMarkets();
  assert.match(b.nodes.get('positionStatus').textContent, /Fresh live evaluation unavailable/);
  b.snapshot(m, s, start + 30000); b.c.renderTrackedPosition();
  assert.match(b.nodes.get('positionStatus').textContent, /HOLD/);
});

for (const asset of ['BTC', 'ETH', 'SOL']) test(`${asset}: identical manual guidance uses exact ticker`, () => {
  const b = browser(); const ticker = `KX${asset}15M-A`;
  const p = position('YES', { asset, ticker });
  const m = market('YES', 60, 10, { asset, ticker });
  assert.equal(evaluate(b, p, m, signal('YES')).status, 'HOLD');
  assert.equal(evaluate(b, p, { ...m, ticker: `KX${asset}15M-B` }, signal('YES')).status, 'UNAVAILABLE');
  assert.equal(evaluate(b, p, m, signal('YES', true)).status, 'HOLD');
  assert.equal(evaluate(b, p, m, signal('YES', true), start + 30000, 2).status, 'TAKE PROFIT');
});
