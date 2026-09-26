import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.secrets');
const filename = path.join(directory, 'coinbase.json');
const walletFilename = path.join(directory, 'coinbase-wallet.json');
const origin = 'http://127.0.0.1:8878';
const token = randomBytes(32).toString('hex');

export function credentials(input) {
  if (!input || typeof input !== 'object') throw new Error('Choose a credential type and fill in both fields.');
  const client = typeof input.client === 'string' ? input.client.trim() : '';
  const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (!client || !secret || client.length > 2048 || secret.length > 12000) throw new Error('Both fields are required and must fit the supported size.');
  if (input.kind === 'oauth') return { COINBASE_CLIENT_ID: client, COINBASE_CLIENT_SECRET: secret };
  if (input.kind === 'api') {
    if (!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|organizations\/[^/]+\/apiKeys\/[^/]+)$/i.test(client)) throw new Error('Use the API key ID from the Secret API Keys entry, not a Client API Key.');
    const ed25519 = /^[A-Za-z0-9+/]+={0,2}$/.test(secret) && Buffer.from(secret, 'base64').length === 64;
    if (!ed25519 && !/-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]+-----END (?:EC )?PRIVATE KEY-----/.test(secret)) throw new Error('The secret must be the matching private key (base64 or PEM), not the API key ID. Copy both values from the same Secret API Keys entry.');
    return { COINBASE_API_KEY_NAME: client, COINBASE_API_PRIVATE_KEY: secret };
  }
  throw new Error('Unknown credential type.');
}

export async function saveCredentials(values, destination = filename) {
  const dir = path.dirname(destination);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = path.join(dir, `.coinbase-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(values, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, destination);
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coinbase credentials · Local setup</title><style nonce="${token}">
:root{color-scheme:dark;font:16px system-ui;background:#0a1117;color:#edf3f5}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:620px;margin:30px auto;background:#111c25;border:1px solid #30414a;border-radius:12px;padding:30px}h1{font-size:28px;margin:10px 0}p{color:#aabcc5;line-height:1.6}.tag{color:#b8f56b;font-size:13px;letter-spacing:1px}label{display:block;margin-top:20px;font-size:15px}input,textarea,select{width:100%;margin-top:8px;background:#0a1117;color:#edf3f5;border:1px solid #435765;border-radius:6px;padding:12px;font:15px system-ui}textarea{min-height:140px;font-family:monospace;-webkit-text-security:disc}button{margin-top:22px;padding:13px 20px;background:#b8f56b;color:#172510;border:0;border-radius:6px;font:600 16px system-ui;cursor:pointer}button:disabled{opacity:.5}code{overflow-wrap:anywhere;font-size:14px}#status{white-space:pre-wrap}a{color:#b8f56b}.small{font-size:14px}.reveal{display:flex;gap:8px;align-items:center;margin-top:10px}.reveal input{width:auto;margin:0}textarea.visible{-webkit-text-security:none}
</style></head><body><main><div class="tag">MOMENTUM LAB · LOCAL SETUP</div><h1>Save your Coinbase credentials</h1><p>This page runs only on this computer. Saving writes a private file in your project; it does not upload credentials or enable trading.</p><form id="form" autocomplete="off"><label>Credential type<select id="kind"><option value="api">CDP Secret API Key — key ID + matching secret</option><option value="oauth">Coinbase OAuth application — client ID + client secret</option></select></label><p id="hint" class="small">From one entry on Coinbase’s Secret API Keys page, copy its API key ID and matching secret. Do not use the separate Client API Key tab.</p><label id="client-label" for="client">Secret API key ID</label><input id="client" required autocomplete="off" spellcheck="false" maxlength="2048"><label id="secret-label" for="secret">Matching secret / private key</label><textarea id="secret" required autocomplete="off" spellcheck="false" maxlength="12000" aria-describedby="secret-help"></textarea><label class="reveal"><input id="reveal" type="checkbox"> Show secret while entering</label><p id="secret-help" class="small">Paste directly here, not into chat. A private key can contain multiple lines.</p><button id="save" type="submit">Save locally</button><p id="status" role="status"></p></form><p class="small">Saved to <code>.secrets/coinbase.json</code> with owner-only file permissions. This folder is excluded from Git. Saving again replaces this credential file.</p><p class="small">When you’re ready to upload to this project’s Cloudflare Worker, run:<br><code>npm run credentials:upload</code></p><hr><h2>Solana wallet setup</h2><p>Your saved API key stays unchanged. Generate a separate Wallet Secret in <a href="https://portal.cdp.coinbase.com/wallets/non-custodial/security" target="_blank" rel="noreferrer">CDP wallet security settings</a>, then save it below.</p><form id="wallet-form" autocomplete="off"><label for="wallet-secret">Wallet Secret</label><input id="wallet-secret" type="password" required autocomplete="off" spellcheck="false" maxlength="12000"><button type="submit">Save Wallet Secret locally</button><p id="wallet-status" role="status"></p></form><p class="small">Saved separately to <code>.secrets/coinbase-wallet.json</code>. This credential authorizes wallet operations. Saving it does not create a wallet or enable live trading. Do not send funds until the Solana receiving address has been created and verified.</p></main><script nonce="${token}">
const kind=document.querySelector('#kind'), secret=document.querySelector('#secret'), status=document.querySelector('#status');
kind.addEventListener('change',()=>{const api=kind.value==='api';document.querySelector('#client-label').textContent=api?'Secret API key ID':'Client ID';document.querySelector('#secret-label').textContent=api?'Matching secret / private key':'Client secret';document.querySelector('#hint').textContent=api?'Copy the API key ID and matching secret from the SAME Secret API Keys entry. The separate Client API Key tab is not needed here. This does not yet connect your consumer Coinbase account or enable trading.':'Use the client ID and client secret from your Coinbase OAuth application. These identify the application; account access still requires Coinbase authorization.';secret.value='';document.querySelector('#client').value='';status.textContent='';});
document.querySelector('#reveal').addEventListener('change',e=>secret.classList.toggle('visible',e.target.checked));
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();const button=document.querySelector('#save');button.disabled=true;status.textContent='Saving…';try{const res=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify({kind:kind.value,client:document.querySelector('#client').value,secret:secret.value})});const data=await res.json();if(!res.ok)throw new Error(data.error);secret.value='';document.querySelector('#client').value='';status.textContent='Saved to .secrets/coinbase.json. Nothing has been uploaded. Fields cleared.';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
document.querySelector('#wallet-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button'),field=document.querySelector('#wallet-secret'),message=document.querySelector('#wallet-status');button.disabled=true;try{const res=await fetch('/save-wallet',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify({secret:field.value})});const data=await res.json();if(!res.ok)throw new Error(data.error);field.value='';message.textContent='Wallet Secret saved locally. Your API key was preserved. Nothing has been uploaded.';}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});
</script></body></html>`;

async function upload() {
  let values;
  try { values = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Save your credentials with npm run credentials first.'); }
  const names = Object.keys(values).sort();
  const allowed = [['COINBASE_CLIENT_ID', 'COINBASE_CLIENT_SECRET'], ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY']];
  if (!allowed.some(keys => JSON.stringify(keys.sort()) === JSON.stringify(names)) || Object.values(values).some(v => typeof v !== 'string' || !v.trim())) throw new Error('Credential file is invalid; save it again using the local setup page.');
  try {
    const wallet = JSON.parse(await readFile(walletFilename, 'utf8'));
    if (Object.keys(wallet).length !== 1 || typeof wallet.CDP_WALLET_SECRET !== 'string' || !wallet.CDP_WALLET_SECRET.trim()) throw new Error('Invalid saved Wallet Secret.');
    values.CDP_WALLET_SECRET = wallet.CDP_WALLET_SECRET;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Wallet Secret file is invalid; save it again.'); }
  let downloaded;
  try { downloaded = (await readFile(path.join(directory, 'cdp_wallet_secret.txt'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read the downloaded Wallet Secret.'); }
  if (downloaded !== undefined) {
    if (!downloaded || downloaded.length > 12000) throw new Error('Downloaded Wallet Secret is empty or too large.');
    if (values.CDP_WALLET_SECRET && values.CDP_WALLET_SECRET !== downloaded)
      throw new Error('The form and downloaded file contain different Wallet Secrets. Resolve the mismatch before uploading.');
    values.CDP_WALLET_SECRET = downloaded;
  }
  console.log('Uploading Coinbase credentials to the pump-research-desk Worker configured in wrangler.jsonc.');
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(values));
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Cloudflare upload failed. The local file is still available.'))); });
}

async function start() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');res.setHeader('X-Content-Type-Options', 'nosniff');res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'nonce-"+token+"'; script-src 'nonce-"+token+"'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(value)); };
    if (req.headers.host !== '127.0.0.1:8878') return json(403,{error:'Open the exact local setup URL.'});
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(page); }
    if (req.method !== 'POST' || !['/save', '/save-wallet'].includes(req.url)) return json(404,{error:'Not found.'});
    const supplied = req.headers['x-setup-token'];
    if (req.headers.origin !== origin || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return json(403,{error:'Reload the local setup page and try again.'});
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'JSON required.'});
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) { size+=chunk.length;if(size>20000)return json(413,{error:'Input is too large.'});chunks.push(chunk); }
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'Invalid input.'});}
      if (req.url === '/save-wallet') {
        if (!input || typeof input.secret !== 'string' || !input.secret.trim() || input.secret.length > 12000) return json(400,{error:'Enter the Wallet Secret from CDP wallet security settings.'});
        await saveCredentials({CDP_WALLET_SECRET: input.secret.trim()}, walletFilename);
        return json(200,{ok:true});
      }
      let values;try{values=credentials(input);}catch(error){return json(400,{error:error.message});}
      await saveCredentials(values);json(200,{ok:true});
    } catch { json(500,{error:'Could not save the file. Check local filesystem permissions.'}); }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 8878 is in use. Close the previous credential setup server before retrying.':'Could not start local setup.');process.exitCode=1;});
  server.listen(8878,'127.0.0.1',()=>console.log('Coinbase credential setup: '+origin+'\nCredentials are saved locally only. Press Ctrl+C to stop.'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes('--upload') ? upload() : start()).catch(error=>{console.error(error.message);process.exitCode=1;});
}
