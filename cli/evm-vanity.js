#!/usr/bin/env node
/**
 * evm-vanity CLI.
 *
 *   evm-vanity grind --prefix beef [--suffix dead] [--keystore wallet.json]
 *   evm-vanity delegate --prefix beef [--api https://…]
 *   evm-vanity quote --prefix beef [--rate 17000]
 *   evm-vanity inspect <address> [--prefix-len 4] [--suffix-len 4]
 *   evm-vanity verify <attestation.json> [--api https://…]
 *   evm-vanity chains [--verify]
 *   evm-vanity serve [--port 8788]
 *   evm-vanity mcp
 *
 * Everything except `delegate`, `verify --api` and `chains --verify` works with
 * no network at all.
 */

import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { grindEoaPool } from '../src/grinder-pool.js';
import { difficulty, rarity, formatAttempts, formatDuration, normalizePattern } from '../src/difficulty.js';
import { validatePattern } from '../src/validation.js';
import { inspectAddress, eip55Checksum } from '../src/address.js';
import { verifyAttestation } from '../src/attestation.js';
import { generateRequesterShare, combineScalars, verifySplitKeyClaim } from '../src/split-key.js';
import { CHAINS, FACTORY_LABELS, probeFactories } from '../src/chains.js';

const DEFAULT_API = process.env.EVM_VANITY_API || 'https://evm-vanity.dev';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
	dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
	violet: (s) => (tty ? `\x1b[38;5;141m${s}\x1b[0m` : s),
	green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

try {
	await main();
} catch (err) {
	console.error(c.red(`error: ${err.message}`));
	process.exitCode = 1;
}

async function main() {
	switch (command) {
		case 'grind': return cmdGrind();
		case 'delegate': return cmdDelegate();
		case 'quote': return cmdQuote();
		case 'inspect': return cmdInspect();
		case 'verify': return cmdVerify();
		case 'chains': return cmdChains();
		case 'serve': return cmdServe();
		case 'mcp': return cmdMcp();
		case 'help': case '--help': case '-h': case undefined: return usage();
		case 'version': case '--version': case '-v': {
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
			console.log(pkg.version);
			return;
		}
		default:
			usage();
			throw new Error(`unknown command "${command}"`);
	}
}

function usage() {
	console.log(`${c.violet('evm-vanity')} ${c.dim('- grind, price and verify EVM vanity addresses')}

${c.bold('Commands')}
  grind      Grind a keypair locally across every core. The key never leaves this machine.
  delegate   Split-key grind through a remote API. The remote side cannot derive your key.
  quote      Difficulty, rarity and ETA for a pattern.
  inspect    Validate an address, check its EIP-55 checksum, score its pattern.
  verify     Verify an EIP-712 vanity attestation.
  chains     List EVM chains and their deterministic deployers.
  serve      Run the HTTP API and, if built, the site.
  mcp        Run the Model Context Protocol server on stdio.

${c.bold('grind')}
  --prefix <hex>       Characters the address must start with, after 0x
  --suffix <hex>       Characters the address must end with
  --cores <n>          Workers to use (default: every core, ${availableParallelism()} here)
  --keystore <file>    Write an encrypted keystore instead of printing the key
  --out <file>         Write a plain JSON wallet file
  --json               Machine-readable output

${c.dim('An uppercase letter in a pattern (BeeF) requests that EIP-55 spelling and costs 2x per letter.')}

${c.bold('Examples')}
  evm-vanity grind --prefix beef --keystore wallet.json
  evm-vanity quote --prefix dEaD --rate 17000
  evm-vanity delegate --prefix beef --api http://localhost:8788
  evm-vanity chains --verify
`);
}

// ── grind ────────────────────────────────────────────────────────────────────
async function cmdGrind() {
	const pattern = readPattern();
	const cores = flags.cores ? Number(flags.cores) : availableParallelism();
	const d = difficulty(pattern);
	const r = rarity(pattern);

	if (!flags.json) {
		console.log(`${c.violet('✦')} grinding ${c.bold(describe(pattern))} ${c.dim(`(${r.label}${pattern.caseSensitive ? `, EIP-55 spelling, ${d.caseCost}x harder` : ''})`)}`);
		console.log(c.dim(`  ${formatAttempts(d.p50)} attempts for an even chance, across ${cores} cores`));
	}

	const result = await grindEoaPool({
		...pattern,
		workers: cores,
		onProgress: flags.json ? undefined : ({ attempts, rate }) => {
			const eta = rate > 0 ? formatDuration(Math.max(0, d.p50 - attempts) / rate) : 'unknown';
			process.stderr.write(`\r  ${attempts.toLocaleString('en-US')} tried · ${Math.round(rate).toLocaleString('en-US')}/s · eta ${eta}   `);
		},
	});

	if (!flags.json) process.stderr.write('\r' + ' '.repeat(78) + '\r');

	if (flags.keystore) {
		const password = await readPassword();
		const { Wallet } = await import('ethers');
		const json = await new Wallet(result.privateKey).encrypt(password);
		writeFileSync(String(flags.keystore), json);
	}
	if (flags.out) {
		writeFileSync(String(flags.out), JSON.stringify({ address: result.addressChecksum, privateKey: result.privateKey }, null, 2));
	}

	if (flags.json) {
		console.log(JSON.stringify({ ...result, rarity: r }, null, 2));
		return;
	}

	console.log(`${c.green('✓')} ${c.bold(result.addressChecksum)}`);
	console.log(c.dim(`  ${result.attempts.toLocaleString('en-US')} attempts in ${(result.durationMs / 1000).toFixed(1)}s across ${result.workers} cores`));
	console.log(c.dim(`  ${r.label} · rarity score ${r.score}`));
	if (flags.keystore) console.log(`${c.violet('→')} encrypted keystore written to ${flags.keystore}`);
	if (flags.out) console.log(`${c.violet('→')} wallet written to ${flags.out}`);
	if (!flags.keystore && !flags.out) {
		console.log('');
		console.log(c.dim('  private key (treat like cash):'));
		console.log(`  ${result.privateKey}`);
		console.log('');
		console.log(c.dim('  Pass --keystore wallet.json to write an encrypted keystore instead.'));
	}
	console.log(c.dim('  This address is identical on every EVM chain.'));
}

// ── delegate ─────────────────────────────────────────────────────────────────
async function cmdDelegate() {
	const pattern = readPattern();
	const api = String(flags.api || DEFAULT_API).replace(/\/$/, '');
	const share = generateRequesterShare();

	if (!flags.json) {
		console.log(`${c.violet('✦')} delegating ${c.bold(describe(pattern))} to ${api}`);
		console.log(c.dim(`  P1 ${share.p1.slice(0, 26)}…`));
		console.log(c.dim('  k1 stays on this machine and is never transmitted'));
	}

	let attempts = 0;
	let rounds = 0;
	for (;;) {
		rounds++;
		const r = await fetch(`${api}/api/splitkey/grind`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ p1: share.p1, ...pattern, timeBudgetMs: 15000 }),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		attempts += data.attempts || 0;
		if (!flags.json) process.stderr.write(`\r  ${attempts.toLocaleString('en-US')} offsets over ${rounds} request${rounds === 1 ? '' : 's'}   `);
		if (!data.found) continue;

		if (!flags.json) process.stderr.write('\r' + ' '.repeat(78) + '\r');

		// Never trust the response: re-derive, then combine locally.
		const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern });
		if (!claim.ok) throw new Error(`the remote grinder returned an invalid offset: ${claim.reason}`);
		const combined = combineScalars(share.k1, data.offset);
		if (combined.address.toLowerCase() !== data.address.toLowerCase()) {
			throw new Error('local combination disagreed with the delegated address');
		}

		if (flags.keystore) {
			const password = await readPassword();
			const { Wallet } = await import('ethers');
			writeFileSync(String(flags.keystore), await new Wallet(combined.privateKey).encrypt(password));
		}

		if (flags.json) {
			console.log(JSON.stringify({ ...combined, attempts, rounds, attestation: data.attestation }, null, 2));
			return;
		}
		console.log(`${c.green('✓')} ${c.bold(combined.addressChecksum)}`);
		console.log(c.dim(`  ${attempts.toLocaleString('en-US')} offsets over ${rounds} request${rounds === 1 ? '' : 's'}, verified locally`));
		if (flags.keystore) {
			console.log(`${c.violet('→')} encrypted keystore written to ${flags.keystore}`);
		} else {
			console.log('');
			console.log(c.dim('  private key (an ordinary secp256k1 key, import it anywhere):'));
			console.log(`  ${combined.privateKey}`);
		}
		return;
	}
}

// ── quote ────────────────────────────────────────────────────────────────────
function cmdQuote() {
	const pattern = readPattern();
	const rate = Number(flags.rate || 0);
	const d = difficulty(pattern, rate > 0 ? { attemptsPerSecond: rate } : {});
	const r = rarity(pattern);

	if (flags.json) {
		console.log(JSON.stringify({ pattern: d.pattern, difficulty: d, rarity: r }, null, 2));
		return;
	}
	console.log(`${c.violet('✦')} ${c.bold(describe(pattern))}`);
	console.log(`  expected attempts  ${Math.round(d.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  even chance (p50)  ${Math.round(d.p50).toLocaleString('en-US')}`);
	console.log(`  90% chance         ${Math.round(d.p90).toLocaleString('en-US')}`);
	console.log(`  99% chance         ${Math.round(d.p99).toLocaleString('en-US')}`);
	console.log(`  rarity             ${r.label} · score ${r.score}`);
	if (d.caseCost > 1) console.log(`  EIP-55 spelling    ${d.caseCost}x harder than the any-case pattern`);
	if (d.eta) console.log(`  eta at ${Number(rate).toLocaleString('en-US')}/s   ${d.eta.p50Human} (p50), ${d.eta.p90Human} (p90)`);
}

// ── inspect ──────────────────────────────────────────────────────────────────
function cmdInspect() {
	const address = argv[1] && !argv[1].startsWith('--') ? argv[1] : String(flags.address || '');
	if (!address) throw new Error('usage: evm-vanity inspect <address>');
	const inspection = inspectAddress(address);
	if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error(inspection.reason);

	const body = address.trim().slice(2);
	const prefixLen = flags['prefix-len'] ? Number(flags['prefix-len']) : 4;
	const suffixLen = flags['suffix-len'] ? Number(flags['suffix-len']) : 0;
	const pattern = { prefix: body.slice(0, prefixLen), suffix: suffixLen ? body.slice(40 - suffixLen) : '', caseSensitive: false };
	const d = difficulty(pattern);
	const r = rarity(pattern);

	if (flags.json) {
		console.log(JSON.stringify({ address: eip55Checksum(address), checksum: inspection, readAs: pattern, difficulty: d, rarity: r }, null, 2));
		return;
	}
	console.log(`${c.violet('✦')} ${c.bold(eip55Checksum(address))}`);
	console.log(`  checksum           ${inspection.checksummed ? c.green(inspection.reason) : inspection.reason}`);
	console.log(`  read as            0x${pattern.prefix}…${pattern.suffix}`);
	console.log(`  expected attempts  ${Math.round(d.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  rarity             ${r.label} · score ${r.score}`);
}

// ── verify ───────────────────────────────────────────────────────────────────
async function cmdVerify() {
	const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : String(flags.file || '');
	if (!file) throw new Error('usage: evm-vanity verify <attestation.json>');
	const raw = JSON.parse(await readFile(file, 'utf8'));
	const doc = raw.attestation ?? raw;

	// Pin against the issuer's published list when we can reach it. Without a
	// pin, a self-signed forgery passes the signature check, so say which ran.
	let issuers = null;
	const api = String(flags.api || DEFAULT_API).replace(/\/$/, '');
	try {
		const r = await fetch(`${api}/.well-known/evm-vanity.json`);
		if (r.ok) issuers = ((await r.json()).issuers || []).map((i) => i.address);
	} catch {
		issuers = null;
	}

	const result = verifyAttestation(doc, issuers?.length ? { issuers } : {});
	if (flags.json) {
		console.log(JSON.stringify({ ...result, issuersPinned: !!issuers?.length, issuerSource: issuers?.length ? api : null }, null, 2));
		process.exitCode = result.valid ? 0 : 1;
		return;
	}
	console.log(result.valid ? c.green('✓ attestation is valid') : c.red('✗ attestation is NOT valid'));
	console.log(c.dim(`  account ${result.account}`));
	console.log(c.dim(`  signer  ${result.issuer || 'not recovered'}`));
	console.log(c.dim(`  issuers ${issuers?.length ? `pinned from ${api}` : 'unavailable, so a self-signed document would pass'}`));
	console.log('');
	for (const check of result.checks) {
		console.log(`  ${check.pass ? c.green('✓') : c.red('✗')} ${check.label}`);
		console.log(c.dim(`     ${check.detail}`));
	}
	process.exitCode = result.valid ? 0 : 1;
}

// ── chains ───────────────────────────────────────────────────────────────────
async function cmdChains() {
	if (!flags.verify) {
		if (flags.json) {
			console.log(JSON.stringify(CHAINS, null, 2));
			return;
		}
		console.log(`${c.violet('✦')} ${CHAINS.length} chains. A vanity EOA works on all of them: the address comes from the key, not the network.`);
		console.log('');
		for (const chain of CHAINS) {
			const count = Object.keys(chain.factories).length;
			console.log(`  ${String(chain.id).padStart(9)}  ${chain.name.padEnd(26)} ${c.dim(`${count}/4 deployers`)}${chain.testnet ? c.dim(' · testnet') : ''}`);
		}
		console.log('');
		console.log(c.dim('  Deployers matter only for vanity CONTRACT addresses. Run with --verify to re-probe every RPC.'));
		return;
	}

	let disagreements = 0;
	for (const chain of CHAINS) {
		process.stderr.write(`\r  checking ${chain.name}…${' '.repeat(30)}`);
		const rows = await probeFactories(chain, { timeoutMs: 12_000 });
		const bad = rows.filter((r) => !r.agrees);
		process.stderr.write('\r' + ' '.repeat(60) + '\r');
		if (!bad.length) {
			console.log(`  ${c.green('✓')} ${chain.name}`);
			continue;
		}
		disagreements++;
		console.log(`  ${c.red('✗')} ${chain.name}`);
		for (const row of bad) {
			console.log(c.dim(`     ${row.label}: repository says ${row.claimed}, chain says ${row.actual === null ? `unreachable (${row.error})` : row.actual}`));
		}
	}
	console.log('');
	console.log(disagreements ? c.red(`${disagreements} chain(s) disagree with this repository.`) : c.green('every chain agrees with this repository.'));
	process.exitCode = disagreements ? 1 : 0;
}

// ── serve / mcp ──────────────────────────────────────────────────────────────
async function cmdServe() {
	if (flags.port) process.env.PORT = String(flags.port);
	await import('../server/index.mjs');
}

async function cmdMcp() {
	const [{ buildServer, TOOLS }, { StdioServerTransport }] = await Promise.all([
		import('../mcp/index.js'),
		import('@modelcontextprotocol/sdk/server/stdio.js'),
	]);
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[evm-vanity] MCP server on stdio with ${TOOLS.length} tools`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** @returns {{ prefix: string, suffix: string, caseSensitive: boolean }} */
function readPattern() {
	const raw = { prefix: String(flags.prefix || ''), suffix: String(flags.suffix || '') };
	const p = normalizePattern(raw);
	if (!p.length) throw new Error('give --prefix, --suffix, or both');
	for (const [label, value] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix: p.prefix, suffix: p.suffix, caseSensitive: p.caseSensitive };
}

/** @param {{prefix:string,suffix:string}} pattern @returns {string} */
function describe(pattern) {
	return `0x${pattern.prefix || ''}…${pattern.suffix || ''}`;
}

/** Read a keystore password without echoing it into the terminal history. */
async function readPassword() {
	if (flags.password) return String(flags.password);
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const password = await rl.question('keystore password: ');
		if (password.length < 8) throw new Error('use a password of at least 8 characters');
		return password;
	} finally {
		rl.close();
	}
}

/**
 * `--key value` and `--flag` into an object. A value that looks like the next
 * flag is treated as a boolean, so `--json --prefix beef` parses correctly.
 * @param {string[]} args
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(args) {
	/** @type {Record<string, string|boolean>} */
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else { out[key] = next; i++; }
	}
	return out;
}
