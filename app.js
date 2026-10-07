const REFRESH_MS = 30000;
const PRICE_HISTORY_KEY = "kalshiCryptoPriceHistory";
const HISTORY_MAX_AGE_MS = 15 * 60 * 1000;

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
  const price = marketPrice(market);
  const previous = previousPrice(market);

  if (!Number.isFinite(price) || !Number.isFinite(previous)) {
    return {
      label: "NO SIGNAL",
      strength: 0,
      css: "neutral",
      reason: "Not enough current market data"
    };
  }

  const move = price - previous;

  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);

  const spread =
    Number.isFinite(bid) && Number.isFinite(ask)
      ? Math.max(0, ask - bid)
      : null;

  const volume = Number(
    market.volume_fp ??
    market.volume ??
    0
  );

  const closeTime =
    market.close_time ??
    market.expiration_time ??
    market.expected_expiration_time;

  const msLeft = closeTime
    ? new Date(closeTime).getTime() - Date.now()
    : NaN;

  const minutesLeft = Number.isFinite(msLeft)
    ? msLeft / 60000
    : NaN;

  if (Number.isFinite(minutesLeft) && minutesLeft <= 0) {
    return {
      label: "NO SIGNAL",
      strength: 0,
      css: "neutral",
      reason: "Market is closing or closed"
    };
  }

  if (spread !== null && spread > 0.08) {
    return {
      label: "NO SIGNAL",
      strength: 0,
      css: "neutral",
      reason: "Bid/ask spread is too wide"
    };
  }

  if (price <= 0.02 || price >= 0.98) {
    return {
      label: "WATCH",
      strength: 25,
      css: "neutral",
      reason: "Price is near an extreme level"
    };
  }

  let score = 0;

  // Momentum: maximum 40 points.
  score += Math.min(
    40,
    Math.round(Math.abs(move) * 400)
  );

  // Tight spreads improve signal quality.
  if (spread !== null) {
    if (spread <= 0.01) {
      score += 25;
    } else if (spread <= 0.03) {
      score += 18;
    } else if (spread <= 0.05) {
      score += 10;
    }
  }

  // More traded markets get more weight.
  if (Number.isFinite(volume)) {
    if (volume >= 100000) {
      score += 20;
    } else if (volume >= 10000) {
      score += 15;
    } else if (volume >= 1000) {
      score += 10;
    } else if (volume > 0) {
      score += 5;
    }
  }

  // Prefer markets with useful time remaining.
  if (Number.isFinite(minutesLeft)) {
    if (minutesLeft >= 2 && minutesLeft <= 15) {
      score += 15;
    } else if (minutesLeft > 15 && minutesLeft <= 30) {
      score += 8;
    } else if (minutesLeft > 0 && minutesLeft < 2) {
      score -= 10;
    }
  }

  score = Math.max(0, Math.min(100, score));

  const strongMove = Math.abs(move) >= 0.05;
  const enoughQuality = score >= 60;

  if (move >= 0.05 && strongMove && enoughQuality) {
    return {
      label: "WATCH YES",
      strength: score,
      css: "up",
      reason:
        "Positive momentum with supportive spread, volume, and timing"
    };
  }

  if (move <= -0.05 && strongMove && enoughQuality) {
    return {
      label: "WATCH NO",
      strength: score,
      css: "down",
      reason:
        "Negative momentum with supportive spread, volume, and timing"
    };
  }

  return {
    label: "WATCH",
    strength: score,
    css: "neutral",
    reason: "Setup does not meet the stronger signal threshold"
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
          <span class="strength">${signal.strength}% signal strength</span>
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

    renderMarkets(markets);
recordMarketPrices(markets);
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

loadEndpoint();
loadLiveMarkets();

setInterval(loadLiveMarkets, REFRESH_MS);
