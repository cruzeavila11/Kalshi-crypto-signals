# Kalshi Crypto Signal Dashboard — iPad Edition

This is the first working UI package for the signal-only bot.

## Safety boundary

This project is deliberately **read-only**. It has no order-placement endpoint, no trading button, and no code that calls Kalshi's order-creation API.

The browser UI can eventually receive market data from a cloud relay. Keep Kalshi private credentials off the iPad/browser.

## What is included

- Mobile/iPad-friendly dashboard
- BTC / ETH / SOL signal cards
- Signal feed
- Signal-history area
- iPad notification permission button
- Cloud endpoint field
- Optional Node.js read-only relay for Kalshi public market data

## Important

The included dashboard uses demo values until a cloud service is connected. Do not treat demo signals as live trading signals.

## Cloud deployment

The optional `server.js` is designed for a Node.js hosting service. After deployment, point the dashboard's "Cloud data endpoint" at:

`https://YOUR-DOMAIN/api/markets`

A production version should add:
- real-time polling/WebSocket ingestion
- historical signal storage
- outcome resolution
- calibrated signal statistics
- alert throttling
- a stronger crypto-market classifier
- fee-aware expected-value calculations

Kalshi's public market-data API supports market and orderbook data. Authentication should be kept server-side if it is needed. See the current Kalshi API documentation before deployment.

## iPad

Once hosted over HTTPS, open the site in Safari and use Share → Add to Home Screen. Notification support depends on the browser/OS and the site being served securely.
