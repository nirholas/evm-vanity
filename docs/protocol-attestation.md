# Vanity attestations

> `evm-vanity-attestation/v1`. A signed statement about how an address was
> produced, verifiable off chain in a browser and on chain with `ecrecover`.

## The document

```json
{
  "protocol": "evm-vanity-attestation/v1",
  "account": "0xBEBD0C8bA9959AbEc284e798A01a001864B6dD04",
  "pattern": { "prefix": "be", "suffix": "", "caseSensitive": false },
  "format": "split-key",
  "attempts": 31,
  "difficulty": { "expectedAttempts": 256, "model": "hex-uniform/v1" },
  "freshness": { "nonce": "0x…", "issuedAt": "2026-09-07T06:57:03.430Z" },
  "nonCustody": { "scheme": "secp256k1-split-key/v1", "requesterPoint": "0x04…", "grinderPoint": "0x04…" },
  "digest": "0x…",
  "signature": "0x…",
  "issuer": "0xF76B418ab373A8fE6FdD3EDc00bb85A51759C2eA",
  "signatureScheme": "eip712-ecdsa-secp256k1"
}
```

## Formats

| `format` | Means |
| --- | --- |
| `eoa` | A keypair was ground. Whoever ran the grinder could have kept a copy. |
| `split-key` | Nobody but the requester could ever hold the key. Carries `nonCustody`. |
| `create2` | A salt was ground for a deterministic contract address. No key exists. |

The format is part of the signed data, so an attestation cannot claim stronger
provenance than the grind that produced it.

## The typed data

```
VanityAttestation(
  address account,
  string prefix,
  string suffix,
  bool caseSensitive,
  string format,
  uint256 expectedAttempts,
  uint256 attempts,
  bytes32 nonce,
  uint256 issuedAt,
  bytes32 nonCustodyHash
)
```

`nonCustodyHash` is `keccak256(requesterPoint ‖ grinderPoint)` for a split-key
grind and 32 zero bytes otherwise, so the two points are bound into the
signature without bloating the struct.

The domain is `EIP712Domain(string name,string version)` with
`name = "EvmVanityAttestation"` and `version = "1"`. It deliberately carries
**no `chainId` and no `verifyingContract`**: an attestation is a statement about
an address, and an address is the same on every EVM chain. Pinning a chain would
make a true statement fail to verify after a bridge.

The type hash and domain separator are served at
`/.well-known/evm-vanity.json` and exported as `TYPE_HASH` and
`DOMAIN_SEPARATOR_HEX`, so a deployed Solidity verifier and this library cannot
drift apart. `tests/attestation.test.js` pins both.

## Verifying on chain

```solidity
bytes32 constant DOMAIN_SEPARATOR = /* from /.well-known/evm-vanity.json */;
bytes32 constant TYPE_HASH = keccak256(
    "VanityAttestation(address account,string prefix,string suffix,bool caseSensitive,"
    "string format,uint256 expectedAttempts,uint256 attempts,bytes32 nonce,"
    "uint256 issuedAt,bytes32 nonCustodyHash)"
);

function issuerOf(Attestation calldata a, bytes calldata sig) internal pure returns (address) {
    bytes32 structHash = keccak256(abi.encode(
        TYPE_HASH, a.account, keccak256(bytes(a.prefix)), keccak256(bytes(a.suffix)),
        a.caseSensitive, keccak256(bytes(a.format)), a.expectedAttempts, a.attempts,
        a.nonce, a.issuedAt, a.nonCustodyHash
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    (bytes32 r, bytes32 s, uint8 v) = split(sig);   // sig is r ‖ s ‖ v, v in {27, 28}
    return ecrecover(digest, v, r, s);
}
```

That is the whole integration. A marketplace can refuse to list an address whose
attestation does not recover to a known issuer; an escrow can require
`format == "split-key"` before it will release; a registry can record who ground
what.

## Verifying off chain

```js
import { verifyAttestation } from 'evm-vanity/attestation';

const issuers = (await (await fetch(BASE + '/.well-known/evm-vanity.json')).json()).issuers.map((i) => i.address);
const result  = verifyAttestation(attestation, { issuers });
```

| Check | What it recomputes |
| --- | --- |
| `protocol` | The document declares a supported protocol. |
| `account` | A well-formed, correctly checksummed address. |
| `pattern` | The address actually matches the claimed pattern. |
| `difficulty` | The expected attempts equal what the named model produces. |
| `freshness` | The nonce is well-formed and the issue time is not in the future. |
| `nonCustody` | For split-key grinds, the two points sum to the address. |
| `signature` | The EIP-712 digest recovers a signer, matching the stated one. |
| `issuerPinned` | The signer is on the published issuer list. |

The last check matters most: without a pin, a self-signed forgery passes the
signature check, because it signed itself. The verifier fails that check and
says so rather than passing quietly.

## Rotation

The issuer list is an array. To rotate: publish the new address alongside the
old one, sign new attestations with the new key, and drop the old one once every
attestation signed with it has aged out.

## What an attestation cannot prove

That whoever ran the grinder kept no copy. Only grinding it yourself, or
split-key delegation, proves that. An `eoa` attestation from a custodial service
is exactly as strong as trusting that service, and the format field says so.
