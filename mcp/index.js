#!/usr/bin/env node
/**
 * evm-vanity MCP server.
 *
 * Six tools over stdio, so an assistant can price a vanity pattern, grind one
 * locally, delegate a hard one without exposing a key, inspect an address, and
 * verify an attestation.
 *
 * Five of the six need no network at all. Only `vanity_split_key_grind` talks
 * to a remote API, and even then the secret half of the key is generated here
 * and never sent.
 *
 *   { "mcpServers": { "evm-vanity": { "command": "npx", "args": ["-y", "evm-vanity", "mcp"] } } }
 */

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { grindEoaPool } from '../src/grinder-pool.js';
import { difficulty, rarity, normalizePattern } from '../src/difficulty.js';
import { validatePattern, MAX_PATTERN_LENGTH } from '../src/validation.js';
import { inspectAddress, eip55Checksum } from '../src/address.js';
import { verifyAttestation } from '../src/attestation.js';
import { generateRequesterShare, combineScalars, verifySplitKeyClaim } from '../src/split-key.js';
import { CHAINS, FACTORY_LABELS } from '../src/chains.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_API = process.env.EVM_VANITY_API || 'https://evm-vanity.dev';

/** Guard rail so an assistant cannot pin the host machine indefinitely. */
const GRIND_MAX_MS = Number(process.env.EVM_VANITY_MAX_GRIND_MS || 120_000);

const PATTERN_SHAPE = {
	prefix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Hex characters the address must start with, without 0x. An uppercase letter requests that EIP-55 spelling and costs 2x per letter.'),
	suffix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Hex characters the address must end with.'),
	caseSensitive: z.boolean().optional().describe('Force EIP-55 case matching. Inferred from the pattern when omitted.'),
};

/** @type {Array<{name:string,title:string,description:string,annotations:object,inputSchema:object,handler:Function}>} */
const TOOLS = [
	{
		name: 'vanity_quote',
		title: 'Price an EVM vanity pattern',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Difficulty for an EVM vanity pattern: probability, expected attempts, p50/p90/p99, rarity tier, and the EIP-55 case multiplier. ' +
			'Every nibble of an EVM address is uniform, so a prefix costs the same as a suffix; the only free variable is casing, where a mixed-case ' +
			'pattern costs 2x per letter. Pure maths, no network.',
		inputSchema: { ...PATTERN_SHAPE, attemptsPerSecond: z.number().positive().optional().describe('Your grind rate, to turn attempts into wall-clock time.') },
		handler(args) {
			const pattern = readPattern(args);
			return { difficulty: difficulty(pattern, args?.attemptsPerSecond ? { attemptsPerSecond: args.attemptsPerSecond } : {}), rarity: rarity(pattern) };
		},
	},
	{
		name: 'vanity_grind',
		title: 'Grind an EVM vanity keypair locally',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			'Grind a secp256k1 keypair whose address matches a pattern, using every core of the machine running this MCP server. ' +
			'The base scalar is a full 256-bit CSPRNG draw, never a narrowed seed, and every match is re-derived and checked before it is returned. ' +
			'The key does cross the MCP transport into the calling assistant, so treat the result as sensitive and prefer vanity_split_key_grind for anything valuable.',
		inputSchema: {
			...PATTERN_SHAPE,
			cores: z.number().int().min(1).max(64).optional().describe(`Workers to use. Defaults to every core (${availableParallelism()} here).`),
			timeBudgetMs: z.number().int().positive().optional().describe(`Give up after this long. Capped at ${GRIND_MAX_MS}ms.`),
		},
		async handler(args) {
			const pattern = readPattern(args);
			const budget = Math.min(GRIND_MAX_MS, args?.timeBudgetMs || GRIND_MAX_MS);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), budget);
			try {
				const result = await grindEoaPool({ ...pattern, workers: args?.cores, signal: controller.signal });
				return { ...result, rarity: rarity(pattern), note: 'This address is identical on every EVM chain.' };
			} catch (err) {
				if (err?.name === 'AbortError') {
					const d = difficulty(pattern);
					throw new Error(`no match within ${budget}ms. This pattern needs about ${Math.round(d.p50).toLocaleString('en-US')} attempts for an even chance; raise timeBudgetMs, shorten the pattern, drop the uppercase letters, or use vanity_split_key_grind.`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	},
	{
		name: 'vanity_split_key_grind',
		title: 'Delegate a grind without exposing a key',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		description:
			'Delegate a hard vanity pattern to a remote grinder using split-key arithmetic. A secret scalar k1 is generated here and never sent; ' +
			'the remote service searches offsets k2 against the public point P1 = k1*G and returns k2, which is useless without k1. ' +
			'The final key is combined and verified locally, and on secp256k1 it is an ordinary private key that imports anywhere.',
		inputSchema: {
			...PATTERN_SHAPE,
			api: z.string().url().optional().describe(`API base URL. Defaults to ${DEFAULT_API}.`),
			maxRounds: z.number().int().min(1).max(50).optional().describe('Time-boxed remote requests to make before giving up. Default 5.'),
		},
		async handler(args) {
			const pattern = readPattern(args);
			const api = String(args?.api || DEFAULT_API).replace(/\/$/, '');
			const share = generateRequesterShare();
			const maxRounds = args?.maxRounds || 5;

			let attempts = 0;
			for (let round = 1; round <= maxRounds; round++) {
				const r = await fetch(`${api}/api/splitkey/grind`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ p1: share.p1, ...pattern, timeBudgetMs: 15000 }),
				});
				const data = await r.json();
				if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
				attempts += data.attempts || 0;
				if (!data.found) continue;

				const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern });
				if (!claim.ok) throw new Error(`the remote grinder returned an offset that does not produce its claimed address: ${claim.reason}`);
				const combined = combineScalars(share.k1, data.offset);
				if (combined.address.toLowerCase() !== data.address.toLowerCase()) {
					throw new Error('local combination disagreed with the delegated address');
				}
				return {
					address: combined.addressChecksum,
					privateKey: combined.privateKey,
					attempts,
					rounds: round,
					attestation: data.attestation ?? null,
					nonCustody: 'address(P1 + k2*G) == the address was checked locally. The remote service never held k1 and could not derive this key.',
				};
			}
			return { found: false, attempts, rounds: maxRounds, hint: 'Raise maxRounds, or shorten the pattern.' };
		},
	},
	{
		name: 'vanity_inspect_address',
		title: 'Inspect an EVM address',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Validate an EVM address, check whether its casing satisfies the EIP-55 checksum (a mixed-case address that fails it is a typo, not an address), ' +
			'read the vanity pattern it appears to carry, and score how much grinding work that represents. Pure maths, no network.',
		inputSchema: {
			address: z.string().describe('The 0x address to inspect.'),
			prefixLen: z.number().int().min(0).max(40).optional().describe('Leading characters to treat as intentional. Default 4.'),
			suffixLen: z.number().int().min(0).max(40).optional().describe('Trailing characters to treat as intentional. Default 0.'),
		},
		handler(args) {
			const address = String(args?.address || '').trim();
			const inspection = inspectAddress(address);
			if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(inspection.reason);
			const body = address.slice(2);
			const prefixLen = Number.isInteger(args?.prefixLen) ? args.prefixLen : 4;
			const suffixLen = Number.isInteger(args?.suffixLen) ? args.suffixLen : 0;
			const pattern = { prefix: body.slice(0, prefixLen), suffix: suffixLen ? body.slice(40 - suffixLen) : '', caseSensitive: false };
			return { address: eip55Checksum(address), checksum: inspection, readAs: pattern, difficulty: difficulty(pattern), rarity: rarity(pattern) };
		},
	},
	{
		name: 'vanity_verify_attestation',
		title: 'Verify an EVM vanity attestation',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		description:
			'Verify an EIP-712 vanity attestation: the pattern, the difficulty claim, the freshness nonce, the split-key non-custody equation, and the ' +
			'recovered signer. Every claim is recomputed rather than trusted. Fetches the issuer list when reachable, and says so when it is not.',
		inputSchema: {
			attestation: z.record(z.string(), z.unknown()).describe('The attestation document.'),
			api: z.string().url().optional().describe('Issuer base URL for the published issuer list.'),
		},
		async handler(args) {
			const doc = args?.attestation?.attestation ?? args?.attestation;
			if (!doc || typeof doc !== 'object') throw new Error('attestation must be an object');
			const api = String(args?.api || DEFAULT_API).replace(/\/$/, '');
			let issuers = null;
			try {
				const r = await fetch(`${api}/.well-known/evm-vanity.json`);
				if (r.ok) issuers = ((await r.json()).issuers || []).map((i) => i.address);
			} catch {
				issuers = null;
			}
			const result = verifyAttestation(doc, issuers?.length ? { issuers } : {});
			return { ...result, issuersPinned: !!issuers?.length, issuerSource: issuers?.length ? api : null };
		},
	},
	{
		name: 'vanity_chains',
		title: 'EVM chains and deterministic deployers',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'The EVM chain registry, including Ethereum, Base, Arbitrum and Robinhood Chain, with the deterministic CREATE2 deployers present on each. ' +
			'A vanity EOA needs none of them: the address comes from the key, so one grind works everywhere. They matter only for vanity contract addresses.',
		inputSchema: {},
		handler() {
			return {
				note: 'A vanity EOA works on every chain listed. Deployers matter only for vanity contract addresses.',
				factories: Object.entries(FACTORY_LABELS).map(([address, label]) => ({ address, label })),
				chains: CHAINS.map((c) => ({ id: c.id, name: c.name, rpc: c.rpc, explorer: c.explorer, testnet: !!c.testnet, factories: Object.keys(c.factories) })),
			};
		},
	},
];

/**
 * @param {any} args
 * @returns {{ prefix: string, suffix: string, caseSensitive: boolean }}
 */
function readPattern(args) {
	const p = normalizePattern({
		prefix: String(args?.prefix ?? '').trim(),
		suffix: String(args?.suffix ?? '').trim(),
		...(typeof args?.caseSensitive === 'boolean' ? { caseSensitive: args.caseSensitive } : {}),
	});
	if (!p.length) throw new Error('give a prefix, a suffix, or both');
	for (const [label, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/**
 * Build a fully registered server without connecting a transport, so tests can
 * drive it in-process.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'evm-vanity', title: 'EVM Vanity', version: PKG.version },
		{
			capabilities: { tools: {} },
			instructions:
				'EVM vanity address tooling. vanity_quote prices a pattern (every nibble is uniform at 16^n; EIP-55 casing costs 2x per letter). ' +
				'vanity_grind produces a real keypair locally across every core, from a full 256-bit CSPRNG draw. vanity_split_key_grind delegates a hard ' +
				'pattern to a remote grinder that mathematically cannot derive the resulting key, and on secp256k1 the result is an ordinary importable ' +
				'private key. vanity_inspect_address validates and scores an existing address. vanity_verify_attestation checks a signed EIP-712 document. ' +
				'vanity_chains lists the networks. No API key and no payment are needed for any of them.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
				} catch (err) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

/** Tool definitions, exported so tests and docs stay in sync with the server. */
export { TOOLS };

async function main() {
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[evm-vanity@${PKG.version}] MCP server on stdio with ${TOOLS.length} tools`);
}

// Connect stdio only when this file is the process entry point, so importing it
// from a test or from the CLI does not hijack the parent's stdio.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
