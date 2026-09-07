/**
 * Node EOA grinder, single-threaded.
 *
 * The same hot loop as the browser worker: draw a random base scalar, walk the
 * curve one point addition at a time, keccak the uncompressed key, compare.
 * Bounded by a wall-clock budget so a request handler can call it without
 * risking a hung process.
 *
 * `grinder-pool.js` runs this across every core, which is what the CLI uses.
 * This module exists on its own because a request handler wants one thread and
 * a hard deadline, not a fan-out.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

import { eip55Checksum, addressMatchesPattern } from './address.js';
import { normalizePattern, expectedAttempts } from './difficulty.js';

const Point = secp256k1.Point;
const G = Point.BASE;
const N = Point.Fn.ORDER;

/** Re-draw the base scalar this often, so one run never extends a single arithmetic progression indefinitely. */
const RESEED_INTERVAL = 1_000_000;
/** Check the clock every this many candidates: often enough to honour a budget, rarely enough not to dominate the loop. */
const CLOCK_INTERVAL = 2048;

/** 32-byte big-endian encoding of a scalar. */
function scalarToBytes(value) {
	let v = ((value % N) + N) % N;
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** A uniformly random non-zero scalar from a full 256-bit draw. */
function randomScalar() {
	const wide = new Uint8Array(64);
	crypto.getRandomValues(wide);
	let n = 0n;
	for (const byte of wide) n = (n << 8n) | BigInt(byte);
	const s = n % N;
	return s === 0n ? 1n : s;
}

/**
 * @typedef {object} NodeGrindResult
 * @property {boolean} found
 * @property {string} [address] lowercase `0x…`
 * @property {string} [addressChecksum] EIP-55 `0x…`
 * @property {string} [privateKey] `0x…` 32 bytes
 * @property {number} attempts
 * @property {number} durationMs
 */

/**
 * Grind on this thread until a match or the budget runs out.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.caseSensitive]
 * @param {number} [opts.timeBudgetMs=15000]
 * @param {(p: { attempts: number, rate: number }) => void} [opts.onProgress]
 * @returns {NodeGrindResult}
 */
export function grindEoaNode(opts = {}) {
	const pattern = normalizePattern(opts);
	if (!pattern.length) throw new Error('a prefix or suffix is required');
	const timeBudgetMs = opts.timeBudgetMs ?? 15_000;
	const started = Date.now();

	let k = randomScalar();
	let P = G.multiply(k);
	let attempts = 0;
	let sinceReseed = 0;

	for (;;) {
		const address = `0x${bytesToHex(keccak_256(P.toBytes(false).subarray(1)).subarray(12))}`;
		attempts++;
		sinceReseed++;

		if (addressMatchesPattern(address, pattern)) {
			const privateKey = scalarToBytes(k);
			// Re-derive from scratch, not from the running point: a key that does
			// not control the advertised address would be a footgun worth money.
			const check = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(privateKey, false).subarray(1)).subarray(12))}`;
			if (check !== address) throw new Error('grinder self-check failed: derived key does not control the matched address');
			return {
				found: true,
				address,
				addressChecksum: eip55Checksum(address),
				privateKey: `0x${bytesToHex(privateKey)}`,
				attempts,
				durationMs: Date.now() - started,
			};
		}

		if (attempts % CLOCK_INTERVAL === 0) {
			if (opts.onProgress) {
				const seconds = (Date.now() - started) / 1000;
				opts.onProgress({ attempts, rate: seconds > 0 ? Math.round(attempts / seconds) : 0 });
			}
			if (Date.now() - started >= timeBudgetMs) break;
		}

		if (sinceReseed >= RESEED_INTERVAL) {
			sinceReseed = 0;
			k = randomScalar();
			P = G.multiply(k);
			continue;
		}

		P = P.add(G);
		k = (k + 1n) % N;
	}

	return { found: false, attempts, durationMs: Date.now() - started };
}

/**
 * Expected attempts for a pattern, re-exported so a caller driving the grinder
 * does not need a second import for the ETA.
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} pattern
 * @returns {number}
 */
export function expectedAttemptsFor(pattern) {
	return expectedAttempts(pattern);
}
