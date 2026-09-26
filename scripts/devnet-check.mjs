import { readFile, writeFile } from 'node:fs/promises';
import { CdpClient } from '@coinbase/cdp-sdk';
import { address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

// Deliberately fixed endpoint and separate named accounts. No mainnet override.
const endpoint = 'https://api.devnet.solana.com';
const dir = new URL('../.secrets/', import.meta.url);
process.env.DISABLE_CDP_ERROR_REPORTING = 'true';
let stage = 'credentials';
const report = { network: 'devnet', startedAt: new Date().toISOString(), transfers: [], status: 'incomplete' };
async function save() { await writeFile(new URL('devnet-check.json', dir), JSON.stringify(report, null, 2), { mode: 0o600 }); }
async function rpc(method, params = []) {
  const response = await fetch(endpoint, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal: AbortSignal.timeout(10000) });
  const data = await response.json(); if (!response.ok || data.error) throw Error('Devnet RPC rejected request'); return data.result;
}
async function confirmed(signature) {
  for (let i=0;i<20;i++) {
    const result = await rpc('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]); const value=result.value[0];
    if(value?.err) throw Error('Devnet transaction failed');
    if(['confirmed','finalized'].includes(value?.confirmationStatus)) return;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error('Confirmation timeout; inspect saved signature before retrying');
}
try {
  const keys=JSON.parse(await readFile(new URL('coinbase.json',dir),'utf8'));
  const walletSecret=(await readFile(new URL('cdp_wallet_secret.txt',dir),'utf8')).trim();
  const cdp=new CdpClient({apiKeyId:keys.COINBASE_API_KEY_NAME,apiKeySecret:keys.COINBASE_API_PRIVATE_KEY,walletSecret});
  stage='retrieve devnet test wallets';
  const account=await cdp.solana.getOrCreateAccount({name:'momentum-devnet-cash'});
  const escrow=await cdp.solana.getOrCreateAccount({name:'momentum-devnet-position'});
  report.cashWallet=account.address;report.positionWallet=escrow.address;await save();
  stage='devnet faucet';
  for(const a of [account,escrow]) {
    const b=await rpc('getBalance',[a.address,{commitment:'confirmed'}]);
    if(b.value<2000000) { const {signature}=await cdp.solana.requestFaucet({address:a.address,token:'sol'});await confirmed(signature); }
  }
  async function transfer(from,to,label) {
    stage=label+' / blockhash';
    const {value:lifetime}=await rpc('getLatestBlockhash',[{commitment:'confirmed'}]);
    stage=label+' / build';
    const message=pipe(createTransactionMessage({version:0}),t=>setTransactionMessageFeePayer(address(from.address),t),t=>setTransactionMessageLifetimeUsingBlockhash(lifetime,t),t=>appendTransactionMessageInstructions([getTransferSolInstruction({source:createNoopSigner(address(from.address)),destination:address(to.address),amount:1000000n})],t));
    const transaction=getBase64EncodedWireTransaction(compileTransaction(message));
    stage=label+' / sign';
    const signed=await cdp.solana.signTransaction({address:from.address,transaction});
    const wire=signed.signedTransaction ?? signed.signature;
    if(typeof wire!=='string') throw Error('Missing signed transaction');
    stage=label+' / simulate';
    const simulation=await rpc('simulateTransaction',[wire,{encoding:'base64',sigVerify:true,commitment:'confirmed'}]);
    if(simulation.value.err) throw Error('Preflight simulation failed');
    stage=label+' / send';
    const signature=await rpc('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'}]);
    const record={label,signature,lamports:1000000,status:'submitted'};report.transfers.push(record);await save();
    await confirmed(signature);record.status='confirmed';await save();
    console.log(`${label}: confirmed on devnet (${signature})`);
  }
  await transfer(account,escrow,'Test entry transfer');
  await transfer(escrow,account,'Test exit transfer');
  report.status='passed';await save();console.log('Devnet roundtrip passed. No mainnet funds used. This does not test a Pump purchase, USDC conversion or market profitability.');
} catch(error) {
  report.stage=stage;await save().catch(()=>{});
  console.error(`Devnet check incomplete during ${stage}. HTTP status: ${Number(error.statusCode)||'unavailable'}. Inspect .secrets/devnet-check.json for submitted signatures. Raw errors suppressed to protect credentials.`);
  process.exitCode=1;
}
