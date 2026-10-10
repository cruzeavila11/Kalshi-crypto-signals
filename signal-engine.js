// Pure scoring rules: prices are dollars; now is an epoch-millisecond timestamp.
export function scoreSignal(market, previous, now) {
  const usableNumber = (value) => {
    if (value === null || value === undefined || String(value).trim() === "") return NaN;
    return Number(value);
  };
  const price = usableNumber(
    market.last_price_dollars ?? market.price ??
    market.yes_ask_dollars ?? market.yes_bid_dollars
  );
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
  const minutesLeft = closeTime ? (new Date(closeTime).getTime() - now) / 60000 : NaN;
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

export function resolvePreviousPrice(market, fallback = NaN) {
  const raw =
    market.previous_price_dollars ??
    market.previousPrice;

  if (raw !== null && raw !== undefined && raw !== "") {
    const previous = Number(raw);

    if (Number.isFinite(previous) && previous > 0) {
      return previous;
    }
  }

  return fallback;
}

