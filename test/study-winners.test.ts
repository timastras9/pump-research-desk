import test from 'node:test';
import assert from 'node:assert/strict';
import {compareWinnersLosers,compactAggregateInput,launchInfoFromCoin,isTerminalLaunch,summarizeSamples,type AggregateRow,type LaunchInfo} from '../src/study-analysis';

const metrics=(start:number,end:number)=>summarizeSamples([{time:1,priceUsd:start},{time:2,priceUsd:end}],0,null,{capturedMs:600000,elapsedMs:600000});
const launch=(tool:string,extra:Partial<LaunchInfo>={}):LaunchInfo=>({twitter:false,website:false,telegram:false,mayhem:false,launchTool:tool,pumpSuffix:true,creator:null,...extra});
const row=(id:string,end:number,l:LaunchInfo|null,cap=3500):AggregateRow=>({id,mint:id,metrics:metrics(1,end),candidate:{marketCapUsd:cap},launch:l});

test('launch facts come from creation fields only and classify terminals',()=>{
 const l=launchInfoFromCoin({image_uri:'https://edge.uxento.io/image/x',twitter:'',website:'https://x.com/a/status/1',mayhem_state:'completed',creator:'C',ath_market_cap:28983},'Mintpump');
 assert.deepEqual(l,{twitter:false,website:true,telegram:false,mayhem:true,launchTool:'uxento',pumpSuffix:true,creator:'C',feeRouted:false,bulkSpam:false});
 assert.equal(launchInfoFromCoin({description:'Fees to @pumpfun via UsePaid'},'M').feeRouted,true);
 assert.equal(launchInfoFromCoin({description:'Launched on discord.gg/uxento'},'M').bulkSpam,true);
 assert.equal(isTerminalLaunch(l),true);
 assert.equal(isTerminalLaunch(launchInfoFromCoin({image_uri:'https://ipfs.io/ipfs/abc'},'M')),false);
 assert.equal(launchInfoFromCoin({image_uri:'https://usepaid.app/api/launch/image/1'},'M').launchTool,'usepaid');
 assert.equal(isTerminalLaunch(null),false);
});

test('winner, loser and tanked counts are computed in code from entry-time features',()=>{
 const rows=[row('w1',3.1,launch('uxento'),3500),row('w2',2.4,launch('axiom',{twitter:true}),10700),row('l1',1,launch('pump-ipfs')),row('t1',0.1,launch('pump-ipfs',{mayhem:true})),{...row('x',5,launch('axiom')),excluded:true}];
 const c=compareWinnersLosers(rows);
 assert.equal(c.winners,2);assert.equal(c.losers,2);assert.equal(c.tanked,1);
 const f=Object.fromEntries(c.features.map(([k,...v])=>[k,v]));
 assert.deepEqual(f.terminal_launch,['2/2','0/2','0/1']);
 assert.deepEqual(f.mayhem_mode,['0/2','1/2','1/1']);
 assert.deepEqual(f.initial_cap_at_least_6000_usd,['1/2','0/2','0/1']);
 assert.deepEqual(f.launch_tool_uxento,['1/2','0/2','0/1']);
});

test('collective input labels every row and stays under the payload cap at 100 tokens',()=>{
 const rows=Array.from({length:120},(_,i)=>row('So1anaMint'+String(i).padStart(34,'x'),i%10===0?2:0.3,launch(i%3?'pump-ipfs':'axiom',{twitter:!!(i%2),mayhem:i%4===0})));
 const input=compactAggregateInput(rows);
 assert.ok(JSON.stringify(input).length<24000,`payload ${JSON.stringify(input).length}`);
 assert.equal(input.table.length,100);
 const col=input.columns.indexOf('outcome_W_winner_L_loser');assert.ok(col>0);assert.equal(input.table[0][col],'W');assert.equal(input.table[1][col],'L');
 assert.equal(input.winnerLoserComparison.winners,12);
});

test('chat traits are compared and missing chat never counts as quiet chat',async()=>{
 const {compactChat}=await import('../src/study-analysis');
 const cw=(n:number,pos:number,neg:number)=>[60,120,600].map(seconds=>({seconds,availability:n?'observed-comments':'observed-empty',uniqueComments:n,sentiment:{positiveComments:pos,negativeComments:neg},repeatedTerms:[{term:'moon',commentCount:2},{term:'send',commentCount:2}]}));
 const rows=[{...row('w',3,launch('axiom')),chatWindows:cw(4,3,0)},{...row('l',1,launch('pump-ipfs')),chatWindows:cw(0,0,0)},{...row('t',0.1,launch('pump-ipfs'))}];
 const f=Object.fromEntries(compareWinnersLosers(rows).features.map(([k,...v])=>[k,v]));
 // The tanked row is also a loser, but without chat it is left out of every denominator.
 assert.deepEqual(f.chat_observed,['1/1','1/1','0/0']);
 assert.deepEqual(f.any_comment_first_120s,['1/1','0/1','0/0']);
 assert.deepEqual(f.positive_outnumbers_negative_120s,['1/1','0/0','0/0']);
 assert.deepEqual(compactChat(undefined),{availability:'not-observed'});
 const many=Array.from({length:100},(_,i)=>({...row('So1anaMint'+String(i).padStart(34,'x'),i%10===0?2:0.3,launch('axiom',{twitter:true})),chatWindows:cw(120,60,30)}));
 const size=JSON.stringify(compactAggregateInput(many)).length;assert.ok(size<24000,`payload ${size}`);
});
