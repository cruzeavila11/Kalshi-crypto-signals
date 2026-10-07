import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Kalshi production REST API
const KALSHI =
  "https://external-api.kalshi.com/trade-api/v2";

app.use(express.static("."));

function marketText(market) {
  return [
    market.ticker,
    market.event_ticker,
    market.series_ticker,
    market.title,
    market.subtitle,
    market.yes_sub_title,
    market.no_sub_title
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getAsset(market) {
  const text = marketText(market);

  if (
    text.includes("bitcoin") ||
    text.includes("btc")
  ) {
    return "BTC";
  }

  if (
    text.includes("ethereum") ||
    text.includes("ether") ||
    text.includes("eth")
  ) {
    return "ETH";
  }

  if (
    text.includes("solana") ||
    text.includes("sol")
  ) {
    return "SOL";
  }

  return null;
}

function isCryptoMarket(market) {
  return getAsset(market) !== null;
}

function normalizeMarket(market) {
  return {
    asset: getAsset(market),

    ticker: market.ticker ?? null,
    event_ticker: market.event_ticker ?? null,
    series_ticker: market.series_ticker ?? null,

    title: market.title ?? null,
    subtitle: market.subtitle ?? null,

    yes_bid_dollars:
      market.yes_bid_dollars ?? null,

    yes_ask_dollars:
      market.yes_ask_dollars ?? null,

    last_price_dollars:
      market.last_price_dollars ?? null,

    previous_price_dollars:
      market.previous_price_dollars ?? null,

    volume_fp:
      market.volume_fp ?? null,

    open_interest_fp:
      market.open_interest_fp ?? null,

    liquidity_dollars:
      market.liquidity_dollars ?? null,

    close_time:
      market.close_time ?? null,

    expiration_time:
      market.expiration_time ?? null,

    expected_expiration_time:
      market.expected_expiration_time ?? null,

    status:
      market.status ?? null
  };
}

async function fetchMarketPage(cursor = "") {
  const params = new URLSearchParams();

  params.set("status", "open");
  params.set("limit", "1000");

  if (cursor) {
    params.set("cursor", cursor);
  }

  const url =
    `${KALSHI}/markets?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Kalshi returned ${response.status}: ` +
      body.slice(0, 300)
    );
  }

  return response.json();
}

async function collectMarkets() {
  const allMarkets = [];

  let cursor = "";
  let pages = 0;

  // Safety cap prevents accidental endless pagination.
  while (pages < 20) {
    const data = await fetchMarketPage(cursor);

    const markets =
      Array.isArray(data.markets)
        ? data.markets
        : [];

    allMarkets.push(...markets);

    pages += 1;

    if (!data.cursor || markets.length === 0) {
      break;
    }

    cursor = data.cursor;
  }

  return {
    markets: allMarkets,
    pages
  };
}

// Main read-only crypto endpoint
app.get("/api/markets", async (req, res) => {
  try {
    const result = await collectMarkets();

    const cryptoMarkets =
      result.markets
        .filter(isCryptoMarket)
        .map(normalizeMarket)
        .sort((a, b) => {
          const aTime = new Date(
            a.close_time ||
            a.expiration_time ||
            0
          ).getTime();

          const bTime = new Date(
            b.close_time ||
            b.expiration_time ||
            0
          ).getTime();

          return aTime - bTime;
        });

    res.set("Cache-Control", "no-store");

    res.json({
      source: "Kalshi",
      mode: "READ_ONLY",
      tradingEnabled: false,

      fetchedAt:
        new Date().toISOString(),

      pagesChecked:
        result.pages,

      totalOpenMarketsChecked:
        result.markets.length,

      cryptoMarketsFound:
        cryptoMarkets.length,

      markets:
        cryptoMarkets
    });
  } catch (error) {
    console.error(
      "Kalshi market request failed:",
      error
    );

    res.status(502).json({
      error:
        "Kalshi market data unavailable",

      message:
        error.message,

      mode:
        "READ_ONLY",

      tradingEnabled:
        false,

      markets: []
    });
  }
});

// Temporary read-only diagnostic endpoint.
// This lets us see what Kalshi is actually
// returning if crypto discovery still fails.
app.get("/api/debug-markets", async (req, res) => {
  try {
    const result = await collectMarkets();

    const sample =
      result.markets
        .slice(0, 50)
        .map((market) => ({
          ticker:
            market.ticker ?? null,

          event_ticker:
            market.event_ticker ?? null,

          series_ticker:
            market.series_ticker ?? null,

          title:
            market.title ?? null,

          subtitle:
            market.subtitle ?? null
        }));

    res.set("Cache-Control", "no-store");

    res.json({
      mode: "READ_ONLY",
      tradingEnabled: false,

      pagesChecked:
        result.pages,

      totalOpenMarketsChecked:
        result.markets.length,

      sample
    });
  } catch (error) {
    console.error(
      "Kalshi diagnostic request failed:",
      error
    );

    res.status(502).json({
      error:
        "Kalshi diagnostic failed",

      message:
        error.message,

      mode:
        "READ_ONLY",

      tradingEnabled:
        false
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mode: "READ_ONLY",
    tradingEnabled: false,
    apiBase: KALSHI
  });
});

app.listen(PORT, () => {
  console.log(
    `Read-only Kalshi signal server listening on ${PORT}`
  );
});
