// Ledger v1 signs wallet send and trade only. Every other signing path must
// refuse a Ledger wallet with LEDGER_UNSUPPORTED before it tries to export a
// key, fall back to another wallet, or touch the network.
//
// Uses a real wallet store in a temp HOME rather than mocking wallet.js: api.js
// reads the wallet through a dynamic import, which does not see a vi.mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../x402.js', () => ({ createPaymentSignatures: vi.fn() }));
vi.mock('../walletconnect-x402.js', () => ({ handleX402Payment: vi.fn() }));

import { createPaymentSignatures } from '../x402.js';
import { handleX402Payment } from '../walletconnect-x402.js';
import { NansenAPI } from '../api.js';
import { resolveEvmWallet, resolveSigningCredentials } from '../wallet-signing.js';
import { buildPerpCommands } from '../perp.js';
import { resolveSolanaWallet } from '../limit-order.js';

const EVM = '0x' + '1'.repeat(40);
const SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let originalHome;
let tempDir;

beforeEach(() => {
  vi.clearAllMocks();
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-ledger-guards-'));
  process.env.HOME = tempDir;
  const walletsDir = path.join(tempDir, '.nansen', 'wallets');
  fs.mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(walletsDir, 'hw.json'), JSON.stringify({
    name: 'hw',
    provider: 'ledger',
    evm: { address: EVM, path: "44'/60'/0'/0/0" },
    solana: { address: SOLANA, path: "44'/501'/0'/0'" },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(walletsDir, 'config.json'), JSON.stringify({ defaultWallet: 'hw' }), { mode: 0o600 });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('Ledger wallets are refused on unsupported signing paths', () => {
  it('bridge: resolveSigningCredentials', () => {
    const wallet = resolveEvmWallet('hw', 'Bridging');
    expect(() => resolveSigningCredentials(wallet)).toThrow(
      expect.objectContaining({ code: 'LEDGER_UNSUPPORTED', message: expect.stringMatching(/^Ledger wallets don't support Bridging yet/) }),
    );
  });

  it('perp: resolves no signing context', async () => {
    const api = { request: vi.fn() };
    const cmds = buildPerpCommands({ log: () => {} });
    const err = await cmds['approve-builder-fee']([], api, {}, { wallet: 'hw' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'LEDGER_UNSUPPORTED' });
    expect(err.message).toMatch(/^Ledger wallets don't support Hyperliquid perp trading yet/);
    expect(api.request).not.toHaveBeenCalled();
  });

  it('limit-order: resolveSolanaWallet', async () => {
    const exit = vi.fn();
    await expect(resolveSolanaWallet('hw', { log: () => {}, exit })).rejects.toMatchObject({
      code: 'LEDGER_UNSUPPORTED',
      message: expect.stringMatching(/^Ledger wallets don't support Limit-order trading yet/),
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('x402: refuses to pay instead of falling back to a local key or WalletConnect', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ message: 'Payment required' }),
      headers: { get: (h) => (h === 'payment-required' ? btoa(JSON.stringify({ accepts: [] })) : null) },
    });
    vi.stubGlobal('fetch', mockFetch);

    const api = new NansenAPI(null, 'https://api.nansen.ai');
    await expect(api.smartMoneyNetflow({})).rejects.toMatchObject({
      code: 'LEDGER_UNSUPPORTED',
      message: expect.stringMatching(/^Ledger wallets don't support x402 auto-payment yet/),
    });
    expect(createPaymentSignatures).not.toHaveBeenCalled();
    expect(handleX402Payment).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
