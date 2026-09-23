/**
 * Nansen CLI — Ledger hardware wallet transport (the only module that touches
 * the Ledger Device Management Kit).
 *
 * Callers never see DMK objects. They get one USB session per command through
 * withLedger(fn), and the session exposes four methods: two address reads and
 * two signers. Private keys never leave the device; nansen still builds,
 * fee-prices and broadcasts every transaction itself, exactly like the local
 * path — the Ledger only replaces signSecp256k1 / Ed25519.
 *
 * The DMK packages are optional peer dependencies: users without a Ledger never
 * install them. They are loaded through createRequire because their ESM build
 * uses directory imports that Node refuses (ERR_UNSUPPORTED_DIR_IMPORT).
 */

import { createRequire } from 'node:module';
import { CommandError } from './api.js';
import { CHAIN_RPCS } from './rpc-urls.js';

const require = createRequire(import.meta.url);

// Ledger Live's standard first account on each chain.
export const LEDGER_PATHS = {
  evm: "44'/60'/0'/0/0",
  solana: "44'/501'/0'/0'",
};

const CONNECT_TIMEOUT_MS = 30_000;
// Matches the WalletConnect approval window (walletconnect-trading.js).
const ACTION_TIMEOUT_MS = 120_000;

const LEDGER_PACKAGES = [
  '@ledgerhq/device-management-kit@^1.9.1',
  '@ledgerhq/device-transport-kit-node-hid@^1.0.1',
  '@ledgerhq/device-signer-kit-ethereum@^1.18.1',
  '@ledgerhq/device-signer-kit-solana@^1.13.2',
  '@ledgerhq/context-module@^2.6.0',
  'rxjs@7.8.2',
];

export const LEDGER_INSTALL_COMMAND = `npm i -g ${LEDGER_PACKAGES.join(' ')}`;

const PROMPTS = {
  'unlock-device': 'ACTION REQUIRED: Unlock your Ledger with your PIN',
  'confirm-open-app': 'ACTION REQUIRED: Confirm opening the app on your Ledger',
  'verify-address': 'ACTION REQUIRED: Check the address on your Ledger matches the one shown here, then approve',
  'sign-transaction': 'ACTION REQUIRED: Review and approve the transaction on your Ledger',
  'sign-typed-data': 'ACTION REQUIRED: Review and approve the message on your Ledger',
  'sign-personal-message': 'ACTION REQUIRED: Review and approve the message on your Ledger',
};

// Blind-signing telemetry is on by default in the context module and reports
// every signature to Ledger. Clear-signing metadata (CAL) and transaction
// checks stay enabled; only this report is dropped.
const NO_BLIND_SIGNING_REPORT = { report: async () => {} };

export function ledgerUnsupportedError(feature, hint = 'Use a software wallet instead: pass --wallet <name>, or run: nansen wallet default <name>') {
  // todo: Ledger v1 signs wallet send and trade only; x402, bridge, perp and
  // limit-order need EIP-712 / off-chain message signing on the device — add
  // them when there is demand.
  return new CommandError(`Ledger wallets don't support ${feature} yet. ${hint}`, 'LEDGER_UNSUPPORTED');
}

function loadLedgerKit() {
  try {
    return {
      dmk: require('@ledgerhq/device-management-kit'),
      transport: require('@ledgerhq/device-transport-kit-node-hid'),
      eth: require('@ledgerhq/device-signer-kit-ethereum'),
      solana: require('@ledgerhq/device-signer-kit-solana'),
      contextModule: require('@ledgerhq/context-module'),
    };
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new CommandError(
      `Ledger support requires additional packages. Run: ${LEDGER_INSTALL_COMMAND}`,
      'LEDGER_DEPS_MISSING',
      null,
      { cause: err },
    );
  }
}

// The node-hid transport keeps a libusb hotplug listener alive, so Node never
// exits on its own — not even after dmk.close(). `usb` is the transport's own
// dependency, so resolve it from there rather than from nansen-cli.
function releaseUsb() {
  try {
    const transportRequire = createRequire(require.resolve('@ledgerhq/device-transport-kit-node-hid'));
    transportRequire('usb').usb.unrefHotplugEvents();
  } catch {
    // Nothing to release if the transport never loaded.
  }
}

// Resolve with the first emitted value matching `predicate`, or reject with
// onTimeout() after `timeoutMs`. Handles observables that emit synchronously
// during subscribe (the session state is a BehaviorSubject).
function firstMatching(observable, predicate, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let done = false;
    let subscription = null;
    const finish = (settle) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(onTimeout())), timeoutMs);
    subscription = observable.subscribe({
      next: (value) => { if (predicate(value)) finish(() => resolve(value)); },
      error: (err) => finish(() => reject(err)),
    });
    if (done) subscription.unsubscribe();
  });
}

function errorCode(err) {
  return String(err?.errorCode ?? err?.originalError?.errorCode ?? '').toLowerCase();
}

function toLedgerError(err, { label, app, blindSigningFallback = false }) {
  if (err instanceof CommandError) return err;
  const tag = err?._tag || err?.name || '';
  const code = errorCode(err);

  if (code === '6985' || code === '5501' || tag === 'RefusedByUserDAError' || tag === 'ActionRefusedError') {
    return new CommandError(`${label} was rejected on the Ledger. Nothing was signed.`, 'LEDGER_REJECTED', null, { cause: err });
  }
  if (code === '5515' || tag === 'DeviceLockedError') {
    return new CommandError('Ledger is locked. Unlock it with your PIN and retry.', 'LEDGER_LOCKED', null, { cause: err });
  }
  if (code === '6807') {
    return new CommandError(`The ${app} app is not installed on your Ledger. Install it with Ledger Live and retry.`, 'LEDGER_APP_MISSING', null, { cause: err });
  }
  if (blindSigningFallback) {
    return blindSigningError(app, err);
  }
  const detail = err instanceof Error ? err.message : (err?.message || tag || JSON.stringify(err));
  return new CommandError(`${label} failed on the Ledger: ${detail}`, 'LEDGER_ERROR', null, { cause: err });
}

function blindSigningError(app, cause) {
  return new CommandError(
    `The Ledger ${app} app could not clear-sign this transaction. Enable "Blind signing" in the ${app} app settings on your Ledger and retry.`,
    'LEDGER_BLIND_SIGNING_DISABLED',
    null,
    { cause },
  );
}

// Run one DMK device action ({observable, cancel}) to completion, echoing the
// on-device prompts to stderr so an unattended agent log shows why it waits.
function runDeviceAction(kit, action, { label, app }) {
  const { DeviceActionStatus } = kit.dmk;
  let lastPrompt = '';
  let blindSigningFallback = false;

  return new Promise((resolve, reject) => {
    let done = false;
    let subscription = null;
    const finish = (settle) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      settle();
    };
    const timer = setTimeout(() => finish(() => {
      action.cancel();
      reject(new CommandError(
        `${label} timed out after ${ACTION_TIMEOUT_MS / 1000}s waiting for the Ledger. Check the device screen and retry.`,
        'LEDGER_TIMEOUT',
      ));
    }), ACTION_TIMEOUT_MS);

    subscription = action.observable.subscribe({
      next: (state) => {
        switch (state.status) {
          case DeviceActionStatus.Pending: {
            const interaction = state.intermediateValue?.requiredUserInteraction;
            if (String(state.intermediateValue?.step ?? '').includes('blindSign')) blindSigningFallback = true;
            if (interaction && interaction !== 'none' && interaction !== lastPrompt) {
              lastPrompt = interaction;
              process.stderr.write(`  ${PROMPTS[interaction] || `ACTION REQUIRED: ${interaction}`}\n`);
            }
            break;
          }
          case DeviceActionStatus.Completed:
            finish(() => resolve(state.output));
            break;
          case DeviceActionStatus.Error:
            finish(() => reject(toLedgerError(state.error, { label, app, blindSigningFallback })));
            break;
          case DeviceActionStatus.Stopped:
            finish(() => reject(new CommandError(`${label} was cancelled.`, 'LEDGER_CANCELLED')));
            break;
        }
      },
      error: (err) => finish(() => reject(toLedgerError(err, { label, app, blindSigningFallback }))),
    });
    if (done) subscription.unsubscribe();
  });
}

async function connect(kit, dmk) {
  process.stderr.write('Looking for a Ledger over USB...\n');
  let device;
  try {
    device = await firstMatching(
      dmk.startDiscovering({}),
      () => true,
      CONNECT_TIMEOUT_MS,
      () => new CommandError('No Ledger found. Plug it in over USB, unlock it, and retry.', 'LEDGER_NOT_FOUND'),
    );
  } catch (err) {
    throw toLedgerError(err, { label: 'Connecting', app: 'Ledger' });
  } finally {
    try { await dmk.stopDiscovering(); } catch { /* already stopped */ }
  }

  const sessionId = await dmk.connect({ device });
  // A session held by another app (Ledger Live, wallet-cli) never becomes ready
  // and never errors either — it just stays busy — so this timeout is the only
  // signal the user gets.
  try {
    await firstMatching(
      dmk.getDeviceSessionState({ sessionId }),
      (state) => state.sessionStateType >= kit.dmk.DeviceSessionStateType.ReadyWithoutSecureChannel,
      CONNECT_TIMEOUT_MS,
      () => new CommandError(
        'Ledger is busy. Close Ledger Live (or any other app using the device), unlock the Ledger, and retry.',
        'LEDGER_BUSY',
      ),
    );
  } catch (err) {
    // withLedger only disconnects sessions connect() returned, so release this one here.
    try { await dmk.disconnect({ sessionId }); } catch { /* device already gone */ }
    throw err;
  }
  return sessionId;
}

function toRecoveryBit(v) {
  const n = Number(v);
  if (n === 0 || n === 1) return n;
  if (n === 27 || n === 28) return n - 27;
  // EIP-155 legacy: v = chainId * 2 + 35 + recoveryBit
  return (n - 35) % 2;
}

function hexToBuffer32(hex) {
  return Buffer.from(String(hex).replace(/^0x/, '').padStart(64, '0'), 'hex');
}

function assertSameAddress(expected, actual, chainLabel, normalize = (a) => a) {
  if (normalize(expected) !== normalize(actual)) {
    throw new CommandError(
      `The connected Ledger's ${chainLabel} address (${actual}) does not match this wallet (${expected}). Connect the Ledger this wallet was created with.`,
      'WALLET_MISMATCH',
    );
  }
}

function createSession(kit, dmk, sessionId) {
  const contextModule = (chain) => new kit.contextModule.ContextModuleBuilder({ originToken: '' })
    .setChain(chain)
    .setBlindSigningReporter(NO_BLIND_SIGNING_REPORT)
    .build();

  let ethSigner = null;
  let solanaSigner = null;
  const eth = () => {
    ethSigner ??= new kit.eth.SignerEthBuilder({ dmk, sessionId })
      .withContextModule(contextModule(kit.contextModule.ContextModuleChainID.Ethereum))
      .build();
    return ethSigner;
  };
  const solana = () => {
    // The RPC lets the signer resolve address lookup tables in versioned
    // (Jupiter) transactions; without it clear signing falls back to blind.
    solanaSigner ??= new kit.solana.SignerSolanaBuilder({ dmk, sessionId, solanaRPCURL: CHAIN_RPCS.solana })
      .withContextModule(contextModule(kit.contextModule.ContextModuleChainID.Solana))
      .build();
    return solanaSigner;
  };

  const session = {
    async getEvmAddress({ verify = false, path = LEDGER_PATHS.evm } = {}) {
      const { address } = await runDeviceAction(
        kit,
        eth().getAddress(path, { checkOnDevice: verify }),
        { label: 'Reading the Ethereum address', app: 'Ethereum' },
      );
      return address;
    },

    async getSolanaAddress({ verify = false, path = LEDGER_PATHS.solana } = {}) {
      return runDeviceAction(
        kit,
        solana().getAddress(path, { checkOnDevice: verify }),
        { label: 'Reading the Solana address', app: 'Solana' },
      );
    },

    // unsignedTx: the exact bytes the local signer hashes — RLP of the EIP-155
    // legacy fields, or 0x02 || RLP(payload) for EIP-1559. Returns the same
    // { r, s, v: recoveryBit } shape as signSecp256k1 so callers assemble the
    // signed envelope with their existing code.
    async signEvmTransaction(expected, unsignedTx) {
      const path = expected.path || LEDGER_PATHS.evm;
      assertSameAddress(expected.address, await session.getEvmAddress({ path }), 'EVM', (a) => a.toLowerCase());
      const { r, s, v } = await runDeviceAction(
        kit,
        eth().signTransaction(path, Uint8Array.from(unsignedTx)),
        { label: 'Signing the transaction', app: 'Ethereum' },
      );
      return { r: hexToBuffer32(r), s: hexToBuffer32(s), v: toRecoveryBit(v) };
    },

    // tx: the full wire-format transaction (or its message bytes). Returns the
    // 64-byte Ed25519 signature; the caller writes it into the signer's slot.
    async signSolanaTransaction(expected, tx) {
      const path = expected.path || LEDGER_PATHS.solana;
      assertSameAddress(expected.address, await session.getSolanaAddress({ path }), 'Solana');
      try {
        const signature = await runDeviceAction(
          kit,
          solana().signTransaction(path, Uint8Array.from(tx)),
          { label: 'Signing the transaction', app: 'Solana' },
        );
        return Buffer.from(signature);
      } catch (err) {
        if (err.code !== 'LEDGER_ERROR') throw err;
        // The Solana app's "blind signing disabled" status word is not in the
        // SDK's known codes, so ask the app directly once signing has failed.
        const config = await runDeviceAction(kit, solana().getAppConfiguration(), { label: 'Reading the Solana app settings', app: 'Solana' })
          .catch(() => null);
        if (config && config.blindSigningEnabled === false) throw blindSigningError('Solana', err);
        throw err;
      }
    },
  };
  return session;
}

// Open one USB session, run `fn(session)`, and always release the device and
// the libusb handle — even on error — so the CLI can exit.
export async function withLedger(fn) {
  const kit = loadLedgerKit();
  const dmk = new kit.dmk.DeviceManagementKitBuilder()
    .addTransport(kit.transport.nodeHidTransportFactory)
    .build();
  let sessionId = null;
  try {
    sessionId = await connect(kit, dmk);
    return await fn(createSession(kit, dmk, sessionId));
  } finally {
    if (sessionId) {
      try { await dmk.disconnect({ sessionId }); } catch { /* device already gone */ }
    }
    try { dmk.close(); } catch { /* already closed */ }
    releaseUsb();
  }
}
