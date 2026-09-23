/**
 * Ledger wallets: create/list/show/export/delete and wallet send on EVM and
 * Solana. src/ledger.js is mocked — the fake session signs with known test
 * keys so the broadcast transactions can be checked like real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RLP } from '@ethereumjs/rlp';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256, signSecp256k1 } from '../crypto.js';
import { signEd25519 } from '../transfer.js';

const h = vi.hoisted(() => ({ session: null, withLedger: null }));

vi.mock('../ledger.js', () => ({
  LEDGER_PATHS: { evm: "44'/60'/0'/0/0", solana: "44'/501'/0'/0'" },
  withLedger: (fn) => h.withLedger(fn),
}));

vi.mock('../walletconnect-trading.js', () => ({
  getWalletConnectAddress: vi.fn(async () => '0x' + 'a'.repeat(40)),
  sendTransactionViaWalletConnect: vi.fn(),
}));

const {
  buildWalletCommands, createLedgerWallet, listWallets, showWallet, exportWallet, deleteWallet, createWallet, getWalletConfig,
} = await import('../wallet.js');
const { sendTokens } = await import('../transfer.js');

const EVM_KEY = Buffer.from('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'hex');
const EVM_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const SOLANA_SEED = Buffer.alloc(32, 7);
const SOLANA_PUBKEY = crypto.createPublicKey(crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SOLANA_SEED]),
  format: 'der',
  type: 'pkcs8',
})).export({ format: 'der', type: 'spki' }).subarray(-32);
const SOLANA_ADDRESS = (await import('../wallet.js')).base58Encode(SOLANA_PUBKEY);

const EVM_RECIPIENT = '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4';
const SOLANA_RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

let originalHome;
let originalEnv;
let tempDir;
let stderrSpy;

function fakeSession() {
  return {
    getEvmAddress: vi.fn(async () => EVM_ADDRESS),
    getSolanaAddress: vi.fn(async () => SOLANA_ADDRESS),
    // What a Ledger does: sign keccak256 of exactly the bytes it was handed.
    signEvmTransaction: vi.fn(async (_expected, unsignedTx) => signSecp256k1(keccak256(unsignedTx), EVM_KEY)),
    signSolanaTransaction: vi.fn(async (_expected, tx) => signEd25519(tx.subarray(1 + 64), SOLANA_SEED)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  originalHome = process.env.HOME;
  originalEnv = { ...process.env };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-ledger-wallet-test-'));
  process.env.HOME = tempDir;
  delete process.env.NANSEN_WALLET_PROVIDER;
  delete process.env.NANSEN_WALLET_PASSWORD;
  h.session = fakeSession();
  h.withLedger = vi.fn(async (fn) => fn(h.session));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env = originalEnv;
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  stderrSpy.mockRestore();
  vi.unstubAllGlobals();
});

const walletsDir = () => path.join(tempDir, '.nansen', 'wallets');

function commands() {
  const output = [];
  const cmds = buildWalletCommands({ log: (m) => output.push(m) });
  return { output, run: (args, flags = {}, options = {}) => cmds.wallet(args, null, flags, options) };
}

// Simulates the existing encrypted local wallets a user may already have, so
// the tests prove Ledger commands never ask for that password.
function writeEncryptedConfig(defaultWallet) {
  fs.mkdirSync(walletsDir(), { recursive: true });
  fs.writeFileSync(path.join(walletsDir(), 'config.json'), JSON.stringify({
    defaultWallet, passwordHash: { salt: '00', hash: '00' },
  }));
}

async function createCold(name = 'cold') {
  await createLedgerWallet(name, { log: () => {} });
  h.withLedger.mockClear();
}

describe('wallet create --provider ledger', () => {
  it('stores addresses and paths only, verifies both on the device, and becomes the default', async () => {
    const { output, run } = commands();
    // Each address must be printed before the device asks to verify it, so
    // the user has something to compare the device screen against.
    h.session.getEvmAddress.mockImplementation(async ({ verify } = {}) => {
      if (verify) output.push('<verify evm>');
      return EVM_ADDRESS;
    });
    h.session.getSolanaAddress.mockImplementation(async ({ verify } = {}) => {
      if (verify) output.push('<verify solana>');
      return SOLANA_ADDRESS;
    });
    await run(['create'], {}, { provider: 'ledger', name: 'cold' });

    const record = JSON.parse(fs.readFileSync(path.join(walletsDir(), 'cold.json'), 'utf8'));
    expect(record).toEqual({
      name: 'cold',
      provider: 'ledger',
      evm: { address: EVM_ADDRESS, path: "44'/60'/0'/0/0" },
      solana: { address: SOLANA_ADDRESS, path: "44'/501'/0'/0'" },
      createdAt: expect.any(String),
    });
    expect(getWalletConfig()).toEqual({ defaultWallet: 'cold', passwordHash: null });

    expect(h.withLedger).toHaveBeenCalledTimes(1);
    expect(h.session.getEvmAddress).toHaveBeenCalledWith({ verify: true });
    expect(h.session.getSolanaAddress).toHaveBeenCalledWith({ verify: true });
    expect(output.slice(0, 4)).toEqual([
      `  EVM address:    ${EVM_ADDRESS}`,
      '<verify evm>',
      `  Solana address: ${SOLANA_ADDRESS}`,
      '<verify solana>',
    ]);

    const joined = output.join('\n');
    expect(joined).toContain('Ledger wallet "cold" created');
    expect(joined).toContain('Set as default wallet');
  });

  it('honours NANSEN_WALLET_PROVIDER=ledger without a password', async () => {
    process.env.NANSEN_WALLET_PROVIDER = 'ledger';
    const { run } = commands();
    await run(['create'], {}, { name: 'env-cold' });
    expect(showWallet('env-cold').provider).toBe('ledger');
  });

  it('keeps an existing default wallet', async () => {
    writeEncryptedConfig('main');
    fs.writeFileSync(path.join(walletsDir(), 'main.json'), JSON.stringify({ name: 'main', evm: {}, solana: {} }));
    const result = await createLedgerWallet('cold', { log: () => {} });
    expect(result.isDefault).toBe(false);
    expect(getWalletConfig().defaultWallet).toBe('main');
    expect(getWalletConfig().passwordHash).toEqual({ salt: '00', hash: '00' });
  });

  it('rejects an existing name without touching the device', async () => {
    await createCold();
    const { run } = commands();
    const err = await run(['create'], {}, { provider: 'ledger', name: 'cold' }).catch((e) => e);
    expect(err.code).toBe('CREATE_FAILED');
    expect(err.message).toMatch(/already exists/);
    expect(h.withLedger).not.toHaveBeenCalled();
  });

  it('rejects an invalid name without touching the device', async () => {
    const err = await createLedgerWallet('../evil').catch((e) => e);
    expect(err.message).toMatch(/Wallet name must be/);
    expect(h.withLedger).not.toHaveBeenCalled();
  });

  it('keeps the Ledger error code and writes nothing when the user rejects on the device', async () => {
    const { CommandError } = await import('../api.js');
    h.session.getEvmAddress.mockImplementation(async ({ verify } = {}) => {
      if (verify) throw new CommandError('Reading the Ethereum address was rejected on the Ledger.', 'LEDGER_REJECTED');
      return EVM_ADDRESS;
    });
    const { run } = commands();
    const err = await run(['create'], {}, { provider: 'ledger', name: 'cold' }).catch((e) => e);
    expect(err.code).toBe('LEDGER_REJECTED');
    expect(fs.existsSync(path.join(walletsDir(), 'cold.json'))).toBe(false);
  });
});

describe('Ledger wallet list/show/export/delete', () => {
  beforeEach(async () => {
    await createCold();
  });

  it('list and show tag the wallet (ledger)', async () => {
    expect(listWallets().wallets[0]).toMatchObject({ name: 'cold', provider: 'ledger', evm: EVM_ADDRESS, solana: SOLANA_ADDRESS });

    const list = commands();
    await list.run(['list']);
    expect(list.output.join('\n')).toContain('cold ★ (ledger)');

    const show = commands();
    await show.run(['show', 'cold']);
    expect(show.output.join('\n')).toContain('cold ★ (ledger)');
  });

  it('showWallet exposes the derivation paths', () => {
    expect(showWallet('cold').ledgerPaths).toEqual({ evm: "44'/60'/0'/0/0", solana: "44'/501'/0'/0'" });
    expect(showWallet('cold').privyWalletIds).toBeUndefined();
  });

  it('export is refused with an actionable message', async () => {
    expect(() => exportWallet('cold', null)).toThrow(/never leave the device.*recovery phrase/);
    const { run } = commands();
    const err = await run(['export', 'cold']).catch((e) => e);
    expect(err.code).toBe('EXPORT_FAILED');
    expect(err.message).toMatch(/Ledger wallets have no exportable keys/);
  });

  it('delete needs no password even when local wallets are encrypted', async () => {
    const config = getWalletConfig();
    config.passwordHash = { salt: '00', hash: '00' };
    fs.writeFileSync(path.join(walletsDir(), 'config.json'), JSON.stringify(config));

    const { output, run } = commands();
    await run(['delete', 'cold']);
    expect(output.join('\n')).toContain('Wallet "cold" deleted');
    expect(fs.existsSync(path.join(walletsDir(), 'cold.json'))).toBe(false);
    expect(h.withLedger).not.toHaveBeenCalled();
  });

  it('deleteWallet removes the reference file', async () => {
    await expect(deleteWallet('cold')).resolves.toMatchObject({ deleted: 'cold' });
  });

  it('does not block creating an encrypted local wallet later', () => {
    expect(() => createWallet('hot', 'testpassword12')).not.toThrow();
  });
});

// ============= wallet send =============

const broadcasts = [];

function mockEvmRpc() {
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const responses = {
      eth_getTransactionCount: '0x5',
      eth_feeHistory: { baseFeePerGas: ['0x3b9aca00'] },
      eth_maxPriorityFeePerGas: '0x5F5E100',
      eth_getBalance: '0x8AC7230489E80000',
      eth_estimateGas: '0x5208',
      eth_sendRawTransaction: '0xledgerhash',
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x10' },
    };
    if (body.method === 'eth_sendRawTransaction') broadcasts.push(body.params[0]);
    return { json: async () => ({ result: responses[body.method] ?? '0x0' }) };
  }));
}

function mockSolanaRpc() {
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const responses = {
      getLatestBlockhash: { value: { blockhash: 'GHtXQBpokWApVtJPBteD6jHQJPMBpfDY4PPnSr3DSEJQ' } },
      getBalance: { value: 1_000_000_000 },
      sendTransaction: 'ledger_sol_sig',
      getSignatureStatuses: { value: [{ confirmationStatus: 'confirmed', slot: 1, err: null }] },
    };
    if (body.method === 'sendTransaction') broadcasts.push(body.params[0]);
    return { json: async () => ({ result: responses[body.method] ?? null }) };
  }));
}

function rpcCalls(method) {
  return fetch.mock.calls.map(([, opts]) => JSON.parse(opts.body)).filter((b) => b.method === method);
}

// Decode an EIP-1559 raw tx and recover who signed it.
function recoverEvmSender(rawTx) {
  const bytes = Buffer.from(rawTx.slice(2), 'hex');
  expect(bytes[0]).toBe(0x02);
  const fields = RLP.decode(bytes.subarray(1));
  const [v, r, s] = fields.slice(9).map((f) => BigInt('0x' + (Buffer.from(f).toString('hex') || '0')));
  const hash = keccak256(Buffer.concat([Buffer.from([0x02]), RLP.encode(fields.slice(0, 9))]));
  const pub = new secp256k1.Signature(r, s).addRecoveryBit(Number(v)).recoverPublicKey(hash).toBytes(false);
  return '0x' + keccak256(Buffer.from(pub).subarray(1)).subarray(12).toString('hex');
}

describe('wallet send with a Ledger wallet', () => {
  beforeEach(async () => {
    broadcasts.length = 0;
    writeEncryptedConfig(null);
    await createCold();
  });

  it('EVM: nansen builds and broadcasts, the Ledger only signs — sender recovers to the device address', async () => {
    mockEvmRpc();
    const { output, run } = commands();
    await run(['send'], {}, { to: EVM_RECIPIENT, amount: '0.01', chain: 'base', wallet: 'cold' });

    expect(h.withLedger).toHaveBeenCalledTimes(1);
    const [expected, unsignedTx] = h.session.signEvmTransaction.mock.calls[0];
    expect(expected).toEqual({ address: EVM_ADDRESS, path: "44'/60'/0'/0/0" });
    expect(unsignedTx[0]).toBe(0x02);

    expect(broadcasts).toHaveLength(1);
    expect(recoverEvmSender(broadcasts[0])).toBe(EVM_ADDRESS.toLowerCase());
    // Nonce comes from nansen's own RPC lookup for the Ledger address.
    expect(rpcCalls('eth_getTransactionCount')[0].params[0]).toBe(EVM_ADDRESS.toLowerCase());

    const joined = output.join('\n');
    expect(joined).toContain('Tx Hash: 0xledgerhash');
    expect(joined).toContain(`From:    ${EVM_ADDRESS}`);
  });

  it('EVM dry run never opens the device', async () => {
    mockEvmRpc();
    const result = await sendTokens({ to: EVM_RECIPIENT, amount: '0.01', chain: 'base', wallet: 'cold', dryRun: true });
    expect(result).toMatchObject({ dryRun: true, from: EVM_ADDRESS });
    expect(h.withLedger).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });

  it('Solana: signature from the device lands in the fee payer slot and verifies', async () => {
    mockSolanaRpc();
    const result = await sendTokens({ to: SOLANA_RECIPIENT, amount: '0.5', chain: 'solana', wallet: 'cold' });
    expect(result).toMatchObject({ success: true, transactionHash: 'ledger_sol_sig', from: SOLANA_ADDRESS });

    const [expected, wireTx] = h.session.signSolanaTransaction.mock.calls[0];
    expect(expected).toEqual({ address: SOLANA_ADDRESS, path: "44'/501'/0'/0'" });
    expect(wireTx.subarray(1, 65)).toEqual(Buffer.alloc(64)); // handed over unsigned

    const tx = Buffer.from(broadcasts[0], 'base64');
    const message = tx.subarray(65);
    expect(message.subarray(4, 36)).toEqual(SOLANA_PUBKEY); // fee payer is the Ledger account
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), SOLANA_PUBKEY]), format: 'der', type: 'spki',
    });
    expect(crypto.verify(null, message, publicKey, tx.subarray(1, 65))).toBe(true);
  });

  it('a rejection on the device keeps its code and broadcasts nothing', async () => {
    mockEvmRpc();
    const { CommandError } = await import('../api.js');
    h.session.signEvmTransaction.mockRejectedValue(new CommandError('Signing the transaction was rejected on the Ledger. Nothing was signed.', 'LEDGER_REJECTED'));
    const { run } = commands();
    const err = await run(['send'], {}, { to: EVM_RECIPIENT, amount: '0.01', chain: 'base', wallet: 'cold' }).catch((e) => e);
    expect(err.code).toBe('LEDGER_REJECTED');
    expect(broadcasts).toHaveLength(0);
  });

  it('--wallet walletconnect still bypasses a Ledger default wallet', async () => {
    const config = getWalletConfig();
    config.defaultWallet = 'cold';
    fs.writeFileSync(path.join(walletsDir(), 'config.json'), JSON.stringify(config));
    mockEvmRpc();
    const result = await sendTokens({ to: EVM_RECIPIENT, amount: '0.01', chain: 'base', walletconnect: true, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, from: '0x' + 'a'.repeat(40) });
    expect(h.withLedger).not.toHaveBeenCalled();
  });
});
