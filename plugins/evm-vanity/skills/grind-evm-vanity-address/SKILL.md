---
name: grind-evm-vanity-address
description: Price and grind an EVM vanity address (a 0x address with a chosen prefix or suffix) with the evm-vanity CLI or MCP tools. Use when the user wants a custom-looking wallet address, or needs to know how hard a pattern is.
---

# Grind an EVM vanity address

`evm-vanity` (npm package, Node >= 20) grinds secp256k1 keypairs whose address matches a hex pattern. An EOA address is identical on every EVM chain, so one grind works on Ethereum, Base, Arbitrum and any other EVM network.

## Price the pattern first

Every nibble is uniform, so a prefix costs the same as a suffix. An uppercase letter in a pattern requests that EIP-55 spelling and costs 2x per letter.

```bash
npx -y evm-vanity quote --prefix dEaD --rate 17000
```

`--rate` is your attempts per second, to turn attempts into wall-clock time. MCP equivalent: `vanity_quote` with `prefix`, `suffix`, `caseSensitive`, `attemptsPerSecond`.

## Grind locally

```bash
npx -y evm-vanity grind --prefix beef --suffix dead --keystore wallet.json
```

Flags: `--prefix <hex>`, `--suffix <hex>`, `--cores <n>` (default every core), `--keystore <file>` (writes an encrypted keystore and prompts for a password), `--out <file>` (plain JSON wallet), `--json`. The key never leaves the machine. MCP equivalent: `vanity_grind` (`cores`, `timeBudgetMs`, capped by `EVM_VANITY_MAX_GRIND_MS`, default 120000). The MCP result carries the private key through the transport into the assistant, so treat it as sensitive.

## Delegate hard patterns without exposing the key

```bash
npx -y evm-vanity delegate --prefix beef --api https://evm-vanity.dev
```

Split-key grinding: a secret scalar k1 stays local, the remote service searches offsets k2 against the public point P1 and returns k2, which is useless without k1. The final key is combined and re-verified locally. The API base defaults to `EVM_VANITY_API` or `https://evm-vanity.dev`. MCP equivalent: `vanity_split_key_grind` (`api`, `maxRounds`, default 5). Prefer this over local grinding for any wallet that will hold value.

## Rules for the agent

- Quote before grinding. If the median attempts are far beyond what the local machine can do, use `delegate`.
- Never print a private key into a shared log, commit or chat. Prefer `--keystore`.
- Do not send funds to a new address, and do not fund it, without the user's explicit confirmation.
- Other commands: `evm-vanity chains [--verify]` lists EVM chains and CREATE2 deployers, `evm-vanity serve [--port 8788]` runs the HTTP API, `evm-vanity mcp` runs the stdio MCP server.

## Example

User: "I want an address starting with 0xcafe."

1. `npx -y evm-vanity quote --prefix cafe` (4 nibbles, quick).
2. `npx -y evm-vanity grind --prefix cafe --keystore cafe.json`.
3. Report the printed address, tell the user where the keystore is, and remind them the password is not recoverable.
