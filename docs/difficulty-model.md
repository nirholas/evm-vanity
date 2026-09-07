# The EVM difficulty model

> Specification of `hex-uniform/v1`, the model every quote and attestation in
> this project names.

## Why this is simpler than Solana's

A Solana address is a *numeral*: a 256-bit integer rendered in Base58, whose
encoding length varies, so its leading character is not uniform and a 58ⁿ model
is wrong by up to 17x. An EVM address is not a numeral. It is the low 20 bytes
of a Keccak-256 digest rendered as a fixed 40-character hex string, with no
length variance and no leading-zero stripping.

Every one of the 40 nibbles is independently uniform over 16 symbols, at both
ends. So the honest model really is 16⁻ⁿ:

| Pattern | Expected attempts |
| --- | --- |
| 1 character | 16 |
| 2 | 256 |
| 4 | 65 536 |
| 6 | 16 777 216 |
| 8 | 4 294 967 296 |
| 10 | 1 099 511 627 776 |

`0x0000…` costs exactly what `0xdead…` costs, and a suffix costs exactly what a
prefix costs. A tool that charges more for one than the other is guessing.

This holds for all three derivations:

```
EOA      address = keccak256(uncompressed pubkey[1:])[12:]
CREATE   address = keccak256(rlp([sender, nonce]))[12:]
CREATE2  address = keccak256(0xff ‖ deployer ‖ salt ‖ initCodeHash)[12:]
```

## The one thing that does change the cost: EIP-55

EIP-55 re-cases the hex letters of an address using bits of
`keccak256(lowercase address)`, which behave as fair coin flips. Asking for a
*specific* case spelling therefore costs an extra factor of two per **letter**
in the pattern. Digits carry no case and cost nothing extra.

```
dead   →  16⁴          =        65 536 attempts
dEaD   →  16⁴ · 2⁴     =     1 048 576 attempts   (16x)
BeeFdead → 16⁸ · 2⁷    ≈ 549 755 813 888          (128x)
```

This is the single most misquoted number in EVM vanity tooling. A mixed-case
request is not "the same speed with nicer capitals": it is `2^letters` harder,
and every quote in this project reports the multiplier as `caseSensitivityCost`.

A pattern is treated as case-sensitive when it contains an uppercase letter,
which is what a user typing `BeeF` means. Pass `caseSensitive` explicitly to
override.

## The mean is not a deadline

Grinding is geometric: each attempt is an independent Bernoulli trial with
probability `p`, so

```
expected attempts        1 / p
median (p50)             ln(0.5) / ln(1 - p)     ≈ 0.693 / p
90th percentile (p90)    ln(0.1) / ln(1 - p)     ≈ 2.303 / p
99th percentile (p99)    ln(0.01) / ln(1 - p)    ≈ 4.605 / p
after n attempts         1 - (1 - p)ⁿ
```

At the expected attempt count you have had a **63.2%** chance of finishing, and
one run in a hundred takes more than four and a half times as long. Quotes here
report p50, p90 and p99 next to the mean, because the decision to start a grind
depends on the tail.

## Rarity

Tiers are thresholds on expected attempts, and the 0-100 score is logarithmic
because the underlying quantity is: each extra nibble multiplies the work by 16.
100 is pinned at 10¹⁸ expected attempts.

| Tier | Expected attempts |
| --- | --- |
| Common | under 10³ |
| Uncommon | 10³ |
| Rare | 10⁵ |
| Epic | 10⁷ |
| Legendary | 10⁹ |
| Mythic | 10¹² and up |

## Reproducing it

```js
import { difficulty, rarity, caseSensitivityCost } from './src/difficulty.js';

difficulty({ prefix: 'beef' }).expectedAttempts;   // 65536
difficulty({ prefix: 'dEaD' }).caseCost;           // 16
rarity({ prefix: 'deadbeef' }).label;              // 'Legendary'
```

`tests/difficulty.test.js` pins the table, checks the case multiplier, and
samples real secp256k1 keypairs to confirm the uniformity claim.
