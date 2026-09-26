import {summarizeSamples} from './study-analysis';
import type {Sample} from './research-model';

/** Observation-relative windows: they do not imply capture started at token creation. */
export function deriveEarlyWindows(samples:Sample[],startedAt:number,createdAt:number|null=null,availableAt?:number) {
  const observed=samples.filter(s=>Number.isFinite(s.time)&&s.time>=startedAt).sort((a,b)=>a.time-b.time);
  // Never infer availability beyond supplied evidence unless the caller provides its clock.
  const clock=availableAt??observed.at(-1)?.time??startedAt;
  return [60,120].map(seconds=>{
    const cutoffAt=startedAt+seconds*1000;
    const limit=Math.min(cutoffAt,clock);
    const window=observed.filter(s=>s.time<=limit);
    const metrics=summarizeSamples(window,startedAt,createdAt);
    const valid=window.filter(s=>s.priceUsd!==null&&Number.isFinite(s.priceUsd)&&s.priceUsd>0);
    const first=valid[0]?.time??null,last=valid.at(-1)?.time??null;
    const complete=clock>=cutoffAt;
    // Include leading/trailing missing evidence, which internal pairwise gaps omit.
    const leadingGapMs=first===null?Math.max(0,limit-startedAt):first-startedAt;
    const trailingGapMs=last===null?Math.max(0,limit-startedAt):Math.max(0,limit-last);
    const sparse=metrics.validPriceCount<2||metrics.coverageStatus==='sparse'||leadingGapMs>10000||trailingGapMs>10000;
    return {seconds,startedAt,cutoffAt,availableAt:clock,complete,metrics,
      quality:sparse?'sparse':'sampled',leadingGapMs,trailingGapMs,
      clockBasis:'observation-start',detectionDelayMs:metrics.detectionDelayMs,
      warning:'Descriptive early evidence only. No winner probability or trade recommendation; observation time is not launch time.'};
  });
}

/** Later outcomes are deliberately separate from the frozen early feature objects. */
export function compareEarlyWithLater(samples:Sample[],startedAt:number,createdAt:number|null=null,availableAt?:number) {
  const clock=availableAt??Math.max(startedAt,...samples.filter(s=>Number.isFinite(s.time)).map(s=>s.time));
  const bounded=samples.filter(s=>s.time>=startedAt&&s.time<=clock&&s.time<=startedAt+600000);
  const early=deriveEarlyWindows(bounded,startedAt,createdAt,clock);
  return {early,laterOutcomes:early.map(window=>{
    const later=bounded.filter(s=>s.time>window.cutoffAt);
    const metrics=summarizeSamples(later,window.cutoffAt,createdAt);
    const earlyLast=window.metrics.lastPriceUsd;
    return {afterSeconds:window.seconds,fromExclusive:window.cutoffAt,toInclusive:startedAt+600000,
      finalWindowComplete:clock>=startedAt+600000,metrics,
      changeFromEarlyLastPct:earlyLast!==null&&metrics.lastPriceUsd!==null?(metrics.lastPriceUsd/earlyLast-1)*100:null,
      warning:'Hindsight outcome for research comparison only; never an input to the early signal.'};
  }),warning:'These are descriptive matched windows, not a validated predictive model. Preserve failures and test any proposed rule on later unseen launches.'};
}
