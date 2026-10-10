const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = import('../signal-engine.js');
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const legacySource = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-signal-scorer.txt'), 'utf8');
const now = Date.now();
class FixedDate extends Date { static now() { return now; } }
const close = minutes => new Date(now + minutes * 60000).toISOString();
function market(ticker = 'BTC-A', asset = 'BTC') {
  return { ticker, asset, last_price_dollars: '0.56', previous_price_dollars: '0.50',
    yes_bid_dollars: '0.55', yes_ask_dollars: '0.56', volume_fp: '100000', close_time: close(10) };
}
async function browser(store = new Map()) {
  const exports = await engine;
  const c = { ...exports, Date: FixedDate, console, URLSearchParams, AbortSignal,
    document: { querySelector: () => null, getElementById: () => null },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
  };
  vm.createContext(c);
  vm.runInContext(appSource.slice(0, appSource.lastIndexOf('\nrenderTrackedPosition();'))
    .replace(/^import .*;\n/gm, ''), c);
  return { c, store };
}
test('shared scorer and browser adapter exactly match pre-extraction scorer across existing scenarios', async () => {
  const { scoreSignal, resolvePreviousPrice } = await engine;
  const legacy = { Date: FixedDate, previousPrice: m => resolvePreviousPrice(m) };
  vm.createContext(legacy); vm.runInContext(legacySource, legacy);
  const { c } = await browser();
  const cases = [
    [{}, 'WATCH YES', 88],
    [{ last_price_dollars: '0.44', yes_bid_dollars: '0.43', yes_ask_dollars: '0.44' }, 'WATCH NO', 88],
    [{ last_price_dollars: '0.51' }, 'WATCH', 49],
    [{ last_price_dollars: '0.98', previous_price_dollars: '0.94', yes_bid_dollars: '0.97', yes_ask_dollars: '0.98' }, 'WATCH', 59],
    [{ last_price_dollars: '0.98', previous_price_dollars: '0.86', yes_bid_dollars: '0.97', yes_ask_dollars: '0.98' }, 'WATCH YES', 90],
    [{ volume_fp: '100' }, 'WATCH', 49],
    [{ yes_bid_dollars: '0.45' }, 'WATCH', 49],
    [{ yes_bid_dollars: undefined, yes_ask_dollars: undefined }, 'WATCH', 49],
    [{ volume_fp: undefined }, 'WATCH', 49], [{ close_time: undefined }, 'WATCH', 49],
    [{ previous_price_dollars: undefined }, 'NO SIGNAL', 0],
    [{ last_price_dollars: undefined, yes_bid_dollars: undefined, yes_ask_dollars: undefined }, 'NO SIGNAL', 0],
    [{ last_price_dollars: '1.5' }, 'NO SIGNAL', 0],
    [{ yes_bid_dollars: '0.60', yes_ask_dollars: '0.55' }, 'NO SIGNAL', 0],
    [{ close_time: close(1) }, 'WATCH', 49], [{ close_time: close(-1) }, 'NO SIGNAL', 0]
  ];
  for (const [over, label, strength] of cases) {
    const m = market(); Object.assign(m, over);
    const original = JSON.parse(JSON.stringify(legacy.buildSignal(m)));
    assert.deepEqual(scoreSignal(m, resolvePreviousPrice(m), now), original);
    assert.deepEqual(c.buildSignal(m), original);
    assert.equal(original.label, label); assert.equal(original.strength, strength);
  }
  for (const minutes of [1, 2, 5, 15, 30]) for (const bearish of [false, true]) {
    const m = { ...market(), close_time: close(minutes), ...(bearish ?
      { last_price_dollars: '0.44', yes_bid_dollars: '0.43', yes_ask_dollars: '0.44' } : {}) };
    const original = JSON.parse(JSON.stringify(legacy.buildSignal(m)));
    assert.deepEqual(c.buildSignal(m), original);
    assert.equal(original.label, minutes === 1 ? 'WATCH' : bearish ? 'WATCH NO' : 'WATCH YES');
    assert.equal(original.strength, minutes === 1 ? 49 : minutes === 30 ? 83 : 88);
  }
});
for (const asset of ['BTC', 'ETH', 'SOL']) test(`${asset}: ticker A never supplies ticker B baseline; same ticker survives reload`, async () => {
  let { c, store } = await browser();
  const a = { ...market(`${asset}-A`, asset), last_price_dollars: '0.50', previous_price_dollars: undefined };
  c.recordMarketPrices([a]);
  const b = { ...market(`${asset}-B`, asset), previous_price_dollars: undefined };
  assert.ok(Number.isNaN(c.previousPrice(b)));
  assert.equal(c.buildSignal(b).label, 'NO SIGNAL');
  assert.equal(c.buildSignal({ ...b, previous_price_dollars: '0.50' }).label, 'WATCH YES');
  c = (await browser(store)).c;
  const same = { ...a, last_price_dollars: '0.56' };
  assert.equal(c.previousPrice(same), 0.50);
  assert.equal(c.buildSignal(same).label, 'WATCH YES');
  assert.ok(Number.isNaN(c.previousPrice(b)));
  c.recordMarketPrices([{ ...b, last_price_dollars: '0.53' }]);
  assert.equal(c.previousPrice(b), 0.53); assert.equal(c.previousPrice(same), 0.50);
});
test('legacy asset history is ignored, malformed history is safe, and ticker storage is bounded', async () => {
  const legacy = JSON.stringify({ BTC: [{ price: 0.1, time: now }], ETH: [{ price: 0.1, time: now }], SOL: [{ price: 0.1, time: now }] });
  const store = new Map([['kalshiCryptoPriceHistory', legacy]]);
  const { c } = await browser(store);
  for (const asset of ['BTC', 'ETH', 'SOL']) {
    assert.equal(c.buildSignal({ ...market(`${asset}-NEW`, asset), previous_price_dollars: undefined }).label, 'NO SIGNAL');
  }
  store.set('kalshiCryptoTickerPriceHistoryV1', legacy);
  assert.ok(Number.isNaN(c.previousPrice({ ...market(), previous_price_dollars: undefined })));
  store.set('kalshiCryptoTickerPriceHistoryV1', '{bad');
  for (let i = 0; i < 30; i++) c.recordMarketPrices([market(`BTC-${i}`)]);
  for (let i = 0; i < 40; i++) c.recordMarketPrices([market('BTC-LAST')]);
  let saved = JSON.parse(store.get('kalshiCryptoTickerPriceHistoryV1'));
  assert.ok(Object.keys(saved.byTicker).length <= 24); assert.equal(saved.byTicker['BTC-LAST'].length, 30);
  saved.byTicker.STALE = [{ price: 0.1, time: now - 16 * 60000 }];
  saved.byTicker.FUTURE = [{ price: 0.1, time: now + 60000 }];
  saved.byTicker.INVALID = [{ price: 1.5, time: now }];
  store.set('kalshiCryptoTickerPriceHistoryV1', JSON.stringify(saved));
  for (const ticker of ['STALE', 'FUTURE', 'INVALID']) assert.ok(Number.isNaN(c.getStoredPreviousPrice({ ticker })));
  assert.equal(store.get('kalshiCryptoPriceHistory'), legacy);
});
test('scorer has explicit time and baseline inputs, is repeatable, and does not mutate market data', async () => {
  const { scoreSignal, resolvePreviousPrice } = await engine;
  const m = { ...market(), previous_price_dollars: undefined };
  const before = JSON.stringify(m);
  assert.equal(scoreSignal(m, 0.50, now).label, 'WATCH YES');
  assert.equal(scoreSignal(m, NaN, now).label, 'NO SIGNAL');
  assert.equal(scoreSignal(m, 0.50, now + 20 * 60000).label, 'NO SIGNAL');
  assert.deepEqual(scoreSignal(m, 0.50, now), scoreSignal(m, 0.50, now));
  assert.equal(resolvePreviousPrice({ previous_price_dollars: '0.51' }, 0.4), 0.51);
  assert.equal(resolvePreviousPrice({ previous_price_dollars: '0' }, 0.4), 0.4);
  assert.equal(JSON.stringify(m), before);
  const source = fs.readFileSync(path.join(__dirname, '../signal-engine.js'), 'utf8');
  assert.doesNotMatch(source, /Date\.now|localStorage|document\./);
});
