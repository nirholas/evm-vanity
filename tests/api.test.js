/**
 * API tests drive the Fetch handler directly, with no socket and no port. It is
 * the same function the Node server and the Cloudflare Worker both call, so
 * these cover both hosts at once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { handle } from '../server/app.mjs';
import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';
import { generateRequesterShare, combineScalars } from '../src/split-key.js';

const BASE = 'https://vanity.test';

/**
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function call(path, body) {
	const req = body === undefined
		? new Request(`${BASE}${path}`)
		: new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const res = await handle(req, {});
	assert.ok(res, `no route matched ${path}`);
	return { status: res.status, json: await res.json() };
}

test('health reports the issuer identity and the EIP-712 constants', async () => {
	const { status, json } = await call('/api/health');
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.match(json.issuer.address, /^0x[0-9a-fA-F]{40}$/);
	assert.equal(json.serverGrind, false, 'custodial grinding must be off unless an operator opts in');
	assert.match(json.eip712.typeHash, /^0x[0-9a-f]{64}$/);
});

test('quote reports the case multiplier that other tools omit', async () => {
	const plain = await call('/api/quote', { prefix: 'dead' });
	const cased = await call('/api/quote', { prefix: 'dEaD' });
	assert.equal(plain.status, 200);
	assert.equal(plain.json.difficulty.caseSensitivityCost, 1);
	assert.equal(cased.json.difficulty.caseSensitivityCost, 16);
	assert.equal(cased.json.difficulty.expectedAttempts, plain.json.difficulty.expectedAttempts * 16);
	assert.ok(cased.json.difficulty.p90 > cased.json.difficulty.p50);
});

test('quote rejects non-hex and empty patterns', async () => {
	assert.equal((await call('/api/quote', { prefix: 'zzzz' })).status, 400);
	assert.equal((await call('/api/quote', {})).status, 400);
});

test('inspect catches an address whose casing fails EIP-55', async () => {
	const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
	const ok = await call('/api/inspect', { address: good });
	assert.equal(ok.status, 200);
	assert.equal(ok.json.checksum.checksummed, true);

	const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
	const bad = await call('/api/inspect', { address: broken });
	assert.equal(bad.json.checksum.valid, false);

	assert.equal((await call('/api/inspect', { address: 'nope' })).status, 400);
});

test('the chain registry is served and includes Robinhood Chain', async () => {
	const { status, json } = await call('/api/chains');
	assert.equal(status, 200);
	const ids = json.chains.map((c) => c.id);
	for (const id of [1, 8453, 42161, 4663]) assert.ok(ids.includes(id), `chain ${id} missing`);
	assert.equal(json.factories.length, 4);
});

test('attest then verify round-trips, and tampering breaks it', async () => {
	const key = secp256k1.utils.randomSecretKey();
	const account = eip55Checksum(addressFromPrivateKey(key));
	const prefix = account.slice(2, 4).toLowerCase();

	const issued = await call('/api/attest', { account, prefix, attempts: 100 });
	assert.equal(issued.status, 200);

	const ok = await call('/api/verify', { attestation: issued.json.attestation });
	assert.equal(ok.json.valid, true, JSON.stringify(ok.json.checks.filter((c) => !c.pass)));

	const bad = await call('/api/verify', { attestation: { ...issued.json.attestation, attempts: 1 } });
	assert.equal(bad.json.valid, false);
	assert.ok(bad.json.checks.some((c) => c.id === 'signature' && !c.pass));
});

test('attest refuses an address that does not match the claimed pattern', async () => {
	const account = eip55Checksum(`0x${'11'.repeat(20)}`);
	const { status, json } = await call('/api/attest', { account, prefix: 'ffff' });
	assert.equal(status, 400);
	assert.match(json.error, /does not match/);
});

test('the split-key endpoint returns an offset only the requester can use', async () => {
	const share = generateRequesterShare();
	const { status, json } = await call('/api/splitkey/grind', { p1: share.p1, prefix: 'a', timeBudgetMs: 8000 });
	assert.equal(status, 200);
	assert.equal(json.found, true);

	// Checkable without any secret.
	const check = await call('/api/splitkey/verify', { p1: share.p1, offset: json.offset, address: json.address, pattern: { prefix: 'a' } });
	assert.equal(check.json.ok, true);

	// The attestation it issued verifies, non-custody check included.
	const verified = await call('/api/verify', { attestation: json.attestation });
	assert.equal(verified.json.valid, true);
	assert.ok(verified.json.checks.some((c) => c.id === 'nonCustody' && c.pass));

	// Only k1 completes the key.
	assert.equal(combineScalars(share.k1, json.offset).addressChecksum, json.address);
});

test('the split-key endpoint rejects a point that is not on the curve', async () => {
	assert.equal((await call('/api/splitkey/grind', { p1: '0xdeadbeef', prefix: 'a' })).status, 400);
});

test('custodial grinding is refused by default, with a pointer to the safe path', async () => {
	const { status, json } = await call('/api/grind', { prefix: 'a' });
	assert.equal(status, 403);
	assert.match(json.error, /splitkey/);
});

test('discovery documents are served and internally consistent', async () => {
	const card = await call('/.well-known/agents.json');
	assert.ok(card.json.skills.length >= 5);
	for (const skill of card.json.skills) assert.ok(skill.endpoint.url.startsWith(BASE), skill.endpoint.url);

	const wellKnown = await call('/.well-known/evm-vanity.json');
	assert.match(wellKnown.json.issuers[0].address, /^0x[0-9a-fA-F]{40}$/);
	assert.equal(wellKnown.json.eip712.type.startsWith('VanityAttestation('), true);

	const openapi = await call('/openapi.json');
	assert.equal(openapi.json.openapi, '3.1.0');
	assert.ok(openapi.json.paths['/api/splitkey/grind']);

	const mcp = await call('/.well-known/mcp.json');
	assert.equal(mcp.json.tools.length, 6);
});

test('an unknown API path 404s as JSON, and a page path falls through', async () => {
	const missing = await handle(new Request(`${BASE}/api/nope`), {});
	assert.equal(missing.status, 404);
	assert.equal(await handle(new Request(`${BASE}/some/page.html`), {}), null);
});

test('CORS preflight is answered', async () => {
	const res = await handle(new Request(`${BASE}/api/quote`, { method: 'OPTIONS' }), {});
	assert.equal(res.status, 204);
	assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
