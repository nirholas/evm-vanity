---
name: inspect-evm-vanity-address
description: Validate an EVM address, check its EIP-55 checksum, score how much grinding its pattern represents, and verify an EIP-712 vanity attestation. Use when the user asks if an address is valid, a typo, genuinely vanity, or provably ground without a leaked key.
---

# Inspect an address and verify an attestation

All of this is read-only. Requires Node >= 20 and the `evm-vanity` npm package.

## Inspect an address

```bash
npx -y evm-vanity inspect 0xBEEF... --prefix-len 4 --suffix-len 4
```

It validates the 0x address, checks the EIP-55 checksum (a mixed-case address that fails it is a typo, not an address), reads the vanity pattern it appears to carry (`--prefix-len` default 4, `--suffix-len` default 0) and scores the grinding work. No network. MCP equivalent: `vanity_inspect_address` with `address`, `prefixLen`, `suffixLen`.

## Verify a provenance attestation

```bash
npx -y evm-vanity verify attestation.json --api https://evm-vanity.dev
```

Every claim is recomputed rather than trusted: the pattern, the difficulty claim, the freshness nonce, the split-key non-custody equation, and the recovered EIP-712 signer. The issuer list is fetched from `<api>/.well-known/evm-vanity.json` when reachable, and the result states whether issuers were pinned (`issuersPinned`). MCP equivalent: `vanity_verify_attestation` with `attestation` (object) and `api`.

## Price a pattern

`vanity_quote` (MCP) or `evm-vanity quote --prefix <hex> [--suffix <hex>]` returns probability, expected attempts, p50/p90/p99 and a rarity tier.

## Example

User: "Is 0xDeaDbeef... a real vanity address or did someone just make it up?"

1. `npx -y evm-vanity inspect <address> --prefix-len 8`.
2. If the checksum is invalid, say it is a typo or fabricated.
3. If valid, report the rarity tier. If they have an attestation file, run `verify` and report `issuersPinned` and the signer.
