---
"nansen-cli": minor
---

Add Ledger hardware wallet support: `nansen wallet create --provider ledger` (or `NANSEN_WALLET_PROVIDER=ledger`) registers the device's first EVM and Solana accounts, and `wallet send` plus `trade quote`/`execute` on Base and Solana — including cross-chain `trade quote --to-chain` swaps — sign on the Ledger over USB — private keys never leave the device. Requires the optional `@ledgerhq/*` peer packages (the CLI prints the install command). Cross-chain (Relay/LI.FI) transactions may require enabling Blind signing in the device app. Known limitations: x402 auto-payments, the `nansen bridge` commands, `trade limit-order` and `perp` are not supported for Ledger wallets yet and fail with `LEDGER_UNSUPPORTED`.
