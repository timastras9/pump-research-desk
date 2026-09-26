import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatesFromFeed} from '../src/launch-feed';

test('launch feed rows become fresh-launch candidates; bad rows and future timestamps are dropped',()=>{
 const now=1_790_000_000_000;
 const rows=[{mint:'5Ctf4jNKMPcK9zP6PSFHqga8vMoabjxN9qeZS5Nzpump',name:'What if',symbol:'IF',created_timestamp:now-3400,usd_market_cap:3510,ath_market_cap:4000,creator:'EA3d',image_uri:'https://edge.uxento.io/i'},
  {mint:'not a mint',created_timestamp:now},{mint:'phzs2KUHXUNcRJXQqJacELx1sazHEKHH9tjAFPLpump',name:'Future',created_timestamp:now+5000},null];
 const c=candidatesFromFeed(rows,now);
 assert.equal(c.length,2);
 assert.deepEqual({mint:c[0].mint,group:c[0].group,createdAt:c[0].createdAt,cap:c[0].marketCapUsd,source:c[0].raw.source,image:c[0].raw.imageUri},{mint:'5Ctf4jNKMPcK9zP6PSFHqga8vMoabjxN9qeZS5Nzpump',group:'new',createdAt:now-3400,cap:3510,source:'pump-api',image:'https://edge.uxento.io/i'});
 assert.equal(c[1].createdAt,null,'future timestamps are not trusted');
 assert.equal(candidatesFromFeed({coins:rows},now).length,2);
 assert.deepEqual(candidatesFromFeed({error:'x'},now),[]);
});
