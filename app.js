const REFRESH_MS = 30000;
const PRICE_HISTORY_KEY = "kalshiCryptoPriceHistory";
const HISTORY_MAX_AGE_MS = 15 * 60 * 1000;
const POSITION_KEY = "kalshiTrackedPosition";
const POSITION_ALERT_KEY = "kalshiTrackedPositionAlert";
let lastPositionAlertState = null;
let positionAlertStateHydrated = false;
let latestMarkets = [];
function loadPosition() {
  try {
    return JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
  } catch {
    return null;
  }
}

function savePosition(position) {
  localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  resetPositionAlert();
}

function clearSavedPosition() {
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
    return JSON.parse(localStorage.getItem(PRICE_HISTORY_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePriceHistory(history) {
  localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(history));
}

function getStoredPreviousPrice(market) {
  const asset = assetName(market);
  const history = loadPriceHistory();
  const entries = Array.isArray(history[asset]) ? history[asset] : [];
  const now = Date.now();

  const valid = entries.filter(
    (entry) =>
      Number.isFinite(Number(entry.price)) &&
      now - Number(entry.time) <= HISTORY_MAX_AGE_MS
  );

  if (valid.length === 0) return NaN;

  return Number(valid[0].price);
}

function recordMarketPrices(markets) {
  const history = loadPriceHistory();
  const now = Date.now();

  for (const market of markets) {
    const asset = assetName(market);
    const price = marketPrice(market);

    if (!["BTC", "ETH", "SOL"].includes(asset)) continue;
    if (!Number.isFinite(price) || price <= 0) continue;

    const entries = Array.isArray(history[asset]) ? history[asset] : [];

    entries.push({
      price,
      time: now
    });

    history[asset] = entries
      .filter((entry) => now - Number(entry.time) <= HISTORY_MAX_AGE_MS)
      .slice(-30);
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
  const raw =
    market.previous_price_dollars ??
    market.previousPrice;

  if (raw !== null && raw !== undefined && raw !== "") {
    const previous = Number(raw);

    if (Number.isFinite(previous) && previous > 0) {
      return previous;
    }
  }

  return getStoredPreviousPrice(market);
}

function buildSignal(market) {
  const usableNumber = (value) => {
    if (value === null || value === undefined || String(value).trim() === "") return NaN;
    return Number(value);
  };
  const price = usableNumber(
    market.last_price_dollars ?? market.price ??
    market.yes_ask_dollars ?? market.yes_bid_dollars
  );
  const previous = previousPrice(market);
  const noSignal = (reason) => ({ label: "NO SIGNAL", strength: 0, css: "neutral", reason });

  if (
    !Number.isFinite(price) || price < 0 || price > 1 ||
    !Number.isFinite(previous) || previous < 0 || previous > 1
  ) return noSignal("Insufficient or invalid current/previous market prices.");

  const bid = usableNumber(market.yes_bid_dollars);
  const ask = usableNumber(market.yes_ask_dollars);
  const validQuote = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (Number.isFinite(bid) && Number.isFinite(ask) &&
      (!validQuote(bid) || !validQuote(ask) || ask < bid)) {
    return noSignal("Invalid or crossed bid/ask quotes.");
  }
  const spread = validQuote(bid) && validQuote(ask) ? ask - bid : null;
  const rawVolume = usableNumber(market.volume_fp ?? market.volume);
  const volume = Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : null;
  const closeTime = market.close_time ?? market.expiration_time ?? market.expected_expiration_time;
  const minutesLeft = closeTime ? (new Date(closeTime).getTime() - Date.now()) / 60000 : NaN;
  if (Number.isFinite(minutesLeft) && minutesLeft <= 0) {
    return noSignal("Market is closing or closed.");
  }

  const move = price - previous;
  const magnitude = Math.abs(move);
  // Explicit evidence weights total 100; this is not a win probability.
  const momentumPoints = Math.round(Math.min(1, magnitude / 0.10) * 30);
  const spreadPoints = spread === null ? 0 :
    spread <= 0.01 + 1e-9 ? 25 : spread <= 0.03 + 1e-9 ? 18 :
    spread <= 0.05 + 1e-9 ? 8 : 0;
  const volumePoints = volume === null ? 0 :
    volume >= 100000 ? 20 : volume >= 10000 ? 14 : volume >= 1000 ? 8 : 0;
  const timingPoints = !Number.isFinite(minutesLeft) ? 0 :
    minutesLeft >= 2 && minutesLeft <= 15 ? 15 :
    minutesLeft > 15 && minutesLeft <= 30 ? 10 : minutesLeft > 30 ? 5 : 0;
  const extreme = price <= 0.05 || price >= 0.95;
  const pricePoints = extreme ? 0 : price <= 0.10 || price >= 0.90 ? 5 : 10;
  let score = momentumPoints + spreadPoints + volumePoints + timingPoints + pricePoints;

  const missing = spread === null || volume === null || !Number.isFinite(minutesLeft);
  const supportive = magnitude >= 0.03 - 1e-9 && spread !== null &&
    spread <= 0.03 + 1e-9 && volume !== null && volume >= 1000 &&
    Number.isFinite(minutesLeft) && minutesLeft >= 2 && minutesLeft <= 30;
  const exceptional = supportive && magnitude >= 0.10 - 1e-9 &&
    spread <= 0.01 + 1e-9 && volume >= 100000 && minutesLeft <= 15;

  // Missing data or a failed quality gate must not imply strong evidence.
  if (missing || !supportive) score = Math.min(score, 49);
  if (extreme && !exceptional) score = Math.min(score, 59);
  const directional = supportive && score >= (extreme ? 85 : 70) && (!extreme || exceptional);
  const label = directional ? (move > 0 ? "WATCH YES" : "WATCH NO") : "WATCH";
  const factors = [
    `Momentum ${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}¢ (${momentumPoints}/30)`,
    spread === null ? "spread unavailable (0/25)" : `spread ${(spread * 100).toFixed(1)}¢ (${spreadPoints}/25)`,
    volume === null ? "volume unavailable (0/20)" : `volume ${volume.toLocaleString()} (${volumePoints}/20)`,
    !Number.isFinite(minutesLeft) ? "timing unavailable (0/15)" : `${minutesLeft.toFixed(1)}m remaining (${timingPoints}/15)`,
    `${extreme ? "extreme" : pricePoints === 5 ? "near-extreme" : "non-extreme"} pricing (${pricePoints}/10)`
  ];
  const summary = directional ? "Directional evidence gates met." :
    missing ? "Missing data caps evidence; watch only." :
    extreme && !exceptional ? "Extreme pricing lacks exceptional support; watch only." :
    !supportive ? "Weak momentum, spread, volume or timing; watch only." :
    "Combined evidence below directional threshold; watch only.";
  return {
    label,
    strength: score,
    css: directional ? (move > 0 ? "up" : "down") : "neutral",
    reason: `${summary} ${factors.join("; ")}. Internal evidence score, not a win probability.`
  };
}

function renderMarkets(markets) {
  const grid = document.querySelector("#marketGrid");
  const feed = document.querySelector("#signalFeed");

  if (!grid || !feed) return;

  if (!Array.isArray(markets) || markets.length === 0) {
    grid.innerHTML = `
      <article class="card market">
        <div class="coin">No live crypto markets found</div>
        <div class="muted">
          Waiting for BTC, ETH or SOL markets from the server.
        </div>
      </article>
    `;

    feed.innerHTML = `
      <div class="feedItem">
        No signals generated because no live markets were returned.
      </div>
    `;

    return;
  }

  grid.innerHTML = markets.map(market => {
    const price = marketPrice(market);
    const previous = previousPrice(market);
    const signal = buildSignal(market);

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
  }).join("");

  feed.innerHTML = markets.map(market => {
    const signal = buildSignal(market);

    return `
      <div class="feedItem">
        <b>${assetName(market)}</b>:
        ${signal.label} —
        ${signal.reason}
      </div>
    `;
  }).join("");
}

function showStatus(text) {
  const status = document.querySelector("#statusText");
  if (status) status.textContent = text;
}

async function loadLiveMarkets() {
  showStatus("Loading live data…");

  try {
    const response = await fetch("/api/markets", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();

    const markets = Array.isArray(data)
      ? data
      : Array.isArray(data.markets)
        ? data.markets
        : [];
latestMarkets = markets;
    renderMarkets(markets);
recordMarketPrices(markets);
    renderTrackedPosition();
    if (markets.length > 0) {
      showStatus("LIVE");
    } else {
      showStatus("NO LIVE MARKETS");
    }
  } catch (error) {
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
  notifyButton.onclick = async () => {
    if (!("Notification" in window)) {
      alert("This browser does not support notifications.");
      return;
    }

    const permission = await Notification.requestPermission();

    notifyButton.textContent =
      permission === "granted"
        ? "Alerts Enabled"
        : "Alerts Not Enabled";
  };
}
const savePositionButton = document.querySelector("#savePosition");
const clearPositionButton = document.querySelector("#clearPosition");
const positionStatus = document.querySelector("#positionStatus");

function renderTrackedPosition() {
  const position = loadPosition();

  if (!position) {
    if (positionStatus) {
      positionStatus.textContent =
        "No position currently being tracked.";
    }
    return;
  }

  const market = latestMarkets.find(
    (item) => assetName(item) === position.asset
  );

  if (!market) {
    if (positionStatus) {
      positionStatus.textContent =
        `${position.asset} ${position.side} • Entry ${position.entryPrice}¢ • ` +
        `${position.contracts} contracts • Waiting for live market data`;
    }
    return;
  }

  const yesBid = Number(market.yes_bid_dollars);
  const yesAsk = Number(market.yes_ask_dollars);
  const fallbackYes = marketPrice(market);

  let currentDollars;

  if (position.side === "YES") {
    currentDollars =
      Number.isFinite(yesBid)
        ? yesBid
        : fallbackYes;
  } else {
    currentDollars =
      Number.isFinite(yesAsk)
        ? 1 - yesAsk
        : 1 - fallbackYes;
  }

  if (!Number.isFinite(currentDollars)) {
    if (positionStatus) {
      positionStatus.textContent =
        `${position.asset} ${position.side} • Live position price unavailable`;
    }
    return;
  }

  currentDollars = Math.max(0, Math.min(1, currentDollars));

  const currentCents = currentDollars * 100;
  const entryCents = Number(position.entryPrice);
  const contracts = Number(position.contracts);

  const pnlCentsPerContract = currentCents - entryCents;
  const pnlDollars =
    (pnlCentsPerContract * contracts) / 100;

  const positionValue =
    (currentCents * contracts) / 100;

  const costBasis =
    (entryCents * contracts) / 100;

  const returnPct =
    costBasis > 0
      ? (pnlDollars / costBasis) * 100
      : 0;

  const closeTime =
    market.close_time ??
    market.expiration_time ??
    market.expected_expiration_time;

  const minutesLeft = closeTime
    ? (new Date(closeTime).getTime() - Date.now()) / 60000
    : NaN;

  const signal = buildSignal(market);

  const oppositeSignal =
    (position.side === "YES" && signal.label === "WATCH NO") ||
    (position.side === "NO" && signal.label === "WATCH YES");

  const nearExpiry =
  Number.isFinite(minutesLeft) && minutesLeft <= 5;

const veryNearExpiry =
  Number.isFinite(minutesLeft) && minutesLeft <= 2;

const strongProfit = returnPct >= 50;
const goodProfit = returnPct >= 25;
const seriousLoss = returnPct <= -25;
const moderateLoss = returnPct <= -15;

const nearMaxValue = currentCents >= 90;

let status = "HOLD";
let reason =
  "Position remains within the current risk and profit conditions.";

if (Number.isFinite(minutesLeft) && minutesLeft <= 0) {
  status = "CLOSED";
  reason = "The tracked market has reached its closing time.";

} else if (seriousLoss) {
  status = "RISK EXIT";
  reason =
    "Loss has crossed the maximum current risk threshold.";

} else if (oppositeSignal && moderateLoss) {
  status = "RISK EXIT";
  reason =
    "The position is losing value and the live signal has reversed.";

} else if (oppositeSignal) {
  status = "CLOSE";
  reason =
    "The live signal has reversed against the tracked position.";

} else if (strongProfit) {
  status = "TAKE PROFIT";
  reason =
    "A large unrealized gain has developed.";

} else if (nearMaxValue && goodProfit) {
  status = "TAKE PROFIT";
  reason =
    "The contract is near its maximum value with a meaningful gain.";

} else if (veryNearExpiry && returnPct > 0) {
  status = "TAKE PROFIT";
  reason =
    "Very little time remains and the position is currently profitable.";

} else if (nearExpiry && goodProfit) {
  status = "TAKE PROFIT";
  reason =
    "The position has a meaningful gain with limited time remaining.";

} else {
  status = "HOLD";
  reason =
    "No exit condition currently outweighs the case for holding.";
}

  const pnlSign = pnlDollars >= 0 ? "+" : "";

  notifyPositionTransition(position, status, currentCents, pnlDollars, returnPct, reason);

  if (positionStatus) {
    positionStatus.innerHTML = `
      <div class="feedItem">
        <b>${position.asset} ${position.side}</b> •
        Entry ${entryCents.toFixed(0)}¢ •
        Current ${currentCents.toFixed(1)}¢ •
        ${contracts} contracts
      </div>

      <div class="feedItem">
        Value $${positionValue.toFixed(2)} •
        P/L ${pnlSign}$${pnlDollars.toFixed(2)} •
        Return ${pnlSign}${returnPct.toFixed(1)}%
      </div>

      <div class="feedItem">
        <b>${status}</b> — ${reason}
      </div>
    `;
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
      !Number.isFinite(contracts) ||
      contracts <= 0
    ) {
      alert("Please enter a valid asset, side, entry price, and contract count.");
      return;
    }

    savePosition({
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

renderTrackedPosition();
loadEndpoint();
loadLiveMarkets();

setInterval(loadLiveMarkets, REFRESH_MS);
