import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const KALSHI =
  "https://external-api.kalshi.com/trade-api/v2";

app.use(express.static("."));

const CACHE_MS = 30_000;
const SERIES_CACHE_MS = 10 * 60_000;

let marketCache = {
  time: 0,
  data: null
};

let seriesCache = {
  time: 0,
  data: []
};

function getAsset(series) {
  const ticker = String(series.ticker || "").toUpperCase();

  const tags = Array.isArray(series.tags)
    ? series.tags.map(tag => String(tag).toUpperCase())
    : [];

  if (
    tags.includes("BTC") ||
    ticker === "BTC" ||
    ticker.startsWith("KXBTC")
  ) {
    return "BTC";
  }

  if (
    tags.includes("ETH") ||
    ticker === "ETH" ||
    ticker.startsWith("KXETH")
  ) {
    return "ETH";
  }

  if (
    tags.includes("SOL") ||
    ticker === "SOL" ||
    ticker.startsWith("KXSOL")
  ) {
    return "SOL";
  }

  return null;
}

function frequencyScore(series) {
  const frequency =
    String(series.frequency || "").toLowerCase();

  const ticker =
    String(series.ticker || "").toUpperCase();

  const title =
    String(series.title || "").toLowerCase();

  let score = 0;

  // Prefer short-term recurring markets.
  if (
    frequency.includes("15") ||
    ticker.includes("15M") ||
    title.includes("15 min") ||
    title.includes("15-minute")
  ) {
    score += 100;
  }

  if (
    frequency.includes("hour") ||
    title.includes("hour")
  ) {
    score += 80;
  }

  if (
    frequency.includes("daily") ||
    frequency === "day" ||
    title.includes("daily")
  ) {
    score += 60;
  }

  // Prefer actual price/range markets.
  if (
    title.includes("price") ||
    title.includes("range") ||
    title.includes("above") ||
    title.includes("below") ||
    title.includes("up or down") ||
    title.includes("up/down")
  ) {
    score += 30;
  }

  // De-prioritize long-term/special-event markets.
  if (
    frequency.includes("annual") ||
    frequency.includes("monthly") ||
    frequency.includes("quarter")
  ) {
    score -= 50;
  }

  if (
    title.includes("election") ||
    title.includes("inauguration") ||
    title.includes("reserve") ||
    title.includes("purchase") ||
    title.includes("legalization")
  ) {
    score -= 100;
  }

  return score;
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Kalshi request failed: ${response.status}`
    );
  }

  return response.json();
}

async function discoverCryptoSeries() {
  if (
    seriesCache.data.length &&
    Date.now() - seriesCache.time < SERIES_CACHE_MS
  ) {
    return seriesCache.data;
  }

  const data = await fetchJSON(`${KALSHI}/series`);

  const series = Array.isArray(data.series)
    ? data.series
    : [];

  const matches = series
    .filter(item => {
      const category =
        String(item.category || "").toLowerCase();

      return (
        category === "crypto" &&
        getAsset(item) !== null
      );
    })
    .map(item => ({
      ...item,
      asset: getAsset(item),
      score: frequencyScore(item)
    }))
    .sort((a, b) => b.score - a.score);

  seriesCache = {
    time: Date.now(),
    data: matches
  };

  return matches;
}

async function fetchOpenMarketsForSeries(series) {
  const params = new URLSearchParams({
    status: "open",
    series_ticker: series.ticker,
    limit: "1000"
  });

  const data = await fetchJSON(
    `${KALSHI}/markets?${params.toString()}`
  );

  const markets = Array.isArray(data.markets)
    ? data.markets
    : [];

  return markets.map(market => ({
    ...market,
    asset: series.asset,
    series_ticker:
      market.series_ticker || series.ticker,
    series_title: series.title || null,
    series_frequency: series.frequency || null
  }));
}

function selectUsableSolMarket(markets, now = Date.now()) {
  const number = value =>
    value === null || value === undefined || String(value).trim() === ""
      ? NaN : Number(value);
  const candidates = markets.map(market => {
    const bid = number(market.yes_bid_dollars);
    const ask = number(market.yes_ask_dollars);
    const price = number(market.last_price_dollars ?? market.price);
    const volume = number(market.volume_fp ?? market.volume);
    const recentVolume = number(market.volume_24h_fp ?? market.volume_24h);
    const interest = number(market.open_interest_fp ?? market.open_interest);
    const minutesLeft = (new Date(
      market.close_time || market.expected_expiration_time || market.expiration_time
    ).getTime() - now) / 60000;

    if (
      !["active", "open"].includes(market.status) ||
      !Number.isFinite(bid) || !Number.isFinite(ask) ||
      bid <= 0 || ask >= 1 || ask < bid || ask - bid > 0.08 + 1e-9 ||
      !Number.isFinite(price) || price <= 0 || price >= 1 ||
      !Number.isFinite(volume) || volume <= 0 ||
      !Number.isFinite(minutesLeft) || minutesLeft <= 0 || minutesLeft > 24 * 60
    ) return null;

    return {
      market,
      // Prefer the signal window, then other short horizons, then near expiry.
      timeRank: minutesLeft >= 2 && minutesLeft <= 30 ? 0 :
        minutesLeft > 30 && minutesLeft <= 180 ? 1 : minutesLeft < 2 ? 2 : 3,
      minutesLeft,
      spread: ask - bid,
      recentVolume: Number.isFinite(recentVolume) && recentVolume >= 0 ? recentVolume : volume,
      interest: Number.isFinite(interest) && interest >= 0 ? interest : 0,
      volume
    };
  }).filter(Boolean);

  candidates.sort((a, b) =>
    a.timeRank - b.timeRank ||
    b.recentVolume - a.recentVolume ||
    a.spread - b.spread ||
    b.interest - a.interest ||
    b.volume - a.volume ||
    a.minutesLeft - b.minutesLeft ||
    String(a.market.ticker).localeCompare(String(b.market.ticker))
  );
  return candidates[0]?.market || null;
}

async function findBestLiveMarkets() {
  const cryptoSeries = await discoverCryptoSeries();

  const selected = [];

  for (const asset of ["BTC", "ETH", "SOL"]) {
    const candidates = cryptoSeries
      .filter(series => series.asset === asset)
      .sort((a, b) => asset === "SOL"
        ? Number(b.ticker === "KXSOL15M") - Number(a.ticker === "KXSOL15M") || b.score - a.score
        : 0)
      .slice(0, 12);

    let assetMarkets = [];

    for (const series of candidates) {
      try {
        const markets =
          await fetchOpenMarketsForSeries(series);

        if (asset === "SOL") {
          const market = selectUsableSolMarket(markets);
          if (!market) continue;
          assetMarkets = [market];
          break;
        }

        if (markets.length > 0) {
      assetMarkets = markets
  .sort((a, b) => {
    const aTime = new Date(
      a.close_time || a.expiration_time || 0
    ).getTime();

    const bTime = new Date(
      b.close_time || b.expiration_time || 0
    ).getTime();

    return aTime - bTime;
  })
  .slice(0, 1);
          break;
        }
      } catch (error) {
        console.error(
          `Series ${series.ticker}:`,
          error.message
        );
      }
    }

    selected.push(...assetMarkets);
  }

  return {
    cryptoSeries,
    markets: selected
  };
}

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    ok: true,
    mode: "READ_ONLY",
    tradingEnabled: false
  });
});

app.get("/api/markets", async (req, res) => {
  try {
    if (
      marketCache.data &&
      Date.now() - marketCache.time < CACHE_MS
    ) {
      return res.json(marketCache.data);
    }

    const result = await findBestLiveMarkets();

    const counts = {
      BTC: result.markets.filter(
        market => market.asset === "BTC"
      ).length,

      ETH: result.markets.filter(
        market => market.asset === "ETH"
      ).length,

      SOL: result.markets.filter(
        market => market.asset === "SOL"
      ).length
    };

    const response = {
      source: "Kalshi",
      mode: "READ_ONLY",
      tradingEnabled: false,
      fetchedAt: new Date().toISOString(),
      counts,
      cryptoMarketsFound: result.markets.length,
      markets: result.markets
    };

    marketCache = {
      time: Date.now(),
      data: response
    };

    res.set("Cache-Control", "no-store");
    res.json(response);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to load Kalshi markets",
      mode: "READ_ONLY",
      tradingEnabled: false,
      details: error.message
    });
  }
});

function classifyMarketOutcome(ticker, market) {
  if (!market || market.ticker !== ticker) {
    return { ticker, outcome: "invalid", reason: "Market identity mismatch." };
  }
  if (!["finalized", "settled"].includes(market.status)) {
    return { ticker, outcome: "unresolved", reason: "Awaiting an explicit final result." };
  }
  const result = String(market.result || "").toLowerCase();
  const settlement = market.settlement_value_dollars;
  if (
    !["yes", "no"].includes(result) ||
    (settlement !== undefined && settlement !== null &&
      (String(settlement).trim() === "" || Number(settlement) !== (result === "yes" ? 1 : 0)))
  ) {
    return { ticker, outcome: "invalid", reason: "Final result is missing, nonbinary, or inconsistent." };
  }
  return { ticker, outcome: result, reason: "Explicit final Kalshi result." };
}

app.get("/api/market-outcomes", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const raw = req.query.tickers;
  const tickers = typeof raw === "string" ? [...new Set(raw.split(","))] : [];
  if (!tickers.length || tickers.length > 20 ||
      tickers.some(ticker => !/^[A-Za-z0-9_.-]{1,128}$/.test(ticker))) {
    return res.status(400).json({ error: "Supply 1–20 valid market tickers.", mode: "READ_ONLY", tradingEnabled: false });
  }
  const outcomes = [];
  for (const ticker of tickers) {
    try {
      const response = await fetch(`${KALSHI}/markets/${encodeURIComponent(ticker)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`);
      const data = await response.json();
      outcomes.push(classifyMarketOutcome(ticker, data.market));
    } catch (error) {
      // Network failures/404s are not evidence of a losing or invalid signal.
      outcomes.push({ ticker, outcome: "unresolved", reason: "Outcome lookup failed; will retry.", lookupError: error.message });
    }
  }
  res.json({ mode: "READ_ONLY", tradingEnabled: false, outcomes });
});

app.get("/api/discover-series", async (req, res) => {
  try {
    const matches = await discoverCryptoSeries();

    res.set("Cache-Control", "no-store");

    res.json({
      mode: "READ_ONLY",
      tradingEnabled: false,
      cryptoSeriesFound: matches.length,
      matches: matches.map(series => ({
        asset: series.asset,
        ticker: series.ticker,
        title: series.title,
        category: series.category,
        tags: series.tags,
        frequency: series.frequency,
        priorityScore: series.score
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      mode: "READ_ONLY",
      tradingEnabled: false
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Kalshi Crypto Signals running on port ${PORT}`
  );

  console.log(
    "READ_ONLY mode — trading is disabled."
  );
});
