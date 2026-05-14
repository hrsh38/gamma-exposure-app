const express = require("express");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const API_KEY = process.env.POLYGON_API_KEY;
const BASE = "https://api.polygon.io";

if (!API_KEY) console.warn("⚠️  POLYGON_API_KEY not set");

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_, res) => res.json({ ok: true, key: !!API_KEY }));

app.get("/api/price", async (_, res) => {
  try {
    const r = await fetch(
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/SPY?apiKey=${API_KEY}`,
    );
    const j = await r.json();
    if (j.status === "ERROR") return res.status(500).json({ error: j.error });
    const t = j?.ticker;
    const price =
      t?.lastTrade?.p ??
      (t?.lastQuote?.p && t?.lastQuote?.P
        ? (t.lastQuote.p + t.lastQuote.P) / 2
        : null) ??
      t?.day?.c ??
      t?.prevDay?.c ??
      null;
    res.json({ price, prevClose: t?.prevDay?.c ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/prevclose", async (_, res) => {
  try {
    const r = await fetch(`${BASE}/v2/aggs/ticker/SPY/prev?apiKey=${API_KEY}`);
    const j = await r.json();
    res.json({ close: j?.results?.[0]?.c ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG: inspect raw Polygon data for a single strike ─────────────────────
// Usage: /api/debug?exp=2026-05-13&strike=743
app.get("/api/debug", async (req, res) => {
  const expDate = req.query.exp;
  const strike = parseFloat(req.query.strike);
  if (!expDate || !strike)
    return res.status(400).json({ error: "exp and strike required" });

  try {
    const url = `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&strike_price=${strike}&apiKey=${API_KEY}`;
    const r = await fetch(url);
    const json = await r.json();

    const rows = (json.results ?? []).map((row) => ({
      type: row.details?.contract_type,
      strike: row.details?.strike_price,
      gamma: row.greeks?.gamma,
      delta: row.greeks?.delta,
      iv: row.implied_volatility,
      open_interest: row.open_interest,
      volume: row.day?.volume,
      last_price: row.last_trade?.price,
      underlying: row.underlying_asset?.price,
    }));

    const call = rows.find((r) => r.type === "call");
    const put = rows.find((r) => r.type === "put");
    const spot = call?.underlying ?? put?.underlying ?? 0;
    const scale = spot * spot * 0.01;

    res.json({
      strike,
      expiration: expDate,
      underlying: spot,
      call_raw: call,
      put_raw: put,
      computed: {
        call_dollar_gex: call
          ? call.gamma * call.open_interest * 100 * scale
          : 0,
        put_dollar_gex: put ? put.gamma * put.open_interest * 100 * scale : 0,
        net_dollar_gex:
          (call ? call.gamma * call.open_interest * 100 * scale : 0) -
          (put ? put.gamma * put.open_interest * 100 * scale : 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/gex", async (req, res) => {
  const expDate = req.query.exp;
  if (!expDate)
    return res.status(400).json({ error: "exp param required (YYYY-MM-DD)" });

  try {
    const byStrike = {};
    let pageUrl = `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&limit=250&apiKey=${API_KEY}`;
    let pages = 0;
    let underlying = null;

    while (pageUrl && pages < 20) {
      const r = await fetch(pageUrl);
      const json = await r.json();
      if (json.status === "ERROR")
        throw new Error(json.error ?? "Polygon API error");

      for (const row of json.results ?? []) {
        if (!underlying) underlying = row.underlying_asset?.price ?? null;
        const gamma = row.greeks?.gamma;
        const oi = row.open_interest ?? 0;
        const type = row.details?.contract_type;
        const k = row.details?.strike_price;
        if (gamma == null || !k || !type) continue;
        const raw = gamma * oi * 100;
        if (!byStrike[k]) byStrike[k] = { strike: k, gamma: 0 };
        byStrike[k].gamma += type === "call" ? raw : -raw;
      }

      pageUrl = json.next_url ? `${json.next_url}&apiKey=${API_KEY}` : null;
      pages++;
    }

    if (underlying) {
      const scale = underlying * underlying * 0.01;
      for (const k of Object.keys(byStrike)) byStrike[k].gamma *= scale;
    }

    const data = Object.values(byStrike).sort((a, b) => a.strike - b.strike);
    console.log(
      `GEX: ${data.length} strikes, ${pages} pages, exp=${expDate}, underlying=${underlying}`,
    );
    res.json({ data, strikes: data.length, underlying });
  } catch (e) {
    console.error("GEX error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅  Gamma Monitor → http://localhost:${PORT}`),
);
