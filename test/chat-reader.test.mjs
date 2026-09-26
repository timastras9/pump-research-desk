import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
// Draft test can run before applying the source patch; after application it reads production source.
let source=readFileSync(new URL('../src/observer.ts',import.meta.url),'utf8');
if(!source.includes('export async function readTokenChat'))source=readFileSync(new URL('../artifacts/chat-capture.patch',import.meta.url),'utf8').split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).map(line=>line.slice(1)).join('\n');
const helper=source.match(/export async function readTokenChat[\s\S]*?\n}\n/)[0];
const code=ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};new Function('exports',code)(exports);
function card(text,{reply=false}={}){return {parentElement:{closest:()=>reply?{}:null},querySelector(selector){if(selector==='p[data-testid="callout-note"]')return {textContent:text};if(selector==='time')return {getAttribute:()=> '2026-09-26T07:00:00Z'};throw Error(`Unexpected selector ${selector}`);}};}
function page(cards,{panel=true,list=true}={}){
 const queries=[];
 const document={querySelector(selector){queries.push(selector);assert.equal(selector,'[data-testid="coin-callouts-feed-panel"]','Never read the global/sidebar feed');if(!panel)return null;return {querySelector(s){assert.equal(s,'ul[aria-label="Callouts for this coin"]');return list?{querySelectorAll(s){assert.equal(s,'article[data-testid="coin-callouts-feed-card"]');return cards;}}:null;}};}};
 return {queries,evaluate:async fn=>new Function('document',`return (${fn.toString()})();`)(document)};
}
test('chat reader uses only token panel, extracts main note/time, and excludes nested reply cards',async()=>{
 const p=page([card('Primary note'),card('Nested reply',{reply:true})]);const result=await exports.readTokenChat(p);assert.equal(result.status,'available');assert.deepEqual(result.messages,[{text:'Primary note',publishedAt:'2026-09-26T07:00:00Z'}]);assert.equal(p.queries.length,1);assert.equal(JSON.stringify(result).includes('portfolio'),false);
});
test('chat reader bounds each capture to 30 cards and 1000 characters',async()=>{const p=page(Array.from({length:35},()=>card('a'.repeat(2000))));const result=await exports.readTokenChat(p);assert.equal(result.messages.length,30);assert.ok(result.messages.every(m=>m.text.length===1000));});
test('missing panel or list is unavailable; visible empty list is available with zero messages',async()=>{assert.equal((await exports.readTokenChat(page([],{panel:false}))).status,'unavailable');assert.equal((await exports.readTokenChat(page([],{list:false}))).status,'unavailable');assert.deepEqual((await exports.readTokenChat(page([]))).messages,[]);assert.equal((await exports.readTokenChat(page([]))).status,'available');});
test('browser evaluation failure becomes unavailable and does not invent comments',async()=>{const result=await exports.readTokenChat({evaluate:async()=>{throw Error('Detached');}});assert.equal(result.status,'unavailable');assert.deepEqual(result.messages,[]);});
