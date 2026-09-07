# evm-vanity

**Grind an EVM address that starts or ends with characters you choose, in your
browser, across every core, with an honest account of what it costs.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-52%20passing-brightgreen.svg)](./tests)
[![No custody](https://img.shields.io/badge/keys-never%20leave%20your%20machine-a78bfa.svg)](#security-model)

A complete vanity wallet stack for Ethereum, Base, Arbitrum, Robinhood Chain and
every other EVM network: the browser grinder, the site, an HTTP API, a CLI, an
MCP server for AI assistants, EIP-712 provenance attestations a contract can
verify, and a delegation protocol that lets somebody else do the work without
ever being able to compute your key.

```bash
npx evm-vanity grind --prefix beef --keystore wallet.json
```

---

## Why another vanity generator

### 1. Entropy, which is the only thing that has ever mattered here

In 2022 the most popular EVM vanity generator seeded its search from a 32-bit
value. Every key it had ever produced became searchable and tens of millions of
dollars were drained. This grinder draws a **full 256-bit base scalar** from the
platform CSPRNG, re-seeds every million candidates so no run extends one
arithmetic progression indefinitely, and re-derives every match through a
separate code path before emitting it. A key that does not control the address
it matched is never returned; there is a test for that.

### 2. Numbers that are not folklore

Every nibble of an EVM address is uniform, so `0x0000…` is exactly as hard as
`0xdead…` and a suffix costs the same as a prefix. The number tools do get wrong
is **casing**: EIP-55 re-cases hex letters with keccak bits, so asking for a
specific spelling costs 2x per letter. `dEaD` is **sixteen times** harder than
any-case `dead`, and this project says so in every quote.

Grinding is geometric, so the mean is not a deadline. Quotes report p50, p90 and
p99 next to the expected value, because the tail is what a decision to start
actually depends on.

### 3. Delegation with no downside at all

Hard patterns need more compute than a browser tab has, and handing the job to
someone else normally means handing over the key. **Split-key grinding** removes
that trade with group arithmetic on secp256k1:

1. you pick a secret scalar `k1` locally and publish only `P1 = k1·G`;
2. the grinder searches offsets `k2` where the address of `P1 + k2·G` matches;
3. it returns `k2`, which is useless without `k1`;
4. you combine `k = (k1 + k2) mod n` on your own machine.

```bash
npx evm-vanity delegate --prefix beef
```

Private keys on secp256k1 **are** scalars, so the combined result is an ordinary
32-byte key that imports into MetaMask, ethers, viem, Rabby or a keystore file
like any other. (The Ed25519 version of this trick, on Solana, yields an expanded
key that seed-only wallets reject. Not here.) The attestation publishes `k2·G`,
so anyone can check `address(P1 + k2·G) == address` and confirm non-custody from
public values alone.

### 4. Provenance a contract can check

Attestations are **EIP-712 typed data**, not opaque blobs, so a marketplace, a
registry or an escrow recovers the signer with `ecrecover` in three lines of
Solidity and can refuse to list an address that is not provably ground and never
custodied. The same document verifies off chain, in the browser, with no RPC.

```bash
npx evm-vanity verify attestation.json
```

The exact type hash and domain separator are served at
`/.well-known/evm-vanity.json` so a deployed verifier and this library cannot
drift apart. The domain carries no `chainId` on purpose: an attestation is a
statement about an address, and an address is the same on every EVM chain.

---

## Install and run

```bash
git clone https://github.com/nirholas/evm-vanity
cd evm-vanity
npm install
npm run dev            # site on http://localhost:5181, API on http://localhost:8788
npm test               # 52 tests
```

Production:

```bash
npm run build
ATTESTATION_KEY=<32-byte hex> npm start      # one process serves site + API
```

Cloudflare Workers, Docker, Cloud Run: see [docs/deploy.md](docs/deploy.md).

---

## One key, every chain

An EVM address is `keccak256(pubkey)[12:]`. It does not depend on a network, so
a single grind gives you the same address on **Ethereum, Base, Arbitrum,
Robinhood Chain, OP, Polygon, BNB and Avalanche** at once, and on chains that do
not exist yet.

The registry in [`src/chains.js`](src/chains.js) exists for explorer links and
for the deterministic CREATE2 deployers, which matter only if you later want a
*contract* at a vanity address. Every row was verified with `eth_getCode`
against the listed public RPC, and both the [chains page](chains.html) and
`evm-vanity chains --verify` re-run that check, so the table can be re-verified
rather than trusted.

---

## The pieces

| Surface | Where | What it is |
| --- | --- | --- |
| Browser grinder | [`index.html`](index.html), [`src/ui/app.js`](src/ui/app.js) | One Web Worker per core. Live rate, pause/resume, encrypted keystore export. |
| Delegation | [`delegate.html`](delegate.html) | The split-key protocol, end to end, in the tab. |
| Chains | [`chains.html`](chains.html) | The registry, re-verified against live RPCs from your browser. |
| Verifier | [`verify.html`](verify.html) | Attestation verification, entirely client-side, with the Solidity to do it on chain. |
| Grind loop | [`src/eoa-grinder-worker.js`](src/eoa-grinder-worker.js) | Incremental point addition, full-entropy seeding, per-match self-check. |
| Difficulty | [`src/difficulty.js`](src/difficulty.js) | The uniform-nibble model and the EIP-55 case multiplier. |
| Split-key | [`src/split-key.js`](src/split-key.js) | The non-custodial delegation protocol. |
| Attestations | [`src/attestation.js`](src/attestation.js) | EIP-712 issue and verify, with the type hash a contract needs. |
| HTTP API | [`server/`](server) | One Fetch handler, hosted on Node or Cloudflare, identical on both. |
| CLI | [`cli/evm-vanity.js`](cli/evm-vanity.js) | `grind`, `delegate`, `quote`, `inspect`, `verify`, `chains`, `serve`, `mcp`. |
| MCP server | [`mcp/index.js`](mcp/index.js) | Six tools for AI assistants. |

---

## CLI

```bash
evm-vanity grind --prefix beef --suffix dead --keystore wallet.json
evm-vanity grind --prefix BeeF                 # EIP-55 spelling, 16x harder
evm-vanity delegate --prefix beef              # split-key, nothing leaks
evm-vanity quote --prefix dEaD --rate 17000
evm-vanity inspect 0xdEaD…
evm-vanity verify attestation.json
evm-vanity chains --verify
evm-vanity serve --port 8788
evm-vanity mcp
```

Add `--json` to anything for machine-readable output.

## MCP

```json
{
  "mcpServers": {
    "evm-vanity": { "command": "npx", "args": ["-y", "evm-vanity", "mcp"] }
  }
}
```

| Tool | Does |
| --- | --- |
| `vanity_quote` | Difficulty, rarity, ETA, and the EIP-55 case multiplier. |
| `vanity_grind` | Grind a real keypair locally, across every core. |
| `vanity_split_key_grind` | Delegate a hard pattern without exposing a key. |
| `vanity_inspect_address` | Validate, checksum and score an address. |
| `vanity_verify_attestation` | Verify an attestation offline. |
| `vanity_chains` | Chains and the deployers live on each. |

## HTTP API

Full schema at `/openapi.json`; agent card at `/.well-known/agents.json`.

```bash
curl -s http://localhost:8788/api/quote \
  -H 'content-type: application/json' \
  -d '{"prefix":"dEaD","attemptsPerSecond":17000}'
```

| Endpoint | Does |
| --- | --- |
| `POST /api/quote` | Probability, expected attempts, p50/p90/p99, rarity, case multiplier. |
| `POST /api/inspect` | Validate an address, check its checksum, score its pattern. |
| `GET /api/chains` | The chain and deployer registry. |
| `POST /api/attest` | Sign an EIP-712 attestation. |
| `POST /api/verify` | Verify one. |
| `POST /api/splitkey/grind` | Non-custodial delegated grinding. |
| `POST /api/splitkey/verify` | Check a split-key claim. |
| `POST /api/grind` | Custodial server-side grind. **Disabled by default.** |

---

## Documentation

| Document | Covers |
| --- | --- |
| [docs/difficulty-model.md](docs/difficulty-model.md) | The uniform-nibble model, EIP-55 casing, and why the mean is not a deadline. |
| [docs/protocol-split-key.md](docs/protocol-split-key.md) | The delegation protocol and its wire format. |
| [docs/protocol-attestation.md](docs/protocol-attestation.md) | The EIP-712 format, every verifier check, and the Solidity to check it on chain. |
| [docs/deploy.md](docs/deploy.md) | Node, Docker, Cloud Run, Cloudflare Workers, static-only. |
| [SECURITY.md](SECURITY.md) | What this project promises, and what it does not. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it and the quality bar. |

The site also ships its own documentation page at `/docs.html`.

---

## Security model

| Path | Who can see the key |
| --- | --- |
| Browser grinder | Only your browser. No request carries key material. |
| CLI `grind` | Only your machine. |
| CLI / API `delegate` | Only you. The remote side holds an offset that is useless without your `k1`. |
| `POST /api/grind` | The server process and every hop in between. Off unless an operator sets `ALLOW_SERVER_GRIND=1`. |

Report vulnerabilities through [GitHub security advisories](https://github.com/nirholas/evm-vanity/security/advisories/new). See [SECURITY.md](./SECURITY.md).

## Environment

| Variable | Meaning |
| --- | --- |
| `ATTESTATION_KEY` | 32-byte secp256k1 key (hex) for signing attestations. Unset means an ephemeral per-process key, reported in every response. Mint one with `npm run keygen`. It is a signing identity, not a wallet: do not fund it. |
| `ALLOW_SERVER_GRIND` | `1` enables the custodial grind endpoint. Off by default. |
| `PORT` | Node listen port. Default 8788. |
| `EVM_VANITY_API` | Default remote API for `delegate` and `verify`. |

## Provenance

The browser grinder, its worker, the pattern validation and the hex wordlist
were first built inside [three.ws](https://github.com/nirholas/three.ws) and are
re-licensed here under Apache-2.0. The secp256k1 split-key protocol, the EIP-712
attestation format, the chain registry, the API, the CLI and the MCP server are
new in this repository.

## Licence

[Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
