# Contributing

## Running it

```bash
npm install
npm run dev     # site on :5181, API on :8788
npm test        # 52 tests; the chain test needs network access
npm run build   # static site into dist/
```

## The bar

- **No mocks, no placeholder data, no TODO comments.** If a path exists it works.
- **Every number is reproducible.** A difficulty, rarity or ETA claim must come
  from `src/difficulty.js` or a test can prove it wrong.
- **Every claim about a chain is verifiable.** The registry is checked against
  live RPCs by `tests/chains.test.js`, `evm-vanity chains --verify`, and the
  chains page. Add a chain and add it to that check.
- **Tests come with the change.** New protocol behaviour needs a negative test:
  not just that the happy path works, but that tampering is rejected.
- **Never narrow the entropy.** Any change to the grind loop that touches
  seeding needs an explicit argument for why it is still a full 256-bit unknown.

## Where things live

| Layer | Directory |
| --- | --- |
| Maths and protocols | `src/*.js` |
| Browser UI | `index.html`, `*.html`, `src/ui/` |
| HTTP API | `server/` (Node) and `worker/` (Cloudflare) |
| CLI | `cli/` |
| MCP server | `mcp/` |
| Tests | `tests/` |

## Licence

Contributions are accepted under the Apache License 2.0.
