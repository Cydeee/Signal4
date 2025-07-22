// netlify/edge-functions/data.js
// Lean build reordered: Derivatives → ROC → Volume → Stress
// Blocks: A indicators | B derivatives | C ROC | D volume | E stress | F structure | G macro | H sentiment

export const config = { path: ["/data", "/data.json"], cache: "manual" };

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
    return new Response(
      `<!DOCTYPE html><html><body><pre id="dashboard-data">${JSON.stringify(payload)}</pre></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
    );
  } catch (err) {
    console.error("Edge Function error", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function buildDashboardData() {
  const SYMBOL = "BTCUSDT";
  const LIMIT = 250;
  const result = {
    dataA: {},   // indicators
    dataB: null, // derivatives
    dataC: {},   // ROC
    dataD: {},   // volume
    dataE: null, // stress
    dataF: null, // structure
    dataG: null, // macro
    dataH: null, // sentiment
    errors: [],
  };

  /* helpers */
  const safeJson = async (u) => { const r = await fetch(u); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();};
  const sma = (a,p)=>a.slice(-p).reduce((s,x)=>s+x,0)/p;
  const ema = (a,p)=>{ if(a.length<p) return 0; const k=2/(p+1); let e=sma(a.slice(0,p),p); for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; };
  const rsi=(a,p)=>{ if(a.length<p+1) return 0; let u=0,d=0; for(let i=1;i<=p;i++){const diff=a[i]-a[i-1]; diff>=0?u+=diff:d-=diff;} let au=u/p,ad=d/p; for(let i=p+1;i<a.length;i++){const diff=a[i]-a[i-1]; au=(au*(p-1)+Math.max(diff,0))/p; ad=(ad*(p-1)+Math.max(-diff,0))/p;} return ad?100-100/(1+au/ad):100; };
  const atr=(h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++){ tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));} return sma(tr,p);} ;
  const roc=(a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

  /* BLOCK A indicators */
  for(const tf of ["15m","1h","4h","1d"]){
    try{
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const closes=kl.map(r=>+r[4]); const highs=kl.map(r=>+r[2]); const lows=kl.map(r=>+r[3]); const last=closes.at(-1)||1;
      const ema50=ema(closes,50), ema200=ema(closes,200);
      const macdArr=[]; for(let i=0;i<closes.length;i++){const sub=closes.slice(0,i+1); macdArr.push(ema(sub,12)-ema(sub,26));}
      const macdHist=macdArr.at(-1)-ema(macdArr,9);
      result.dataA[tf]={ ema50:+ema50.toFixed(2), ema200:+ema200.toFixed(2), rsi14:+rsi(closes,14).toFixed(1), atrPct:+((atr(highs,lows,closes,14)/last)*100).toFixed(2), macdHist:+macdHist.toFixed(2)};
    }catch(e){ result.errors.push(`A[${tf}]: ${e.message}`)} }

  /* BLOCK B derivatives */
  try{
    const fr=await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates=fr.slice(-42).map(d=>+d.fundingRate); const mean=rates.reduce((s,x)=>s+x,0)/rates.length; const sd=Math.sqrt(rates.reduce((s,x)=>s+(x-mean)**2,0)/rates.length);
    const fundingZ=sd?((rates.at(-1)-mean)/sd).toFixed(2):"0.00";
    const oiNow=await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist=await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`);
    const oiDelta24h=((+oiNow.openInterest-+oiHist[0].sumOpenInterest)/+oiHist[0].sumOpenInterest*100).toFixed(1);
    result.dataB={ fundingZ, oiDelta24h };
  }catch(e){ result.dataB={ fundingZ:null, oiDelta24h:null }; result.errors.push("B: "+e.message);}  

  /* BLOCK C ROC */
  for(const tf of ["15m","1h","4h","1d"]){
    try{
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const closes=kl.map(r=>+r[4]); result.dataC[tf]={ roc10:+roc(closes,10).toFixed(2), roc20:+roc(closes,20).toFixed(2) };
    }catch(e){ result.errors.push(`C[${tf}]: ${e.message}`);} }

  /* BLOCK D volume */
  try{
    const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500`);
    const now=Date.now(); const windows={"15m":0.25,"1h":1,"4h":4,"24h":24};
    for(const [lbl,hrs] of Object.entries(windows)){
      const cutoff=now-hrs*3600000; let bull=0,bear=0; for(const k of kl){ if(+k[0]<cutoff) continue; +k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]; }
      result.dataD[lbl]={ bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) }; }
    const tot24=result.dataD["24h"].totalVol; const base={"15m":tot24/96,"1h":tot24/24,"4h":tot24/6}; result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){ const r=result.dataD[lbl].totalVol/Math.max(base[lbl],1); result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal"; }
  }catch(e){ result.errors.push("D: "+e.message);}  

  /* BLOCK E synthetic stress */
  try{
    const biasScore=Math.min(3,Math.abs(+result.dataB.fundingZ||0));
    const levScore=Math.max(0,(+result.dataB.oiDelta24h||0)/5);
    const volFlag=result.dataD.relative["15m"]; const volScore=volFlag==="very high"?2:volFlag==="high"?1:0;
    const divScore=0; const stress=biasScore+levScore+volScore+divScore;
    result.dataE={ stressIndex:+stress.toFixed(2), highRisk:stress>=5, components:{biasScore,levScore,volScore,divScore}, source:"synthetic" };
  }catch(e){ result.dataE=null; result.errors.push("E-synth: "+e.message);}  

  /* BLOCK F market structure */
  try{
    const dayK=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=2`);
    const [yH,yL,yC]=[+dayK[0][2],+dayK[0][3],+dayK[0][4]]; const P=(yH+yL+yC)/3; const R1=2*P-yL; const S1=2*P-yH;
    const min1=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500`);
    const utc0=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()); let pv=0,vol=0,prices=[];
    for(const k of min1){ if(+k[0]<utc0) continue; const tp=(+k[2]+ +k[3]+ +k[4])/3; const v=+k[5]; pv+=tp*v; vol+=v; prices.push(tp);} const vwap=pv/vol; const sd=prices.length>1?Math.sqrt(prices.reduce((s,x)=>s+(x-vwap)**2,0)/prices.length):0;
    const kl20=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=20`);
    const closes20=kl20.map(r=>+r[4]); const HH20=Math.max(...closes20); const LL20=Math.min(...closes20);
    result.dataF={ pivot:{P:+P.toFixed(2),R1:+R1.toFixed(2),S1:+S1.toFixed(2)}, vwap:{value:+vwap.toFixed(2),band:+sd.toFixed(2)}, hhll20:{HH:+HH20.toFixed(2),LL:+LL20.toFixed(2)} };
  }catch(e){ result.errors.push("F: "+e.message);}  

  /* BLOCK G macro */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"); const gd=gv.data;
    result.dataG={ totalMcapT:+(gd.total_market_cap.usd/1e12).toFixed(2), mcap24hPct:+gd.market_cap_change_percentage_24h_usd.toFixed(2), btcDominance:+gd.market_cap_percentage.btc.toFixed(2), ethDominance:+gd.market_cap_percentage.eth.toFixed(2) };
  }catch(e){ result.errors.push("G: "+e.message);}  

  /* BLOCK H sentiment */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"); const fgd=fg.data?.[0]; if(!fgd) throw new Error("FNG missing");
    result.dataH={ fearGreed:`${fgd.value} · ${fgd.value_classification}` };
  }catch(e){ result.errors.push("H: "+e.message);}  

  return result;
}
