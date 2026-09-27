import test from 'node:test';import assert from 'node:assert/strict';
const nodes={};globalThis.document={getElementById:id=>id==='study-panel'?null:nodes[id]??={disabled:false,textContent:'',innerHTML:''}};
const {render,tokenRow}=await import('../public/observer-study.js');
const now=1_000_000_000;
const tok=(i,extra={})=>({mint:'M'+i,name:'T'+i,status:'watching',createdAt:now-300000,startedAt:now-290000,endsAt:now+310000,frameCount:100+i,lastFrameAt:now-1000,...extra});
test('panel shows every concurrently watched token and slot usage',()=>{
 const running=render({campaign:{status:'running',concurrency:20,maxTokens:100,seenCount:40,skippedCapacity:2,admissionEndsAt:now+60000},tokens:[tok(1),tok(2),tok(3,{status:'finished'})]},now);
 assert.equal(running,true);assert.match(nodes['study-summary'].textContent,/2 watching now of 20 slots · 3\/100 tokens/);
 assert.equal((nodes['study-live'].innerHTML.match(/<article/g)||[]).length,3);assert.equal(nodes['study-start'].disabled,true);
});
test('token row escapes names and reports launch lag and time left',()=>{
 const html=tokenRow(tok(1,{name:'<img onerror=x>'}),now);assert.ok(!html.includes('<img onerror'));assert.match(html,/started 10s after launch/);assert.match(html,/310s left/);
});
test('no campaign invites a start',()=>{assert.equal(render({campaign:null,tokens:[]},now),false);assert.match(nodes['study-summary'].textContent,/Press Start/);});
