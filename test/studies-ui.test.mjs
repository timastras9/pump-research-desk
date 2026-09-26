import test from 'node:test';
import assert from 'node:assert/strict';
import {comparison,esc} from '../public/studies.js';
test('group comparison retains excluded losses and separates missing values',()=>{
 const rows=[{metrics:{changePct:20}},{excluded:true,metrics:{changePct:-80}},{metrics:{}},{metrics:{changePct:0}},{metrics:{changePct:NaN}}];
 const r=comparison(rows);assert.equal(r.all.count,5);assert.equal(r.all.measured,3);assert.equal(r.all.average,-20);assert.equal(r.all.median,0);assert.equal(r.included.measured,2);assert.equal(r.included.average,10);assert.equal(rows.length,5);
});
test('empty comparison has no invented zero return',()=>{assert.equal(comparison([]).all.average,null);});
test('untrusted token labels are escaped',()=>{assert.equal(esc('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');});

test('early windows keep absent values unknown and escape quality labels',async()=>{
 const {earlyWindowsHtml}=await import('../public/studies.js');
 const html=earlyWindowsHtml([{seconds:60,metrics:{validPriceCount:0,changePct:null,peakGainPct:null,firstRise10PctAfterMs:null,coverageStatus:'<unsafe>'}}]);
 assert.match(html,/60 sec/);assert.match(html,/Not observed/);assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/0\.00%/);
});

test('health flags capture gaps without labeling finished tokens stalled',async()=>{
 const {tokenHealth}=await import('../public/studies.js');
 assert.equal(tokenHealth({status:'watching',startedAt:0,lastFrameAt:1000,endsAt:600000},62000).stale,true);
 assert.equal(tokenHealth({status:'watching',startedAt:0,endsAt:600000},62000).stale,true);
 assert.equal(tokenHealth({status:'watching',startedAt:0,lastFrameAt:61000,endsAt:600000},62000).stale,false);
 assert.equal(tokenHealth({status:'finished',startedAt:0,lastFrameAt:1000,endsAt:600000},900000).stale,false);
 assert.equal(tokenHealth({status:'watching',startedAt:0,endsAt:600000},300000).progress,50);
});


test('chat renders availability distinctly and escapes words without raw usernames',async()=>{
 const {chatHtml}=await import('../public/studies.js');
 const html=chatHtml([{seconds:60,complete:true,availability:'observed-empty',uniqueComments:0,sentiment:{},repeatedTerms:[{term:'<script>',commentCount:2}],username:'PRIVATE-NAME'}],null);
 assert.match(html,/Feed available; no comments observed/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/PRIVATE-NAME/);assert.match(chatHtml([],null),/not been observed/);
});
