/**
 * `trade quote` / `trade execute` with a Ledger wallet.
 *
 * ../ledger.js is mocked with a fake USB session that signs with known test
 * keys — secp256k1 over keccak256(unsignedTxBytes) for EVM, Ed25519 over the
 * message for Solana — exactly what the real device does. Each test then
 * proves the transaction nansen broadcast recovers to the wallet address.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', async (importOriginal) => ({
  ...(await importOriginal()),
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  listWallets: vi.fn(() => ({ wallets: [], defaultWallet: null })),
  exportWallet: vi.fn(() => {
    throw new Error('exportWallet must not be reached for a Ledger wallet');
  }),
}));

const { withLedger } = vi.hoisted(() => ({ withLedger: vi.fn() }));
vi.mock('../ledger.js', async (importOriginal) => ({
  ...(await importOriginal()),
  withLedger,
}));

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RLP } from '@ethereumjs/rlp';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CommandError } from '../api.js';
import { keccak256, signSecp256k1 } from '../crypto.js';
import { SIMULATION_RPCS } from '../rpc-urls.js';
import { readCompactU16 } from '../solana-tx.js';
import { base58Decode } from '../transfer.js';
import { exportWallet, generateSolanaWallet, showWallet, getWalletConfig, listWallets } from '../wallet.js';
import { buildTradingCommands, evmTxHash, loadQuote, saveQuote, __setAllowanceTimingForTests } from '../trading.js';

const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';
const RELAY_ROUTER = '0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_CHAIN_ID = 8453;
const APPROVE_SELECTOR = '095ea7b3';

// Valid secp256k1 scalars, not random-looking literals (secret scanners).
const EVM_KEY = '11'.repeat(32);
const OTHER_EVM_KEY = '22'.repeat(32);

function addressForKey(privHex) {
  const pub = secp256k1.getPublicKey(Buffer.from(privHex, 'hex'), false);
  return '0x' + keccak256(Buffer.from(pub).subarray(1)).subarray(12).toString('hex');
}

const EVM_ADDRESS = addressForKey(EVM_KEY);
const SOLANA = generateSolanaWallet();

const LEDGER_WALLET = {
  name: 'nano',
  provider: 'ledger',
  evm: EVM_ADDRESS,
  solana: SOLANA.address,
  ledgerPaths: { evm: "44'/60'/0'/0/0", solana: "44'/501'/0'/0'" },
};

// Every transaction is screened; this instance always reports clean.
function screenApi(events = []) {
  return {
    request: async (endpoint, body) => {
      if (endpoint.startsWith('/api/v1/sanctions/screen')) {
        events.push('screen');
        return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
}

// The fake device: signs like the Ledger, and checks its own address against
// the expected account the way ledger.js does.
function fakeLedgerSession({ evmKey = EVM_KEY, events = [] } = {}) {
  const deviceEvm = addressForKey(evmKey);
  const solanaKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SOLANA.privateKey.slice(0, 64), 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    getEvmAddress: vi.fn(async () => deviceEvm),
    getSolanaAddress: vi.fn(async () => SOLANA.address),
    signEvmTransaction: vi.fn(async (expected, unsignedTx) => {
      events.push('sign');
      if (expected.address.toLowerCase() !== deviceEvm.toLowerCase()) {
        throw new CommandError(`The connected Ledger's EVM address (${deviceEvm}) does not match this wallet (${expected.address}).`, 'WALLET_MISMATCH');
      }
      return signSecp256k1(keccak256(unsignedTx), Buffer.from(evmKey, 'hex'));
    }),
    signSolanaTransaction: vi.fn(async (_expected, tx) => {
      events.push('sign');
      const { value: sigCount, size } = readCompactU16(tx, 0);
      return crypto.sign(null, tx.subarray(size + sigCount * 64), solanaKey);
    }),
  };
}

// Counts sessions opened and released. The callback's promise only settles when
// execute calls close(), so an unreleased session is a leaked USB connection.
function useLedger(session) {
  const usage = { opened: 0, released: 0 };
  withLedger.mockImplementation(async (fn) => {
    usage.opened++;
    try {
      return await fn(session);
    } finally {
      usage.released++;
    }
  });
  return usage;
}

function bufToBigInt(u8) {
  const hex = Buffer.from(u8).toString('hex');
  return hex === '' ? 0n : BigInt('0x' + hex);
}

function recoverAddress(msgHash, r, s, recoveryBit) {
  const sig = secp256k1.Signature
    .fromBytes(Buffer.from(Buffer.from(r).toString('hex').padStart(64, '0') + Buffer.from(s).toString('hex').padStart(64, '0'), 'hex'), 'compact')
    .addRecoveryBit(recoveryBit);
  const pub = sig.recoverPublicKey(msgHash).toBytes(false);
  return '0x' + keccak256(Buffer.from(pub).subarray(1)).subarray(12).toString('hex');
}

// Decode a broadcast EVM transaction (legacy EIP-155 or type 2) and recover
// its sender from the signature.
function decodeSignedEvmTx(raw) {
  const bytes = Buffer.from(raw.slice(2), 'hex');
  if (bytes[0] === 0x02) {
    const fields = RLP.decode(Uint8Array.from(bytes.subarray(1)));
    const unsigned = Buffer.concat([Buffer.from([0x02]), Buffer.from(RLP.encode(fields.slice(0, 9)))]);
    return {
      type: 2,
      to: '0x' + Buffer.from(fields[5]).toString('hex'),
      data: '0x' + Buffer.from(fields[7]).toString('hex'),
      from: recoverAddress(keccak256(unsigned), fields[10], fields[11], Number(bufToBigInt(fields[9]))),
    };
  }
  const fields = RLP.decode(Uint8Array.from(bytes));
  const v = bufToBigInt(fields[6]);
  const chainId = (v - 35n) / 2n;
  const unsigned = Buffer.from(RLP.encode([...fields.slice(0, 6), chainId, new Uint8Array(0), new Uint8Array(0)]));
  return {
    type: 0,
    chainId: Number(chainId),
    to: '0x' + Buffer.from(fields[3]).toString('hex'),
    data: '0x' + Buffer.from(fields[5]).toString('hex'),
    from: recoverAddress(keccak256(unsigned), fields[7], fields[8], Number(v - chainId * 2n - 35n)),
  };
}

function evmIntent({ walletAddress = EVM_ADDRESS, fromToken = BASE_ETH, toToken = BASE_USDC, amount = '1000000000000000000' } = {}) {
  return { chain: 'base', toChain: null, walletAddress, recipient: null, fromToken, toToken, swapMode: 'exactIn', amount, maxInputAmount: amount };
}

function saveNativeEvmQuote(txFees, { walletAddress = EVM_ADDRESS, aggregator = 'lifi', to = LIFI_ROUTER, quotes = 1 } = {}) {
  const quote = {
    aggregator,
    inputMint: BASE_ETH,
    outputMint: BASE_USDC,
    inAmount: '1000000000000000000',
    outAmount: '3000000000',
    transaction: { to, data: '0x12345678', value: '1000000000000000000', gas: '210000', ...txFees },
  };
  return saveQuote({ success: true, quotes: Array.from({ length: quotes }, () => structuredClone(quote)) }, 'base', 'ledger', null, null, {
    swapMode: 'exactIn',
    request: evmIntent({ walletAddress }),
  });
}

// EVM RPC + Trading API. The broadcaster echoes the real hash of the signed
// bytes; broadcast approve() calls update the simulated on-chain allowance.
function mockEvmNetwork({ allowance = 0n, events = [] } = {}) {
  const broadcasts = [];
  let currentAllowance = BigInt(allowance);
  const rpc = (id, result) => Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id, result })) });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
      events.push('broadcast');
      broadcasts.push(body.signedTransaction);
      const selectorIdx = body.signedTransaction.indexOf(APPROVE_SELECTOR);
      if (selectorIdx >= 0) {
        const amountStart = selectorIdx + APPROVE_SELECTOR.length + 64;
        currentAllowance = BigInt('0x' + body.signedTransaction.slice(amountStart, amountStart + 64));
      }
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ status: 'Success', txHash: evmTxHash(body.signedTransaction), chainType: 'evm', broadcaster: 'test' })),
      });
    }
    if (body.method === 'eth_getCode') return rpc(body.id, '0x6080604052');
    if (body.method === 'eth_getTransactionCount') return rpc(body.id, '0x5');
    if (body.method === 'eth_getTransactionReceipt') return rpc(body.id, { status: '0x1', blockNumber: '0x100' });
    if (body.method === 'eth_call') {
      const data = body.params?.[0]?.data || '';
      if (data.startsWith('0xdd62ed3e')) return rpc(body.id, '0x' + currentAllowance.toString(16).padStart(64, '0'));
      events.push('simulate');
      return rpc(body.id, '0x');
    }
    return rpc(body.id || 1, null);
  }));
  return { broadcasts };
}

// Solana wire tx: verify the fee-payer signature in slot 0 against `address`.
function solanaSignatureValid(txBase64, address) {
  const signed = Buffer.from(txBase64, 'base64');
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(address)]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, signed.subarray(65), publicKey, signed.subarray(1, 65));
}

// Cross-chain quote → execute: the trading API's /quote and /execute, bridge
// status, and the Base / Solana RPC methods both commands touch.
function mockCrossChainNetwork(quoteResponse) {
  const quoteRequests = [];
  const broadcasts = [];
  const blockhash = generateSolanaWallet().address;
  const rpc = (id, result) => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id, result })) });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (urlStr.includes('trading-api') && urlStr.includes('/quote')) {
      quoteRequests.push(`${urlStr} ${opts?.body ?? ''}`);
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(quoteResponse)) });
    }
    if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
      broadcasts.push(body.signedTransaction);
      const result = body.signedTransaction.startsWith('0x')
        ? { status: 'Success', txHash: evmTxHash(body.signedTransaction), chainType: 'evm', broadcaster: 'test' }
        : { status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'relay' };
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(result)) });
    }
    if (urlStr.includes('/bridge/status')) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ status: 'DONE', receiving: { status: 'DONE', txHash: 'destTx' } })) });
    }
    if (body.method === 'getLatestBlockhash') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: { value: { blockhash } } }) });
    }
    if (body.method === 'eth_getCode') return rpc(body.id, '0x6080604052');
    if (body.method === 'eth_getTransactionCount') return rpc(body.id, '0x5');
    if (body.method === 'eth_getTransactionReceipt') return rpc(body.id, { status: '0x1', blockNumber: '0x100' });
    if (body.method === 'eth_call') return rpc(body.id, '0x');
    return rpc(body.id || 1, null);
  }));
  return { quoteRequests, broadcasts };
}

function quoteIdFrom(logs) {
  const quoteId = logs.join('\n').match(/\d{13}-[0-9a-f]{8}/)?.[0];
  expect(quoteId).toBeTruthy();
  return quoteId;
}

let originalHome;
let tempDir;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-ledger-trading-test-'));
  process.env.HOME = tempDir;
  vi.mocked(showWallet).mockImplementation((name) => {
    if (name !== LEDGER_WALLET.name) throw new Error(`Wallet "${name}" not found`);
    return LEDGER_WALLET;
  });
  vi.mocked(getWalletConfig).mockReturnValue({ defaultWallet: LEDGER_WALLET.name });
  __setAllowanceTimingForTests({ verifyDelayMs: 0, propagationDelayMs: 0 });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
  __setAllowanceTimingForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Ledger trade quote', () => {
  it('builds the quote for the stored Ledger address and persists signerType ledger', async () => {
    let quoteRequest;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      quoteRequest = { url: String(url), body: opts?.body };
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          quotes: [{ aggregator: 'jupiter', inputMint: SOL_MINT, outputMint: SOL_USDC, inAmount: '1000000000', outAmount: '150000000', transaction: 'AQAAAA==' }],
        }),
      };
    }));

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.quote([], screenApi(), {}, { chain: 'solana', from: SOL_MINT, to: SOL_USDC, amount: '1000000000' });

    expect(`${quoteRequest.url} ${quoteRequest.body ?? ''}`).toContain(SOLANA.address);
    const quoteId = logs.join('\n').match(/\d{13}-[0-9a-f]{8}/)?.[0];
    expect(quoteId).toBeTruthy();
    const saved = loadQuote(quoteId);
    expect(saved.signerType).toBe('ledger');
    expect(saved.request.walletAddress).toBe(SOLANA.address);
    expect(withLedger).not.toHaveBeenCalled();
  });
});

describe('Ledger trade execute', () => {
  it('signs a Solana swap on the device and broadcasts a transaction valid for the wallet', async () => {
    const origSolanaSimRpc = SIMULATION_RPCS.solana;
    SIMULATION_RPCS.solana = null;
    try {
      const session = fakeLedgerSession();
      useLedger(session);

      const walletKey = base58Decode(SOLANA.address);
      const message = Buffer.concat([
        Buffer.from([0x01, 0x00, 0x01, 0x02]),
        walletKey,
        Buffer.alloc(32), // System Program
        Buffer.alloc(32), // recentBlockhash
        Buffer.from([0x01, 0x01, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]),
      ]);
      const txBase64 = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(64), message]).toString('base64');
      const quoteId = saveQuote({
        success: true,
        quotes: [{ aggregator: 'jupiter', inputMint: SOL_MINT, outputMint: SOL_USDC, inAmount: '1000000000', outAmount: '150000000', transaction: txBase64 }],
      }, 'solana', 'ledger', null, null, {
        swapMode: 'exactIn',
        request: { chain: 'solana', toChain: null, walletAddress: SOLANA.address, recipient: null, fromToken: SOL_MINT, toToken: SOL_USDC, swapMode: 'exactIn', amount: '1000000000', maxInputAmount: '1000000000' },
      });

      const broadcasts = [];
      vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
        if (String(url).includes('trading-api') && String(url).endsWith('/execute')) {
          broadcasts.push(JSON.parse(opts.body).signedTransaction);
          return { ok: true, text: async () => JSON.stringify({ status: 'Success', signature: 'SolSig', chainType: 'solana', broadcaster: 'solana-rpc' }) };
        }
        return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }) };
      }));

      const logs = [];
      const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
      await cmds.execute([], screenApi(), {}, { quote: quoteId });

      expect(withLedger).toHaveBeenCalledTimes(1);
      expect(session.signSolanaTransaction).toHaveBeenCalledWith(
        { address: SOLANA.address, path: LEDGER_WALLET.ledgerPaths.solana },
        expect.any(Buffer),
      );
      expect(broadcasts).toHaveLength(1);
      expect(solanaSignatureValid(broadcasts[0], SOLANA.address)).toBe(true);
      expect(logs.some(l => l.includes('Signing Solana transaction on your Ledger'))).toBe(true);
    } finally {
      SIMULATION_RPCS.solana = origSolanaSimRpc;
    }
  });

  it('signs an EIP-1559 swap after screening and simulation, and the broadcast recovers to the wallet', async () => {
    const events = [];
    const session = fakeLedgerSession({ events });
    const usage = useLedger(session);
    const { broadcasts } = mockEvmNetwork({ events });
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000', maxPriorityFeePerGas: '1100000' });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds.execute([], screenApi(events), { 'no-verify-outcome': true }, { quote: quoteId });

    expect(broadcasts).toHaveLength(1);
    const tx = decodeSignedEvmTx(broadcasts[0]);
    expect(tx.type).toBe(2);
    expect(tx.from).toBe(EVM_ADDRESS);
    expect(tx.to).toBe(LIFI_ROUTER);
    expect(tx.data).toBe('0x12345678');
    // The device is only prompted once every pre-signing check has passed.
    expect(events.indexOf('screen')).toBeLessThan(events.indexOf('sign'));
    expect(events.lastIndexOf('simulate')).toBeLessThan(events.indexOf('sign'));
    expect(session.signEvmTransaction).toHaveBeenCalledWith(
      { address: EVM_ADDRESS, path: LEDGER_WALLET.ledgerPaths.evm },
      expect.any(Buffer),
    );
    expect(() => loadQuote(quoteId)).toThrow(/already executed/);
    expect(usage).toEqual({ opened: 1, released: 1 });
  });

  it('signs a legacy (gasPrice-only) swap with an EIP-155 v', async () => {
    const session = fakeLedgerSession();
    useLedger(session);
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ gasPrice: '5000000' });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId });

    expect(broadcasts).toHaveLength(1);
    const tx = decodeSignedEvmTx(broadcasts[0]);
    expect(tx.type).toBe(0);
    expect(tx.chainId).toBe(BASE_CHAIN_ID);
    expect(tx.from).toBe(EVM_ADDRESS);
  });

  it('revokes, approves and swaps an ERC-20 inside one Ledger session', async () => {
    const session = fakeLedgerSession();
    const usage = useLedger(session);
    // An allowance above the oversized threshold forces revoke → approve → swap.
    const { broadcasts } = mockEvmNetwork({ allowance: 10n ** 30n });
    const inputAmount = '100000';
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: BASE_ETH,
        inAmount: inputAmount,
        inputAmount,
        outAmount: '44000000000000',
        approvalAddress: LIFI_ROUTER,
        transaction: { to: LIFI_ROUTER, data: '0xdeadbeef', value: '0', gas: '300000', gasPrice: '5000000' },
        metadata: {},
      }],
    }, 'base', 'ledger', null, null, {
      swapMode: 'exactIn',
      request: evmIntent({ fromToken: BASE_USDC, toToken: BASE_ETH, amount: inputAmount }),
    });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await cmds.execute([], screenApi(), { 'no-simulate': true, 'no-verify-outcome': true }, { quote: quoteId });

    expect(withLedger).toHaveBeenCalledTimes(1);
    expect(session.signEvmTransaction).toHaveBeenCalledTimes(3);
    expect(broadcasts).toHaveLength(3);
    const [revoke, approve, swap] = broadcasts.map(decodeSignedEvmTx);
    for (const tx of [revoke, approve, swap]) expect(tx.from).toBe(EVM_ADDRESS);
    expect(revoke.to).toBe(BASE_USDC);
    expect(revoke.data).toBe('0x' + APPROVE_SELECTOR + LIFI_ROUTER.slice(2).padStart(64, '0') + '0'.repeat(64));
    expect(approve.to).toBe(BASE_USDC);
    expect(approve.data.endsWith(BigInt(inputAmount).toString(16).padStart(64, '0'))).toBe(true);
    expect(swap.to).toBe(LIFI_ROUTER);
    expect(swap.data).toBe('0xdeadbeef');
    // All three signatures share one session, released at the end.
    expect(usage).toEqual({ opened: 1, released: 1 });
  });

  it('refuses before connecting when the Ledger wallet does not match the quote', async () => {
    useLedger(fakeLedgerSession());
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' }, { walletAddress: addressForKey(OTHER_EVM_KEY) });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect(withLedger).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });

  it('refuses a non-Ledger wallet for a Ledger quote', async () => {
    vi.mocked(showWallet).mockReturnValue({ ...LEDGER_WALLET, provider: 'local' });
    useLedger(fakeLedgerSession());
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), {}, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect(withLedger).not.toHaveBeenCalled();
  });

  it('stops without trying the next quote when a different Ledger is connected', async () => {
    const session = fakeLedgerSession({ evmKey: OTHER_EVM_KEY });
    useLedger(session);
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' }, { quotes: 2 });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'WALLET_MISMATCH' });
    expect(session.signEvmTransaction).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(0);
  });

  it('propagates a rejection on the device and does not re-prompt for the next quote', async () => {
    const session = fakeLedgerSession();
    session.signEvmTransaction.mockRejectedValue(
      new CommandError('Signing the transaction was rejected on the Ledger. Nothing was signed.', 'LEDGER_REJECTED'),
    );
    const usage = useLedger(session);
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' }, { quotes: 2 });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'LEDGER_REJECTED', message: expect.stringContaining('rejected on the Ledger') });
    expect(session.signEvmTransaction).toHaveBeenCalledTimes(1);
    expect(withLedger).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(0);
    // The session opened for the rejected signature is still released.
    expect(usage).toEqual({ opened: 1, released: 1 });
  });

  it('propagates a connection failure (no Ledger found) as-is', async () => {
    withLedger.mockRejectedValue(new CommandError('No Ledger found. Plug it in over USB, unlock it, and retry.', 'LEDGER_NOT_FOUND'));
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' }, { quotes: 2 });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'LEDGER_NOT_FOUND' });
    expect(withLedger).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(0);
  });

  it('refuses a software-wallet quote executed with a Ledger wallet', async () => {
    vi.mocked(listWallets).mockReturnValue({ wallets: [{ name: LEDGER_WALLET.name, provider: 'ledger' }], defaultWallet: LEDGER_WALLET.name });
    useLedger(fakeLedgerSession());
    const quoteId = saveQuote({
      success: true,
      quotes: [{ aggregator: 'lifi', inputMint: BASE_ETH, outputMint: BASE_USDC, inAmount: '1', outAmount: '1', transaction: { to: LIFI_ROUTER, data: '0x12345678', value: '1', gas: '210000', maxFeePerGas: '6600000' } }],
    }, 'base', 'local', null, null, { swapMode: 'exactIn', request: evmIntent({ amount: '1' }) });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), {}, { quote: quoteId, wallet: LEDGER_WALLET.name }))
      .rejects.toMatchObject({ code: 'WALLET_MISMATCH', message: expect.stringContaining(`Get a new quote with --wallet ${LEDGER_WALLET.name}`) });
    expect(exportWallet).not.toHaveBeenCalled();
    expect(withLedger).not.toHaveBeenCalled();
  });

  it('refuses with a recreate hint when the Ledger wallet has no address for the chain', async () => {
    vi.mocked(showWallet).mockReturnValue({ ...LEDGER_WALLET, evm: null });
    useLedger(fakeLedgerSession());
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), {}, { quote: quoteId }))
      .rejects.toMatchObject({ message: expect.stringContaining(`Recreate it with: nansen wallet create --provider ledger --name ${LEDGER_WALLET.name}`) });
    expect(withLedger).not.toHaveBeenCalled();
  });

  it('rejects --gasless for a Ledger wallet without touching the device', async () => {
    useLedger(fakeLedgerSession());
    const { broadcasts } = mockEvmNetwork();
    const quoteId = saveNativeEvmQuote({ maxFeePerGas: '6600000' }, { aggregator: 'relay', to: RELAY_ROUTER });

    const cmds = buildTradingCommands({ log: () => {}, exit: () => {} });
    await expect(cmds.execute([], screenApi(), { gasless: true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'GASLESS_UNSUPPORTED_WALLET', message: expect.stringContaining('Ledger') });
    expect(withLedger).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });
});

describe('Ledger cross-chain trade (quote --to-chain → execute)', () => {
  let origSolanaSimRpc;
  beforeEach(() => { origSolanaSimRpc = SIMULATION_RPCS.solana; SIMULATION_RPCS.solana = null; });
  afterEach(() => { SIMULATION_RPCS.solana = origSolanaSimRpc; });

  it('Base → Solana: quotes for both Ledger addresses and signs the Relay deposit on the device', async () => {
    const session = fakeLedgerSession();
    useLedger(session);
    const inAmount = '10000000000000000';
    const { quoteRequests, broadcasts } = mockCrossChainNetwork({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: BASE_ETH,
        outputMint: '11111111111111111111111111111111',
        inAmount,
        outAmount: '250000000',
        inUsdValue: '40',
        approvalAddress: '',
        transaction: { to: RELAY_ROUTER, data: '0x12345678', value: inAmount, gas: '300000', maxFeePerGas: '5000000', maxPriorityFeePerGas: '1000000' },
        metadata: { requestId: 'relay-req-ledger', isCrossChain: true, bridgeTool: 'relay' },
      }],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.quote([], screenApi(), {}, { chain: 'base', 'to-chain': 'solana', from: BASE_ETH, to: '11111111111111111111111111111111', amount: inAmount });
    const quoteId = quoteIdFrom(logs);
    const saved = loadQuote(quoteId);
    expect(saved).toMatchObject({ signerType: 'ledger', toChain: 'solana', request: { walletAddress: EVM_ADDRESS, recipient: SOLANA.address } });
    expect(quoteRequests[0]).toContain(EVM_ADDRESS);
    expect(quoteRequests[0]).toContain(SOLANA.address);

    await cmds.execute([], screenApi(), { 'no-verify-outcome': true }, { quote: quoteId });

    expect(withLedger).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
    const tx = decodeSignedEvmTx(broadcasts[0]);
    expect(tx).toMatchObject({ type: 2, from: EVM_ADDRESS, to: RELAY_ROUTER, data: '0x12345678' });
    expect(logs.some(l => l.includes('Bridge completed'))).toBe(true);
  });

  it('Solana → Base: compiles Relay raw instructions with the Ledger as fee payer and the signature verifies', async () => {
    const session = fakeLedgerSession();
    useLedger(session);
    const inAmount = '1000000000';
    const { quoteRequests, broadcasts } = mockCrossChainNetwork({
      success: true,
      quotes: [{
        aggregator: 'relay',
        inputMint: '11111111111111111111111111111111',
        outputMint: BASE_USDC,
        inAmount,
        outAmount: '180000000',
        inUsdValue: '150',
        approvalAddress: '',
        transaction: {
          instructions: [{
            keys: [
              { pubkey: SOLANA.address, isSigner: true, isWritable: true },
              { pubkey: generateSolanaWallet().address, isSigner: false, isWritable: true },
            ],
            programId: generateSolanaWallet().address,
            data: 'deadbeef',
          }],
        },
        metadata: { requestId: 'relay-req-ledger-sol', isCrossChain: true, bridgeTool: 'relay' },
      }],
    });

    const logs = [];
    const cmds = buildTradingCommands({ log: (m) => logs.push(m), exit: () => {} });
    await cmds.quote([], screenApi(), {}, { chain: 'solana', 'to-chain': 'base', from: '11111111111111111111111111111111', to: BASE_USDC, amount: inAmount });
    const quoteId = quoteIdFrom(logs);
    expect(loadQuote(quoteId)).toMatchObject({ signerType: 'ledger', toChain: 'base', request: { walletAddress: SOLANA.address, recipient: EVM_ADDRESS } });
    expect(quoteRequests[0]).toContain(SOLANA.address);

    await cmds.execute([], screenApi(), {}, { quote: quoteId });

    expect(withLedger).toHaveBeenCalledTimes(1);
    expect(session.signSolanaTransaction).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
    // Compiled with the Ledger's address as the first (fee-payer) account key.
    const signed = Buffer.from(broadcasts[0], 'base64');
    const messageOffset = 1 + 64;
    const firstKey = signed.subarray(messageOffset + 1 + 3 + 1, messageOffset + 1 + 3 + 1 + 32);
    expect(Buffer.compare(firstKey, base58Decode(SOLANA.address))).toBe(0);
    expect(solanaSignatureValid(broadcasts[0], SOLANA.address)).toBe(true);
    expect(logs.some(l => l.includes('Bridge completed'))).toBe(true);
  });
});
