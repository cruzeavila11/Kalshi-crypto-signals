import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const KALSHI =
  "https://external-api.kalshi.com/trade-api/v2";

app.use(express.static("."));

// Only the crypto series we intentionally monitor.
const CRYPTO_SERIES = [
  { asset: "BTC", series: "KXBTCPERP" },
  { asset: "ETH", series: "KXETHPERP" },
  { asset: "SOL", series: "KXSOLPERP" }
];

function normalizeMarket(market, asset) {
  return {
    asset,

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

    status: market.status ?? null
  };
}

async function fetchSeriesMarkets(asset, series) {
  const params = new URLSearchParams({
    status: "open",
    series_ticker: series,
    limit: "1000"
  });

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
      `${asset}/${series} returned ` +
      `${response.status}: ${body.slice(0, 250)}`
    );
  }

  const data = await response.json();

  return {
    asset,
    series,
    markets: Array.isArray(data.markets)
      ? data.markets
      : []
  };
}

app.get("/api/markets", async (req, res) => {
  try {
    const results = await Promise.all(
      CRYPTO_SERIES.map(({ asset, series }) =>
        fetchSeriesMarkets(asset, series)
      )
    );

    const markets = results
      .flatMap(({ asset, markets }) =>
        markets.map((market) =>
          normalizeMarket(market, asset)
        )
      )
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

    const counts = {};

    for (const result of results) {
      counts[result.asset] =
        result.markets.length;
    }

    res.set("Cache-Control", "no-store");

    res.json({
      source: "Kalshi",
      mode: "READ_ONLY",
      tradingEnabled: false,
      fetchedAt: new Date().toISOString(),
      seriesChecked:
        CRYPTO_SERIES.map((x) => x.series),
      counts,
      cryptoMarketsFound: markets.length,
      markets
    });
  } catch (error) {
    console.error(
      "Kalshi crypto request failed:",
      error
    );

    res.status(502).json({
      error: "Kalshi crypto data unavailable",
      message: error.message,
      mode: "READ_ONLY",
      tradingEnabled: false,
      markets: []
    });
  }
});

// Diagnostic endpoint for the exact series only.
app.get("/api/debug-markets", async (req, res) => {
  try {
    const results = await Promise.all(
      CRYPTO_SERIES.map(({ asset, series }) =>
        fetchSeriesMarkets(asset, series)
      )
    );

    res.set("Cache-Control", "no-store");

    res.json({
      mode: "READ_ONLY",
      tradingEnabled: false,

      results: results.map((result) => ({
        asset: result.asset,
        series: result.series,
        count: result.markets.length,

        sample: result.markets
          .slice(0, 5)
          .map((market) => ({
            ticker: market.ticker ?? null,
            event_ticker:
              market.event_ticker ?? null,
            title: market.title ?? null,
            yes_bid_dollars:
              market.yes_bid_dollars ?? null,
            yes_ask_dollars:
              market.yes_ask_dollars ?? null,
            last_price_dollars:
              market.last_price_dollars ?? null
          }))
      }))
    });
  } catch (error) {
    res.status(502).json({
      error: "Kalshi diagnostic failed",
      message: error.message,
      mode: "READ_ONLY",
      tradingEnabled: false
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mode: "READ_ONLY",
    tradingEnabled: false,
    apiBase: KALSHI,
    monitoredSeries:
      CRYPTO_SERIES.map((x) => x.series)
  });
});

app.listen(PORT, () => {
  console.log(
    `Read-only Kalshi crypto server listening on ${PORT}`
  );
});
