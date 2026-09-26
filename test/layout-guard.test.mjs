// Layout guard (Tim, 2026-09-26: "keep it the same or improve it, don't take away unless I ask").
// Baseline = every element, heading and table column on the Studies and Paper pages as of the live version.
// Adding things is fine. If a change removes or renames anything below, this test fails and nothing may be deployed
// until Tim has approved the change and this baseline is updated on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=p=>readFileSync(new URL(`../public/${p}`,import.meta.url),'utf8');
const BASELINE={
 'studies.html':{
  ids:'start-form max-tokens concurrency min-cap launch-filter start status watching-panel watching-count watching paper-panel paper refresh studies detail study-title stop study-status study-notes costs group winner-loser group-analysis live-tokens tokens token-detail token-title refresh-token token-mint token-chart token-metrics early-windows token-chat token-analysis vision-reviews exclusion-form exclusion-reason exclude exclusion-status evidence-status frame play play-speed evidence-image evidence-link token-json overview-panel refresh-overview ledger paper-all overview'.split(' '),
  headings:['Start a bounded study','Watching now','Paper trading: this study','Saved and active studies','Study','Group comparison','Individual tokens','History: all tokens across all studies'],
  nav:['/studies.html','/paper.html','/observer.html'],
 },
 'paper.html':{
  ids:'refresh status improvement trade-strategy trade-show trades ledger paper-all'.split(' '),
  headings:['Results over time','Every trade: P&L per token','Learning loop: ledger, tuner, mistake review and rules history','All studies combined: by exit and launch trait'],
  nav:['/studies.html','/paper.html'],
 },
};
const COLUMNS='20% trail stop|After our exit|All tokens: per trade · total|All tokens: trades · won · avg · total|Avg|Cap first seen|Cases|Chat status|Comments|Comments 0–2m|Comparison|Costliest mistake|Cumulative|Detect delay|Enough samples|Exit|Filter|Filtered: trades · won · avg · total|Filtered: trades · won · per trade · total|Final|First +10%|Frames|Held|Launch|Launch trait|Losers|Mean price change 30s later|Metric|Mistake|Now|Outcome|P&L %|Paper (all)|Paper (filtered)|Peak|Peak → −20%|Peak → −50%|Positive / negative|Repeated words|Review|Rules|Rules / filter used|Rules · filter|Signal that should have changed the call|Source|Status|Study|Tanked (≤−50%)|Time left|Time to peak|Token|Tokens|Total|Trades|What happened after|What went wrong|What went wrong (filtered)|When|Window|Winners (&gt;+7%)|With it: trades · avg · total|Without it|Won|Word'.split('|');

for(const [page,want] of Object.entries(BASELINE)){
 test(`${page}: every original element, heading and nav link is still there`,()=>{
  const html=read(page);
  for(const id of want.ids)assert.ok(html.includes(`id="${id}"`),`${page} lost element #${id}`);
  for(const h of want.headings)assert.ok(html.includes(`>${h}</h2>`),`${page} lost heading "${h}"`);
  for(const href of want.nav)assert.ok(html.includes(`href="${href}"`),`${page} lost nav link ${href}`);
 });
}

test('study-charts.js: every original table column is still rendered',()=>{
 const js=read('study-charts.js');
 for(const c of COLUMNS)assert.ok(js.includes(`>${c}</th>`),`lost table column "${c}"`);
});

test('studies.js still renders every original panel',()=>{
 const js=read('studies.js');
 for(const fn of ['overviewHtml','tokenChartHtml','chatHtml','watchingHtml','tokenTableHtml','paperHtml','ledgerHtml','winnerLoserHtml','analysisHtml','metricsHtml','earlyWindowsHtml'])assert.ok(js.includes(fn+'('),`studies.js no longer calls ${fn}`);
});
