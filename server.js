import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const KALSHI =
  "https://api.elections.kalshi.com/trade-api/v2";

app.use(express.static("."));

function isCryptoMarket(market) {
  const text = [
    market.ticker,
    market.event_ticker,
    market.title,
    market.subtitle,
    market.yes_sub_title,
    market.no_sub_title
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /\bbitcoin\b|\bbtc\b/.test(text) ||
    /\bethereum\b|\beth\b/.test(text) ||
    /\bsolana\b|\bsol\b/.test(text)
  );
}

function getAsset(market) {
  const text = [
    market.ticker,
    market.event_ticker,
    market.title,
    market.subtitle
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\bbitcoin\b|\bbtc\b/.test(text)) return "BTC";
  if (/\bethereum\b|\beth\b/.test(text)) return "ETH";
  if (/\bsolana\b|\bsol\b/.test(text)) return "SOL";

  return "CRYPTO";
}

function normalizeMarket(market) {
  return {
    asset: getAsset(market),
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    title: market.title,
    subtitle: market.subtitle,

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

async function fetchPage(cursor = "") {
  const params = new URLSearchParams({
    status: "open",
    limit: "1000"
  });

  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await fetch(
    `${KALSHI}/markets?${params.toString()}`,
    {
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Kalshi returned ${response.status}: ${body.slice(0, 200)}`
    );
  }

  return response.json();
}

app.get("/api/markets", async (req, res) => {
  try {
    let cursor = "";
    let pages = 0;
    const cryptoMarkets = [];

    /*
      Read-only market discovery.

      Pagination is capped so one dashboard refresh cannot
      make an unlimited number of upstream requests.
    */
    while (pages < 10) {
      const data = await fetchPage(cursor);

      const markets = Array.isArray(data.markets)
        ? data.markets
        : [];

      for (const market of markets) {
        if (isCryptoMarket(market)) {
          cryptoMarkets.push(normalizeMarket(market));
        }
      }

      pages += 1;

      if (!data.cursor || markets.length === 0) {
        break;
      }

      cursor = data.cursor;
    }

    cryptoMarkets.sort((a, b) => {
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
      readOnly: true,
      fetchedAt: new Date().toISOString(),
      markets: cryptoMarkets
    });
  } catch (error) {
    console.error("Kalshi market request failed:", error);

    res.status(502).json({
      error: "Kalshi market data unavailable",
      readOnly: true,
      markets: []
    });
  }
});

/*
  Health check for Render.

  There are deliberately NO:
  - order creation routes
  - position routes
  - trading routes
  - private Kalshi credentials
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mode: "READ_ONLY",
    tradingEnabled: false
  });
});

app.listen(PORT, () => {
  console.log(
    `Read-only Kalshi signal server listening on ${PORT}`
  );
});
