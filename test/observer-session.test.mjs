import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function runtime({expired=false}={}){
 let now=100000,connects=0,launches=0,disconnects=0,closes=0,newPages=0,gotos=0;
 const page={url:()=> 'https://pump.fun/coin/mint',waitForSelector:async()=>{},$:async()=>({evaluate:async()=> 'Price'}),screenshot:async()=>{now+=100;return 'YQ==';},evaluate:async()=>({priceRaw:'$1',priceMode:'Price',text:''}),setViewport:async()=>{},goto:async()=>{gotos++;},$eval:async()=>false,$$eval:async()=>-1};
 const browser={sessionId:()=> 'session1',pages:async()=>[page],newPage:async()=>{newPages++;return page;},disconnect:async()=>{disconnects++;},close:async()=>{closes++;}};
 const puppeteer={connect:async()=>{connects++;if(expired)throw Error('Expired');return browser;},launch:async()=>{launches++;return browser;}};
 const imports={'@cloudflare/puppeteer':{default:puppeteer},'./research-model':{MODEL:'test',PROMPT_VERSION:'test',prompts:{},compareExits:()=>[],usdPrice:()=>1}};
 const code=ts.transpileModule(readFileSync(new URL('../src/observer.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 class Clock extends Date{static now(){return now;}}
 const exports={};new Function('require','exports','Date','setTimeout','clearTimeout',code)(name=>imports[name],exports,Clock,(cb,ms)=>{if(ms<2000){now+=ms;queueMicrotask(cb);}return 1;},()=>{});
 return {api:exports,counts:()=>({connects,launches,disconnects,closes,newPages,gotos})};
}
test('healthy existing token page is reused without new browser or navigation',async()=>{
 const h=runtime();let persisted=false;const result=await h.api.observe({},'mint','id',1,{},async()=>{assert.equal(persisted,true);},null,{sessionId:'session1',keepSession:true,maxVision:0,skipAnalysis:true,onSession:async id=>{assert.equal(id,'session1');persisted=true;}});
 assert.equal(result.sessionId,'session1');assert.equal(result.sessionReused,true);assert.equal(result.frameCount,2);assert.deepEqual(h.counts(),{connects:1,launches:0,disconnects:1,closes:0,newPages:0,gotos:0});
});
test('expired session falls back to new browser and reports nonreuse',async()=>{const h=runtime({expired:true});assert.equal((await h.api.acquireObservationBrowser({},'expired')).reused,false);assert.equal(h.counts().launches,1);});
test('non-retained observation closes browser session at completion',async()=>{const h=runtime();const r=await h.api.observe({},'mint','id',1,{},async()=>{},null,{sessionId:'session1',keepSession:false,maxVision:0,skipAnalysis:true});assert.equal(r.sessionId,null);assert.equal(h.counts().closes,1);assert.equal(h.counts().disconnects,0);});
test('stop during capture closes retained browser rather than leaving an orphan session',async()=>{const h=runtime();let running=true;const r=await h.api.observe({},'mint','id',15,{},async()=>{running=false;},null,{sessionId:'session1',keepSession:true,shouldContinue:()=>running,maxVision:0,skipAnalysis:true});assert.equal(r.frameCount,1);assert.equal(r.sessionId,null);assert.equal(h.counts().closes,1);assert.equal(h.counts().disconnects,0);});
