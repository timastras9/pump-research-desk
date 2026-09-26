import puppeteer, {type Page} from '@cloudflare/puppeteer';
import { MODEL, PROMPT_VERSION, prompts, freshLaunch, numeric, usdPrice, validatePicks, visionResult, compareExits, type Candidate, type Signal } from './research-model';
const boundedBrowser=(env:Env)=>({fetch:(input:RequestInfo|URL,init?:RequestInit)=>env.BROWSER.fetch(input,init?.method==='POST'?{...init,signal:AbortSignal.timeout(20000)}:init)});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function kimi(env:Env,system:string,input:string,image?:string,max=600,onUsage?:(usage:unknown)=>void) {
  const model:string=MODEL;
  const result=await env.AI.run(model,{messages:[{role:'system',content:system},{role:'user',content:image?[{type:'text',text:input},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${image}`}}]:input}],max_completion_tokens:max,reasoning_effort:'none',temperature:0},{signal:AbortSignal.timeout(20000)}).catch(error=>{onUsage?.(null);throw error;});
  onUsage?.(result.usage??null);
  const text=(Array.isArray(result.choices)?result.choices[0]?.message?.content:null)??result.response;
  if(typeof text!=='string'||!text.trim()) throw Error('No readable model output.');
  return text;
}
async function clickLabel(page:Page,label:string) {
  const index=await page.$$eval('button',(buttons,label)=>buttons.findIndex(b=>b.textContent?.trim()===label),label);
  if(index<0)return;
  const button=(await page.$$('button'))[index];
  if(button && (await button.evaluate(e=>e.textContent))?.trim()===label) await button.click();
}
async function prepare(page:Page,url:string) {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
  await sleep(2000);
  if(await page.$eval('body',e=>(e.textContent??'').includes('Welcome to Pump.fun!'))) {
    // Specific welcome acceptance previously authorized by owner.
    await clickLabel(page,'Continue');await sleep(1000);
  }
  await clickLabel(page,'Reject all');
}
export async function browserCapacity(env:Env){return puppeteer.limits(boundedBrowser(env));}
export async function scanExplore(env:Env,options:{skipSelection?:boolean}={}) {
  const startedAt=Date.now(); const browser=await puppeteer.launch(boundedBrowser(env));
  const candidates:Candidate[]=[];const errors:string[]=[];
  try {
    const page=await browser.newPage(); await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
    for(const group of ['new'] as const) {
      try {
        await prepare(page,`https://pump.fun/explore?tab=${group==='new'?'created_timestamp':'featured'}`);
        await page.waitForSelector('td[id="usd_market_cap"]',{timeout:15000});
        const selected=await page.$$eval('[role="tab"][aria-selected="true"]',els=>els.map(e=>e.textContent?.trim()));
        if(!selected.includes(group==='new'?'New':'Movers')) throw Error('Requested feed is not selected.');
        const rows=await page.$$eval('tr',els=>els.filter(e=>e.getBoundingClientRect().height>0).map(e=>({
          mint:e.querySelector('img[alt^="Coin image for "]')?.getAttribute('alt')?.replace('Coin image for ',''),
          name:e.querySelector('td[id="name"] [title]')?.getAttribute('title')??'',
          created:e.querySelector('td[id="created_timestamp"] time')?.getAttribute('datetime')??null,
          raw:Object.fromEntries(Array.from(e.querySelectorAll('td[id]')).map(c=>[c.id,(c.textContent??'').trim().slice(0,200)])),
        })).filter(r=>r.mint).slice(0,20));
        const detectedAt=Date.now();
        for(const row of rows) if(row.mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint) && !candidates.some(c=>c.group===group&&c.mint===row.mint)) {
          const createdAt=row.created?Date.parse(row.created):NaN;
          candidates.push({mint:row.mint,group,detectedAt,firstSeenAt:detectedAt,createdAt:Number.isFinite(createdAt)?createdAt:null,name:row.name.slice(0,120),raw:row.raw,marketCapUsd:numeric(row.raw.usd_market_cap),athUsd:numeric(row.raw.ath),volume24hUsd:numeric(row.raw.volume),traders:numeric(row.raw.traders),transactions:numeric(row.raw.txns)});
        }
      } catch {errors.push(`${group} feed unavailable or its table structure changed. No candidates inferred.`);}
    }
  } finally {await browser.close();}
  const browserDurationMs=Date.now()-startedAt;
  const eligible=candidates.filter(c=>freshLaunch(c,Date.now()));
  const aiStartedAt=Date.now();let picks:ReturnType<typeof validatePicks>=[];let selectionError:string|null=null;
  try {if(eligible.length && !options.skipSelection) picks=validatePicks(await kimi(env,prompts.selection,JSON.stringify(eligible)),eligible).filter(p=>{const c=eligible.find(c=>c.mint===p.mint)!;return freshLaunch(c,Date.now());});}
  catch {selectionError='Kimi selection unavailable or invalid. No automatic selection made.';}
  return {browserDurationMs,scope:'new-under-60s',maxAgeMs:60000,id:crypto.randomUUID(),startedAt,completedAt:Date.now(),aiStartedAt,aiFinishedAt:Date.now(),model:MODEL,promptVersion:PROMPT_VERSION,candidates,picks,errors,selectionError,liveTrading:false};
}
export async function closeSession(env:Env,sessionId:string){const browser=await puppeteer.connect(boundedBrowser(env),sessionId);await browser.close();}
export async function acquireObservationBrowser(env:Env,sessionId?:string){
  if(sessionId){try{return {browser:await puppeteer.connect(boundedBrowser(env),sessionId),reused:true};}catch{/* Expired sessions require a fresh browser; caller records the gap. */}}
  return {browser:await puppeteer.launch(boundedBrowser(env),{keep_alive:120000}),reused:false};
}
export type ChatSnapshot={capturedAt:number;status:'available'|'unavailable';messages:{text:string;publishedAt:string|null}[]};
async function openTokenCallouts(page:Page){
  try{
    const tabs=await page.$$('[role="tab"]');
    for(const tab of tabs){if((await tab.evaluate(el=>el.textContent))?.trim()==='Callouts'){await tab.click();break;}}
  }finally{await page.evaluate(()=>window.scrollTo(0,0));}
}
export async function readTokenChat(page:Page):Promise<ChatSnapshot>{
  try{
    const data=await page.evaluate(()=>{
      const panel=document.querySelector('[data-testid="coin-callouts-feed-panel"]');
      if(!panel)return null;
      // pump.fun renders an empty-state message instead of the list when a coin has no callouts yet.
      const list=panel.querySelector('ul[aria-label="Callouts for this coin"]');
      if(!list)return [];
      return Array.from(list.querySelectorAll('article[data-testid="coin-callouts-feed-card"]'))
        .filter(card=>!card.parentElement?.closest('article[data-testid="coin-callouts-feed-card"]')).slice(0,30)
        .map(card=>({text:card.querySelector('p[data-testid="callout-note"]')?.textContent?.trim().slice(0,1000)??'',publishedAt:card.querySelector('time')?.getAttribute('datetime')??null}))
        .filter(message=>message.text.length>0);
    });
    return {capturedAt:Date.now(),status:data===null?'unavailable':'available',messages:data??[]};
  }catch{return {capturedAt:Date.now(),status:'unavailable',messages:[]};}
}
export type Frame={index:number;captureStartedAt:number;capturedAt:number;screenshotMs:number;image:string;text:string;priceUsd:number|null;priceRaw:string;priceMode:string;priceReadAt:number};
export async function observe(env:Env,mint:string,id:string,seconds:number,assumptions:unknown,saveFrame:(frame:Frame)=>Promise<void>,createdAt:number|null=null,options:{maxVision?:number;skipAnalysis?:boolean;allowOlder?:boolean;endAt?:number;sessionId?:string;keepSession?:boolean;captureChat?:boolean;onChat?:(snapshot:ChatSnapshot)=>Promise<void>;shouldContinue?:()=>boolean;onSession?:(id:string,reused:boolean)=>Promise<void>}={}) {
  const browserOpenedAt=Date.now();const usage:unknown[]=[];
  const {browser,reused:sessionReused}=await acquireObservationBrowser(env,options.sessionId);let retainedSessionId:string|null=null;let timedOut=false;
  const captureTimeout=setTimeout(()=>{timedOut=true;void browser.close().catch(()=>{});},Math.max(10000,Math.min(seconds*1000+45000,(options.endAt??Infinity)-Date.now()+5000)));
  const samples:Omit<Frame,'image'|'text'>[]=[];const chatSnapshots:ChatSnapshot[]=[];let lastChatReadAt=0;
  const reviews:{frame:number;startedAt:number;finishedAt:number;text:string;ok:boolean;vision?:ReturnType<typeof visionResult>}[]=[];
  let active:Promise<void>|null=null,attempts=0,skipped=0,lastAnalysis=0,startedAt=Date.now(),failure:string|null=null;
  try {
    await options.onSession?.(browser.sessionId(),sessionReused);
    const url=`https://pump.fun/coin/${mint}`;
    const existing=sessionReused?(await browser.pages()).find(page=>page.url()===url):undefined;
    const page=existing??await browser.newPage();
    if(!existing){await page.setViewport({width:1200,height:800,deviceScaleFactor:1});await prepare(page,url);}
    await page.waitForSelector('[data-testid="coin-chart-display-mode-switch"]',{timeout:15000});
    const switcher=await page.$('[data-testid="coin-chart-display-mode-switch"]');
    if(switcher && (await switcher.evaluate(e=>e.textContent))?.trim()!=='Price') await switcher.click();
    if(options.captureChat&&!existing){try{await openTokenCallouts(page);}catch{/* Missing chat does not invalidate price evidence. */}}
    if(!existing)await sleep(1000);startedAt=Date.now();
    if(!options.allowOlder && createdAt!==null && startedAt-createdAt>60000)throw Error('Token aged past one minute while the page loaded. Scan for a fresh launch.');
    while((options.shouldContinue?.()??true) && Date.now()-startedAt<seconds*1000 && Date.now()<(options.endAt??Infinity) && samples.length<seconds*2) {
      const captureStartedAt=Date.now();
      const image=await page.screenshot({type:'jpeg',quality:55,encoding:'base64'});const capturedAt=Date.now();
      const data=await page.evaluate(()=>({
        priceRaw:document.querySelector('[data-testid="coin-header-market-cap"]')?.textContent?.trim()??'',
        priceMode:document.querySelector('[data-testid="coin-chart-display-mode-switch"]')?.textContent?.trim()??'',
        // Only the heading/statistics region, excluding trader comments and recommendations.
        text:(document.querySelector('[id="coin-content-container"]')?.textContent??'').split('View bubble map')[0].slice(0,1800),
      }));
      const priceReadAt=Date.now();const frame:Frame={index:samples.length,captureStartedAt,capturedAt,screenshotMs:capturedAt-captureStartedAt,image,...data,priceReadAt,priceUsd:usdPrice(data.priceRaw,data.priceMode)};
      const {image:_image,text:_text,...sample}=frame;samples.push(sample);
      await saveFrame(frame);
      if(options.captureChat&&captureStartedAt-lastChatReadAt>=5000){lastChatReadAt=captureStartedAt;const snapshot=await readTokenChat(page);chatSnapshots.push(snapshot);await options.onChat?.(snapshot);}
      if(!active && attempts<(options.maxVision??6) && captureStartedAt-lastAnalysis>=5000){
        attempts++;lastAnalysis=captureStartedAt;const aiStarted=Date.now();
        active=(async()=>{try {
          const text=await kimi(env,prompts.vision,`Frame ${frame.index}, capturedAt ${capturedAt}. Analyze only this screenshot.`,image,300,u=>usage.push(u));
          const vision=visionResult(text);reviews.push({frame:frame.index,startedAt:aiStarted,finishedAt:Date.now(),text,ok:true,vision});
        }catch{reviews.push({frame:frame.index,startedAt:aiStarted,finishedAt:Date.now(),text:'Vision unavailable or invalid; no signal inferred.',ok:false});}})().finally(()=>{active=null;});
      }else skipped++;
      await sleep(Math.max(0,500-(Date.now()-captureStartedAt)));
    }
  }catch(error){failure=error instanceof Error && error.message.startsWith('Token aged')?error.message:'Capture interrupted or token page unavailable. Partial evidence retained; no missing data invented.';}
  finally {await active;clearTimeout(captureTimeout);if(options.keepSession&&(options.shouldContinue?.()??true)&&!failure&&!timedOut&&Date.now()<(options.endAt??Infinity)){retainedSessionId=browser.sessionId();await browser.disconnect();}else await browser.close().catch(()=>{});}
  const browserDurationMs=Date.now()-browserOpenedAt;
  const intervals=samples.slice(1).map((f,i)=>f.captureStartedAt-samples[i].captureStartedAt);
  const signals:Signal[]=reviews.map(r=>({availableAt:r.finishedAt,direction:r.vision?.direction??'unknown',valid:r.ok&&!!r.vision?.chartVisible&&!r.vision.blocked&&r.vision.axis==='price'&&r.vision.direction!=='unknown'}));
  const paper=compareExits(samples.map(f=>({time:f.priceReadAt,priceUsd:f.priceUsd})),signals,assumptions);
  const prices=samples.filter(s=>s.priceUsd!==null);
  const measurements={durationMs:samples.length?samples.at(-1)!.priceReadAt-samples[0].priceReadAt:0,priceSamples:prices.length,totalSamples:samples.length,firstPrice:prices[0]?.priceUsd??null,lastPrice:prices.at(-1)?.priceUsd??null,changePct:prices.length?((prices.at(-1)!.priceUsd!/prices[0].priceUsd!)-1)*100:null,visionLatencyMs:reviews.map(r=>r.finishedAt-r.startedAt)};
  const analysisStartedAt=Date.now();let analysis='No analysis available.';
  try {if(!options.skipAnalysis)analysis=await kimi(env,prompts.analysis,JSON.stringify({measurements,reviews,paper}),undefined,500,u=>usage.push(u));}catch{analysis='Kimi analysis unavailable. Recorded evidence and deterministic paper comparisons remain available.';}
  return {chatSnapshots,sessionId:retainedSessionId,sessionReused,id,mint,startedAt,completedAt:Date.now(),seconds,usage,browserDurationMs,model:MODEL,promptVersion:PROMPT_VERSION,targetIntervalMs:500,frameCount:samples.length,reviews,samples,measurements,skippedAnalysisFrames:skipped,failure,paper,analysis,analysisStartedAt,analysisFinishedAt:Date.now(),
    meanIntervalMs:intervals.length?intervals.reduce((a,b)=>a+b,0)/intervals.length:null,maxIntervalMs:intervals.length?Math.max(...intervals):null,
    mode:'observation-and-paper-proxies',liveTrading:false,note:'Snapshots are not trade candles. Price freshness and executable fills are unverified. AI output is evidence, not an order. Each exit strategy is an independent hypothetical experiment.'};
}
