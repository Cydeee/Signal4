// netlify/edge-functions/data.js
// Lean build + ROC10/20 + Liquidations + Market Structure
export const config = {
  path: ["/data", "/data.json"],
  cache: "manual",
};

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const wantJson = new URL(request.url).pathname.endsWith("/data.json");

  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();

    if (wantJson) {
      return new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, s-maxage=60, must-revalidate",
        },
      });
    }

    const html = `<!DOCTYPE html><html><body><pre id="dashboard-data">${JSON.stringify(
      payload
    )}</pre></body></html>`;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("Error in Edge Function:", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/* -------------------------------------------------------------------- */
/*                       data-building logic                            */
/* -------------------------------------------------------------------- */
async function buildDashboardData() {
  const SYMBOL = "BTCUSDT";   // change BTC to any top-20 coin ticker
  const LIMIT  = 250;

  const result = {
    dataA: {},   // indicators
    dataB: {},   // ROC10 / ROC20
    dataC: {},   // volume delta
    dataD: null, // derivatives
    dataE: null, // liquidations
    dataF: null, // market structure
    dataG: null, // sentiment
    dataH: null, // macro dominance
    errors: [],
  };

  /* ---------------------- helpers ----------------------------------- */
  const safeJson = async (u, opt={}) => {
    const r = await fetch(u, opt);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  };

  const sma = (a, p) => a.slice(-p).reduce((s, x) => s + x, 0) / p;

  const std = (a, p) => {
    const m = sma(a, p);
    return Math.sqrt(a.slice(-p).reduce((t, x) => t + (x - m) ** 2, 0) / p);
  };

  const ema = (a, p) => {
    if (a.length < p) return 0;
    const k = 2 / (p + 1);
    let e = sma(a.slice(0, p), p);
    for (let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k);
    return e;
  };

  const rsi = (a, p) => {
    if (a.length < p + 1) return 0;
    let up = 0, dn = 0;
    for (let i = 1; i <= p; i++) {
      const d = a[i] - a[i - 1];
      d >= 0 ? (up += d) : (dn -= d);
    }
    let avgUp = up / p, avgDn = dn / p;
    for (let i = p + 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      avgUp = (avgUp * (p - 1) + Math.max(d, 0)) / p;
      avgDn = (avgDn * (p - 1) + Math.max(-d, 0)) / p;
    }
    return avgDn ? 100 - 100 / (1 + avgUp / avgDn) : 100;
  };

  const atr = (h, l, c, p) => {
    if (h.length < p + 1) return 0;
    const tr = [];
    for (let i = 1; i < h.length; i++)
      tr.push(Math.max(h[i] - l[i],
                       Math.abs(h[i] - c[i - 1]),
                       Math.abs(l[i] - c[i - 1])));
    return sma(tr, p);
  };

  const roc = (a, n) => (a.length >= n + 1)
      ? ((a.at(-1) - a.at(-(n + 1))) / a.at(-(n + 1))) * 100
      : 0;

  /* ------------------------------------------------------------------ */
  /* BLOCK A – trend / momentum / volatility -------------------------- */
  /* ------------------------------------------------------------------ */
  for (const tf of ["15m", "1h", "4h", "1d"]) {
    try {
      const kl = await safeJson(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`
      );
      const closes = kl.map(r => +r[4]);
      const highs  = kl.map(r => +r[2]);
      const lows   = kl.map(r => +r[3]);

      const last   = closes.at(-1) || 1;
      const ema50  = ema(closes, 50);
      const ema200 = ema(closes, 200);

      /* MACD histogram */
      const macdArr = [];
      for (let i = 0; i < closes.length; i++) {
        const sub = closes.slice(0, i + 1);
        macdArr.push(ema(sub, 12) - ema(sub, 26));
      }
      const macdH = macdArr.at(-1) - ema(macdArr, 9);

      result.dataA[tf] = {
        ema50: +ema50.toFixed(2),
        ema200: +ema200.toFixed(2),
        rsi14: +rsi(closes, 14).toFixed(1),
        atrPct: +((atr(highs, lows, closes, 14) / last) * 100).toFixed(2),
        macdHist: +macdH.toFixed(2),
      };
    } catch (e) {
      result.errors.push(`A[${tf}]: ${e.message}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* BLOCK B – ROC 10 / 20 -------------------------------------------- */
  /* ------------------------------------------------------------------ */
  for (const tf of ["15m", "1h", "4h", "1d"]) {
    try {
      const kl = await safeJson(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`
      );
      const closes = kl.map(r => +r[4]);
      result.dataB[tf] = {
        roc10: +roc(closes, 10).toFixed(2),
        roc20: +roc(closes, 20).toFixed(2),
      };
    } catch (e) {
      result.errors.push(`B[${tf}]: ${e.message}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* BLOCK C – volume delta ------------------------------------------- */
  /* ------------------------------------------------------------------ */
  try {
    const kl = await safeJson(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500`
    );
    const now = Date.now();
    const windows = { "15m": 0.25, "1h": 1, "4h": 4, "24h": 24 };
    for (const [lbl, hrs] of Object.entries(windows)) {
      const cutoff = now - hrs * 3600000;
      let bull = 0, bear = 0;
      for (const k of kl) {
        if (+k[0] < cutoff) continue;
        +k[4] >= +k[1] ? (bull += +k[5]) : (bear += +k[5]);
      }
      result.dataC[lbl] = {
        bullVol: +bull.toFixed(2),
        bearVol: +bear.toFixed(2),
        totalVol: +(bull + bear).toFixed(2),
      };
    }
    const tot24 = result.dataC["24h"].totalVol;
    const base  = { "15m": tot24 / 96, "1h": tot24 / 24, "4h": tot24 / 6 };
    result.dataC.relative = {};
    for (const lbl of ["15m", "1h", "4h"]) {
      const r = result.dataC[lbl].totalVol / Math.max(base[lbl], 1);
      result.dataC.relative[lbl] =
        r > 2 ? "very high" : r > 1.2 ? "high" : r < 0.5 ? "low" : "normal";
    }
  } catch (e) {
    result.errors.push("C: " + e.message);
  }

  /* ------------------------------------------------------------------ */
  /* BLOCK D – derivatives positioning -------------------------------- */
  /* ------------------------------------------------------------------ */
  try {
    const fr = await safeJson(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`
    );
    const rates = fr.slice(-42).map(d => +d.fundingRate);
    const mean  = rates.reduce((s, x) => s + x, 0) / rates.length;
    const sd    = Math.sqrt(rates.reduce((s, x) => s + (x - mean) ** 2, 0) / rates.length);
    const fundingZ = sd ? ((rates.at(-1) - mean) / sd).toFixed(2) : "0.00";

    const oiNow = await safeJson(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`
    );
    const oiHistArr = await safeJson(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`
    );
    const pct24h = (
      ((+oiNow.openInterest - +oiHistArr[0].sumOpenInterest) /
        +oiHistArr[0].sumOpenInterest) * 100
    ).toFixed(1);

    result.dataD = { fundingZ, oiDelta24h: pct24h };
  } catch (e) {
    result.dataD = { fundingZ: null, oiDelta24h: null };
    result.errors.push(`D: ${e.message}`);
  }

/* ------------------------------------------------------------------ */
/* BLOCK E – liquidations (Coinglass, 5-minute buckets)               */
/* ------------------------------------------------------------------ */
try {
  const CG_KEY = Deno.env.get("COINGLASS_KEY");
  if (!CG_KEY) throw new Error("COINGLASS_KEY env-var is missing");

  const url =
    "https://open-api.coinglass.com/public/v2/liquidation" +
    "?symbol=BTC&type=futures&time_interval=5m";

  const resp = await fetch(url, {
    headers: {
      coinglassSecret: CG_KEY,
      accept: "application/json"
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const body = await resp.json();
  if (body.code !== 0 || !Array.isArray(body.data))
    throw new Error(`Coinglass error code ${body.code}`);

  const buckets = body.data;
  const slice1h = buckets.slice(-12);   // 12×5m = 1 h
  const slice4h = buckets.slice(-48);   // 48×5m = 4 h
  const sum = (arr) => arr.reduce((s, b) => s + (+b.vol_usd || 0), 0);

  const usd1h = sum(slice1h);
  const usd4h = sum(slice4h);

  result.dataE = {
    usd1h: +usd1h.toFixed(0),
    usd4h: +usd4h.toFixed(0),
    spike: usd1h > 1.5 * (usd4h / 4),
  };
} catch (e) {
  result.dataE = null;                  // keep schema consistent
  result.errors.push("E-liq: " + e.message);
}

  /* ------------------------------------------------------------------ */
  /* BLOCK F – market structure --------------------------------------- */
  /* ------------------------------------------------------------------ */
  try {
    /* Daily pivots */
    const dayK = await safeJson(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=2`
    );
    const [yHi, yLo, yCl] = [+dayK[0][2], +dayK[0][3], +dayK[0][4]];
    const P  = (yHi + yLo + yCl) / 3;
    const R1 = 2 * P - yLo;
    const S1 = 2 * P - yHi;

    /* Session VWAP ± 1 σ */
    const min1 = await safeJson(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500`
    );
    const todayUTC0 = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    )).getTime();
    let pv = 0, vol = 0, prices = [];
    for (const k of min1) {
      if (+k[0] < todayUTC0) continue;
      const tp = (+k[2] + +k[3] + +k[4]) / 3;
      const v  = +k[5];
      pv += tp * v; vol += v;
      prices.push(tp);
    }
    const vwap = pv / vol;
    const sd   = Math.sqrt(prices.reduce((s,x)=>s+(x-vwap)**2,0)/prices.length);

    /* HH/LL 20 on 15-minute TF */
    const kl20 = await safeJson(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`
    );
    const closes20 = kl20.map(r => +r[4]);
    const HH20 = Math.max(...closes20);
    const LL20 = Math.min(...closes20);

    result.dataF = {
      pivot: { P:+P.toFixed(2), R1:+R1.toFixed(2), S1:+S1.toFixed(2) },
      vwap:  { value:+vwap.toFixed(2), band:+sd.toFixed(2) },
      hhll20:{ HH:+HH20.toFixed(2), LL:+LL20.toFixed(2) },
    };
  } catch (e) {
    result.errors.push("F: " + e.message);
  }

  /* ------------------------------------------------------------------ */
  /* BLOCK G – sentiment ---------------------------------------------- */
  /* ------------------------------------------------------------------ */
  try {
    const fg = await safeJson(`https://api.alternative.me/fng/?limit=1`);
    const fgd = fg.data?.[0];
    if (!fgd) throw new Error("FNG missing");
    result.dataG = {
      fearGreed: `${fgd.value} · ${fgd.value_classification}`,
    };
  } catch (e) {
    result.errors.push("G: " + e.message);
  }

  /* ------------------------------------------------------------------ */
  /* BLOCK H – macro dominance ---------------------------------------- */
  /* ------------------------------------------------------------------ */
  try {
    const gv = await safeJson(`https://api.coingecko.com/api/v3/global`);
    const gd = gv.data;
    result.dataH = {
      btcDominance: +gd.market_cap_percentage.btc.toFixed(2),
      ethDominance: +gd.market_cap_percentage.eth.toFixed(2),
    };
  } catch (e) {
    result.errors.push("H: " + e.message);
  }

  return result;
}
