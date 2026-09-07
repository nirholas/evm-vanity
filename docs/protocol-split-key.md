# Split-key grinding on secp256k1

> `evm-split-key/v1`. A protocol for having somebody else grind your vanity
> address without them being able to compute the key.

## The problem

Every paid vanity grinder sees the key it sells you. That is not a trust
preference, it is arithmetic: if a worker generates a keypair, the worker has
the keypair. No amount of policy fixes it.

The idea below is not new in the abstract, but on EVM it has been effectively
unavailable: the one well-known implementation is a command-line C++ program
with no library, no browser build, no wire format and no verifier. This document
is the protocol written down and made checkable.

## The construction

secp256k1, generator `G`, group order `n`.

1. **The requester** picks a secret scalar `k1 ∈ [1, n)` locally and publishes
   only `P1 = k1·G`. `k1` never leaves their machine.
2. **A worker** searches offset scalars `k2`, computing candidate addresses
   `A = keccak256(uncompressed(P1 + k2·G)[1:])[12:]` and testing each against
   the pattern. It knows `k2` and `P1` but not `k1`, so it cannot compute the
   private key.
3. On a hit the worker publishes `(k2, A)`. Anyone verifies, with no secret,
   that the address derived from `P1 + k2·G` equals `A` and matches the pattern.
4. **The requester** combines `k = (k1 + k2) mod n` on their own machine. Since
   `k·G = k1·G + k2·G = P1 + k2·G`, that scalar is the private key for `A`, and
   it only ever exists on the requester's device.

The offset is **not a secret**. It is useless without `k1`, so it travels in the
clear with no envelope, no escrow and no trusted delivery.

## No catch

Private keys on secp256k1 *are* scalars, so `k` is an ordinary 32-byte private
key: it imports into MetaMask, ethers, viem, Rabby or a keystore file like any
other. Delegated EVM grinding costs you nothing beyond trusting the arithmetic,
which you can check yourself.

(The Ed25519 version of this trick, used on Solana, produces a raw scalar rather
than a seed, because recovering a seed that expands to a chosen scalar would mean
inverting SHA-512. That wallet signs correctly but seed-only imports reject it.
The difference is worth knowing if you work on both chains.)

## Why the search is cheap

The worker does not derive a keypair per candidate. It walks the curve: each
step is one point addition (`Q ← Q + G`, `k2 ← k2 + 1`) followed by a keccak.
That is why a pure-JavaScript implementation is viable on a server or in a
browser tab.

## Wire format

Request:

```json
{ "p1": "0x04…", "prefix": "beef", "suffix": "", "caseSensitive": false, "timeBudgetMs": 8000 }
```

Response on a hit:

```json
{
  "found": true,
  "protocol": "evm-split-key/v1",
  "address": "0xBEEF…",
  "offset": "0x…",
  "grinderPoint": "0x04…",
  "attempts": 431,
  "attestation": { }
}
```

A miss carries `found: false` and the attempts spent; the requester calls again
with the same `p1`. Time-boxing each request keeps a long search as many short
calls rather than one held connection.

## Verification

```js
import { verifySplitKeyClaim, combineScalars } from './src/split-key.js';

// Anyone, with no secret:
verifySplitKeyClaim({ p1, offset, address, pattern });  // { ok, derivationOk, patternOk }

// Only the requester:
const { privateKey, address } = combineScalars(k1, offset);
```

A client must **always** verify before accepting. A malicious or broken worker
returning a wrong offset has to fail visibly, not silently hand over a key that
controls nothing. Both the web page and the CLI in this repository do that check
and refuse to display a result that fails it.

## The non-custody assertion

An attestation for a split-key grind carries:

```json
"nonCustody": {
  "scheme": "secp256k1-split-key/v1",
  "requesterPoint": "0x04…",
  "grinderPoint": "0x04…"
}
```

The verifier recomputes `address(requesterPoint + grinderPoint)` and compares it
to the attested address. The secret offset scalar is never in the attestation:
only the public point, which is what makes the claim provable rather than
promised. `keccak256(requesterPoint ‖ grinderPoint)` is bound into the EIP-712
digest, so the points cannot be swapped after signing.
