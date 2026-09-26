import {DurableObject} from 'cloudflare:workers';
import {compareEarlyWithLater} from './study-features';
import {observe, scanExplore, browserCapacity, closeSession, type ChatSnapshot, type Frame} from './observer';
import {ingestChat, summarizeChatAsOf, wordMovementAssociations, type ChatState} from './study-chat';
import {freshLaunch, type Candidate} from './research-model';
import {summarizeSamples, analyzeStudy, aggregateStudies, usageFromResponse, compactStudyInput, compactAggregateInput, compareWinnersLosers, priceSeries, exitMetrics, outcomeLabel, launchInfoFromCoin, isTerminalLaunch, COLLECTIVE_PROMPT, type LaunchInfo} from './study-analysis';

type Chunk=Awaited<ReturnType<typeof observe>> & {frames:{index:number;capturedAt:number;key:string}[];chatSnapshots?:ChatSnapshot[]};
type Campaign={id:string;status:string;startedAt:number;admissionEndsAt:number;maxTokens:number;concurrency:number;capacityNote:string;pending:Token[];tokens:number;seenCount:number;skippedCapacity:number;errors:string[];coverageNote:string;lastScanAt:number;seen:string[];browserDurationMs:number;aiEstimatedUsd:number;unknownUsageCalls:number;stoppedAt?:number;analysis?:unknown;analysisStartedAt?:number;analysisExclusions?:string;minMarketCapUsd?:number;launchFilter?:'all'|'terminal';skippedFilter?:number};
type Token={browserSessionId?:string;lastBrowserAccountingAt?:number;lastFrameAt?:number;latestFrame?:{key:string;capturedAt:number};heartbeatAt?:number;phase?:string;lastErrorAt?:number;id:string;campaignId:string;mint:string;name:string;status:string;startedAt:number;endsAt:number;createdAt:number|null;frameCount:number;capturedMs:number;excluded:boolean;exclusionReason:string;candidate:Candidate;mediaPrefix:string;chunks:number;failures:number;browserDurationMs:number;aiEstimatedUsd:number;unknownUsageCalls:number;costIncomplete?:boolean;error?:string;metrics?:ReturnType<typeof summarizeSamples>;earlyWindows?:ReturnType<typeof compareEarlyWithLater>['early'];laterOutcomes?:ReturnType<typeof compareEarlyWithLater>['laterOutcomes'];analysis?:unknown;lastAnalysisAt?:number;analysisHistory?:unknown[];launch?:LaunchInfo|null;series?:[number,number][];chatWindows?:ReturnType<typeof summarizeChatAsOf>[];chatAssociations?:ReturnType<typeof wordMovementAssociations>;exits?:ReturnType<typeof exitMetrics>;finalAnalysisStartedAt?:number};
type StudyEnv=Env & {CRYPTO_STUDY:D1Database;CRYPTO_MEDIA:R2Bucket;RECORDERS:DurableObjectNamespace<StudyRecorder>};
// Launch facts from pump.fun's public coin record at admission; failures stay null and never block recording.
async function fetchLaunchInfo(mint:string):Promise<LaunchInfo|null>{try{const r=await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(3000)});if(!r.ok)return null;return launchInfoFromCoin(await r.json() as Record<string,unknown>,mint);}catch{return null;}}
const COVERAGE='Sampled Explore New feed, at most 20 rows per scan. Not every market launch is visible. Browser reload and analysis gaps are measured; screenshots are not executable trade quotes.';
class StudyStore extends DurableObject<StudyEnv>{
  constructor(ctx:DurableObjectState,env:StudyEnv){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL)');}
  protected read<T>(key:string):T|undefined {const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM state WHERE key=?',key).toArray()[0];return row?JSON.parse(row.data):undefined;}
  protected write(key:string,value:unknown){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO state VALUES (?,?)',key,JSON.stringify(value));}
  protected async saveToken(t:Token){this.write(`token:${t.id}`,t);await this.env.CRYPTO_STUDY.prepare('INSERT OR REPLACE INTO study_tokens VALUES (?,?,?,?)').bind(t.id,t.campaignId,t.startedAt,JSON.stringify(t)).run();}
  async token(id:string){const row=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_tokens WHERE id=?').bind(id).first<{data:string}>();if(!row)throw Error('Token study not found.');const chunks=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_chunks WHERE token_id=? ORDER BY started_at').bind(id).all<{data:string}>();return {token:JSON.parse(row.data),chunks:chunks.results.map(r=>JSON.parse(r.data) as Chunk)};}
}
export class StudyCoordinator extends StudyStore{
  private campaign(){return this.read<Campaign>('current');}
  private async tokens(c:Campaign){const rows=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_tokens WHERE campaign_id=? ORDER BY started_at').bind(c.id).all<{data:string}>();return rows.results.map(r=>JSON.parse(r.data) as Token);}
  private async saveCampaign(c:Campaign){const current=this.campaign();if(current && (current.id!==c.id || (c.status==='running'&&current.status!=='running')))return;this.write('current',c);await this.env.CRYPTO_STUDY.prepare('INSERT OR REPLACE INTO study_campaigns VALUES (?,?,?)').bind(c.id,c.startedAt,JSON.stringify(c)).run();}
  async start(options:{maxTokens?:number;concurrency?:number;minMarketCapUsd?:number;launchFilter?:string}={}){
    const old=this.campaign();if(old&&old.status==='running')throw Error('A study campaign is already running.');
    const maxTokens=options.maxTokens??100,requested=options.concurrency??20;let concurrency=requested;const minMarketCapUsd=options.minMarketCapUsd??0,launchFilter=options.launchFilter==='terminal'?'terminal' as const:'all' as const;if(!Number.isFinite(minMarketCapUsd)||minMarketCapUsd<0||minMarketCapUsd>1e6)throw Error('Minimum market cap must be between $0 and $1,000,000.');
    if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>100||!Number.isInteger(concurrency)||concurrency<1||concurrency>50)throw Error('Choose 1–100 tokens and 1–50 simultaneous observations.');
    const capacity=await browserCapacity(this.env);const availableSlots=capacity.maxConcurrentSessions-capacity.activeSessions.length;if(availableSlots<2)throw Error('Browser capacity unavailable: reserve one scanner and at least one recorder slot.');concurrency=Math.min(requested,availableSlots-1);if(this.campaign()?.status==='running')throw Error('A study campaign is already running.');const now=Date.now();const c:Campaign={id:crypto.randomUUID(),status:'running',startedAt:now,admissionEndsAt:now+1800000,maxTokens,concurrency,capacityNote:`Requested ${requested}; using ${concurrency} token slots plus one scanner. Account maximum ${capacity.maxConcurrentSessions}, currently active ${capacity.activeSessions.length}.`,minMarketCapUsd,launchFilter,skippedFilter:0,pending:[],tokens:0,seenCount:0,skippedCapacity:0,errors:[],coverageNote:COVERAGE,lastScanAt:0,seen:[],browserDurationMs:0,aiEstimatedUsd:0,unknownUsageCalls:0};
    this.write('current',c);await this.ctx.storage.setAlarm(now+1000);await this.saveCampaign(c);return c;
  }
  async status(){const c=this.campaign();return {campaign:c??null,tokens:c?await this.tokens(c):[],nextAlarmAt:await this.ctx.storage.getAlarm()};}
  async list(){const rows=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_campaigns ORDER BY started_at DESC LIMIT 50').all<{data:string}>();return {campaigns:rows.results.map(r=>{const c=JSON.parse(r.data);delete c.seen;return c;})};}
  // Every token across every study, with chart paths and exit metrics; older tokens are back-filled once from saved samples.
  async overview(){const rows=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_tokens ORDER BY started_at DESC LIMIT 1000').all<{data:string}>();const campaigns=new Map((await this.env.CRYPTO_STUDY.prepare('SELECT id,started_at FROM study_campaigns').all<{id:string;started_at:number}>()).results.map(r=>[r.id,r.started_at]));const out=[];for(const r of rows.results){const t=JSON.parse(r.data) as Token;if(t.metrics&&!t.series&&!['watching','queued','capturing','analyzing'].includes(t.status)){const chunks=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_chunks WHERE token_id=? ORDER BY started_at').bind(t.id).all<{data:string}>();const samples=chunks.results.flatMap(c=>(JSON.parse(c.data) as Chunk).samples??[]).map(s=>({time:s.priceReadAt,priceUsd:s.priceUsd}));t.series=priceSeries(samples,t.createdAt??t.startedAt);t.exits=exitMetrics(samples);await this.saveToken(t);}const m=t.metrics;out.push({id:t.id,campaignId:t.campaignId,studyStartedAt:campaigns.get(t.campaignId)??null,name:t.name,mint:t.mint,status:t.status,excluded:t.excluded,outcome:outcomeLabel(m?.changePct),initialCapUsd:t.candidate?.marketCapUsd??null,detectionDelayMs:m?.detectionDelayMs??null,firstRise10PctAfterMs:m?.firstRise10PctAfterMs??null,peakGainPct:m?.peakGainPct??null,peakAfterMs:m?.peakAfterMs??null,maxDrawdownPct:m?.maxDrawdownPct??null,changePct:m?.changePct??null,exits:t.exits??null,launch:t.launch??null,chat120:(()=>{const w=t.chatWindows?.find(w=>w.seconds===120);return !w||w.availability==='not-observed'||w.availability==='unavailable'?null:w.uniqueComments;})(),series:t.series??[]});}return {tokens:out};}
  async detail(id:string){const row=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_campaigns WHERE id=?').bind(id).first<{data:string}>();if(!row)throw Error('Study not found.');const results=await this.env.CRYPTO_STUDY.prepare('SELECT data FROM study_tokens WHERE campaign_id=? ORDER BY started_at').bind(id).all<{data:string}>();const tokens=results.results.map(r=>JSON.parse(r.data));return {campaign:JSON.parse(row.data),tokens,analysisStale:!!JSON.parse(row.data).analysisStartedAt&&JSON.parse(row.data).analysisExclusions!==JSON.stringify(tokens.map((t:Token)=>[t.id,t.excluded,t.exclusionReason]).sort()),aggregate:aggregateStudies(tokens.filter(t=>t.metrics)),winnerLoser:compareWinnersLosers(tokens.filter(t=>t.metrics))};}
  async flag(id:string,excluded:boolean,reason:string){await this.token(id);return this.env.RECORDERS.getByName(id).flag(excluded,reason);}
  async stop(id?:string){const c=this.campaign();if(id&&c?.id!==id)throw Error('Selected campaign is not active.');if(c&&c.status==='running'){c.status='stopped';c.stoppedAt=Date.now();this.write('current',c);await this.ctx.storage.deleteAlarm();await this.saveCampaign(c);const tokens=[...await this.tokens(c),...(c.pending??[])];await Promise.all(tokens.filter(t=>t.status==='watching').map(t=>this.env.RECORDERS.getByName(t.id).stop()));}return this.status();}
  private isRunning(id:string){const c=this.campaign();return c?.id===id&&c.status==='running';}
  private async analyzeCampaign(c:Campaign){
    if(c.analysisStartedAt)return;
    c.analysisStartedAt=Date.now();c.analysisExclusions=JSON.stringify((await this.tokens(c)).map(t=>[t.id,t.excluded,t.exclusionReason]).sort());await this.saveCampaign(c);
    const rows=(await this.tokens(c)).filter((t):t is Token & {metrics:NonNullable<Token['metrics']>}=>!!t.metrics);
    const result=await analyzeStudy(this.env.AI,compactAggregateInput(rows),COLLECTIVE_PROMPT);
    c.analysis=result;c.aiEstimatedUsd+=result.usage.estimatedUsd??0;if(result.usage.estimatedUsd===null)c.unknownUsageCalls++;
    await this.saveCampaign(c);
  }
  async alarm(){const c=this.campaign();if(!c||c.status!=='running')return;await this.ctx.storage.setAlarm(Date.now()+90000);try{
      for(const pending of c.pending??[]){if(!this.isRunning(c.id))return;await this.saveToken(pending);await this.env.RECORDERS.getByName(pending.id).initialize(pending);}
      c.pending=[];await this.saveCampaign(c);
      const active=(await this.tokens(c)).filter(t=>t.status==='watching');c.tokens=(await this.tokens(c)).length;
      if(Date.now()<c.admissionEndsAt&&c.tokens<c.maxTokens&&Date.now()-c.lastScanAt>=30000){
        c.lastScanAt=Date.now();await this.saveCampaign(c);
        const scan=await scanExplore(this.env,{skipSelection:true});if(!this.isRunning(c.id))return;c.browserDurationMs+=scan.browserDurationMs;c.tokens=(await this.tokens(c)).length;
        for(const candidate of scan.candidates){
          if(!this.isRunning(c.id))return;
          if(c.seen.includes(candidate.mint))continue;if(c.minMarketCapUsd&&freshLaunch(candidate,Date.now())&&!((candidate.marketCapUsd??0)>=c.minMarketCapUsd))continue;c.seen.push(candidate.mint);c.seenCount++;
          if(!freshLaunch(candidate,Date.now()))continue;
          if(active.length>=c.concurrency||c.tokens>=c.maxTokens){c.skippedCapacity++;continue;}
          const launch=await fetchLaunchInfo(candidate.mint);if(c.launchFilter==='terminal'&&!isTerminalLaunch(launch)){c.skippedFilter=(c.skippedFilter??0)+1;continue;}const now=Date.now();const t:Token={id:`${c.id}:${candidate.mint}`,campaignId:c.id,mint:candidate.mint,name:candidate.name,status:'watching',startedAt:now,endsAt:now+600000,createdAt:candidate.createdAt,frameCount:0,capturedMs:0,excluded:false,exclusionReason:'',candidate,mediaPrefix:`studies/${c.id}/${candidate.mint}`,chunks:0,failures:0,browserDurationMs:0,aiEstimatedUsd:0,unknownUsageCalls:0,launch};
          c.pending.push(t);await this.saveCampaign(c);await this.saveToken(t);await this.env.RECORDERS.getByName(t.id).initialize(t);c.pending=c.pending.filter(p=>p.id!==t.id);active.push(t);c.tokens++;
        }
        if(scan.errors.length)c.errors.push(...scan.errors);c.errors=c.errors.slice(-20);await this.saveCampaign(c);
      }
      if(!this.isRunning(c.id))return;
      const remaining=(await this.tokens(c)).filter(t=>t.status==='watching');
      if(!remaining.length&&(Date.now()>=c.admissionEndsAt||c.tokens>=c.maxTokens)){await this.analyzeCampaign(c);if(!this.isRunning(c.id))return;c.status='finished';await this.saveCampaign(c);if(this.campaign()?.id===c.id)await this.ctx.storage.deleteAlarm();}
      else if(this.isRunning(c.id))await this.ctx.storage.setAlarm(Date.now()+10000);
    }catch{if(this.isRunning(c.id)){c.errors.push('Discovery step failed; retained evidence and retry scheduled.');c.errors=c.errors.slice(-20);await this.saveCampaign(c);if(this.isRunning(c.id))await this.ctx.storage.setAlarm(Date.now()+10000);}}
  }
}
export class StudyRecorder extends StudyStore {
  private current(){const id=this.read<string>('token-id');return id?this.read<Token>(`token:${id}`):undefined;}
  private isRunning(_campaignId:string){return this.current()?.status==='watching'&&!this.read<boolean>('stopped');}
  async initialize(t:Token){if(this.read<boolean>('stopped')){t.status='stopped';await this.saveToken(t);return;}const existing=this.current();if(!existing){this.write('token-id',t.id);await this.saveToken(t);}else await this.saveToken(existing);if(this.current()?.status==='watching'&&!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(Date.now()+1000);}
  async status(){return this.current()??null;}
  private accountBrowser(t:Token){const now=Date.now();if(t.lastBrowserAccountingAt!==undefined)t.browserDurationMs+=Math.max(0,now-t.lastBrowserAccountingAt);t.lastBrowserAccountingAt=t.browserSessionId?now:undefined;}
  private async releaseBrowser(t:Token){if(t.browserSessionId){try{await closeSession(this.env,t.browserSessionId);}catch{t.costIncomplete=true;}this.accountBrowser(t);t.browserSessionId=undefined;t.lastBrowserAccountingAt=undefined;await this.saveToken(t);}}
  async stop(){this.write('stopped',true);await this.ctx.storage.deleteAlarm();const t=this.current();if(t){t.status='stopped';t.phase='stopped';t.heartbeatAt=Date.now();await this.saveToken(t);await this.releaseBrowser(t);}return t??null;}
  async flag(excluded:boolean,reason:string){if(excluded&&!reason.trim())throw Error('An exclusion reason is required.');let t=this.current();if(!t)throw Error('Token recorder unavailable.');t.excluded=excluded;t.exclusionReason=reason.slice(0,500);await this.saveToken(t);return t;}
  private async analyzeToken(t:Token,final:boolean){
    const latest=this.read<Token>(`token:${t.id}`);if(latest?.status==='stopped'||!this.isRunning(t.campaignId))return;
    if(latest){t.excluded=latest.excluded;t.exclusionReason=latest.exclusionReason;}
    // Persist the attempt before billing; alarm retries must not repeat this call.
    t.lastAnalysisAt=Date.now();t.heartbeatAt=Date.now();t.phase='analyzing';await this.saveToken(t);
    const data=await this.token(t.id);const chunks=data.chunks;
    t.frameCount=chunks.reduce((n,c)=>n+(c.frames?.length??0),0);
    t.capturedMs=chunks.reduce((n,c)=>n+(c.measurements?.durationMs??Math.max(0,(c.samples?.at(-1)?.priceReadAt??0)-(c.samples?.[0]?.priceReadAt??0))),0);
    if(chunks.some(c=>!Array.isArray(c.usage)||!Number.isFinite(c.browserDurationMs)))t.costIncomplete=true;
    const samples=chunks.flatMap(c=>c.samples??[]).map(s=>({time:s.priceReadAt,priceUsd:s.priceUsd})).sort((a,b)=>a.time-b.time);
    const elapsedMs=Math.max(0,Math.min(Date.now(),t.endsAt)-t.startedAt);
    const coverage={elapsedMs,capturedMs:t.capturedMs,gapMs:Math.max(0,elapsedMs-t.capturedMs),frameCount:t.frameCount};
    t.metrics=summarizeSamples(samples,t.startedAt,t.createdAt,coverage);const windows=compareEarlyWithLater(samples,t.startedAt,t.createdAt,Date.now());t.earlyWindows=windows.early;t.laterOutcomes=windows.laterOutcomes;t.series=priceSeries(samples,t.createdAt??t.startedAt);t.exits=exitMetrics(samples);
    // Rebuild public chat chronologically from saved snapshots. Absent snapshots stay absent, never neutral.
    let chat:ChatState|undefined;for(const c of chunks.flatMap(c=>c.chatSnapshots??[]).sort((a,b)=>a.capturedAt-b.capturedAt))chat=await ingestChat(chat,{mint:t.mint,observedAt:c.capturedAt,availability:c.status,comments:c.messages.map(m=>({text:m.text,publishedAt:m.publishedAt?Date.parse(m.publishedAt):null}))});
    if(chat){const asOf=Date.now();t.chatWindows=([60,120,600] as const).map(sec=>summarizeChatAsOf(chat!,t.startedAt,sec,asOf));t.chatAssociations=wordMovementAssociations(chat.observations,samples,asOf);}
    const result=await analyzeStudy(this.env.AI,compactStudyInput({id:t.id,mint:t.mint,metrics:t.metrics,reviews:chunks.flatMap(c=>c.reviews??[]),coverage,candidate:t.candidate,phase:final?'final':'interim',earlyWindows:t.earlyWindows,laterOutcomes:t.laterOutcomes,launch:t.launch,chatWindows:t.chatWindows,chatAssociations:t.chatAssociations}));
    const current=this.read<Token>(`token:${t.id}`)??t;t.excluded=current.excluded;t.exclusionReason=current.exclusionReason;
    t.aiEstimatedUsd+=result.usage.estimatedUsd??0;if(result.usage.estimatedUsd===null)t.unknownUsageCalls++;
    t.analysis=result;t.analysisHistory=[...(t.analysisHistory??[]),{at:Date.now(),phase:final?'final':'interim',...result}].slice(-6);
    if(current.status==='stopped')t.status='stopped';
    else if(final)t.status=t.failures>=3?'failed':'finished';
    t.phase=t.status==='watching'?'capturing':t.status;t.heartbeatAt=Date.now();
    await this.saveToken(t);
  }
  private async finish(t:Token){
    await this.releaseBrowser(t);
    if(t.finalAnalysisStartedAt){t.analysis={analysis:null,error:'Final analysis was interrupted; it was not billed again automatically.'};t.status=t.failures>=3?'failed':'finished';await this.saveToken(t);return;}
    t.finalAnalysisStartedAt=Date.now();await this.saveToken(t);await this.analyzeToken(t,true);
  }
  private async chunk(t:Token){
    // Claim the ordinal durably before external work. A retry never replays the same paid chunk.
    const baselineFrameCount=t.frameCount;let lastProgressAt=0;const ordinal=t.chunks++;t.phase='loading';t.heartbeatAt=Date.now();await this.saveToken(t);if(!this.isRunning(t.campaignId))return;const id=`${t.id}:${ordinal}`;
    const frames:{index:number;capturedAt:number;key:string}[]=[];const chatSnapshots:ChatSnapshot[]=[];const partialSamples:Omit<Frame,'image'|'text'>[]=[];
    const report=await observe(this.env,t.mint,id,Math.max(1,Math.min(15,Math.floor((t.endsAt-Date.now())/1000))),undefined,async(frame:Frame)=>{
      const key=`${t.mediaPrefix}/${ordinal}/${frame.index}.jpg`;
      const raw=Uint8Array.from(atob(frame.image),c=>c.charCodeAt(0));
      await this.env.CRYPTO_MEDIA.put(key,raw,{httpMetadata:{contentType:'image/jpeg'}});
      frames.push({index:frame.index,capturedAt:frame.capturedAt,key});t.latestFrame={key,capturedAt:frame.capturedAt};t.lastFrameAt=frame.capturedAt;t.heartbeatAt=Date.now();t.phase='capturing';if(Date.now()-lastProgressAt>=5000){const current=this.current();if(current){t.excluded=current.excluded;t.exclusionReason=current.exclusionReason;if(current.status==='stopped'){t.status='stopped';t.phase='stopped';}}t.frameCount=baselineFrameCount+frames.length;await this.saveToken(t);lastProgressAt=Date.now();}const {image:_image,text:_text,...sample}=frame;partialSamples.push(sample);
      // Persist an incremental manifest so an interrupted chunk still exposes its saved evidence.
      await this.env.CRYPTO_STUDY.prepare('INSERT OR REPLACE INTO study_chunks VALUES (?,?,?,?)').bind(id,t.id,frames[0].capturedAt,JSON.stringify({id,startedAt:frames[0].capturedAt,frames,samples:partialSamples,chatSnapshots,failure:'Chunk in progress or interrupted'})).run();
    },null,{maxVision:1,skipAnalysis:true,allowOlder:true,endAt:t.endsAt,sessionId:t.browserSessionId,keepSession:true,captureChat:true,onChat:async snapshot=>{chatSnapshots.push(snapshot);await this.env.CRYPTO_STUDY.prepare('INSERT OR REPLACE INTO study_chunks VALUES (?,?,?,?)').bind(id,t.id,frames[0]?.capturedAt??Date.now(),JSON.stringify({id,startedAt:frames[0]?.capturedAt??Date.now(),frames,samples:partialSamples,chatSnapshots,failure:'Chunk in progress or interrupted'})).run();},shouldContinue:()=>this.isRunning(t.campaignId),onSession:async(sessionId,reused)=>{if(!this.isRunning(t.campaignId)){await closeSession(this.env,sessionId);throw Error('Recorder stopped.');}if(!reused&&t.browserSessionId)t.costIncomplete=true;this.accountBrowser(t);t.browserSessionId=sessionId;t.lastBrowserAccountingAt=Date.now();await this.saveToken(t);}});
    const chunk={...report,frames};await this.env.CRYPTO_STUDY.prepare('INSERT OR REPLACE INTO study_chunks VALUES (?,?,?,?)').bind(id,t.id,report.startedAt,JSON.stringify(chunk)).run();
    // Preserve user edits or a stop arriving while capture was in flight.
    const current=this.read<Token>(`token:${t.id}`)??t;t.excluded=current.excluded;t.exclusionReason=current.exclusionReason;
    if(current.status==='stopped')t.status='stopped';
    t.frameCount=baselineFrameCount+frames.length;t.capturedMs+=report.measurements.durationMs;t.browserDurationMs=current.browserDurationMs;t.lastBrowserAccountingAt=current.lastBrowserAccountingAt;t.browserSessionId=current.browserSessionId;this.accountBrowser(t);t.browserSessionId=report.sessionId??undefined;if(!t.browserSessionId)t.lastBrowserAccountingAt=undefined;for(const raw of report.usage){const usage=usageFromResponse({usage:raw});t.aiEstimatedUsd+=usage.estimatedUsd??0;if(usage.estimatedUsd===null)t.unknownUsageCalls++;}
    if(report.failure){t.failures++;t.error=report.failure;}
    await this.saveToken(t);
    if(t.status==='watching'&&Date.now()-(t.lastAnalysisAt??t.startedAt)>=120000&&Date.now()<t.endsAt)await this.analyzeToken(t,false);
  }
  async alarm(){let t=this.current();if(!t||!this.isRunning(t.campaignId))return;await this.ctx.storage.setAlarm(Date.now()+90000);try{if(Date.now()>=t.endsAt||t.failures>=3){await this.finish(t);}else await this.chunk(t);}catch(error){console.error('Study recorder step failed',error instanceof Error?error.message.slice(0,300):'Unknown error');t=this.current()??t;t.failures++;t.costIncomplete=true;t.lastErrorAt=Date.now();t.heartbeatAt=Date.now();t.phase='failed';t.error='Capture or persistence interrupted; available evidence retained.';await this.saveToken(t);}t=this.current()??t;if(this.isRunning(t.campaignId))await this.ctx.storage.setAlarm(Date.now()+1000);else await this.ctx.storage.deleteAlarm();}
}
