import { installAuthLifecycle } from "./auth-client.js";
import { scoreSignal, resolvePreviousPrice } from "./signal-engine.js";

const REFRESH_MS = 30000;
let authLifecycle = null;
function authenticatedFetch(...args) {
  return authLifecycle ? authLifecycle.fetch(...args) : fetch(...args);
}

const PRICE_HISTORY_KEY = "kalshiCryptoTickerPriceHistoryV1";
const HISTORY_MAX_AGE_MS = 15 * 60 * 1000;
const HISTORY_MAX_TICKERS = 24;
const POSITION_KEY = "kalshiTrackedPosition";
const POSITION_ALERT_KEY = "kalshiTrackedPositionAlert";
const ALERTS_ENABLED_KEY = "kalshiAlertsEnabled";
let alertsEnabled = loadAlertsEnabled();
let lastPositionAlertState = null;
let positionAlertStateHydrated = false;
let latestMarkets = [];
let positionEvaluation = null;
let positionEvaluationSequence = 0;
let opposingConfirmation = null;
function loadAlertsEnabled() {
  try {
    return localStorage.getItem(ALERTS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function setAlertsEnabled(enabled) {
  alertsEnabled = enabled;
  try {
    localStorage.setItem(ALERTS_ENABLED_KEY, String(enabled));
  } catch (error) {
    console.warn("Unable to persist alert preference:", error);
  }
  renderAlertControl();
}

function renderAlertControl() {
  const button = document.querySelector("#notifyBtn");
  if (button) {
    button.textContent = alertsEnabled ? "Alerts ON" : "Alerts OFF";
    button.setAttribute("aria-pressed", String(alertsEnabled));
  }
}

async function toggleAlerts() {
  if (alertsEnabled) {
    setAlertsEnabled(false);
    return;
  }
  if (typeof Notification === "undefined") {
    alert("This browser does not support notifications.");
    return;
  }
  try {
    const permission = Notification.permission === "granted"
      ? "granted" : await Notification.requestPermission();
    setAlertsEnabled(permission === "granted");
  } catch (error) {
    console.warn("Unable to request notification permission:", error);
    setAlertsEnabled(false);
  }
}
function loadPosition() {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
  } catch {
    return null;
  }
}

function savePosition(position) {
  opposingConfirmation = null;
  localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  resetPositionAlert();
}

function clearSavedPosition() {
  opposingConfirmation = null;
  localStorage.removeItem(POSITION_KEY);
  resetPositionAlert();
}

function resetPositionAlert() {
  lastPositionAlertState = null;
  positionAlertStateHydrated = true;
  try {
    localStorage.removeItem(POSITION_ALERT_KEY);
  } catch (error) {
    console.warn("Unable to reset position alert state:", error);
  }
}

function notifyPositionTransition(position, status, currentCents, pnlDollars, returnPct, reason) {
  const positionId = JSON.stringify([
    position.openedAt, position.asset, position.side,
    position.entryPrice, position.contracts
  ]);

  // Hydrate once; stale persisted data must never replace newer session state.
  if (!positionAlertStateHydrated) {
    positionAlertStateHydrated = true;
    try {
      lastPositionAlertState = JSON.parse(localStorage.getItem(POSITION_ALERT_KEY) || "null");
    } catch (error) {
      console.warn("Unable to read position alert state:", error);
    }
  }

  const previous = lastPositionAlertState;
  if (previous?.positionId === positionId && previous.status === status) return;

  // Record every evaluated status, including HOLD/CLOSED and denied permission.
  // This prevents refresh duplicates while allowing a later transition back.
  lastPositionAlertState = { positionId, status };
  try {
    localStorage.setItem(POSITION_ALERT_KEY, JSON.stringify(lastPositionAlertState));
  } catch (error) {
    console.warn("Unable to persist position alert state:", error);
  }

  if (
    !["TAKE PROFIT", "CLOSE", "RISK EXIT"].includes(status) ||
    !alertsEnabled ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) return;

  const pnlSign = pnlDollars >= 0 ? "+" : "";
  const returnSign = returnPct >= 0 ? "+" : "";
  try {
    new Notification(`${position.asset} ${position.side} • ${status}`, {
      body: `Current ${currentCents.toFixed(1)}¢ • ` +
        `P/L ${pnlSign}$${pnlDollars.toFixed(2)} • ` +
        `Return ${returnSign}${returnPct.toFixed(1)}%` +
        (reason ? ` • ${reason}` : ""),
      tag: `kalshi-position-${positionId}`
    });
  } catch (error) {
    console.warn("Unable to show position notification:", error);
  }
}
function loadPriceHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICE_HISTORY_KEY) || "null");
    if (saved?.version === 1 && saved.byTicker && typeof saved.byTicker === "object" &&
        !Array.isArray(saved.byTicker)) return prunePriceHistory(saved);
  } catch {
    // Legacy asset-keyed data is never read or migrated without ticker identity.
  }
  return { version: 1, byTicker: {} };
}

function prunePriceHistory(history, now = Date.now()) {
  const tickers = Object.entries(history.byTicker).map(([ticker, entries]) => [ticker,
    Array.isArray(entries) ? entries.filter(entry => entry &&
      Number.isFinite(entry.price) && entry.price > 0 && entry.price <= 1 &&
      Number.isFinite(entry.time) && entry.time <= now && now - entry.time <= HISTORY_MAX_AGE_MS
    ).sort((a, b) => a.time - b.time).slice(-30) : []
  ]).filter(([ticker, entries]) => /^[A-Za-z0-9_.-]{1,128}$/.test(ticker) && entries.length).reverse()
    .sort((a, b) => b[1][b[1].length - 1].time - a[1][a[1].length - 1].time)
    .slice(0, HISTORY_MAX_TICKERS);
  return { version: 1, byTicker: Object.fromEntries(tickers) };
}

function savePriceHistory(history) {
  localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(prunePriceHistory(history)));
}

function getStoredPreviousPrice(market) {
  if (typeof market.ticker !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(market.ticker)) return NaN;
  const history = loadPriceHistory();
  const entries = Object.hasOwn(history.byTicker, market.ticker) ? history.byTicker[market.ticker] : [];
  return entries.length ? entries[0].price : NaN;
}

function recordMarketPrices(markets) {
  const history = loadPriceHistory();
  const now = Date.now();

  for (const market of markets) {
    const asset = assetName(market);
    const price = marketPrice(market);

    if (!["BTC", "ETH", "SOL"].includes(asset)) continue;
    if (!Number.isFinite(price) || price <= 0 || price > 1 ||
        typeof market.ticker !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(market.ticker)) continue;

    const entries = Object.hasOwn(history.byTicker, market.ticker) ? history.byTicker[market.ticker] : [];

    entries.push({
      price,
      time: now
    });

    Object.defineProperty(history.byTicker, market.ticker, { value: entries
      .filter((entry) => now - Number(entry.time) <= HISTORY_MAX_AGE_MS)
      .slice(-30), enumerable: true, configurable: true, writable: true });
  }

  savePriceHistory(history);
}
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `${Math.round(n * 100)}¢`;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : "--";
}

function timeLeft(closeTime) {
  if (!closeTime) return "Unknown close time";

  const ms = new Date(closeTime).getTime() - Date.now();

  if (!Number.isFinite(ms)) return "Unknown close time";
  if (ms <= 0) return "Closing/closed";

  const minutes = Math.floor(ms / 60000);

  if (minutes < 60) return `${minutes}m left`;

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours < 24) return `${hours}h ${mins}m left`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h left`;
}

function assetName(market) {
  const text = [
    market.asset,
    market.ticker,
    market.event_ticker,
    market.title,
    market.subtitle
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (text.includes("bitcoin") || text.includes("btc")) return "BTC";
  if (text.includes("ethereum") || text.includes("eth")) return "ETH";
  if (text.includes("solana") || text.includes("sol")) return "SOL";

  return market.asset || "CRYPTO";
}

function marketPrice(market) {
  return Number(
    market.last_price_dollars ??
    market.price ??
    market.yes_ask_dollars ??
    market.yes_bid_dollars
  );
}

function previousPrice(market) {
  return resolvePreviousPrice(market, getStoredPreviousPrice(market));
}

function buildSignal(market) {
  const now = Date.now();
  const signal = scoreSignal(market, previousPrice(market), now);
  if (!["WATCH YES", "WATCH NO"].includes(signal.label)) return signal;

  const history = loadPriceHistory();
  const entries = Object.hasOwn(history.byTicker, market.ticker) ? history.byTicker[market.ticker] : [];
  // Current reading is evaluated before it is stored. Count distinct prior
  // observation times so repeated evaluations at one timestamp cannot warm up.
  const priorTimes = [...new Set(entries.map(entry => entry.time).filter(time => time < now))];
  if (priorTimes.length < 2 || now - priorTimes[0] < 60000) {
    return {
      ...signal,
      label: "WATCH",
      css: "neutral",
      reason: `Warming up new 15-minute contract: need 3 same-ticker observations spanning 60 seconds. ${signal.reason}`
    };
  }

  // Keep the latest price for each distinct prior timestamp. Never include
  // another ticker or count the current evaluation twice.
  const recentByTime = new Map(entries.filter(entry => entry.time < now &&
    now - entry.time <= 120000).map(entry => [entry.time, entry.price]));
  const prices = [...recentByTime.values()].slice(-4).concat(marketPrice(market));
  const direction = signal.label === "WATCH YES" ? 1 : -1;
  const moves = prices.slice(1).map((price, index) => direction * (price - prices[index]));
  const epsilon = 1e-9;
  const aligned = moves.filter(move => move > epsilon);
  const opposing = moves.filter(move => move < -epsilon);
  const support = aligned.reduce((sum, move) => sum + move, 0);
  const opposition = opposing.reduce((sum, move) => sum - move, 0);
  const consistent = prices.length >= 3 && support - opposition > epsilon &&
    aligned.length * 3 >= (aligned.length + opposing.length) * 2 &&
    support + epsilon >= opposition * 3 && moves[moves.length - 1] >= -0.01 - epsilon;
  if (consistent) return signal;

  return {
    ...signal,
    label: "WATCH",
    css: "neutral",
    reason: `Recent price action does not consistently support the longer baseline direction (or recent same-ticker history is insufficient). ${signal.reason}`
  };
}

const SIGNAL_HISTORY_KEY = "kalshiSignalObservationsV1";
// Bump when signal policy changes, including adapter eligibility gates.
const SIGNAL_MODEL_VERSION = "crypto-15m-warmup60-consistency-v1";
const SIGNAL_HISTORY_LIMIT = 500;
const SIGNAL_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OUTCOME_RETRY_MS = 5 * 60 * 1000;
let signalHistory = null;
let outcomeResolutionInFlight = false;

function loadSignalHistory() {
  if (signalHistory) return signalHistory;
  try {
    const saved = JSON.parse(localStorage.getItem(SIGNAL_HISTORY_KEY) || "null");
    if (saved?.version === 1 && Array.isArray(saved.observations) && Array.isArray(saved.states)) {
      signalHistory = saved;
    }
  } catch (error) {
    console.warn("Unable to read signal history:", error);
  }
  signalHistory ||= { version: 1, observations: [], states: [] };
  pruneSignalHistory();
  signalHistory.modelBenchmarks ||= {};
  signalHistory.modelBenchmarks[SIGNAL_MODEL_VERSION] ||= {
    startedAt: Date.now(), initialTickers: {}
  };
  return signalHistory;
}

function pruneSignalHistory(now = Date.now()) {
  signalHistory.observations = signalHistory.observations.filter(record =>
    record && typeof record.ticker === "string" &&
    ["WATCH YES", "WATCH NO"].includes(record.direction) &&
    ["correct", "incorrect", "unresolved", "invalid"].includes(record.outcome) &&
    Number.isFinite(record.evidenceScore) && record.evidenceScore >= 0 && record.evidenceScore <= 100 &&
    Number.isFinite(record.timestamp) && record.timestamp >= now - SIGNAL_HISTORY_AGE_MS
  ).slice(-SIGNAL_HISTORY_LIMIT);
  signalHistory.states = signalHistory.states.filter(state =>
    state && typeof state.ticker === "string" && Number.isFinite(state.timestamp) &&
    state.timestamp >= now - SIGNAL_HISTORY_AGE_MS
  ).slice(-SIGNAL_HISTORY_LIMIT);
}

function saveSignalHistory() {
  pruneSignalHistory();
  try {
    localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify(signalHistory));
  } catch (error) {
    // Session memory stays authoritative even if persistence fails.
    console.warn("Unable to persist signal history:", error);
  }
}

function observeSignal(market, signal, now = Date.now()) {
  const history = loadSignalHistory();
  const ticker = market.ticker;
  if (typeof ticker !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(ticker)) return;
  const asset = assetName(market);
  const benchmark = history.modelBenchmarks[SIGNAL_MODEL_VERSION];
  if (["BTC", "ETH", "SOL"].includes(asset) && !Object.hasOwn(benchmark.initialTickers, asset)) {
    benchmark.initialTickers[asset] = ticker;
  }
  // Initial contracts and tickers already observed by another policy are not
  // clean benchmark contracts. Do not modify or relabel their older records.
  const olderTicker = history.observations.some(record => record.ticker === ticker &&
    record.modelVersion !== SIGNAL_MODEL_VERSION) || history.states.some(state =>
    state.ticker === ticker && state.modelVersion !== SIGNAL_MODEL_VERSION);
  const priorObservation = history.observations.find(record => record.ticker === ticker &&
    record.modelVersion === SIGNAL_MODEL_VERSION);
  const previous = history.states.find(state => state.ticker === ticker &&
    state.modelVersion === SIGNAL_MODEL_VERSION);
  const priorEligibility = priorObservation || previous;
  const benchmarkEligible = priorEligibility ? priorEligibility.benchmarkEligible === true :
    ["BTC", "ETH", "SOL"].includes(asset) && benchmark.initialTickers[asset] !== ticker && !olderTicker;
  const changed = previous?.label !== signal.label;
  history.states = history.states.filter(state => state.ticker !== ticker ||
    state.modelVersion !== SIGNAL_MODEL_VERSION);
  history.states.push({ modelVersion: SIGNAL_MODEL_VERSION, benchmarkEligible, ticker, label: signal.label, timestamp: now });
  if (!changed || !["WATCH YES", "WATCH NO"].includes(signal.label)) return;

  const numeric = value => value === null || value === undefined || String(value).trim() === "" ||
    !Number.isFinite(Number(value)) ? null : Number(value);
  const bid = numeric(market.yes_bid_dollars);
  const ask = numeric(market.yes_ask_dollars);
  const closeTime = market.close_time ?? market.expiration_time ?? market.expected_expiration_time;
  const closeTimestamp = closeTime ? new Date(closeTime).getTime() : NaN;
  history.observations.push({
    modelVersion: SIGNAL_MODEL_VERSION, benchmarkEligible,
    asset, ticker, direction: signal.label,
    evidenceScore: signal.strength, price: numeric(marketPrice(market)),
    yesBid: bid, yesAsk: ask,
    volume: numeric(market.volume_fp ?? market.volume),
    openInterest: numeric(market.open_interest_fp ?? market.open_interest),
    spread: bid !== null && ask !== null && ask >= bid ? ask - bid : null,
    minutesLeft: Number.isFinite(closeTimestamp) ? (closeTimestamp - now) / 60000 : null,
    closeTimestamp: Number.isFinite(closeTimestamp) ? closeTimestamp : null,
    timestamp: now, outcome: "unresolved", result: null, nextCheckAt: 0
  });
}

function applySignalOutcomes(outcomes, now = Date.now()) {
  const history = loadSignalHistory();
  for (const result of outcomes) {
    for (const record of history.observations) {
      if (record.ticker !== result.ticker || record.outcome !== "unresolved") continue;
      record.checkedAt = now;
      record.nextCheckAt = now + OUTCOME_RETRY_MS;
      record.lookupError = result.lookupError || null;
      record.outcomeReason = result.reason || "Awaiting a reliable result.";
      if (result.outcome === "invalid") {
        record.outcome = "invalid";
      } else if (["yes", "no"].includes(result.outcome)) {
        record.result = result.outcome;
        record.outcome = (record.direction === "WATCH YES") === (result.outcome === "yes")
          ? "correct" : "incorrect";
        record.resolvedAt = now;
      }
    }
  }
  saveSignalHistory();
}

function filterSignalRecords(records, { modelVersion, benchmarkOnly = false } = {}) {
  return records.filter(record =>
    (modelVersion === undefined || (modelVersion === null
      ? !record.modelVersion : record.modelVersion === modelVersion)) &&
    (!benchmarkOnly || record.benchmarkEligible === true));
}

function calculateSignalMetrics(records = loadSignalHistory().observations, options = {}) {
  records = filterSignalRecords(records, options);
  const summarize = rows => {
    const correct = rows.filter(row => row.outcome === "correct").length;
    const incorrect = rows.filter(row => row.outcome === "incorrect").length;
    const resolved = correct + incorrect;
    return { total: rows.length, correct, incorrect, resolved,
      unresolved: rows.filter(row => row.outcome === "unresolved").length,
      invalid: rows.filter(row => row.outcome === "invalid").length,
      accuracy: resolved ? correct / resolved : null };
  };
  return {
    overall: summarize(records),
    assets: Object.fromEntries(["BTC", "ETH", "SOL"].map(asset =>
      [asset, summarize(records.filter(row => row.asset === asset))])),
    directions: Object.fromEntries(["WATCH YES", "WATCH NO"].map(direction =>
      [direction, summarize(records.filter(row => row.direction === direction))])),
    bands: Object.fromEntries([[70, 79], [80, 89], [90, 100]].map(([low, high]) =>
      [`${low}–${high}`, summarize(records.filter(row => row.evidenceScore >= low && row.evidenceScore <= high))]))
  };
}

function calculateContractMetrics(records = loadSignalHistory().observations, options = {}) {
  records = filterSignalRecords(records, options);
  const representatives = new Map();
  // First directional observation in retained history wins; equal timestamps
  // retain insertion order. Later transitions cannot change direction or band.
  for (const record of records) {
    if (!["WATCH YES", "WATCH NO"].includes(record.direction)) continue;
    const first = representatives.get(record.ticker);
    if (!first || record.timestamp < first.timestamp) representatives.set(record.ticker, record);
  }
  return calculateSignalMetrics([...representatives.values()].map(record => {
    let outcome = record.outcome;
    if (["correct", "incorrect"].includes(outcome)) {
      outcome = ["yes", "no"].includes(record.result)
        ? ((record.direction === "WATCH YES") === (record.result === "yes") ? "correct" : "incorrect")
        : "invalid";
    }
    return { ...record, outcome };
  }));
}

function renderSignalHistory() {
  const history = loadSignalHistory();
  pruneSignalHistory();
  const current = { modelVersion: SIGNAL_MODEL_VERSION, benchmarkOnly: true };
  const metrics = calculateSignalMetrics(history.observations, current);
  const contracts = calculateContractMetrics(history.observations, current);
  const percentage = value => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  for (const [id, value] of [["signals", contracts.overall.total], ["wins", contracts.overall.correct],
    ["accuracy", percentage(contracts.overall.accuracy)]]) {
    const node = document.getElementById(id);
    if (node) node.textContent = String(value);
  }
  const details = document.getElementById("signalHistoryDetails");
  if (details) {
    const lines = [`Current benchmark: ${SIGNAL_MODEL_VERSION}. First observed contract per asset excluded; later new tickers only.`];
    for (const [label, view] of [["Current benchmark contract-level", contracts], ["Current benchmark observation-level", metrics],
      ["Current version all contract-level", calculateContractMetrics(history.observations, { modelVersion: SIGNAL_MODEL_VERSION })],
      ["Current version all observation-level", calculateSignalMetrics(history.observations, { modelVersion: SIGNAL_MODEL_VERSION })],
      ["Legacy/unversioned contract-level", calculateContractMetrics(history.observations, { modelVersion: null })],
      ["Legacy/unversioned observation-level", calculateSignalMetrics(history.observations, { modelVersion: null })]]) {
      lines.push(`${label}: ${percentage(view.overall.accuracy)} (${view.overall.correct}/${view.overall.resolved} resolved correct); total: ${view.overall.total}; unresolved: ${view.overall.unresolved}; invalid/unusable: ${view.overall.invalid}`);
      for (const group of [view.assets, view.directions, view.bands]) {
        for (const [name, data] of Object.entries(group)) {
          lines.push(`${name}: ${percentage(data.accuracy)} (${data.correct}/${data.resolved} resolved correct)`);
        }
      }
    }
    lines.push("Recent observations:");
    for (const record of history.observations.slice(-10).reverse()) {
      lines.push(`${new Date(record.timestamp).toLocaleString()} · ${record.asset} ${record.ticker} · ${record.direction} · ${record.evidenceScore}/100 · ${record.outcome} · ${record.modelVersion || "legacy/unversioned"}${record.benchmarkEligible === true ? " · benchmark" : ""}`);
    }
    details.textContent = lines.join("\n");
  }
}

async function resolveSignalOutcomes() {
  if (outcomeResolutionInFlight) return;
  const now = Date.now();
  const history = loadSignalHistory();
  const tickers = [...new Set(history.observations.filter(record => record.outcome === "unresolved" &&
    (record.closeTimestamp === null || record.closeTimestamp <= now) && (record.nextCheckAt || 0) <= now
  ).map(record => record.ticker))].slice(0, 20);
  if (!tickers.length) return;
  outcomeResolutionInFlight = true;
  // Back off on transient failures; never turn a failed request into a loss.
  applySignalOutcomes(tickers.map(ticker => ({ ticker, outcome: "unresolved" })), now);
  try {
    const response = await authenticatedFetch(`/api/market-outcomes?${new URLSearchParams({ tickers: tickers.join(",") })}`, {
      cache: "no-store", signal: AbortSignal.timeout(330000)
    });
    if (!response.ok) throw new Error(`Outcome endpoint returned ${response.status}`);
    const data = await response.json();
    if (authLifecycle && !authLifecycle.isActive()) return;
    if (!Array.isArray(data.outcomes)) throw new Error("Invalid outcome response");
    applySignalOutcomes(data.outcomes.filter(result => result && tickers.includes(result.ticker)));
  } catch (error) {
    console.warn("Signal outcomes remain unresolved:", error);
  } finally {
    outcomeResolutionInFlight = false;
    renderSignalHistory();
  }
}

function renderMarkets(markets) {
  const grid = document.querySelector("#marketGrid");
  const feed = document.querySelector("#signalFeed");

  if (!grid || !feed) return;

  markets = Array.isArray(markets) ? markets : [];
  const missingAssets = ["BTC", "ETH", "SOL"].filter(asset =>
    !markets.some(market => assetName(market) === asset));
  const waitingReason = "Waiting for the next usable 15-minute contract.";

  grid.innerHTML = markets.map(market => {
    const price = marketPrice(market);
    const previous = previousPrice(market);
    const signal = buildSignal(market);

    observeSignal(market, signal);

    const change =
      Number.isFinite(price) && Number.isFinite(previous)
        ? (price - previous) * 100
        : null;

    return `
      <article class="card market">
        <div class="marketTop">
          <div>
            <div class="coin">${assetName(market)}</div>
            <div class="ticker">${market.ticker || "Unknown ticker"}</div>
          </div>
          <div class="muted">
            ${timeLeft(
              market.close_time ||
              market.expiration_time ||
              market.expected_expiration_time
            )}
          </div>
        </div>

        <div class="price">${money(price)}</div>

        <div class="change ${signal.css}">
          ${
            change === null
              ? "Previous price unavailable"
              : `${change >= 0 ? "+" : ""}${change.toFixed(1)}¢ vs prior`
          }
        </div>

        <div class="signal">
          <strong class="${signal.css}">${signal.label}</strong>
          <span class="strength">${signal.strength}/100 evidence score</span>
        </div>

        <div class="muted">${signal.reason}</div>

        <div class="muted">
          YES bid ${money(market.yes_bid_dollars)}
          · YES ask ${money(market.yes_ask_dollars)}
          · Volume ${number(market.volume_fp ?? market.volume)}
        </div>
      </article>
    `;
  }).join("") + missingAssets.map(asset => `
    <article class="card market">
      <div class="coin">${asset}</div>
      <div class="signal"><strong class="neutral">NO SIGNAL</strong></div>
      <div class="muted">${waitingReason}</div>
    </article>
  `).join("");

  feed.innerHTML = markets.map(market => {
    const signal = buildSignal(market);

    return `
      <div class="feedItem">
        <b>${assetName(market)}</b>:
        ${signal.label} —
        ${signal.reason}
      </div>
    `;
  }).join("") + missingAssets.map(asset => `
    <div class="feedItem"><b>${asset}</b>: NO SIGNAL — ${waitingReason}</div>
  `).join("");
  saveSignalHistory();
  renderSignalHistory();
}

function showStatus(text) {
  const status = document.querySelector("#statusText");
  if (status) status.textContent = text;
}

async function loadLiveMarkets() {
  showStatus("Loading live data…");

  try {
    const response = await authenticatedFetch("/api/markets", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();
    if (authLifecycle && !authLifecycle.isActive()) return;

    const markets = Array.isArray(data)
      ? data
      : Array.isArray(data.markets)
        ? data.markets
        : [];
latestMarkets = markets;
    evaluatePositionMarkets(markets);
    renderMarkets(markets);
recordMarketPrices(markets);
    renderTrackedPosition();
    if (markets.length > 0) {
      showStatus("LIVE");
    } else {
      showStatus("NO LIVE MARKETS");
    }
  } catch (error) {
    positionEvaluation = null;
    opposingConfirmation = null;
    renderTrackedPosition();
    console.error("Live market request failed:", error);

    showStatus("DATA UNAVAILABLE");

    const grid = document.querySelector("#marketGrid");

    if (grid) {
      grid.innerHTML = `
        <article class="card market">
          <div class="coin">Live data unavailable</div>
          <div class="muted">
            The dashboard could not reach the market-data server.
            No demo prices are being substituted.
          </div>
        </article>
      `;
    }
  } finally {
    void resolveSignalOutcomes();
  }
}

function loadEndpoint() {
  const endpoint = document.querySelector("#endpoint");

  if (endpoint) {
    endpoint.value =
      localStorage.getItem("kalshiSignalEndpoint") || "";
  }
}

const saveEndpoint = document.querySelector("#saveEndpoint");

if (saveEndpoint) {
  saveEndpoint.onclick = () => {
    const endpoint = document.querySelector("#endpoint");
    const message = document.querySelector("#endpointMsg");
    const value = endpoint ? endpoint.value.trim() : "";

    localStorage.setItem("kalshiSignalEndpoint", value);

    if (message) {
      message.textContent = value
        ? "Saved on this device."
        : "Cleared.";
    }
  };
}

const notifyButton = document.querySelector("#notifyBtn");

if (notifyButton) {
  notifyButton.onclick = toggleAlerts;
  renderAlertControl();
}
const savePositionButton = document.querySelector("#savePosition");
const clearPositionButton = document.querySelector("#clearPosition");
const positionStatus = document.querySelector("#positionStatus");

function positionNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" ||
      typeof value === "object" || String(value).trim() === "") return NaN;
  return Number(value);
}

function validTrackedPosition(position) {
  return position && ["BTC", "ETH", "SOL"].includes(position.asset) &&
    ["YES", "NO"].includes(position.side) &&
    typeof position.ticker === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(position.ticker) &&
    Number.isFinite(positionNumber(position.entryPrice)) &&
    positionNumber(position.entryPrice) > 0 && positionNumber(position.entryPrice) < 100 &&
    Number.isSafeInteger(positionNumber(position.contracts)) && positionNumber(position.contracts) > 0 &&
    Number.isSafeInteger(positionNumber(position.openedAt)) && positionNumber(position.openedAt) > 0;
}

function executablePositionPrice(market, side) {
  const bid = positionNumber(market.yes_bid_dollars);
  const ask = positionNumber(market.yes_ask_dollars);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask > 1 ||
      ask < bid) return NaN;
  const price = side === "YES" ? bid : 1 - ask;
  return price > 0 && price <= 1 ? price : NaN;
}

// One evaluation per successful market response, before price history changes.
// Rendering/saving a position cannot manufacture additional evaluations.
function evaluatePositionMarkets(markets, now = Date.now()) {
  positionEvaluation = { id: ++positionEvaluationSequence, time: now,
    signals: new Map(markets.map(market => [market.ticker, buildSignal(market)])) };
}

function positionGuidance(position, market, signal, evaluation, now = Date.now()) {
  const unavailable = reason => {
    opposingConfirmation = null;
    return { status: "UNAVAILABLE", reason };
  };
  if (!position?.ticker) return unavailable("Legacy position has no ticker. Clear and re-save it against the correct contract; identity cannot be inferred.");
  if (!validTrackedPosition(position) || positionNumber(position.openedAt) > now) {
    return unavailable("Invalid tracked position inputs. Clear and re-save the position.");
  }
  const savedClose = positionNumber(position.closeTimestamp);
  if (!market) {
    if (Number.isFinite(savedClose) && savedClose <= now) {
      opposingConfirmation = null;
      return { status: "EXPIRED", reason: "Tracked contract expired; awaiting verified settlement. No new contract is substituted." };
    }
    return unavailable("Exact tracked ticker is unavailable. No other contract is substituted.");
  }
  if (market.ticker !== position.ticker || assetName(market) !== position.asset ||
      (market.asset && market.asset !== position.asset)) {
    return unavailable("Market identity does not match the tracked ticker and asset.");
  }
  const close = market.close_time ?? market.expiration_time ?? market.expected_expiration_time;
  const closeTimestamp = close ? new Date(close).getTime() : NaN;
  if (!Number.isFinite(closeTimestamp)) return unavailable("Valid contract expiry is unavailable.");
  if (closeTimestamp <= now || (market.status && !["open", "active"].includes(market.status))) {
    opposingConfirmation = null;
    return { status: "EXPIRED", reason: "Tracked contract is expired or inactive; awaiting verified settlement. This does not mean the position was manually closed." };
  }
  if (!evaluation || !Number.isFinite(evaluation.time) || !Number.isInteger(evaluation.id) ||
      evaluation.id <= 0 || evaluation.time > now || now - evaluation.time > REFRESH_MS * 2) {
    return unavailable("Fresh live evaluation unavailable; waiting for the next successful refresh.");
  }
  const current = executablePositionPrice(market, position.side);
  if (!Number.isFinite(current)) return unavailable("Valid executable bid/ask data unavailable. Last-price estimates are not used for exit guidance.");
  const currentCents = current * 100;
  const contracts = positionNumber(position.contracts);
  const entry = positionNumber(position.entryPrice);
  const pnlDollars = (currentCents - entry) * contracts / 100;
  // Remove binary floating-point noise at the unchanged percentage boundaries.
  const returnPct = Number(((currentCents - entry) / entry * 100).toFixed(10));
  const minutesLeft = (closeTimestamp - now) / 60000;
  const score = positionNumber(signal?.strength);
  const directional = signal && ["WATCH YES", "WATCH NO"].includes(signal.label) &&
    Number.isFinite(score) && score >= 0 && score <= 100;
  const opposite = directional && ((position.side === "YES" && signal.label === "WATCH NO") ||
    (position.side === "NO" && signal.label === "WATCH YES"));
  const strongOpposite = opposite && score >= 80;
  const identity = JSON.stringify([position.ticker, position.openedAt, position.asset,
    position.side, position.entryPrice, position.contracts]);
  if (!strongOpposite) opposingConfirmation = null;
  else if (!opposingConfirmation || opposingConfirmation.identity !== identity) {
    opposingConfirmation = { identity, lastTime: Math.max(evaluation.time, positionNumber(position.openedAt)), lastId: evaluation.id, confirmed: false };
  } else if (opposingConfirmation.lastId !== evaluation.id) {
    // Same snapshot/render is ignored; qualifying later refresh confirms at 30s.
    opposingConfirmation.confirmed ||= evaluation.time - opposingConfirmation.lastTime >= 30000;
    opposingConfirmation.lastTime = evaluation.time;
    opposingConfirmation.lastId = evaluation.id;
  }
  const confirmed = strongOpposite && opposingConfirmation?.confirmed === true;
  const relation = !signal || signal.label === "NO SIGNAL" || !Number.isFinite(score)
    ? "missing signal" : opposite ? (strongOpposite ? "opposing signal" : "weak opposing signal")
    : directional ? "supporting signal" : "neutral signal";
  let status = "HOLD";
  let rule = "No exit rule met";
  if (returnPct <= -25) { status = "RISK EXIT"; rule = "Return at or below -25%"; }
  else if (returnPct <= -15 && (minutesLeft <= 2 || confirmed)) {
    status = "RISK EXIT"; rule = minutesLeft <= 2 ? "Moderate loss with at most 2 minutes remaining" : "Moderate loss with confirmed opposition";
  } else if (returnPct > 0 && (returnPct >= 50 || currentCents >= 90 ||
      minutesLeft <= 2 || (minutesLeft <= 5 && returnPct >= 25))) {
    status = "TAKE PROFIT";
    rule = returnPct >= 50 ? "Return at or above +50%" : currentCents >= 90 ? "Profitable contract value at or above 90¢"
      : minutesLeft <= 2 ? "Positive return with at most 2 minutes remaining" : "At least +25% return with at most 5 minutes remaining";
  } else if (confirmed) {
    status = returnPct > 0 ? "TAKE PROFIT" : "CLOSE";
    rule = "Confirmed opposing evidence at least 80 across evaluations spanning 30 seconds";
  }
  const confirmation = strongOpposite ? (confirmed ? "confirmed" : "unconfirmed; waiting for a later evaluation") : "cleared/not applicable";
  return { status, currentCents, pnlDollars, returnPct, positionValue: current * contracts,
    reason: `${rule}. Gross P/L ${pnlDollars >= 0 ? "+" : ""}$${pnlDollars.toFixed(2)}; return ${returnPct.toFixed(1)}%; ${minutesLeft.toFixed(1)}m remaining; ${relation}${signal?.label ? ` (${signal.label})` : ""}; evidence ${Number.isFinite(score) ? `${score}/100 (not a probability)` : "unavailable"}; opposition ${confirmation}. Manual guidance; fees excluded.` };
}

function renderTrackedPosition() {
  const position = loadPosition();
  if (!position) {
    opposingConfirmation = null;
    if (positionStatus) positionStatus.textContent = "No position currently being tracked.";
    return;
  }
  const market = latestMarkets.find(item => item.ticker === position.ticker);
  const guidance = positionGuidance(position, market,
    positionEvaluation?.signals.get(position.ticker), positionEvaluation);
  if (["UNAVAILABLE", "EXPIRED"].includes(guidance.status)) {
    if (positionStatus) positionStatus.textContent = `${guidance.status === "EXPIRED" ? "Expired" : "Guidance unavailable"} — ${guidance.reason}`;
    return;
  }
  notifyPositionTransition(position, guidance.status, guidance.currentCents,
    guidance.pnlDollars, guidance.returnPct, guidance.reason);
  if (positionStatus) {
    // Position identity and reasons are text, not interpolated HTML.
    positionStatus.textContent = `${position.asset} ${position.side} • ${position.ticker} • ` +
      `Entry ${Number(position.entryPrice).toFixed(1)}¢ • Current ${guidance.currentCents.toFixed(1)}¢ • ` +
      `${position.contracts} contracts • Value $${guidance.positionValue.toFixed(2)} • ` +
      `${guidance.status} — ${guidance.reason}`;
  }
}

if (savePositionButton) {
  savePositionButton.onclick = () => {
    const asset = document.querySelector("#positionAsset")?.value;
    const side = document.querySelector("#positionSide")?.value;
    const entryPrice = Number(document.querySelector("#entryPrice")?.value);
    const contracts = Number(document.querySelector("#positionSize")?.value);

    if (
      !["BTC", "ETH", "SOL"].includes(asset) ||
      !["YES", "NO"].includes(side) ||
      !Number.isFinite(entryPrice) ||
      entryPrice <= 0 ||
      entryPrice >= 100 ||
      !Number.isSafeInteger(contracts) ||
      contracts <= 0
    ) {
      alert("Please enter a valid asset, side, entry price, and contract count.");
      return;
    }

    const market = latestMarkets.find(item => assetName(item) === asset);
    const close = market?.close_time ?? market?.expiration_time ?? market?.expected_expiration_time;
    const closeTimestamp = close ? new Date(close).getTime() : NaN;
    if (!market || typeof market.ticker !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(market.ticker) ||
        (market.asset && market.asset !== asset) ||
        !Number.isFinite(closeTimestamp) || closeTimestamp <= Date.now() ||
        (market.status && !["open", "active"].includes(market.status)) ||
        !Number.isFinite(executablePositionPrice(market, side)) || !positionEvaluation ||
        Date.now() - positionEvaluation.time > REFRESH_MS * 2) {
      alert("Cannot save: a fresh active exact contract with executable quotes is required.");
      return;
    }
    savePosition({
      ticker: market.ticker,
      closeTimestamp,
      asset,
      side,
      entryPrice,
      contracts,
      openedAt: Date.now()
    });

    renderTrackedPosition();
  };
}

if (clearPositionButton) {
  clearPositionButton.onclick = () => {
    clearSavedPosition();

    const entryPriceInput = document.querySelector("#entryPrice");
    const positionSizeInput = document.querySelector("#positionSize");

    if (entryPriceInput) entryPriceInput.value = "";
    if (positionSizeInput) positionSizeInput.value = "";

    renderTrackedPosition();
  };
}

let marketRefreshTimer;
renderTrackedPosition();
authLifecycle = installAuthLifecycle(() => {
  clearInterval(marketRefreshTimer);
  latestMarkets = [];
  positionEvaluation = null;
  opposingConfirmation = null;
});
renderSignalHistory();
loadEndpoint();
if (await authLifecycle.check()) {
  loadLiveMarkets();
  marketRefreshTimer = setInterval(loadLiveMarkets, REFRESH_MS);
}
