/**
 * End-to-end Ledger tests — runs the actual CLI against a real device and mainnet.
 *
 * Prerequisites:
 *   - NANSEN_LEDGER_E2E=1 (the whole file is skipped otherwise)
 *   - A Ledger connected over USB and unlocked, with the Ethereum and Solana
 *     apps installed. Close Ledger Live (and wallet-cli): they hold the USB
 *     session and the CLI reports "Ledger is busy".
 *   - Ledger peer packages installed next to the repo:
 *       npm i --no-save @ledgerhq/device-management-kit@^1.9.1 @ledgerhq/device-transport-kit-node-hid@^1.0.1 \
 *         @ledgerhq/device-signer-kit-ethereum@^1.18.1 @ledgerhq/device-signer-kit-solana@^1.13.2 \
 *         @ledgerhq/context-module@^2.6.0 rxjs@7.8.2
 *   - Linux: Ledger udev rules installed, otherwise the device is invisible to
 *     non-root users (https://github.com/LedgerHQ/udev-rules).
 *   - The Ledger's first accounts (44'/60'/0'/0/0, 44'/501'/0'/0') funded with
 *     ETH on Base (~0.001), SOL on Solana (~0.01) and >= 1 USDC on Base (the
 *     cross-chain step moves 1 USDC to the Ledger's Solana address).
 *   - NANSEN_LEDGER_E2E_PEER=<name> of a funded local wallet in ~/.nansen/wallets/
 *     (ETH on Base, SOL on Solana) and NANSEN_WALLET_PASSWORD for it.
 *   - Blind signing enabled in the Ethereum app if the device can't clear-sign the
 *     swap; Relay/LI.FI cross-chain transactions usually need it.
 *
 * Clear signing check (manual, on the device screen): ledger.js builds the
 * context module with an empty originToken, so confirm CAL metadata and
 * transaction checks (web3checks) still resolve. For the Base ETH → USDC swap
 * and the USDC legs, the device should show the token ticker (USDC) and a
 * formatted amount rather than raw hex calldata, and no "Blind signing" /
 * "unverified" warning. If every transaction falls back to blind signing
 * (the screen shows only a hash / "Accept risk"), the empty originToken is
 * the first suspect.
 *
 * Run: NANSEN_LEDGER_E2E=1 NANSEN_LEDGER_E2E_PEER=test1 npm run test:ledger
 *
 * These tests move REAL funds and every Ledger step waits for a human to
 * approve on the device (up to 120s each). The Ledger wallet entry is created
 * under a throwaway name and deleted at the end; the keys stay on the device.
 */

import { spawnSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';

const CLI_PATH = path.resolve('src/index.js');
const ENABLED = process.env.NANSEN_LEDGER_E2E === '1';
const PEER = process.env.NANSEN_LEDGER_E2E_PEER;
const LEDGER_NAME = `ledger-e2e-${Date.now()}`;

// Room for a human to approve on the device (ledger.js waits 120s per action).
const DEVICE_TIMEOUT = 300_000;

function runCli(...args) {
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {};
  const { stdout, stderr, status } = spawnSync('node', [CLI_PATH, ...args], {
    env: process.env,
    encoding: 'utf8',
    timeout: opts.timeout || DEVICE_TIMEOUT,
  });
  const output = (stdout || '') + (stderr || '');
  return { output, exitCode: status ?? 1 };
}

function addresses(output) {
  return {
    evm: output.match(/EVM:\s+(0x[a-fA-F0-9]{40})/)?.[1],
    solana: output.match(/Solana:\s+([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1],
  };
}

const SEND_AMOUNT_ETH = '0.0001';
const SEND_AMOUNT_SOL = '0.001';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SWAP_AMOUNT_ETH = '270000000000000'; // ~$0.50
const CROSS_CHAIN_USDC = '1000000'; // 1 USDC (6 decimals)
// trade execute polls the bridge for up to 10 min after the device approval.
const BRIDGE_TIMEOUT = 720_000;

describe.skipIf(!ENABLED)('e2e: Ledger wallet', () => {
  const ledger = {};
  const peer = {};

  beforeAll(() => {
    if (!PEER) throw new Error('Set NANSEN_LEDGER_E2E_PEER to the name of a funded local wallet.');
    const { output, exitCode } = runCli('wallet', 'show', PEER);
    expect(exitCode, `Peer wallet "${PEER}" not found:\n${output}`).toBe(0);
    Object.assign(peer, addresses(output));
  });

  afterAll(() => {
    runCli('wallet', 'delete', LEDGER_NAME);
  });

  it('wallet create --provider ledger', () => {
    const { output, exitCode } = runCli('wallet', 'create', '--provider', 'ledger', '--name', LEDGER_NAME);
    expect(exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain(`Ledger wallet "${LEDGER_NAME}" created`);
    Object.assign(ledger, addresses(output));
    expect(ledger.evm, `Expected EVM address:\n${output}`).toBeTruthy();
    expect(ledger.solana, `Expected Solana address:\n${output}`).toBeTruthy();
  });

  it('wallet show reports the ledger provider and the same addresses', () => {
    const { output, exitCode } = runCli('wallet', 'show', LEDGER_NAME);
    expect(exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain('(ledger)');
    expect(addresses(output)).toEqual({ evm: ledger.evm, solana: ledger.solana });
  });

  describe.sequential('native ETH send round-trip on Base', () => {
    it('Ledger → peer', () => {
      const { output, exitCode } = runCli(
        'wallet', 'send', '--to', peer.evm, '--amount', SEND_AMOUNT_ETH, '--chain', 'base', '--wallet', LEDGER_NAME,
      );
      expect(exitCode, `CLI failed:\n${output}`).toBe(0);
      const tx = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
      expect(tx, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
      console.log(`ETH Ledger→peer: https://basescan.org/tx/${tx[1]}`);
    });

    it('peer → Ledger', () => {
      const { output, exitCode } = runCli(
        'wallet', 'send', '--to', ledger.evm, '--amount', SEND_AMOUNT_ETH, '--chain', 'base', '--wallet', PEER,
      );
      expect(exitCode, `CLI failed:\n${output}`).toBe(0);
      expect(output).toContain('Transaction sent');
    });
  });

  describe.sequential('native SOL send round-trip on Solana', () => {
    it('Ledger → peer', () => {
      const { output, exitCode } = runCli(
        'wallet', 'send', '--to', peer.solana, '--amount', SEND_AMOUNT_SOL, '--chain', 'solana', '--wallet', LEDGER_NAME,
      );
      expect(exitCode, `CLI failed:\n${output}`).toBe(0);
      const sig = output.match(/Tx Hash:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
      expect(sig, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
      console.log(`SOL Ledger→peer: https://solscan.io/tx/${sig[1]}`);
    });

    it('peer → Ledger', () => {
      const { output, exitCode } = runCli(
        'wallet', 'send', '--to', ledger.solana, '--amount', SEND_AMOUNT_SOL, '--chain', 'solana', '--wallet', PEER,
      );
      expect(exitCode, `CLI failed:\n${output}`).toBe(0);
      expect(output).toContain('Transaction sent');
    });
  });

  describe.sequential('ETH ↔ USDC swap round-trip on Base', () => {
    const state = {};

    function swap(from, to, amount) {
      const quote = runCli('trade', 'quote', '--chain', 'base', '--from', from, '--to', to, '--amount', amount, '--wallet', LEDGER_NAME);
      const quoteId = quote.output.match(/Quote ID:\s+(\S+)/)?.[1];
      expect(quoteId, `Expected Quote ID in output:\n${quote.output}`).toBeTruthy();

      const { output } = runCli('trade', 'execute', '--quote', quoteId, '--wallet', LEDGER_NAME);
      expect(output).toContain('Transaction successful');
      const tx = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
      expect(tx, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
      console.log(`Swap ${from.slice(0, 6)}→${to.slice(0, 6)}: https://basescan.org/tx/${tx[1]}`);
      return output;
    }

    it('ETH → USDC', () => {
      const output = swap(BASE_ETH, BASE_USDC, SWAP_AMOUNT_ETH);
      state.usdc = output.match(/Output:\s+(\d+)\s+→/)?.[1];
      expect(state.usdc, `Expected Output amount in output:\n${output}`).toBeTruthy();
    });

    it('USDC → ETH', () => {
      expect(state.usdc, 'Forward swap must capture USDC amount').toBeTruthy();
      swap(BASE_USDC, BASE_ETH, state.usdc);
    });
  });

  // Cross-chain via `trade` is supported (the Ledger signs the source-chain
  // tx); only the `nansen bridge` commands are not. One-way: the USDC lands on
  // the Ledger's own Solana address, so nothing leaves the device's accounts.
  it('cross-chain USDC (Base) → USDC (Solana) via trade --to-chain', () => {
    const quote = runCli(
      'trade', 'quote', '--chain', 'base', '--to-chain', 'solana',
      '--from', BASE_USDC, '--to', 'USDC', '--amount', CROSS_CHAIN_USDC, '--wallet', LEDGER_NAME,
    );
    expect(quote.output).toContain('cross-chain quote');
    const quoteId = quote.output.match(/Quote ID:\s+(\S+)/)?.[1];
    expect(quoteId, `Expected Quote ID in output:\n${quote.output}`).toBeTruthy();

    const { output } = runCli('trade', 'execute', '--quote', quoteId, '--wallet', LEDGER_NAME, { timeout: BRIDGE_TIMEOUT });
    expect(output).toContain('Transaction successful');
    const tx = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(tx, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    console.log(`Cross-chain Base→Solana: https://basescan.org/tx/${tx[1]}`);
  }, BRIDGE_TIMEOUT + 60_000);

  it('wallet delete removes the entry only', () => {
    const { output, exitCode } = runCli('wallet', 'delete', LEDGER_NAME);
    expect(exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain(`Wallet "${LEDGER_NAME}" deleted`);
    expect(runCli('wallet', 'show', LEDGER_NAME).exitCode).not.toBe(0);
  });
});
