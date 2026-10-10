const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const now = Date.now();
class FixedDate extends Date { static now() { return now; } }
function setup() {
  const c = { Date: FixedDate, console };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function selectUsableSolMarket'), source.indexOf('app.get("/api/health"')), c);
  return c;
}
function market(asset, suffix = 'NEXT') {
  return { asset, ticker: `KX${asset}15M-${suffix}`, status: 'active',
    open_time: new Date(now - 60000).toISOString(), close_time: new Date(now + 10 * 60000).toISOString(),
    last_price_dollars: '0.50', yes_bid_dollars: '0.49', yes_ask_dollars: '0.50', volume_fp: '1000', open_interest_fp: '100' };
}
for (const asset of ['BTC', 'ETH', 'SOL']) test(`${asset}: strict series, expired/future rejection, gap and automatic resumption`, async () => {
  const c = setup();
  const old = { ...market(asset, 'OLD'), close_time: new Date(now - 1000).toISOString() };
  const hourly = { ...market(asset), ticker: `KX${asset}E-HOURLY` };
  assert.equal(c.selectFifteenMinuteMarket([old, hourly], asset, now), null);
  assert.equal(c.selectFifteenMinuteMarket([{ ...market(asset), open_time: new Date(now + 60000).toISOString() }], asset, now), null);
  assert.equal(c.selectFifteenMinuteMarket([{ ...market(asset), status: 'closed' }], asset, now), null);
  assert.equal(c.selectFifteenMinuteMarket([old, market(asset), hourly], asset, now).ticker, `KX${asset}15M-NEXT`);
  let available = false;
  const calls = [];
  c.fetchOpenMarketsForSeries = async series => {
    calls.push(series.ticker);
    return series.asset === asset ? (available ? [old, market(asset)] : [old, hourly]) : [market(series.asset)];
  };
  let result = await c.findBestLiveMarkets();
  assert.ok(!result.markets.some(m => m.asset === asset));
  assert.deepEqual(calls, ['KXBTC15M', 'KXETH15M', 'KXSOL15M']);
  available = true; result = await c.findBestLiveMarkets();
  assert.equal(result.markets.find(m => m.asset === asset).ticker, `KX${asset}15M-NEXT`);
  assert.equal(result.markets.length, 3);
});
test('SOL unusable 15-minute contract never triggers another-duration fallback', async () => {
  const c = setup();
  c.fetchOpenMarketsForSeries = async series => [series.asset === 'SOL'
    ? { ...market('SOL'), volume_fp: '0' } : market(series.asset)];
  const result = await c.findBestLiveMarkets();
  assert.equal(result.markets.length, 2);
  assert.equal(c.selectFifteenMinuteMarket([market('SOL')], 'SOL', now).ticker, 'KXSOL15M-NEXT');
});
test('cached markets are refreshed when a contract expires, even inside cache TTL', async () => {
  let handler, refreshed = 0;
  const c = { Date: FixedDate, CACHE_MS: 30000,
    marketCache: { time: now - 1000, data: { markets: [{ ...market('ETH'), close_time: new Date(now).toISOString() }] } },
    findBestLiveMarkets: async () => { refreshed++; return { markets: [] }; },
    app: { get: (_, fn) => { handler = fn; } }, console };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('app.get("/api/markets"'), source.indexOf('function classifyMarketOutcome')), c);
  const res = { set() {}, json(data) { this.data = data; }, status() { return this; } };
  await handler({}, res);
  assert.equal(refreshed, 1); assert.equal(res.data.markets.length, 0);
  assert.equal(res.data.mode, 'READ_ONLY'); assert.equal(res.data.tradingEnabled, false);
});
