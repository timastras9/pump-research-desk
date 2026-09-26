import type {Candidate} from './research-model';

// pump.fun's public "newest coins" list: ~0.2s per call, no browser, no API key. It rate-limits
// bursts, so callers poll no faster than every few seconds and fall back to the browser scan on error.
export const LAUNCH_FEED_URL='https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false';
export const LAUNCH_POLL_MS=2000;   // poll cadence, measured from each poll start (was 5 s after the admission work)

const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
export function candidatesFromFeed(rows:unknown,now:number):Candidate[] {
  const list=Array.isArray(rows)?rows:rows&&typeof rows==='object'&&Array.isArray((rows as {coins?:unknown}).coins)?(rows as {coins:unknown[]}).coins:[];
  return list.flatMap(r=>{
    if(!r||typeof r!=='object')return [];
    const d=r as Record<string,unknown>,mint=typeof d.mint==='string'?d.mint:'';
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))return [];
    const createdAt=num(d.created_timestamp);
    return [{mint,group:'new' as const,detectedAt:now,firstSeenAt:now,createdAt:createdAt!==null&&createdAt<=now?createdAt:null,name:String(d.name??'').slice(0,80),
      raw:{source:'pump-api',symbol:String(d.symbol??'').slice(0,20),creator:String(d.creator??''),imageUri:String(d.image_uri??'').slice(0,300)},
      marketCapUsd:num(d.usd_market_cap),athUsd:num(d.ath_market_cap),volume24hUsd:null,traders:null,transactions:null}];
  });
}
export async function fetchNewLaunches(now=Date.now()):Promise<{candidates:Candidate[];errors:string[];browserDurationMs:number}> {
  try {
    const r=await fetch(LAUNCH_FEED_URL,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(4000)});
    if(!r.ok)return {candidates:[],errors:[`Launch feed HTTP ${r.status}`],browserDurationMs:0};
    return {candidates:candidatesFromFeed(await r.json(),now),errors:[],browserDurationMs:0};
  } catch(error) {return {candidates:[],errors:[`Launch feed failed: ${error instanceof Error?error.message:'unknown'}`],browserDurationMs:0};}
}
