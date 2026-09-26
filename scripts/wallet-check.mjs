// Creates/reuses the named CDP wallet and verifies a non-transaction signature.
// This script cannot transfer funds or broadcast a trade.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CdpClient } from '@coinbase/cdp-sdk';
import bs58 from 'bs58';

process.env.DISABLE_CDP_ERROR_REPORTING = 'true';
const dir = new URL('../.secrets/', import.meta.url);
let stage = 'load credentials';
try {
  const keys = JSON.parse(await readFile(new URL('coinbase.json', dir), 'utf8'));
  let walletSecret;
  try {
    walletSecret = (await readFile(new URL('cdp_wallet_secret.txt', dir), 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    walletSecret = JSON.parse(await readFile(new URL('coinbase-wallet.json', dir), 'utf8')).CDP_WALLET_SECRET;
  }
  if (!keys.COINBASE_API_KEY_NAME || !keys.COINBASE_API_PRIVATE_KEY || !walletSecret) {
    throw new Error('Missing credentials');
  }
  const cdp = new CdpClient({
    apiKeyId: keys.COINBASE_API_KEY_NAME,
    apiKeySecret: keys.COINBASE_API_PRIVATE_KEY,
    walletSecret,
  });
  stage = 'create or retrieve Solana wallet';
  const account = await cdp.solana.getOrCreateAccount({ name: 'pump-research-desk' });
  stage = 'verify wallet signing';
  const message = `Momentum Lab connectivity test only. No transaction or authorization. ${randomUUID()}`;
  const { signature } = await cdp.solana.signMessage({ address: account.address, message });
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bs58.decode(account.address)]),
    format: 'der', type: 'spki',
  });
  if (!verify(null, Buffer.from(message), publicKey, bs58.decode(signature))) {
    throw new Error('Signature verification failed');
  }
  const result = {
    address: account.address, name: 'pump-research-desk',
    signingVerifiedAt: new Date().toISOString(),
    liveTradingEnabled: false, mainnetBalanceSol: null,
  };
  stage = 'read mainnet balance';
  try {
    const response = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [account.address, { commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (response.ok && Number.isSafeInteger(data.result?.value)) result.mainnetBalanceSol = data.result.value / 1e9;
  } catch { /* RPC availability does not invalidate the verified signature. */ }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(new URL('solana-wallet.json', dir), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  console.log(`Saved wallet metadata to ${fileURLToPath(new URL('solana-wallet.json', dir))}`);
} catch (error) {
  // SDK errors may carry request headers. Never log raw errors or response bodies.
  console.error(`Wallet check failed during: ${stage}. HTTP status: ${Number(error.statusCode) || 'unavailable'}. Credentials were not printed.`);
  process.exitCode = 1;
}
