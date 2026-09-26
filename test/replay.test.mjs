import test from 'node:test';
import assert from 'node:assert/strict';
import { observations, candles, replay } from '../public/lab/model.js';
const row=(time,priceUsd=1,volumeUsd=10)=>({id:String(time),time,priceUsd,volumeUsd});
const series=[row(0),row(1000),row(5000,1.1,30),row(6000,1.1,30),row(10000,1.1),row(11000,1.2),row(12000,1.2),row(13000,1.2)];
test('candles preserve OHLC, volume, boundaries and empty gaps',()=>{
 const c=candles(observations([row(0,2),row(500,1),row(999,3),row(2000,4)]),1);
 assert.deepEqual(c[0],{time:0,open:2,high:3,low:1,close:3,volumeUsd:30,count:3});
 assert.equal(c.length,2);assert.equal(c[1].time,2000);
});
test('invalid timestamps, duplicate IDs and negative prices are rejected',()=>{
 assert.throws(()=>observations([row(1),row(0)]));
 assert.throws(()=>observations([row(1),row(1)]));
 assert.throws(()=>observations([row(1),row(2,-1)]));
});
test('signal waits for closed candles and entry waits for execution delay',()=>{
 assert.equal(replay(series.slice(0,4)).pending,null);
 const signal=replay(series.slice(0,5)); assert.equal(signal.pending.side,'buy');assert.equal(signal.position,null);
 const entry=replay(series.slice(0,6));assert.equal(entry.position.openedAt,11000);assert.equal(entry.position.entry,1.2);
});
test('data end never invents liquidation and flat roundtrip loses costs',()=>{
 const open=replay(series.slice(0,6));assert.ok(open.position);assert.equal(open.trades.length,0);
 const closed=replay(series);assert.equal(closed.trades.length,1);assert.ok(closed.trades[0].pnl<0);
 assert.ok(Math.abs(closed.cash-(11+closed.trades[0].pnl))<1e-10);
});
test('observation gap blocks a queued exit, charges attempt and leaves position open',()=>{
 const r=replay([...series.slice(0,6),row(30000,1.2)]);
 assert.equal(r.failed,1);assert.equal(r.trades.length,0);assert.ok(r.position);assert.equal(r.pending.side,'sell');
});
test('future prices cannot change an already recorded entry',()=>{
 const a=replay(series),b=replay([...series.slice(0,6),row(12000,9),row(13000,9)]);
 assert.equal(a.trades[0].quantity,b.trades[0].quantity);assert.equal(a.trades[0].entry,b.trades[0].entry);
});
