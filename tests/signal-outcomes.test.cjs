const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const signalSource = fs.readFileSync(path.join(__dirname, '../signal-engine.js'), 'utf8');
const now = Date.now();
class FixedDate extends Date { static now() { return now; } }
function browser(store = new Map()) {
  const nodes = new Map(['marketGrid', 'signalFeed', 'signals', 'wins', 'accuracy', 'signalHistoryDetails']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const c = {
    console: { warn() {}, error() {} }, Date: FixedDate, URLSearchParams, AbortSignal,
    document: { querySelector: id => nodes.get(id.slice(1)) || null, getElementById: id => nodes.get(id) || null },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
  };
  vm.createContext(c);
  vm.runInContext(signalSource.replace(/^export /gm, ''), c);
  vm.runInContext(appSource.slice(0, appSource.lastIndexOf('\nrenderTrackedPosition();'))
    .replace(/^import .*;\n/gm, ''), c);
  return { c, nodes, store };
}
function market(ticker = 'BTC-TEST', asset = 'BTC') {
  return { ticker, asset, last_price_dollars: '0.56', previous_price_dollars: '0.50',
    yes_bid_dollars: '0.55', yes_ask_dollars: '0.56', volume_fp: '100000', open_interest_fp: '5000',
    close_time: new Date(now + 10 * 60000).toISOString() };
}
function record(c, ticker, asset, direction, score) {
  c.observeSignal(market(ticker, asset), { label: direction, strength: score }, now);
}
test('correct/incorrect YES and NO, asset/direction/band accuracy, unresolved and invalid exclusion', () => {
  const { c } = browser();
  const examples = [
    ['BTC-A', 'BTC', 'WATCH YES', 75, 'yes', 'correct'],
    ['BTC-B', 'BTC', 'WATCH YES', 85, 'no', 'incorrect'],
    ['ETH-A', 'ETH', 'WATCH NO', 95, 'no', 'correct'],
    ['SOL-A', 'SOL', 'WATCH NO', 95, 'yes', 'incorrect'],
    ['SOL-B', 'SOL', 'WATCH YES', 85, 'unresolved', 'unresolved'],
    ['ETH-B', 'ETH', 'WATCH YES', 75, 'invalid', 'invalid']
  ];
  for (const [ticker, asset, direction, score, outcome] of examples) {
    record(c, ticker, asset, direction, score);
    c.applySignalOutcomes([{ ticker, outcome }], now);
  }
  const observations = c.loadSignalHistory().observations;
  examples.forEach((row, i) => assert.equal(observations[i].outcome, row[5]));
  assert.equal(observations[0].price, 0.56);
  assert.equal(observations[0].openInterest, 5000);
  assert.equal(observations[0].minutesLeft, 10);
  const m = c.calculateSignalMetrics();
  assert.equal(m.overall.total, 6); assert.equal(m.overall.resolved, 4);
  assert.equal(m.overall.correct, 2); assert.equal(m.overall.accuracy, 0.5);
  assert.equal(m.overall.unresolved, 1); assert.equal(m.overall.invalid, 1);
  assert.equal(m.assets.BTC.accuracy, 0.5); assert.equal(m.assets.ETH.accuracy, 1);
  assert.equal(m.assets.SOL.accuracy, 0);
  assert.equal(m.directions['WATCH YES'].accuracy, 0.5);
  assert.equal(m.directions['WATCH NO'].accuracy, 0.5);
  assert.equal(m.bands['70–79'].accuracy, 1);
  assert.equal(m.bands['80–89'].accuracy, 0);
  assert.equal(m.bands['90–100'].accuracy, 0.5);
});
test('unchanged signals deduplicate across refresh/reload; score changes do not spam; reentry and new ticker record', () => {
  let { c, store } = browser();
  for (let i = 0; i < 5; i++) record(c, 'BTC-A', 'BTC', 'WATCH YES', 88 + i);
  assert.equal(c.loadSignalHistory().observations.length, 1);
  c.saveSignalHistory(); c = browser(store).c;
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 90);
  assert.equal(c.loadSignalHistory().observations.length, 1);
  record(c, 'BTC-A', 'BTC', 'WATCH', 49);
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 90);
  record(c, 'BTC-A', 'BTC', 'WATCH NO', 90);
  record(c, 'BTC-B', 'BTC', 'WATCH NO', 90);
  assert.equal(c.loadSignalHistory().observations.length, 4);
  c.applySignalOutcomes([{ ticker: 'BTC-A', outcome: 'yes' }]);
  assert.equal(c.loadSignalHistory().observations[3].outcome, 'unresolved');
});
test('bounded storage, empty metrics and failed storage retain session deduplication', () => {
  const { c } = browser();
  assert.equal(c.calculateSignalMetrics().overall.accuracy, null);
  c.localStorage.getItem = () => { throw Error('blocked'); };
  c.localStorage.setItem = () => { throw Error('quota'); };
  for (let i = 0; i < 510; i++) record(c, `SOL-${i}`, 'SOL', 'WATCH YES', 80);
  c.saveSignalHistory();
  assert.equal(c.loadSignalHistory().observations.length, 500);
  assert.equal(c.loadSignalHistory().states.length, 500);
  record(c, 'SOL-509', 'SOL', 'WATCH YES', 80);
  assert.equal(c.loadSignalHistory().observations.length, 500);
  c.loadSignalHistory().observations[0].timestamp = now - 31 * 86400000;
  c.saveSignalHistory();
  assert.equal(c.loadSignalHistory().observations.length, 499);
});
test('real render path observes before price-history update and fills existing history UI', () => {
  const store = new Map([['kalshiCryptoTickerPriceHistoryV1', JSON.stringify({ version: 1,
    byTicker: { 'BTC-TEST': [{ price: .50, time: now - 60000 }, { price: .52, time: now - 30000 }] }
  })]]);
  const { c, nodes } = browser(store);
  c.renderMarkets([market()]); c.renderMarkets([market()]);
  assert.equal(c.loadSignalHistory().observations.length, 1);
  assert.equal(c.loadSignalHistory().observations[0].evidenceScore, 88);
  assert.equal(nodes.get('signals').textContent, '0'); // Initial ticker is outside the clean benchmark.
  assert.match(nodes.get('signalHistoryDetails').textContent, /BTC-TEST/);
});
test('warm-up reason renders without recording a directional outcome observation', () => {
  const { c, nodes } = browser();
  c.renderMarkets([market()]);
  assert.equal(c.loadSignalHistory().observations.length, 0);
  assert.match(nodes.get('marketGrid').innerHTML, /Warming up new 15-minute contract/);
});
function backend(fetch) {
  let handler;
  const c = { fetch, AbortSignal, KALSHI: 'https://external-api.kalshi.com/trade-api/v2',
    app: { get: (route, callback) => { handler = callback; } } };
  vm.createContext(c);
  vm.runInContext(serverSource.slice(serverSource.indexOf('function classifyMarketOutcome'),
    serverSource.indexOf('app.get("/api/discover-series"')), c);
  return { c, handler };
}
test('rollover gaps display per-asset waiting cards without recording synthetic signals', () => {
  const { c, nodes } = browser();
  c.renderMarkets([market()]);
  assert.match(nodes.get('marketGrid').innerHTML, /ETH/);
  assert.match(nodes.get('marketGrid').innerHTML, /SOL/);
  assert.match(nodes.get('signalFeed').innerHTML, /Waiting for the next usable 15-minute contract/);
  const count = c.loadSignalHistory().observations.length;
  c.renderMarkets([]);
  for (const asset of ['BTC', 'ETH', 'SOL']) assert.match(nodes.get('signalFeed').innerHTML, new RegExp(`${asset}</b>: NO SIGNAL`));
  assert.equal(c.loadSignalHistory().observations.length, count);
});
test('only explicit final binary results resolve; closed, ambiguous, conflicting and wrong identity do not guess', () => {
  const { c } = backend();
  const classify = patch => c.classifyMarketOutcome('BTC-A', { ticker: 'BTC-A', status: 'finalized', result: 'yes', ...patch }).outcome;
  assert.equal(classify({}), 'yes');
  assert.equal(classify({ status: 'settled', result: 'no', settlement_value_dollars: '0.0000' }), 'no');
  assert.equal(classify({ status: 'closed' }), 'unresolved');
  assert.equal(classify({ result: '' }), 'invalid');
  assert.equal(classify({ result: 'scalar' }), 'invalid');
  assert.equal(classify({ settlement_value_dollars: '0.5' }), 'invalid');
  assert.equal(classify({ ticker: 'BTC-B' }), 'invalid');
});
test('read-only endpoint validates input, scopes tickers, and preserves transient API failures as unresolved', async () => {
  const urls = [];
  const { handler } = backend(async url => {
    urls.push(url);
    return url.endsWith('BTC-A') ? { ok: true, json: async () => ({ market: { ticker: 'BTC-A', status: 'finalized', result: 'yes' } }) }
      : { ok: false, status: 429 };
  });
  const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ query: { tickers: '../orders' } }, res);
  assert.equal(res.code, 400); assert.equal(urls.length, 0);
  res.code = 200;
  await handler({ query: { tickers: 'BTC-A,SOL-A,BTC-A' } }, res);
  assert.equal(urls.length, 2); assert.equal(res.body.mode, 'READ_ONLY'); assert.equal(res.body.tradingEnabled, false);
  assert.equal(res.body.outcomes[0].outcome, 'yes'); assert.equal(res.body.outcomes[1].outcome, 'unresolved');
  assert.match(res.body.outcomes[1].lookupError, /429/);
});
test('resolver queries expired ticker, applies outcome, and backs off transient errors', async () => {
  const { c } = browser();
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 88);
  c.loadSignalHistory().observations[0].closeTimestamp = now - 1000;
  let requests = 0;
  c.fetch = async url => { requests++; assert.match(url, /tickers=BTC-A/); return { ok: true, json: async () => ({ outcomes: [{ ticker: 'BTC-A', outcome: 'yes' }] }) }; };
  await c.resolveSignalOutcomes(); await c.resolveSignalOutcomes();
  assert.equal(requests, 1); assert.equal(c.loadSignalHistory().observations[0].outcome, 'correct');
  record(c, 'ETH-A', 'ETH', 'WATCH NO', 88);
  c.loadSignalHistory().observations[1].closeTimestamp = now - 1000;
  c.fetch = async () => { requests++; throw Error('offline'); };
  await c.resolveSignalOutcomes(); await c.resolveSignalOutcomes();
  assert.equal(requests, 2); assert.equal(c.loadSignalHistory().observations[1].outcome, 'unresolved');
});

test('contract accuracy counts first directional observation once despite reentry and reversal', () => {
  const { c, nodes } = browser();
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 75);
  record(c, 'BTC-A', 'BTC', 'WATCH', 49);
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 85);
  record(c, 'BTC-A', 'BTC', 'WATCH NO', 95);
  for (let i = 0; i < 5; i++) record(c, 'BTC-B', 'BTC', 'WATCH YES', 90);
  record(c, 'ETH-A', 'ETH', 'WATCH NO', 85);
  record(c, 'SOL-A', 'SOL', 'WATCH YES', 95);
  record(c, 'SOL-B', 'SOL', 'WATCH NO', 75);
  record(c, 'ETH-B', 'ETH', 'WATCH YES', 80);
  c.applySignalOutcomes([
    { ticker: 'BTC-A', outcome: 'no' }, { ticker: 'BTC-B', outcome: 'yes' },
    { ticker: 'ETH-A', outcome: 'no' }, { ticker: 'SOL-A', outcome: 'yes' },
    { ticker: 'SOL-B', outcome: 'unresolved' }, { ticker: 'ETH-B', outcome: 'invalid' }
  ]);
  const before = JSON.stringify(c.loadSignalHistory().observations);
  const observations = c.calculateSignalMetrics();
  const contracts = c.calculateContractMetrics();
  assert.equal(observations.overall.total, 8); assert.equal(contracts.overall.total, 6);
  assert.equal(observations.overall.resolved, 6); assert.equal(contracts.overall.resolved, 4);
  assert.equal(observations.overall.correct, 4); assert.equal(contracts.overall.correct, 3);
  assert.equal(observations.overall.accuracy, 4 / 6); assert.equal(contracts.overall.accuracy, 3 / 4);
  assert.equal(contracts.overall.unresolved, 1); assert.equal(contracts.overall.invalid, 1);
  assert.equal(contracts.assets.BTC.total, 2); assert.equal(contracts.assets.BTC.accuracy, 0.5);
  assert.equal(contracts.assets.ETH.accuracy, 1); assert.equal(contracts.assets.SOL.accuracy, 1);
  assert.equal(contracts.directions['WATCH YES'].accuracy, 2 / 3);
  assert.equal(contracts.directions['WATCH NO'].accuracy, 1);
  assert.equal(contracts.bands['70–79'].resolved, 1);
  assert.equal(contracts.bands['70–79'].accuracy, 0);
  assert.equal(contracts.bands['80–89'].resolved, 1);
  assert.equal(contracts.bands['80–89'].accuracy, 1);
  assert.equal(contracts.bands['90–100'].resolved, 2);
  assert.equal(contracts.bands['90–100'].accuracy, 1);
  assert.equal(JSON.stringify(c.loadSignalHistory().observations), before);
  c.renderSignalHistory();
  assert.equal(nodes.get('signals').textContent, '3');
  assert.equal(nodes.get('accuracy').textContent, '100.0%');
  assert.match(nodes.get('signalHistoryDetails').textContent, /Current version all observation-level: 66.7%/);
});

test('representative uses earliest timestamp, stable ties, exact ticker and explicit result without mutation', () => {
  const { c } = browser();
  const rows = [
    { ticker: 'SOL-A', timestamp: 20, direction: 'WATCH NO', asset: 'SOL', evidenceScore: 95, outcome: 'incorrect', result: 'yes' },
    { ticker: 'SOL-A', timestamp: 10, direction: 'WATCH YES', asset: 'SOL', evidenceScore: 75, outcome: 'correct', result: 'yes' },
    { ticker: 'SOL-B', timestamp: 10, direction: 'WATCH NO', asset: 'SOL', evidenceScore: 85, outcome: 'correct', result: 'no' },
    { ticker: 'SOL-B', timestamp: 10, direction: 'WATCH YES', asset: 'SOL', evidenceScore: 95, outcome: 'incorrect', result: 'no' }
  ];
  const before = JSON.stringify(rows);
  const m = c.calculateContractMetrics(rows);
  assert.equal(m.overall.total, 2); assert.equal(m.overall.correct, 2);
  assert.equal(m.bands['70–79'].total, 1); assert.equal(m.bands['80–89'].total, 1);
  assert.equal(m.bands['90–100'].total, 0); assert.equal(JSON.stringify(rows), before);
  assert.equal(c.calculateContractMetrics([]).overall.accuracy, null);
  rows[1].result = null;
  assert.equal(c.calculateContractMetrics(rows).overall.invalid, 1);
  assert.equal(c.calculateContractMetrics(rows).overall.resolved, 1);
});

const modelVersion = 'crypto-15m-warmup60-consistency-v1';
test('new observations and states carry policy version; legacy and older states cannot suppress them', () => {
  const legacy = { asset: 'BTC', ticker: 'BTC-A', direction: 'WATCH YES', evidenceScore: 75,
    timestamp: now - 1000, outcome: 'correct', result: 'yes', custom: 'preserve me' };
  const older = { ...legacy, ticker: 'ETH-A', asset: 'ETH', modelVersion: 'old-policy' };
  const original = JSON.stringify([legacy, older]);
  const store = new Map([['kalshiSignalObservationsV1', JSON.stringify({ version: 1,
    observations: [legacy, older], states: [
      { ticker: 'BTC-A', label: 'WATCH YES', timestamp: now - 1000 },
      { ticker: 'ETH-A', label: 'WATCH YES', timestamp: now - 1000, modelVersion: 'old-policy' }
    ] })]]);
  let { c } = browser(store);
  for (const [ticker, asset] of [['BTC-A', 'BTC'], ['ETH-A', 'ETH'], ['SOL-A', 'SOL']]) {
    record(c, ticker, asset, 'WATCH YES', 88);
    record(c, ticker, asset, 'WATCH YES', 90);
  }
  let history = c.loadSignalHistory();
  assert.equal(history.observations.length, 5);
  assert.equal(JSON.stringify(history.observations.slice(0, 2)), original);
  for (const row of history.observations.slice(2)) {
    assert.equal(row.modelVersion, modelVersion); assert.equal(row.benchmarkEligible, false);
  }
  assert.equal(history.states.filter(state => state.modelVersion === modelVersion).length, 3);
  c.saveSignalHistory(); c = browser(store).c;
  record(c, 'BTC-A', 'BTC', 'WATCH YES', 95);
  assert.equal(c.loadSignalHistory().observations.length, 5);
  record(c, 'BTC-A', 'BTC', 'WATCH', 49); record(c, 'BTC-A', 'BTC', 'WATCH YES', 95);
  assert.equal(c.loadSignalHistory().observations.length, 6);
  assert.equal(JSON.stringify(c.loadSignalHistory().observations.slice(0, 2)), original);
});

test('version filtering precedes contract grouping and applies to every metric without mutation', () => {
  const { c } = browser();
  const row = (ticker, asset, direction, evidenceScore, outcome, result, timestamp, version) => ({
    ticker, asset, direction, evidenceScore, outcome, result, timestamp,
    ...(version ? { modelVersion: version, benchmarkEligible: true } : {})
  });
  const rows = [
    row('BTC-A', 'BTC', 'WATCH YES', 75, 'incorrect', 'no', 1),
    row('BTC-A', 'BTC', 'WATCH NO', 95, 'correct', 'no', 2, modelVersion),
    row('BTC-A', 'BTC', 'WATCH YES', 85, 'incorrect', 'no', 3, modelVersion),
    row('ETH-A', 'ETH', 'WATCH YES', 75, 'incorrect', 'no', 4, modelVersion),
    row('SOL-A', 'SOL', 'WATCH YES', 85, 'correct', 'yes', 5, modelVersion),
    row('SOL-B', 'SOL', 'WATCH NO', 95, 'unresolved', null, 6, modelVersion),
    row('ETH-B', 'ETH', 'WATCH YES', 75, 'invalid', null, 7, modelVersion),
    row('BTC-OLD', 'BTC', 'WATCH YES', 95, 'correct', 'yes', 8, 'old-policy')
  ];
  const original = JSON.stringify(rows);
  const options = { modelVersion, benchmarkOnly: true };
  const observations = c.calculateSignalMetrics(rows, options);
  const contracts = c.calculateContractMetrics(rows, options);
  assert.equal(observations.overall.total, 6); assert.equal(observations.overall.accuracy, .5);
  assert.equal(contracts.overall.total, 5); assert.equal(contracts.overall.accuracy, 2 / 3);
  assert.equal(contracts.overall.resolved, 3); assert.equal(contracts.overall.unresolved, 1);
  assert.equal(contracts.overall.invalid, 1);
  assert.equal(observations.assets.BTC.total, 2); assert.equal(observations.assets.BTC.accuracy, .5);
  assert.equal(contracts.assets.BTC.total, 1); assert.equal(contracts.assets.BTC.accuracy, 1);
  assert.equal(contracts.assets.ETH.accuracy, 0); assert.equal(contracts.assets.SOL.accuracy, 1);
  assert.equal(contracts.directions['WATCH YES'].accuracy, .5);
  assert.equal(contracts.directions['WATCH NO'].accuracy, 1);
  assert.equal(observations.directions['WATCH YES'].accuracy, 1 / 3);
  assert.equal(contracts.bands['70–79'].accuracy, 0);
  assert.equal(contracts.bands['80–89'].accuracy, 1);
  assert.equal(contracts.bands['90–100'].accuracy, 1);
  assert.equal(observations.bands['80–89'].accuracy, .5);
  assert.equal(c.calculateContractMetrics(rows, { modelVersion: null }).overall.accuracy, 0);
  assert.equal(c.calculateSignalMetrics(rows, { modelVersion: 'old-policy' }).overall.total, 1);
  assert.equal(c.calculateSignalMetrics(rows, { modelVersion: 'missing' }).overall.accuracy, null);
  assert.equal(c.calculateSignalMetrics(rows).overall.total, 8);
  assert.equal(JSON.stringify(rows), original);
});

test('benchmark excludes initial/older tickers and persists eligibility across reload for BTC ETH SOL', () => {
  const { c, store, nodes } = browser();
  for (const asset of ['BTC', 'ETH', 'SOL']) record(c, `${asset}-INITIAL`, asset, 'WATCH YES', 88);
  c.saveSignalHistory();
  const reloaded = browser(store).c;
  for (const asset of ['BTC', 'ETH', 'SOL']) {
    record(reloaded, `${asset}-INITIAL`, asset, 'WATCH NO', 88);
    record(reloaded, `${asset}-NEXT`, asset, 'WATCH', 49);
    record(reloaded, `${asset}-NEXT`, asset, 'WATCH YES', 88);
    reloaded.applySignalOutcomes([{ ticker: `${asset}-NEXT`, outcome: 'yes' }]);
  }
  const options = { modelVersion, benchmarkOnly: true };
  const history = reloaded.loadSignalHistory();
  assert.equal(reloaded.calculateContractMetrics(history.observations, options).overall.total, 3);
  assert.equal(reloaded.calculateContractMetrics(history.observations, options).overall.accuracy, 1);
  assert.equal(history.modelBenchmarks[modelVersion].initialTickers.BTC, 'BTC-INITIAL');
  const oldTicker = { ...history.observations[0], ticker: 'BTC-SEEN-BEFORE' };
  delete oldTicker.modelVersion; delete oldTicker.benchmarkEligible;
  history.observations.push(oldTicker);
  record(reloaded, 'BTC-SEEN-BEFORE', 'BTC', 'WATCH YES', 88);
  assert.equal(history.observations.at(-1).benchmarkEligible, false);
  reloaded.saveSignalHistory();
  const again = browser(store);
  again.c.renderSignalHistory();
  assert.equal(again.nodes.get('signals').textContent, '3');
  assert.equal(again.nodes.get('accuracy').textContent, '100.0%');
  assert.match(again.nodes.get('signalHistoryDetails').textContent, /Legacy\/unversioned/);
  assert.match(again.nodes.get('signalHistoryDetails').textContent, /Current benchmark/);
  assert.equal(again.c.calculateContractMetrics(again.c.loadSignalHistory().observations, options).overall.total, 3);
});

test('non-directional first sightings establish persistent benchmark exclusions without synthetic observations', () => {
  const { c, store } = browser();
  record(c, 'BTC-INITIAL', 'BTC', 'WATCH', 49);
  assert.equal(c.loadSignalHistory().observations.length, 0);
  c.saveSignalHistory();
  const again = browser(store).c;
  record(again, 'BTC-INITIAL', 'BTC', 'WATCH YES', 88);
  assert.equal(again.loadSignalHistory().observations[0].benchmarkEligible, false);
  record(again, 'BTC-NEXT', 'BTC', 'WATCH', 49);
  again.saveSignalHistory();
  const next = browser(store).c;
  record(next, 'BTC-NEXT', 'BTC', 'WATCH YES', 88);
  assert.equal(next.loadSignalHistory().observations.at(-1).benchmarkEligible, true);
  assert.equal(next.calculateSignalMetrics(next.loadSignalHistory().observations,
    { modelVersion, benchmarkOnly: true }).overall.total, 1);
});
