// Optional cloud relay (Node.js 20+). This service is READ-ONLY.
// It exposes public Kalshi market data to the iPad dashboard.
// There is deliberately NO order-placement route in this server.
import express from "express";
const app = express();
const PORT = process.env.PORT || 3000;
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";

app.use(express.static("."));

app.get("/api/markets", async (req,res)=>{
  try{
    const r=await fetch(`${KALSHI}/markets?status=open&limit=100`);
    if(!r.ok) return res.status(r.status).json({error:"Kalshi request failed"});
    const data=await r.json();
    const markets=(data.markets||[]).filter(m=>{
      const s=((m.title||"")+" "+(m.subtitle||"")+" "+(m.ticker||"")).toLowerCase();
      return /bitcoin|btc|ethereum|eth|solana|sol\b/.test(s);
    });
    res.json({markets});
  }catch(e){res.status(500).json({error:"Market data unavailable"});}
});

app.get("/api/orderbook/:ticker", async (req,res)=>{
  try{
    const safe=encodeURIComponent(req.params.ticker);
    const r=await fetch(`${KALSHI}/markets/${safe}/orderbook?depth=10`);
    if(!r.ok) return res.status(r.status).json({error:"Kalshi orderbook request failed"});
    res.json(await r.json());
  }catch(e){res.status(500).json({error:"Orderbook unavailable"});}
});

// Intentionally no POST /orders route.
app.listen(PORT,()=>console.log(`Signal-only server listening on ${PORT}`));
