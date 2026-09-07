/**
 * The evm-vanity HTTP API.
 *
 * One Fetch handler, two hosts (Node and Cloudflare Workers). Every route is
 * either pure maths, pure verification, or a delegated grind that is
 * mathematically incapable of exposing a key. The one exception, `/api/grind`,
 * is custodial, off by default, and says so everywhere it appears.
 *
 * Design rule: the server must never become a party you have to trust. What it
 * returns is either checkable offline (a signature, a derivation) or has no
 * security content at all (a probability).
 */

import { createRouter, json, text, body, assert, HttpError } from './router.mjs';
import { issuerKey, publicIssuers } from './keys.mjs';
import { difficulty, rarity, normalizePattern, formatDuration, expectedAttempts, DIFFICULTY_MODEL } from '../src/difficulty.js';
import { inspectAddress, eip55Checksum, addressMatchesPattern } from '../src/address.js';
import { validatePattern, MAX_PATTERN_LENGTH } from '../src/validation.js';
import { buildAttestation, signAttestation, verifyAttestation, SUPPORTED_FORMATS, FORMAT_EOA, TYPE_HASH, DOMAIN_SEPARATOR_HEX, ATTESTATION_TYPE } from '../src/attestation.js';
import { grindSplitKeyOffset, verifySplitKeyClaim, isValidP1, offsetPoint, p1Fingerprint, SPLIT_KEY_PROTOCOL } from '../src/split-key.js';
import { CHAINS, FACTORY_LABELS } from '../src/chains.js';
import { agentCard, mcpDescriptor, llmsTxt, openApi, robotsTxt, sitemapXml } from './discovery.mjs';

export const SERVICE = {
	name: 'evm-vanity',
	version: '1.0.0',
	description: 'EVM vanity address difficulty, non-custodial delegated grinding, and EIP-712 provenance attestations.',
	repository: 'https://github.com/nirholas/evm-vanity',
	license: 'Apache-2.0',
};

/** Server-side split-key grinds are bounded so one caller cannot hold a worker. */
const SPLITKEY_MAX_MS = 20_000;
const SPLITKEY_DEFAULT_MS = 8_000;

const router = createRouter();

// ── Health ───────────────────────────────────────────────────────────────────
router.get('/api/health', ({ env }) => {
	const key = issuerKey(env);
	return json({
		ok: true,
		service: SERVICE.name,
		version: SERVICE.version,
		issuer: { address: key.address, ephemeral: key.ephemeral },
		serverGrind: serverGrindEnabled(env),
		difficultyModel: DIFFICULTY_MODEL,
		eip712: { typeHash: TYPE_HASH, domainSeparator: DOMAIN_SEPARATOR_HEX, type: ATTESTATION_TYPE },
	});
});

// ── Quote ────────────────────────────────────────────────────────────────────
router.post('/api/quote', async ({ req }) => {
	const b = await body(req);
	const pattern = readPattern(b);
	const rate = positiveNumber(b.attemptsPerSecond, 0);
	const d = difficulty(pattern, rate > 0 ? { attemptsPerSecond: rate } : {});

	return json({
		pattern: d.pattern,
		difficulty: {
			model: d.model,
			probability: d.probability,
			expectedAttempts: d.expectedAttempts,
			p50: d.p50,
			p90: d.p90,
			p99: d.p99,
			// The most misquoted number in EVM vanity tooling: a mixed-case request
			// is not "the same speed", it is 2^letters harder.
			caseSensitivityCost: d.caseCost,
		},
		rarity: rarity(pattern),
		eta: d.eta ?? null,
		note: 'Every nibble of an EVM address is uniform, so a prefix and a suffix cost the same. The only free variable is EIP-55 casing.',
		limits: { maxPatternLengthPerSide: MAX_PATTERN_LENGTH },
	}, { cache: 'public, max-age=3600' });
});

// ── Inspect an address ───────────────────────────────────────────────────────
router.post('/api/inspect', async ({ req }) => {
	const b = await body(req);
	const address = String(b.address || '').trim();
	assert(address, 'address is required');
	const inspection = inspectAddress(address);
	assert(/^0x[0-9a-fA-F]{40}$/.test(address), 'address must be 20 bytes of 0x-prefixed hex');

	// Read the pattern the address appears to carry. Without an explicit split,
	// take four leading characters, which is the shortest length anyone
	// deliberately grinds, and no suffix.
	const body_ = address.slice(2);
	const prefixLen = Number.isInteger(b.prefixLen) ? Math.max(0, Math.min(b.prefixLen, 40)) : 4;
	const suffixLen = Number.isInteger(b.suffixLen) ? Math.max(0, Math.min(b.suffixLen, 40 - prefixLen)) : 0;
	const pattern = {
		prefix: body_.slice(0, prefixLen),
		suffix: suffixLen ? body_.slice(40 - suffixLen) : '',
		caseSensitive: !!b.caseSensitive,
	};

	return json({
		address: eip55Checksum(address),
		checksum: inspection,
		readAs: pattern,
		difficulty: difficulty(pattern),
		rarity: rarity(pattern),
	}, { cache: 'public, max-age=3600' });
});

// ── Chains ───────────────────────────────────────────────────────────────────
router.get('/api/chains', () => json({
	note: 'A vanity EOA works on every EVM chain: the address comes from the key, not the network. The deployers matter only for vanity contract addresses.',
	verifiedAt: '2026-09-07',
	factories: Object.entries(FACTORY_LABELS).map(([address, label]) => ({ address, label })),
	chains: CHAINS.map((c) => ({
		id: c.id,
		name: c.name,
		shortName: c.shortName,
		rpc: c.rpc,
		explorer: c.explorer,
		currency: c.currency,
		testnet: !!c.testnet,
		factories: Object.keys(c.factories),
	})),
}, { cache: 'public, max-age=3600' }));

// ── Attestations ─────────────────────────────────────────────────────────────
router.post('/api/attest', async ({ req, env }) => {
	const b = await body(req);
	const account = String(b.account || '').trim();
	assert(/^0x[0-9a-fA-F]{40}$/.test(account), 'account must be a 20-byte 0x address');

	const pattern = readPattern(b);
	const format = SUPPORTED_FORMATS.includes(b.format) ? b.format : FORMAT_EOA;
	assert(addressMatchesPattern(account, pattern), 'the address does not match the claimed pattern');

	const key = issuerKey(env);
	let core;
	try {
		core = buildAttestation({
			account,
			pattern,
			format,
			attempts: positiveNumber(b.attempts, 0),
			...(b.nonCustody ? { nonCustody: b.nonCustody } : {}),
		});
	} catch (err) {
		throw new HttpError(400, err.message);
	}

	const attestation = signAttestation({ core, signingKey: key.privateKey });
	return json({
		attestation,
		issuer: key.address,
		ephemeralKey: key.ephemeral,
		verify: '/api/verify',
		issuers: '/.well-known/evm-vanity.json',
		...(key.ephemeral
			? { warning: 'This service is running with an ephemeral issuer key. The attestation verifies now and stops verifying when the process restarts. Set ATTESTATION_KEY for a durable identity.' }
			: {}),
	});
});

router.post('/api/verify', async ({ req, env }) => {
	const b = await body(req);
	const doc = b.attestation ?? b;
	assert(doc && typeof doc === 'object', 'send { "attestation": { … } }');
	const result = verifyAttestation(doc, { issuers: publicIssuers(env).map((i) => i.address) });
	return json(result);
});

// ── Split-key delegation ─────────────────────────────────────────────────────
router.post('/api/splitkey/grind', async ({ req, env }) => {
	const b = await body(req);
	const p1 = String(b.p1 || '').trim();
	assert(p1, 'p1 is required: the public point k1*G you generated locally');
	assert(isValidP1(p1), 'p1 is not a valid secp256k1 point');

	const pattern = readPattern(b);
	const budget = Math.min(SPLITKEY_MAX_MS, positiveNumber(b.timeBudgetMs, SPLITKEY_DEFAULT_MS));
	const result = grindSplitKeyOffset({ p1, ...pattern, timeBudgetMs: budget });

	if (!result.found) {
		return json({
			found: false,
			attempts: result.attempts,
			durationMs: result.durationMs,
			timeBudgetMs: budget,
			expectedAttempts: expectedAttempts(pattern),
			protocol: SPLIT_KEY_PROTOCOL,
			hint: `Call again with the same p1 to keep searching, or raise timeBudgetMs (capped at ${SPLITKEY_MAX_MS}ms per request).`,
		});
	}

	// A found offset is worthless to anyone but the holder of k1, so returning
	// it over the wire is safe: that is the entire point of the protocol.
	const key = issuerKey(env);
	const grinderPoint = offsetPoint(result.offset);
	const attestation = signAttestation({
		core: buildAttestation({
			account: result.address,
			pattern,
			format: 'split-key',
			attempts: result.attempts,
			nonCustody: { requesterPoint: p1, grinderPoint },
		}),
		signingKey: key.privateKey,
	});

	return json({
		found: true,
		protocol: SPLIT_KEY_PROTOCOL,
		address: result.addressChecksum,
		offset: result.offset,
		grinderPoint,
		attempts: result.attempts,
		durationMs: result.durationMs,
		p1Fingerprint: p1Fingerprint(p1),
		attestation,
		next: 'Combine locally: k = (k1 + offset) mod n. This service cannot compute it, because it never saw k1.',
	});
});

router.post('/api/splitkey/verify', async ({ req }) => {
	const b = await body(req);
	assert(b.p1 && b.offset && b.address, 'p1, offset and address are required');
	return json(verifySplitKeyClaim({
		p1: String(b.p1),
		offset: String(b.offset),
		address: String(b.address),
		pattern: b.pattern && typeof b.pattern === 'object' ? b.pattern : undefined,
	}));
});

// ── Server-side grind (opt-in, custodial, loudly labelled) ───────────────────
router.post('/api/grind', async ({ req, env }) => {
	if (!serverGrindEnabled(env)) {
		throw new HttpError(
			403,
			'Server-side grinding is disabled on this deployment. It hands a private key over a network, which this project treats as a last resort. Use the browser grinder, the CLI, or POST /api/splitkey/grind, which delegates the work without anyone else ever holding your key.',
			{ enable: 'set ALLOW_SERVER_GRIND=1 to enable it on a deployment you control' },
		);
	}
	const b = await body(req);
	const pattern = readPattern(b);
	const budget = Math.min(SPLITKEY_MAX_MS, positiveNumber(b.timeBudgetMs, SPLITKEY_DEFAULT_MS));

	const { grindEoaNode } = await import('../src/grinder-node.js');
	const result = grindEoaNode({ ...pattern, timeBudgetMs: budget });
	if (!result.found) {
		return json({ found: false, attempts: result.attempts, durationMs: result.durationMs, expectedAttempts: expectedAttempts(pattern) });
	}
	return json({
		...result,
		custodyWarning: 'This private key travelled over the network and existed in this server process. Treat it as compromised for anything of value, and prefer /api/splitkey/grind.',
	});
});

// ── Discovery ────────────────────────────────────────────────────────────────
router.get('/.well-known/evm-vanity.json', ({ env, url }) => json({
	service: SERVICE.name,
	version: SERVICE.version,
	description: SERVICE.description,
	repository: SERVICE.repository,
	license: SERVICE.license,
	protocols: { attestation: 'evm-vanity-attestation/v1', splitKey: SPLIT_KEY_PROTOCOL, difficultyModel: DIFFICULTY_MODEL },
	eip712: { typeHash: TYPE_HASH, domainSeparator: DOMAIN_SEPARATOR_HEX, type: ATTESTATION_TYPE },
	issuers: publicIssuers(env),
	endpoints: {
		quote: `${url.origin}/api/quote`,
		inspect: `${url.origin}/api/inspect`,
		chains: `${url.origin}/api/chains`,
		attest: `${url.origin}/api/attest`,
		verify: `${url.origin}/api/verify`,
		splitKeyGrind: `${url.origin}/api/splitkey/grind`,
		openapi: `${url.origin}/openapi.json`,
	},
}, { cache: 'public, max-age=300' }));

router.get('/.well-known/agents.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/agent.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/mcp.json', ({ url }) => json(mcpDescriptor(url.origin), { cache: 'public, max-age=3600' }));
router.get('/openapi.json', ({ url }) => json(openApi(url.origin), { cache: 'public, max-age=3600' }));
router.get('/llms.txt', ({ url }) => text(llmsTxt(url.origin), { cache: 'public, max-age=3600' }));
router.get('/robots.txt', ({ url }) => text(robotsTxt(url.origin)));
router.get('/sitemap.xml', ({ url }) => text(sitemapXml(url.origin), { type: 'application/xml; charset=utf-8' }));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pull a validated pattern out of a request body.
 * @param {Record<string, any>} b
 * @returns {{ prefix: string, suffix: string, caseSensitive: boolean }}
 */
function readPattern(b) {
	const raw = {
		prefix: String(b.prefix ?? '').trim(),
		suffix: String(b.suffix ?? '').trim(),
		...(typeof b.caseSensitive === 'boolean' ? { caseSensitive: b.caseSensitive } : {}),
	};
	const p = normalizePattern(raw);
	assert(p.length > 0, 'give a prefix, a suffix, or both');
	for (const [side, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		assert(v.valid, `${side}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/** @param {any} value @param {number} fallback @returns {number} */
function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {Record<string, any>} env @returns {boolean} */
function serverGrindEnabled(env) {
	const flag = env?.ALLOW_SERVER_GRIND ?? (typeof process !== 'undefined' ? process.env?.ALLOW_SERVER_GRIND : undefined);
	return flag === '1' || flag === 'true';
}

/**
 * The application handler. Returns `null` when nothing matched so a host can
 * serve static assets from the same origin.
 * @param {Request} req
 * @param {any} [env]
 * @returns {Promise<Response|null>}
 */
export function handle(req, env) {
	return router.handle(req, env);
}
