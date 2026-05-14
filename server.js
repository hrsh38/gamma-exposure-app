const express = require('express');
const path    = require('path');
const fetch   = require('node-fetch');

const app     = express();
const API_KEY = process.env.POLYGON_API_KEY;
const BASE    = 'https://api.polygon.io';

if (!API_KEY) console.warn('⚠️  POLYGON_API_KEY not set');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_, res) => res.json({ ok: true, key: !!API_KEY }));

app.get('/api/price', async (_, res) => {
  try {
    const r = await fetch(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/SPY?apiKey=${API_KEY}`);
    const j = await r.json();
    if (j.status === 'ERROR') return res.status(500).json({ error: j.error });
    const t = j?.ticker;
    const price =
         t?.lastTrade?.p
      ?? (t?.lastQuote?.p && t?.lastQuote?.P ? (t.lastQuote.p + t.lastQuote.P) / 2 : null)
      ?? t?.day?.c
      ?? t?.prevDay?.c
      ?? null;
    res.json({ price, prevClose: t?.prevDay?.c ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/prevclose', async (_, res) => {
  try {
    const r = await fetch(`${BASE}/v2/aggs/ticker/SPY/prev?apiKey=${API_KEY}`);
    const j = await r.json();
    res.json({ close: j?.results?.[0]?.c ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Real list of valid, non-expired SPY expirations ─────────────────────────
app.get('/api/expirations', async (_, res) => {
  try {
    let url = `${BASE}/v3/reference/options/contracts?underlying_ticker=SPY&expired=false&limit=1000&apiKey=${API_KEY}`;
    const all = new Set();
    let pages = 0;
    while (url && pages < 5) {
      const r    = await fetch(url);
      const json = await r.json();
      for (const c of (json.results ?? [])) all.add(c.expiration_date);
      url = json.next_url ? `${json.next_url}&apiKey=${API_KEY}` : null;
      pages++;
    }
    const today = new Date().toISOString().slice(0,10);
    const exps  = [...all].filter(d => d >= today).sort().slice(0, 15);
    res.json({ expirations: exps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug a specific strike ─────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const expDate = req.query.exp;
  const strike  = req.query.strike ? parseFloat(req.query.strike) : null;
  if (!expDate) return res.status(400).json({ error: 'exp required' });
  try {
    const url = strike
      ? `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&strike_price=${strike}&apiKey=${API_KEY}`
      : `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&limit=250&apiKey=${API_KEY}`;
    const r    = await fetch(url);
    const json = await r.json();
    const all  = json.results ?? [];
    const spot = all[0]?.underlying_asset?.price ?? null;

    if (strike) {
      const call = all.find(r => r.details?.contract_type === 'call');
      const put  = all.find(r => r.details?.contract_type === 'put');
      const scale = spot ? spot * spot * 0.01 : 0;
      return res.json({
        expiration: expDate, strike, underlying: spot, scale,
        call_raw: call ? { gamma:call.greeks?.gamma, oi:call.open_interest, volume:call.day?.volume, iv:call.implied_volatility, last:call.last_trade?.price } : null,
        put_raw:  put  ? { gamma:put.greeks?.gamma,  oi:put.open_interest,  volume:put.day?.volume,  iv:put.implied_volatility,  last:put.last_trade?.price  } : null,
        computed: {
          call_dollar_gex: call ? call.greeks?.gamma * call.open_interest * 100 * scale : 0,
          put_dollar_gex:  put  ? put.greeks?.gamma  * put.open_interest  * 100 * scale : 0,
        },
      });
    }
    const withGamma = all.filter(r => r.greeks?.gamma != null);
    const withOI    = all.filter(r => r.open_interest > 0);
    const strikes   = [...new Set(all.map(r => r.details?.strike_price))].sort((a,b)=>a-b);
    res.json({
      expiration: expDate, underlying: spot,
      total: all.length, with_gamma: withGamma.length, with_oi: withOI.length,
      strike_range: strikes.length ? { min: strikes[0], max: strikes[strikes.length-1] } : null,
      near_spot: spot ? strikes.filter(s => Math.abs(s - spot) <= 5) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gex', async (req, res) => {
  const expDate = req.query.exp;
  if (!expDate) return res.status(400).json({ error: 'exp param required (YYYY-MM-DD)' });

  try {
    const byStrike  = {};
    let pageUrl     = `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&limit=250&apiKey=${API_KEY}`;
    let pages       = 0;
    let underlying  = null;

    while (pageUrl && pages < 20) {
      const r    = await fetch(pageUrl);
      const json = await r.json();
      if (json.status === 'ERROR') throw new Error(json.error ?? 'Polygon API error');

      for (const row of json.results ?? []) {
        if (!underlying) underlying = row.underlying_asset?.price ?? null;
        const gamma = row.greeks?.gamma;
        const oi    = row.open_interest ?? 0;
        const type  = row.details?.contract_type;
        const k     = row.details?.strike_price;
        if (gamma == null || !k || !type) continue;
        const raw = gamma * oi * 100;
        if (!byStrike[k]) byStrike[k] = { strike: k, gamma: 0 };
        byStrike[k].gamma += type === 'call' ? raw : -raw;
      }
      pageUrl = json.next_url ? `${json.next_url}&apiKey=${API_KEY}` : null;
      pages++;
    }

    if (underlying) {
      const scale = underlying * underlying * 0.01; // Per 1% Move (matches QuantData)
      for (const k of Object.keys(byStrike)) byStrike[k].gamma *= scale;
    }

    const data = Object.values(byStrike).sort((a, b) => a.strike - b.strike);
    console.log(`GEX: ${data.length} strikes, ${pages} pages, exp=${expDate}, underlying=${underlying}`);
    res.json({ data, strikes: data.length, underlying });
  } catch (e) {
    console.error('GEX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Gamma Monitor → http://localhost:${PORT}`));
