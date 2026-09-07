# Deploying

One Fetch handler (`server/app.mjs`) with two hosts. Pick either; the API is
identical apart from one endpoint noted below.

## Node (Docker, Cloud Run, a VM, anything)

```bash
npm ci
npm run build                       # static site into dist/
node server/keygen.mjs              # mint a durable attestation key
ATTESTATION_KEY=<hex> npm start    # serves the API and dist/ on :8788
```

The Dockerfile builds exactly this in two stages:

```bash
docker build -t evm-vanity .
docker run -p 8788:8788 -e ATTESTATION_KEY=<hex> evm-vanity
```

For Google Cloud Run:

```bash
gcloud run deploy evm-vanity \
  --source . --region us-central1 --allow-unauthenticated \
  --set-secrets ATTESTATION_KEY=evm-vanity-attestation:latest
```

## Cloudflare Workers

```bash
npm run build
npx wrangler secret put ATTESTATION_KEY
npx wrangler deploy
```

`wrangler.toml` binds `dist/` as the assets directory, so the Worker serves the
site and the API from one origin.

**No endpoint differs on the edge.** The grinder is pure @noble arithmetic with
no filesystem or WebAssembly dependency, so the Worker runs the same code as
Node, including the custodial `/api/grind` when an operator enables it.

## Static-only

The browser grinder, the chain table and attestation verification are all
client-side. `dist/` on any static host gives you a fully working grinder; the
pages degrade honestly when the API is absent (the attestation button reports
that provenance is unavailable, and the grinder is unaffected).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `ATTESTATION_KEY` | for durable attestations | 32-byte secp256k1 key, hex. Without it the service mints an ephemeral key, says so in every response, and its attestations stop verifying on restart. |
| `ALLOW_SERVER_GRIND` | no | `1` enables the custodial `/api/grind`. Off by default; it returns a secret key over the network. |
| `PORT` | no | Node listen port. Default 8788. |

## After deploying

```bash
curl -s https://your-host/api/health
curl -s https://your-host/.well-known/evm-vanity.json    # your published issuer list
curl -s https://your-host/openapi.json | head
```

`/api/health` reports whether the issuer key is ephemeral. If it says
`"ephemeral": true` on a production deployment, `ATTESTATION_KEY` did not reach
the process.

The issuer key is a signing identity, not a wallet. It never sends a transaction
and never needs gas: do not fund it.
