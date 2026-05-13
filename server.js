const express = require('express');
const path    = require('path');

const app     = express();
const API_KEY = process.env.POLYGON_API_KEY;
const BASE    = 'https://api.polygon.io';

if (!API_KEY) {
  console.warn('⚠️  POLYGON_API_KEY not set — set it as an environment variable');
}

// ── Serve static frontend ─────────────────────────────────────────────────────
app.use(express.static(__dirname));
// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ── Last trade price ──────────────────────────────────────────────────────────
app.get('/api/price', async (_, res) => {
  try {
    const r = await fetch(`${BASE}/v2/last/trade/SPY?apiKey=${API_KEY}`);
    const j = await r.json();
    res.json({ price: j?.results?.p ?? null, raw: j });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Previous close (for % change) ─────────────────────────────────────────────
app.get('/api/prevclose', async (_, res) => {
  try {
    const r = await fetch(`${BASE}/v2/aggs/ticker/SPY/prev?apiKey=${API_KEY}`);
    const j = await r.json();
    res.json({ close: j?.results?.[0]?.c ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GEX — paginate all options, compute net gamma exposure per strike ─────────
// GEX = Σ(gamma × OI × 100) calls  −  Σ(gamma × OI × 100) puts
app.get('/api/gex', async (req, res) => {
  const expDate = req.query.exp;
  if (!expDate) return res.status(400).json({ error: 'exp query param required (YYYY-MM-DD)' });

  try {
    const byStrike = {};
    let pageUrl = `${BASE}/v3/snapshot/options/SPY?expiration_date=${expDate}&limit=250&apiKey=${API_KEY}`;
    let pages   = 0;

    while (pageUrl && pages < 20) { // safety cap — SPY has ~500 strikes max
      const r    = await fetch(pageUrl);
      const json = await r.json();

      if (json.status === 'ERROR') throw new Error(json.error ?? 'Polygon error');

      for (const row of json.results ?? []) {
        const gamma = row.greeks?.gamma;
        const oi    = row.open_interest ?? 0;
        const type  = row.details?.contract_type;  // 'call' | 'put'
        const k     = row.details?.strike_price;

        if (gamma == null || !k || !type) continue;

        if (!byStrike[k]) byStrike[k] = { strike: k, gamma: 0 };
        byStrike[k].gamma += type === 'call' ? gamma * oi * 100 : -(gamma * oi * 100);
      }

      pageUrl = json.next_url ? `${json.next_url}&apiKey=${API_KEY}` : null;
      pages++;
    }

    const data = Object.values(byStrike).sort((a, b) => a.strike - b.strike);
    res.json({ data, strikes: data.length, pages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all → frontend ──────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Gamma Monitor running → http://localhost:${PORT}`));
