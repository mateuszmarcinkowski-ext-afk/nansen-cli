/**
 * Tests for the Ledger transport (src/ledger.js). The DMK packages are not
 * installed, so createRequire is mocked to hand out fake DMK objects whose
 * device actions return { observable, cancel } like the real kit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keccak256, signSecp256k1 } from '../crypto.js';

const h = vi.hoisted(() => ({
  modules: null,
  usb: { unrefHotplugEvents: vi.fn() },
  hid: { devicesAsync: async () => [] },
}));

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  const fakeRequire = (name) => {
    if (name === 'usb') return { usb: h.usb };
    if (name === 'node-hid') return h.hid;
    if (!h.modules || !h.modules[name]) {
      const err = new Error(`Cannot find module '${name}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return h.modules[name];
  };
  fakeRequire.resolve = (name) => `/fake/node_modules/${name}/index.js`;
  return {
    ...actual,
    createRequire: (from) => (String(from).includes('ledger.js') || String(from).startsWith('/fake/')
      ? fakeRequire
      : actual.createRequire(from)),
  };
});

const { withLedger, LEDGER_INSTALL_COMMAND, LEDGER_PATHS } = await import('../ledger.js');

const DeviceActionStatus = { NotStarted: 'none', Pending: 'pending', Stopped: 'stopped', Completed: 'completed', Error: 'error' };
const DeviceSessionStateType = { Connected: 0, ReadyWithoutSecureChannel: 1, ReadyWithSecureChannel: 2 };

const EVM_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const EVM_KEY = Buffer.from('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'hex');
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

// An observable that emits `values` synchronously on subscribe, like the
// BehaviorSubject-backed DMK streams, then stays silent — which is what a
// session held by another app looks like when the only value is Connected.
function observableOf(...values) {
  return {
    subscribe({ next }) {
      for (const v of values) next(v);
      return { unsubscribe: vi.fn() };
    },
  };
}

function completed(output) {
  return { observable: observableOf({ status: DeviceActionStatus.Completed, output }), cancel: vi.fn() };
}

function failed(error) {
  return { observable: observableOf({ status: DeviceActionStatus.Error, error }), cancel: vi.fn() };
}

let dmk;
let eth;
let solana;
let sessionState;

function installFakeKit() {
  sessionState = observableOf({ sessionStateType: DeviceSessionStateType.ReadyWithoutSecureChannel });
  dmk = {
    startDiscovering: vi.fn(() => observableOf({ id: 'device-1' })),
    stopDiscovering: vi.fn(async () => {}),
    connect: vi.fn(async () => 'session-1'),
    getDeviceSessionState: vi.fn(() => sessionState),
    disconnect: vi.fn(async () => {}),
    close: vi.fn(),
  };
  eth = {
    getAddress: vi.fn(() => completed({ address: EVM_ADDRESS })),
    signTransaction: vi.fn(),
  };
  solana = {
    getAddress: vi.fn(() => completed(SOLANA_ADDRESS)),
    signTransaction: vi.fn(),
    getAppConfiguration: vi.fn(),
  };
  const builder = (product) => function Builder() {
    this.withContextModule = () => this;
    this.addTransport = () => this;
    this.build = () => product;
  };
  function ContextModuleBuilder() {
    this.setChain = () => this;
    this.setBlindSigningReporter = () => this;
    this.build = () => ({});
  }
  h.modules = {
    '@ledgerhq/device-management-kit': {
      DeviceManagementKitBuilder: builder(dmk),
      DeviceActionStatus,
      DeviceSessionStateType,
    },
    '@ledgerhq/device-transport-kit-node-hid': { nodeHidTransportFactory: {} },
    '@ledgerhq/device-signer-kit-ethereum': { SignerEthBuilder: builder(eth) },
    '@ledgerhq/device-signer-kit-solana': { SignerSolanaBuilder: builder(solana) },
    '@ledgerhq/context-module': { ContextModuleBuilder, ContextModuleChainID: { Ethereum: 1, Solana: 'solana' } },
  };
}

let stderrSpy;

beforeEach(() => {
  vi.clearAllMocks();
  installFakeKit();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.useRealTimers();
});

function expectCleanedUp() {
  expect(dmk.disconnect).toHaveBeenCalledWith({ sessionId: 'session-1' });
  expect(dmk.close).toHaveBeenCalled();
  expect(h.usb.unrefHotplugEvents).toHaveBeenCalled();
}

describe('withLedger: packages', () => {
  it('reports missing DMK packages with the install command', async () => {
    h.modules = null;
    const fn = vi.fn();
    const err = await withLedger(fn).catch((e) => e);
    expect(err.code).toBe('LEDGER_DEPS_MISSING');
    expect(err.message).toContain(LEDGER_INSTALL_COMMAND);
    expect(LEDGER_INSTALL_COMMAND).toMatch(/^npm i -g @ledgerhq\/device-management-kit@/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withLedger: session lifecycle', () => {
  it('reports a session held by another app as LEDGER_BUSY after the connect timeout', async () => {
    vi.useFakeTimers();
    sessionState = observableOf({ sessionStateType: DeviceSessionStateType.Connected });
    const fn = vi.fn();
    const result = withLedger(fn).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await result;
    expect(err.code).toBe('LEDGER_BUSY');
    expect(err.message).toMatch(/Close Ledger Live/);
    expect(fn).not.toHaveBeenCalled();
    expectCleanedUp();
  });

  it('reports an unplugged device as LEDGER_NOT_FOUND instead of the raw DMK tag', async () => {
    dmk.startDiscovering.mockReturnValue({
      subscribe({ error }) {
        error({ _tag: 'NoAccessibleDeviceError' });
        return { unsubscribe: vi.fn() };
      },
    });
    const err = await withLedger(vi.fn()).catch((e) => e);
    expect(err.code).toBe('LEDGER_NOT_FOUND');
    expect(err.message).toMatch(/Plug it in over USB/);
  });

  it('disconnects and closes the kit when the callback throws', async () => {
    const err = await withLedger(async () => { throw new Error('boom'); }).catch((e) => e);
    expect(err.message).toBe('boom');
    expectCleanedUp();
  });

  it('disconnects and closes the kit after a successful callback', async () => {
    await expect(withLedger(async () => 'ok')).resolves.toBe('ok');
    expectCleanedUp();
  });
});

describe('session.signEvmTransaction', () => {
  const unsignedTx = Buffer.from('02c0ffee', 'hex');

  // What the Ethereum app would return for `unsignedTx`, with v in the given
  // encoding: the recovery bit, 27/28, or legacy EIP-155 chainId * 2 + 35 + bit.
  function deviceSignature(encodeV) {
    const sig = signSecp256k1(keccak256(unsignedTx), EVM_KEY);
    return { sig, output: { r: '0x' + sig.r.toString('hex'), s: '0x' + sig.s.toString('hex'), v: encodeV(sig.v) } };
  }

  it.each([
    ['recovery bit', (bit) => bit],
    ['27/28', (bit) => 27 + bit],
    ['legacy EIP-155 (Base)', (bit) => 8453 * 2 + 35 + bit],
    ['legacy EIP-155 (mainnet)', (bit) => 1 * 2 + 35 + bit],
  ])('maps v encoded as %s to the recovery bit', async (_label, encodeV) => {
    const { sig, output } = deviceSignature(encodeV);
    eth.signTransaction.mockReturnValue(completed(output));

    const result = await withLedger((s) => s.signEvmTransaction({ address: EVM_ADDRESS, path: LEDGER_PATHS.evm }, unsignedTx));

    expect(result).toEqual({ r: sig.r, s: sig.s, v: sig.v });
    const [path, bytes] = eth.signTransaction.mock.calls[0];
    expect(path).toBe(LEDGER_PATHS.evm);
    expect(Buffer.from(bytes)).toEqual(unsignedTx);
  });

  it('left-pads a short r/s to 32 bytes', async () => {
    eth.signTransaction.mockReturnValue(completed({ r: '0x01', s: '0x02', v: 1 }));
    const result = await withLedger((s) => s.signEvmTransaction({ address: EVM_ADDRESS }, unsignedTx));
    expect(result.r).toEqual(Buffer.concat([Buffer.alloc(31), Buffer.from([1])]));
    expect(result.s).toHaveLength(32);
    expect(result.v).toBe(1);
  });

  it('matches the wallet address case-insensitively', async () => {
    eth.signTransaction.mockReturnValue(completed({ r: '0x01', s: '0x02', v: 0 }));
    await expect(withLedger((s) => s.signEvmTransaction({ address: EVM_ADDRESS.toLowerCase() }, unsignedTx)))
      .resolves.toMatchObject({ v: 0 });
  });

  it('refuses to sign with a different Ledger (WALLET_MISMATCH)', async () => {
    const err = await withLedger((s) => s.signEvmTransaction({ address: '0x' + '1'.repeat(40) }, unsignedTx)).catch((e) => e);
    expect(err.code).toBe('WALLET_MISMATCH');
    expect(err.message).toContain(EVM_ADDRESS);
    expect(eth.signTransaction).not.toHaveBeenCalled();
    expectCleanedUp();
  });

  it('maps a 6985 rejection on the device to LEDGER_REJECTED', async () => {
    eth.signTransaction.mockReturnValue(failed({ _tag: 'UnknownDAError', errorCode: '6985' }));
    const err = await withLedger((s) => s.signEvmTransaction({ address: EVM_ADDRESS }, unsignedTx)).catch((e) => e);
    expect(err.code).toBe('LEDGER_REJECTED');
    expect(err.message).toMatch(/rejected on the Ledger/);
    expectCleanedUp();
  });
});

describe('session.signEvmTransaction after the blind-signing fallback', () => {
  // The SDK reports the fallback step, then fails: what the user sees must
  // depend on the status word, not on the step alone.
  function failsAfterBlindFallback(error) {
    return {
      observable: observableOf(
        { status: DeviceActionStatus.Pending, intermediateValue: { requiredUserInteraction: 'none', step: 'signer.eth.steps.blindSignTransactionFallback' } },
        { status: DeviceActionStatus.Error, error },
      ),
      cancel: vi.fn(),
    };
  }
  const sign = () => withLedger((s) => s.signEvmTransaction({ address: EVM_ADDRESS, path: LEDGER_PATHS.evm }, Buffer.from('02c0', 'hex')))
    .catch((e) => e);

  it('reports a rejection on the device as LEDGER_REJECTED, not as a settings problem', async () => {
    eth.signTransaction.mockReturnValue(failsAfterBlindFallback({ _tag: 'EthAppCommandError', errorCode: '6985', message: 'Condition not satisfied' }));
    expect((await sign()).code).toBe('LEDGER_REJECTED');
  });

  it('reports 6a80 as Blind signing being disabled', async () => {
    eth.signTransaction.mockReturnValue(failsAfterBlindFallback({ _tag: 'EthAppCommandError', errorCode: '6a80', message: 'Invalid data' }));
    const err = await sign();
    expect(err.code).toBe('LEDGER_BLIND_SIGNING_DISABLED');
    expect(err.message).toMatch(/Enable "Blind signing"/);
  });

  it('reports any other failure as a plain LEDGER_ERROR with its status word', async () => {
    eth.signTransaction.mockReturnValue(failsAfterBlindFallback({ _tag: 'EthAppCommandError', errorCode: '6a84', message: 'Not enough space' }));
    const err = await sign();
    expect(err.code).toBe('LEDGER_ERROR');
    expect(err.message).toMatch(/status 6a84/);
  });
});

describe('session.signSolanaTransaction', () => {
  const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from('message')]);

  it('returns the 64-byte signature for the full wire transaction', async () => {
    const signature = new Uint8Array(64).fill(9);
    solana.signTransaction.mockReturnValue(completed(signature));
    const result = await withLedger((s) => s.signSolanaTransaction({ address: SOLANA_ADDRESS, path: LEDGER_PATHS.solana }, tx));
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from(signature));
    const [path, bytes] = solana.signTransaction.mock.calls[0];
    expect(path).toBe(LEDGER_PATHS.solana);
    expect(Buffer.from(bytes)).toEqual(tx);
  });

  it('reports blind signing disabled when the app settings say so', async () => {
    solana.signTransaction.mockReturnValue(failed({ _tag: 'UnknownDAError', errorCode: '6808' }));
    solana.getAppConfiguration.mockReturnValue(completed({ blindSigningEnabled: false }));
    const err = await withLedger((s) => s.signSolanaTransaction({ address: SOLANA_ADDRESS }, tx)).catch((e) => e);
    expect(err.code).toBe('LEDGER_BLIND_SIGNING_DISABLED');
    expect(err.message).toMatch(/Enable "Blind signing" in the Solana app/);
  });

  it('keeps the original error when blind signing is already enabled', async () => {
    solana.signTransaction.mockReturnValue(failed({ _tag: 'UnknownDAError', errorCode: '6808', message: 'bad tx' }));
    solana.getAppConfiguration.mockReturnValue(completed({ blindSigningEnabled: true }));
    const err = await withLedger((s) => s.signSolanaTransaction({ address: SOLANA_ADDRESS }, tx)).catch((e) => e);
    expect(err.code).toBe('LEDGER_ERROR');
    expect(err.message).toContain('bad tx');
  });

  it('refuses to sign with a different Ledger (WALLET_MISMATCH)', async () => {
    const err = await withLedger((s) => s.signSolanaTransaction({ address: '11111111111111111111111111111111' }, tx)).catch((e) => e);
    expect(err.code).toBe('WALLET_MISMATCH');
    expect(solana.signTransaction).not.toHaveBeenCalled();
  });
});

describe('Linux HID interface selection', () => {
  it('keeps only the APDU interface so the transport never opens the FIDO one', async () => {
    const flex = { vendorId: 0x2c97, productId: 0x7011 };
    const listed = [
      { ...flex, path: '/dev/hidraw4', interface: 0, usagePage: 0xffa0 },
      { ...flex, path: '/dev/hidraw5', interface: 2, usagePage: 0xf1d0 },
      { vendorId: 0x046d, productId: 0xc08b, path: '/dev/hidraw0', usagePage: 0x0001 },
    ];
    h.hid.devicesAsync = async () => listed;
    // Any kit load goes through the filter; a missing kit still patches node-hid first.
    await withLedger(async () => {}).catch(() => {});

    const paths = (await h.hid.devicesAsync()).map((d) => d.path);
    expect(paths).toEqual(['/dev/hidraw4', '/dev/hidraw0']);
  });
});
