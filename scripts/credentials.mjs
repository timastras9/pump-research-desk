import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.secrets');
const filename = path.join(directory, 'coinbase.json');
const origin = 'http://127.0.0.1:8878';
const token = randomBytes(32).toString('hex');

export function credentials(input) {
  if (!input || typeof input !== 'object') throw new Error('Choose a credential type and fill in both fields.');
  const client = typeof input.client === 'string' ? input.client.trim() : '';
  const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (!client || !secret || client.length > 2048 || secret.length > 12000) throw new Error('Both fields are required and must fit the supported size.');
  if (input.kind === 'oauth') return { COINBASE_CLIENT_ID: client, COINBASE_CLIENT_SECRET: secret };
  if (input.kind === 'api') return { COINBASE_API_KEY_NAME: client, COINBASE_API_PRIVATE_KEY: secret };
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
</style></head><body><main><div class="tag">MOMENTUM LAB · LOCAL SETUP</div><h1>Save your Coinbase credentials</h1><p>This page runs only on this computer. Saving writes a private file in your project; it does not upload credentials or enable trading.</p><form id="form" autocomplete="off"><label>Credential type<select id="kind"><option value="oauth">Coinbase OAuth — client ID + client secret</option><option value="api">Coinbase API — key name + private key</option></select></label><p id="hint" class="small">Use the client ID and client secret from your Coinbase OAuth application. These identify the application; account access still requires Coinbase authorization.</p><label id="client-label" for="client">Client ID</label><input id="client" required autocomplete="off" spellcheck="false" maxlength="2048"><label id="secret-label" for="secret">Client secret</label><textarea id="secret" required autocomplete="off" spellcheck="false" maxlength="12000" aria-describedby="secret-help"></textarea><label class="reveal"><input id="reveal" type="checkbox"> Show secret while entering</label><p id="secret-help" class="small">Paste directly here, not into chat. A private key can contain multiple lines.</p><button id="save" type="submit">Save locally</button><p id="status" role="status"></p></form><p class="small">Saved to <code>.secrets/coinbase.json</code> with owner-only file permissions. This folder is excluded from Git. Saving again replaces this credential file.</p><p class="small">When you’re ready to upload to this project’s Cloudflare Worker, run:<br><code>npm run credentials:upload</code></p></main><script nonce="${token}">
const kind=document.querySelector('#kind'), secret=document.querySelector('#secret'), status=document.querySelector('#status');
kind.addEventListener('change',()=>{const api=kind.value==='api';document.querySelector('#client-label').textContent=api?'API key name':'Client ID';document.querySelector('#secret-label').textContent=api?'API private key':'Client secret';document.querySelector('#hint').textContent=api?'Use the key name and private key from Coinbase Developer Platform. Start with view-only permissions; this dashboard does not yet execute real trades.':'Use the client ID and client secret from your Coinbase OAuth application. These identify the application; account access still requires Coinbase authorization.';secret.value='';document.querySelector('#client').value='';status.textContent='';});
document.querySelector('#reveal').addEventListener('change',e=>secret.classList.toggle('visible',e.target.checked));
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();const button=document.querySelector('#save');button.disabled=true;status.textContent='Saving…';try{const res=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify({kind:kind.value,client:document.querySelector('#client').value,secret:secret.value})});const data=await res.json();if(!res.ok)throw new Error(data.error);secret.value='';document.querySelector('#client').value='';status.textContent='Saved to .secrets/coinbase.json. Nothing has been uploaded. Fields cleared.';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
</script></body></html>`;

async function upload() {
  let values;
  try { values = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Save your credentials with npm run credentials first.'); }
  const names = Object.keys(values).sort();
  const allowed = [['COINBASE_CLIENT_ID', 'COINBASE_CLIENT_SECRET'], ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY']];
  if (!allowed.some(keys => JSON.stringify(keys.sort()) === JSON.stringify(names)) || Object.values(values).some(v => typeof v !== 'string' || !v.trim())) throw new Error('Credential file is invalid; save it again using the local setup page.');
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
    if (req.method !== 'POST' || req.url !== '/save') return json(404,{error:'Not found.'});
    const supplied = req.headers['x-setup-token'];
    if (req.headers.origin !== origin || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) return json(403,{error:'Reload the local setup page and try again.'});
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'JSON required.'});
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) { size+=chunk.length;if(size>20000)return json(413,{error:'Input is too large.'});chunks.push(chunk); }
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'Invalid input.'});}
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
