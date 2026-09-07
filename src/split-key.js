/**
 * Trustless split-key vanity grinding on secp256k1: `evm-split-key/v1`.
 *
 * The Ed25519 version of this idea is old news in the Solana world. On EVM it is
 * effectively unavailable: the well-known tool that did it (profanity2) is a
 * command-line C++ program with no library, no browser build, no wire format and
 * no verifier, and the tool it replaced shipped a 32-bit seed that drained real
 * wallets in 2022. This module is the protocol written down and made checkable.
 *
 * ── The maths (secp256k1 group, generator G, order n) ────────────────────────
 *   1. The requester picks a secret scalar  k1 ∈ [1, n)  locally and publishes
 *      only  P1 = k1·G  (an uncompressed public point). k1 never leaves.
 *   2. A worker grinds an offset scalar k2, computing candidate addresses
 *           A = keccak256(uncompressed(P1 + k2·G)[1:])[12:]
 *      and testing each against the pattern. It knows k2 and P1 but not k1, so
 *      it cannot compute the final private key.
 *   3. On a hit the worker publishes (k2, A). Anyone verifies, with no secret,
 *      that the address derived from P1 + k2·G equals A.
 *   4. The requester combines  k = (k1 + k2) mod n  on their own machine. Since
 *      k·G = k1·G + k2·G = P1 + k2·G, that scalar is the private key for A, and
 *      it only ever exists on the requester's device.
 *
 * Unlike the Ed25519 case there is no expanded-key caveat here: secp256k1
 * private keys *are* scalars, so the combined result is an ordinary 32-byte
 * private key that imports into MetaMask, ethers, viem, Rabby or a keystore
 * file like any other. Delegated EVM grinding therefore has no downside at all
 * beyond trusting the arithmetic, which you can check yourself below.
 *
 * The offset k2 is not a secret. It is useless without k1, so it travels in the
 * clear and needs no envelope, escrow or trusted delivery.
 *
 * Pure and isomorphic: @noble/curves and @noble/hashes only, so the identical
 * code runs in the browser, the API, the CLI and the tests.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { addressFromPoint, eip55Checksum, addressMatchesPattern } from './address.js';

export const SPLIT_KEY_PROTOCOL = 'evm-split-key/v1';

const Point = secp256k1.Point;
const G = Point.BASE;
/** secp256k1 group order. */
export const N = Point.Fn.ORDER;

// ── scalars ──────────────────────────────────────────────────────────────────

/** 32-byte big-endian encoding of a scalar already reduced mod n. */
export function scalarToBytes(value) {
	let v = ((value % N) + N) % N;
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** Big-endian bytes or hex to a scalar, reduced mod n. */
export function bytesToScalar(input) {
	const bytes = typeof input === 'string' ? hexToBytes(input.replace(/^0x/, '')) : input;
	let n = 0n;
	for (const byte of bytes) n = (n << 8n) | BigInt(byte);
	return ((n % N) + N) % N;
}

/**
 * A uniformly random non-zero scalar.
 *
 * 512 bits reduced mod n has negligible bias, and this is deliberately NOT a
 * narrowed seed: the 2022 Profanity failure was a 32-bit seed that made every
 * ground key brute-forceable. The unknown here is a full 256-bit secret.
 * @returns {bigint}
 */
export function randomScalar() {
	const wide = new Uint8Array(64);
	const g = globalThis.crypto;
	if (!g?.getRandomValues) throw new Error('split-key: no secure RNG available');
	g.getRandomValues(wide);
	let n = 0n;
	for (const byte of wide) n = (n << 8n) | BigInt(byte);
	const s = n % N;
	return s === 0n ? 1n : s;
}

// ── points ───────────────────────────────────────────────────────────────────

/**
 * Parse a public point from hex (compressed 33 bytes or uncompressed 65) or bytes.
 * @param {string|Uint8Array} input
 * @returns {InstanceType<typeof Point>}
 */
export function parsePoint(input) {
	if (input instanceof Point) return input;
	const bytes = typeof input === 'string' ? hexToBytes(input.replace(/^0x/, '')) : input;
	if (bytes.length !== 33 && bytes.length !== 65) {
		throw new Error('parsePoint: expected a 33-byte compressed or 65-byte uncompressed point');
	}
	return Point.fromBytes(bytes);
}

/** @param {string|Uint8Array} p1 @returns {boolean} */
export function isValidP1(p1) {
	try {
		const point = parsePoint(p1);
		point.assertValidity();
		return !point.equals(Point.ZERO);
	} catch {
		return false;
	}
}

/**
 * The requester's share. `k1` is the secret and must never be transmitted;
 * `p1` is the public point the grinder works against.
 * @returns {{ k1: string, p1: string, address: string, protocol: string }}
 */
export function generateRequesterShare() {
	const k1 = randomScalar();
	const P1 = G.multiply(k1);
	return {
		k1: `0x${bytesToHex(scalarToBytes(k1))}`,
		p1: `0x${bytesToHex(P1.toBytes(false))}`,
		// The address P1 alone controls, shown so a requester can sanity-check
		// that the pattern search actually moved it somewhere new.
		address: addressFromPoint(P1),
		protocol: SPLIT_KEY_PROTOCOL,
	};
}

/**
 * Search offsets until `P1 + k2·G` produces a matching address.
 *
 * Walks the curve one point addition at a time, exactly like the local EOA
 * grinder, so the cost per candidate is the same: one addition plus one keccak.
 *
 * @param {object} opts
 * @param {string|Uint8Array} opts.p1              requester public point
 * @param {string} [opts.prefix]                   hex prefix, without 0x
 * @param {string} [opts.suffix]                   hex suffix
 * @param {boolean} [opts.caseSensitive]           match EIP-55 casing exactly
 * @param {number} [opts.maxAttempts=Infinity]
 * @param {number} [opts.timeBudgetMs=Infinity]
 * @param {(p: { attempts: number, rate: number }) => void} [opts.onProgress]
 * @param {number} [opts.progressEvery=4096]
 * @param {{ aborted: boolean }|AbortSignal} [opts.signal]
 * @returns {{ found: boolean, offset?: string, address?: string, addressChecksum?: string, attempts: number, durationMs: number }}
 */
export function grindSplitKeyOffset(opts = {}) {
	const P1 = parsePoint(opts.p1);
	const pattern = {
		prefix: (opts.prefix || '').replace(/^0x/i, ''),
		suffix: opts.suffix || '',
		caseSensitive: !!opts.caseSensitive,
	};
	if (!pattern.prefix && !pattern.suffix) throw new Error('a prefix or suffix is required');

	const maxAttempts = opts.maxAttempts ?? Infinity;
	const timeBudgetMs = opts.timeBudgetMs ?? Infinity;
	const progressEvery = opts.progressEvery || 4096;
	const started = Date.now();

	// Start from a random offset so two requests for the same pattern do not
	// re-walk the same stretch of the curve.
	let k2 = randomScalar();
	let Q = P1.add(G.multiply(k2));

	let attempts = 0;
	let sinceProgress = 0;
	const aborted = () => (opts.signal && 'aborted' in opts.signal ? opts.signal.aborted : false);

	for (;;) {
		const address = addressFromPoint(Q);
		attempts++;
		sinceProgress++;

		if (addressMatchesPattern(address, pattern)) {
			return {
				found: true,
				offset: `0x${bytesToHex(scalarToBytes(k2))}`,
				address,
				addressChecksum: eip55Checksum(address),
				attempts,
				durationMs: Date.now() - started,
			};
		}

		if (sinceProgress >= progressEvery) {
			sinceProgress = 0;
			if (opts.onProgress) {
				const seconds = (Date.now() - started) / 1000;
				opts.onProgress({ attempts, rate: seconds > 0 ? Math.round(attempts / seconds) : 0 });
			}
			if (aborted() || attempts >= maxAttempts || Date.now() - started >= timeBudgetMs) break;
		}

		Q = Q.add(G);
		k2 = (k2 + 1n) % N;
	}

	return { found: false, attempts, durationMs: Date.now() - started };
}

/**
 * Verify a worker's claim with no secret at all: re-derive the address from the
 * public point and the offset, and check it against both the claim and the
 * pattern. A client must run this before accepting anything.
 *
 * @param {object} p
 * @param {string|Uint8Array} p.p1
 * @param {string|Uint8Array} p.offset
 * @param {string} p.address
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} [p.pattern]
 * @returns {{ ok: boolean, derivationOk: boolean, patternOk: boolean, derivedAddress: string, reason: string }}
 */
export function verifySplitKeyClaim({ p1, offset, address, pattern }) {
	let derivedAddress = '';
	let derivationOk = false;
	try {
		const P1 = parsePoint(p1);
		const k2 = bytesToScalar(offset);
		derivedAddress = addressFromPoint(P1.add(G.multiply(k2)));
		derivationOk = derivedAddress.toLowerCase() === String(address || '').toLowerCase();
	} catch (err) {
		return { ok: false, derivationOk: false, patternOk: false, derivedAddress, reason: err.message };
	}

	const patternOk = pattern ? addressMatchesPattern(derivedAddress, pattern) : true;
	const ok = derivationOk && patternOk;
	let reason = '';
	if (!derivationOk) reason = `P1 + offset*G derives ${derivedAddress}, not the claimed ${address}`;
	else if (!patternOk) reason = `${derivedAddress} does not match the requested pattern`;
	return { ok, derivationOk, patternOk, derivedAddress, reason };
}

/**
 * Combine the requester's secret with a worker's offset into the final private
 * key. Runs only on the requester's machine.
 *
 * The result is an ordinary secp256k1 private key: import it anywhere.
 *
 * @param {string|Uint8Array} k1
 * @param {string|Uint8Array} offset
 * @returns {{ privateKey: string, address: string, addressChecksum: string }}
 */
export function combineScalars(k1, offset) {
	const a = bytesToScalar(k1);
	const b = bytesToScalar(offset);
	const k = (a + b) % N;
	if (k === 0n) throw new Error('combineScalars: degenerate combined scalar');
	const address = addressFromPoint(G.multiply(k));
	return {
		privateKey: `0x${bytesToHex(scalarToBytes(k))}`,
		address,
		addressChecksum: eip55Checksum(address),
	};
}

/**
 * The public half of an offset: `k2·G`, uncompressed hex.
 *
 * A certificate publishes this rather than the scalar, so a verifier can check
 * `P1 + k2·G == address` with nothing secret in the calculation. That equation
 * is what makes the non-custody claim provable instead of promised.
 * @param {string|Uint8Array} offset
 * @returns {string}
 */
export function offsetPoint(offset) {
	const k2 = bytesToScalar(offset);
	if (k2 === 0n) throw new Error('offsetPoint: offset scalar is zero');
	return `0x${bytesToHex(G.multiply(k2).toBytes(false))}`;
}

/**
 * Check the non-custody equation from public values only.
 * @param {string} p1
 * @param {string} serverComponent
 * @param {string} address
 * @returns {boolean}
 */
export function nonCustodyHolds(p1, serverComponent, address) {
	try {
		const sum = parsePoint(p1).add(parsePoint(serverComponent));
		return addressFromPoint(sum).toLowerCase() === String(address || '').toLowerCase();
	} catch {
		return false;
	}
}

/** Short, stable fingerprint of a P1, for logs and bounty keys. */
export function p1Fingerprint(p1) {
	return bytesToHex(keccak_256(parsePoint(p1).toBytes(false))).slice(0, 16);
}
