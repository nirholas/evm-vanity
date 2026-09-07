# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/nirholas/evm-vanity/security/advisories/new).
Do not open a public issue for anything that could expose a user's key.

Expect an acknowledgement within 72 hours.

## Entropy: the thing that actually breaks these tools

In 2022 the most popular EVM vanity generator, Profanity, seeded its search from
a 32-bit value. Every key it had produced was therefore searchable, and tens of
millions of dollars were drained from addresses it generated. Any vanity grinder
should be judged on this first.

| Defence | Where |
| --- | --- |
| The base scalar is a full 256-bit CSPRNG draw, never narrowed. | `src/eoa-grinder-worker.js`, `src/node-worker.js`, `src/grinder-node.js` |
| The incremental walk (`k+i`) is re-seeded every million candidates, so no run extends one arithmetic progression indefinitely. | same |
| Every match is re-derived from the private key through a separate code path, and a key that does not control the matched address is never emitted. | same, and `tests/grinder.test.js` |

## What this project promises

| Claim | Enforced by |
| --- | --- |
| The browser grinder never transmits key material. | No `fetch` in the grind path. Check the network tab, or read `src/ui/app.js`. |
| A delegated grind cannot expose your key. | Split-key arithmetic: the remote side holds `k2` and never sees `k1`. The result is verified locally before it is shown. |
| An attestation cannot be forged. | EIP-712 ECDSA signature, recovered and checked against the issuer's published list rather than the address inside the document. |
| An attestation cannot state a lie. | `/api/attest` refuses an address that does not match the claimed pattern, and refuses a split-key attestation whose non-custody equation does not hold. |

## What it does not promise

- **`POST /api/grind` is custodial.** It returns a private key over the network
  and is disabled unless an operator sets `ALLOW_SERVER_GRIND=1`. Treat any key
  it produces as compromised for anything of value.
- **An attestation is not proof that no copy was kept.** It proves the issuer
  signed a set of facts. Only grinding it yourself, or split-key delegation,
  proves nobody else could hold the key. The `format` field says which applied.
- **An ephemeral issuer key is not an identity.** When `ATTESTATION_KEY` is
  unset the service mints a per-process key, says so in every response, and its
  attestations stop verifying on restart.

## Cryptographic dependencies

secp256k1 arithmetic and Keccak-256 come from
[@noble/curves](https://github.com/paulmillr/noble-curves) and
[@noble/hashes](https://github.com/paulmillr/noble-hashes). Keystore encryption
uses [ethers](https://github.com/ethers-io/ethers.js), loaded only when a
keystore is actually exported. Nothing in this repository implements a
cryptographic primitive itself.
