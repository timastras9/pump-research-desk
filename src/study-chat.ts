export type PublicTokenComment={id?:string;text:string;publishedAt?:number|null};
export type ChatObservation={id:string;mint:string;text:string;firstObservedAt:number;publishedAt:number|null};
export type ChatSnapshot={mint:string;observedAt:number;availability:'available'|'unavailable';comments:PublicTokenComment[]};
export type ChatState={mint:string;observations:ChatObservation[];checks:{observedAt:number;availability:'available'|'unavailable';visibleCount:number}[];overflowObservationAttempts:number};
const MAX_COMMENTS=300,MAX_CHECKS=1200,MAX_TEXT=1000;
const positive=new Set(['bullish','moon','pump','buy','buying','strong','good','great','holding','hold','up','send']);
const negative=new Set(['bearish','rug','scam','sell','selling','dump','dead','bad','down','exit']);
const stop=new Set(['the','and','this','that','with','from','have','has','for','are','was','you','your','its','it','is','to','of','a','an','on','in','we','will','be','just','not','but','at','as']);
const words=(text:string)=>text.toLowerCase().replace(/https?:\/\/\S+/g,' ').match(/[a-z][a-z0-9]{1,29}/g)??[];
function normalized(text:string){return text.replace(/\s+/g,' ').trim().slice(0,MAX_TEXT);}
// Stable content identity when the public source does not expose a comment id.
async function digest(text:string){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function ingestChat(previous:ChatState|undefined,snapshot:ChatSnapshot):Promise<ChatState>{
  if(!snapshot.mint||!Number.isFinite(snapshot.observedAt))throw Error('Token and observation time required');
  if(previous&&previous.mint!==snapshot.mint)throw Error('Cannot mix token chat');
  const state:ChatState=previous?{...previous,observations:[...previous.observations],checks:[...previous.checks]}:{mint:snapshot.mint,observations:[],checks:[],overflowObservationAttempts:0};
  const known=new Set(state.observations.map(c=>c.id));
  let visibleCount=0;
  if(snapshot.availability==='available')for(const raw of snapshot.comments.slice(0,MAX_COMMENTS)){
    const text=normalized(raw.text);if(!text)continue;visibleCount++;
    const publishedAt=typeof raw.publishedAt==='number'&&Number.isFinite(raw.publishedAt)&&raw.publishedAt>=0&&raw.publishedAt<=snapshot.observedAt?raw.publishedAt:null;
    const id=raw.id?`source:${raw.id.slice(0,160)}`:`text:${await digest(JSON.stringify([text,publishedAt]))}`;
    if(known.has(id))continue;known.add(id);
    if(state.observations.length>=MAX_COMMENTS){state.overflowObservationAttempts++;continue;}
    state.observations.push({id,mint:snapshot.mint,text,firstObservedAt:snapshot.observedAt,publishedAt});
  }
  state.checks.push({observedAt:snapshot.observedAt,availability:snapshot.availability,visibleCount});
  state.checks=state.checks.slice(-MAX_CHECKS);
  return state;
}
export function summarizeChatAsOf(state:ChatState,startedAt:number,seconds:60|120|600,availableAt:number){
  const cutoffAt=startedAt+seconds*1000,limit=Math.min(cutoffAt,availableAt);
  const checks=state.checks.filter(c=>c.observedAt>=startedAt&&c.observedAt<=limit);
  const latest=checks.at(-1),availableChecks=checks.filter(c=>c.availability==='available');
  const observations=state.observations.filter(c=>c.firstObservedAt>=startedAt&&c.firstObservedAt<=limit);
  const terms=new Map<string,number>();let positiveComments=0,negativeComments=0,mixedComments=0,neutralComments=0;
  for(const c of observations){const tokens=words(c.text),unique=new Set(tokens);let pos=0,neg=0;for(const w of tokens){if(positive.has(w))pos++;if(negative.has(w))neg++;}if(pos&&neg)mixedComments++;else if(pos)positiveComments++;else if(neg)negativeComments++;else neutralComments++;
    for(const w of unique)if(!stop.has(w))terms.set(w,(terms.get(w)??0)+1);
  }
  return {mint:state.mint,seconds,cutoffAt,complete:availableAt>=cutoffAt,
    availability:availableChecks.length?observations.length?'observed-comments':'observed-empty':latest?'unavailable':'not-observed',
    latestCheck:latest?.availability??null,uniqueComments:observations.length,availableChecks:availableChecks.length,unavailableChecks:checks.length-availableChecks.length,
    sentiment:{method:'English keyword heuristic; not a language model',positiveComments,negativeComments,mixedComments,neutralComments},
    repeatedTerms:[...terms].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,20).map(([term,commentCount])=>({term,commentCount})),
    cap:MAX_COMMENTS,overflowObservationAttempts:state.overflowObservationAttempts,overflowCountMeaning:'Repeated attempts beyond retention capacity, not unique dropped comments',historyTruncated:state.checks.length===MAX_CHECKS,
    warning:'Public token-specific comments only. First observed time is not publication time. Identical text without source ids or distinct valid publication timestamps is deduplicated and may undercount people. Keywords miss sarcasm, negation and non-English sentiment; spam can distort associations. No causal or profitability claim.'};
}

export function wordMovementAssociations(observations:ChatObservation[],samples:{time:number;priceUsd:number|null}[],asOf:number) {
  const prices=samples.filter(s=>s.time<=asOf&&Number.isFinite(s.time)&&s.priceUsd!==null&&Number.isFinite(s.priceUsd)&&s.priceUsd>0).sort((a,b)=>a.time-b.time) as {time:number;priceUsd:number}[];
  const terms=new Map<string,{count:number;sum:number;positive:number}>();let matchedComments=0;
  for(const comment of observations.filter(c=>c.firstObservedAt<=asOf).slice(0,MAX_COMMENTS)){
    const time=comment.firstObservedAt,target=time+30000;
    const base=prices.filter(p=>p.time<=time&&time-p.time<=5000).at(-1);
    const later=prices.find(p=>p.time>=target&&p.time-target<=5000);
    if(!base||!later)continue;
    const change=(later.priceUsd/base.priceUsd-1)*100;if(!Number.isFinite(change))continue;matchedComments++;
    for(const term of new Set(words(comment.text)))if(!stop.has(term)){
      const a=terms.get(term)??{count:0,sum:0,positive:0};a.count++;a.sum+=change;if(change>0)a.positive++;terms.set(term,a);
    }
  }
  return {horizonSeconds:30,maxMatchingGapSeconds:5,matchedComments,
    terms:[...terms].sort((a,b)=>b[1].count-a[1].count||a[0].localeCompare(b[0])).slice(0,20).map(([term,a])=>({term,count:a.count,meanObservedChangePct:a.sum/a.count,positiveChanges:a.positive,minimumCountMet:a.count>=5})),
    minimumDescriptiveCount:5,warning:'Exploratory associations, not causal or predictive evidence. Overlapping comments and price windows are dependent; count is not independent sample size. Multiple comparisons, spam and rounded prices can mislead. Not executable returns or profitability.'};
}
