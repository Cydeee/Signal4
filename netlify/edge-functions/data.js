// netlify/edge-functions/data.js

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

    const html = `<!DOCTYPE html>
<html><body><pre id="dashboard-data">${JSON.stringify(payload)}</pre></body></html>`;
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

// Shared data building logic
async function buildDashboardData() {
  const SYMBOL = "BTCUSDT";
  const LIMIT = 250;
  const result = {
    dataA: {},
    dataB: {},
    dataC: {},
    dataD: null,
    dataE: null, // new Market Structure block
    dataF: null, // sentiment (was E)
    dataG: null, // global (was F)
    errors: []
  };

  const safeJson = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  };
  const sma = (a, p) => a.slice(-p).reduce((s, x) => s + x, 0) / p;
  const std = (a, p) => {
    const sl = a.slice(-p);
    const m = sma(sl, p);
    return Math.sqrt(sl.reduce((t, x) => t + (x - m) ** 2, 0) / p);
  };
  const ema = (a, p) => {
    if (a.length < p) return 0;
    const k = 2 / (p + 1);
    let e = sma(a.slice(0, p), p);
    for (let i = p; i < a.length; i++) {
      e = a[i] * k + e * (1 - k);
    }
    return e;
  };
  const rsi = (a, p) => {
    if (a.length < p + 1) return 0;
    let g = 0,
      l = 0;
    for (let i = 1; i <= p; i++) {
      const d = a[i] - a[i - 1];
      d >= 0 ? (g += d) : (l -= d);
    }
    let ag = g / p,
      al = l / p;
    for (let i = p + 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      ag = (ag * (p - 1) + Math.max(d, 0)) / p;
      al = (al * (p - 1) + Math.max(-d, 0)) / p;
    }
    return al ? 100 - 100 / (1 + ag / al) : 100;
  };
  const atr = (h, l, c, p) => {
    if (h.length < p + 1) return 0;
    const trs = [];
    for (let i = 1; i < h.length; i++) {
      trs.push(
        Math.max(
          h[i] - l[i],
          Math.abs(h[i] - c[i - 1]),
          Math.abs(l[i] - c[i - 1])
        )
      );
    }
    return sma(trs.slice(-p), p);
  };

  // helper for MACD 12-26-9
  const macdCalc = (closes) => {
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema
