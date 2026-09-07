/**
 * Vanity attestations, signed as EIP-712 typed data: `evm-vanity-attestation/v1`.
 *
 * A certificate is a signed statement about how an address was produced: the
 * pattern, the difficulty, the grind format, a freshness nonce and, for a
 * split-key grind, the two public points whose sum is the address.
 *
 * ── Why EIP-712 rather than a plain signature blob ───────────────────────────
 * The Solana equivalent of this format signs a canonical JSON encoding with
 * Ed25519, which is fine for an off-chain verifier and useless to a contract.
 * On EVM the interesting verifier is on chain: an EIP-712 digest is recovered
 * with `ecrecover` in three lines of Solidity, so a marketplace, a registry or
 * an escrow can require a valid attestation before it accepts a vanity address
 * as "provably ground and never custodied". The same digest verifies off chain
 * here, in the browser, with no RPC at all.
 *
 * The domain deliberately carries no `chainId` and no `verifyingContract`: an
 * attestation is a statement about an address, and an address is the same on
 * every EVM chain. Pinning a chain would make the same true statement fail to
 * verify on Base after being issued on Arbitrum, which is exactly wrong for a
 * multi-chain tool.
 *
 * Pure @noble: no ethers, no RPC, identical in the browser, the API and tests.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { addressFromPoint, eip55Checksum, addressMatchesPattern } from './address.js';
import { nonCustodyHolds, parsePoint } from './split-key.js';
import { expectedAttempts } from './difficulty.js';

export const ATTESTATION_PROTOCOL = 'evm-vanity-attestation/v1';

/** Grind formats an attestation can describe. */
export const FORMAT_EOA = 'eoa';
export const FORMAT_SPLIT_KEY = 'split-key';
export const FORMAT_CREATE2 = 'create2';
export const SUPPORTED_FORMATS = Object.freeze([FORMAT_EOA, FORMAT_SPLIT_KEY, FORMAT_CREATE2]);

/** Certificates older than this are stale, but still structurally valid. */
export const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const DOMAIN_TYPE = 'EIP712Domain(string name,string version)';
const DOMAIN_NAME = 'EvmVanityAttestation';
const DOMAIN_VERSION = '1';

const ATTESTATION_TYPE =
	'VanityAttestation(' +
	'address account,' +
	'string prefix,' +
	'string suffix,' +
	'bool caseSensitive,' +
	'string format,' +
	'uint256 expectedAttempts,' +
	'uint256 attempts,' +
	'bytes32 nonce,' +
	'uint256 issuedAt,' +
	'bytes32 nonCustodyHash' +
	')';

const DOMAIN_SEPARATOR = keccak_256(concatBytes(
	keccak_256(utf8ToBytes(DOMAIN_TYPE)),
	keccak_256(utf8ToBytes(DOMAIN_NAME)),
	keccak_256(utf8ToBytes(DOMAIN_VERSION)),
));

/** The type hash a Solidity verifier must use. Exported so the two cannot drift. */
export const TYPE_HASH = `0x${bytesToHex(keccak_256(utf8ToBytes(ATTESTATION_TYPE)))}`;
export const DOMAIN_SEPARATOR_HEX = `0x${bytesToHex(DOMAIN_SEPARATOR)}`;
export { ATTESTATION_TYPE };

// ── encoding ─────────────────────────────────────────────────────────────────

/** @param {bigint|number} value @returns {Uint8Array} 32-byte big-endian word */
function word(value) {
	let v = BigInt(value);
	if (v < 0n) throw new RangeError('negative value in a uint256 field');
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0 && v > 0n; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** @param {string} hex `0x…` @param {number} bytes @returns {Uint8Array} left-padded word */
function hexWord(hex, bytes) {
	const raw = hexToBytes(String(hex || '').replace(/^0x/, ''));
	if (raw.length !== bytes) throw new RangeError(`expected ${bytes} bytes, got ${raw.length}`);
	const out = new Uint8Array(32);
	out.set(raw, 32 - bytes);
	return out;
}

/** @param {string} s @returns {Uint8Array} */
function stringWord(s) {
	return keccak_256(utf8ToBytes(String(s ?? '')));
}

/**
 * The keccak256 of the two public points whose sum must equal the address, or
 * 32 zero bytes when the attestation makes no non-custody claim.
 * @param {{ requesterPoint?: string, grinderPoint?: string }} [nonCustody]
 * @returns {Uint8Array}
 */
export function nonCustodyHash(nonCustody) {
	if (!nonCustody?.requesterPoint || !nonCustody?.grinderPoint) return new Uint8Array(32);
	return keccak_256(concatBytes(
		parsePoint(nonCustody.requesterPoint).toBytes(false),
		parsePoint(nonCustody.grinderPoint).toBytes(false),
	));
}

/**
 * The EIP-712 digest a signer signs and `ecrecover` recovers against.
 * @param {object} core the attestation core (see {@link buildAttestation})
 * @returns {Uint8Array} 32 bytes
 */
export function attestationDigest(core) {
	const structHash = keccak_256(concatBytes(
		keccak_256(utf8ToBytes(ATTESTATION_TYPE)),
		hexWord(core.account, 20),
		stringWord(core.pattern.prefix || ''),
		stringWord(core.pattern.suffix || ''),
		word(core.pattern.caseSensitive ? 1 : 0),
		stringWord(core.format),
		word(BigInt(Math.round(core.difficulty.expectedAttempts))),
		word(BigInt(Math.round(core.attempts || 0))),
		hexWord(core.freshness.nonce, 32),
		word(BigInt(Math.floor(Date.parse(core.freshness.issuedAt) / 1000))),
		nonCustodyHash(core.nonCustody),
	));
	return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

// ── issuing ──────────────────────────────────────────────────────────────────

/** A fresh 32-byte freshness nonce. */
export function randomNonce() {
	const out = new Uint8Array(32);
	globalThis.crypto.getRandomValues(out);
	return `0x${bytesToHex(out)}`;
}

/**
 * Build the unsigned core of an attestation.
 *
 * Refuses to describe an address that does not match the pattern, or a
 * split-key format whose non-custody points do not add up: an attestation that
 * cannot verify is worse than none.
 *
 * @param {object} p
 * @param {string} p.account `0x…` address being attested
 * @param {{ prefix?: string, suffix?: string, caseSensitive?: boolean }} p.pattern
 * @param {string} p.format one of {@link SUPPORTED_FORMATS}
 * @param {number} [p.attempts] attempts the grinder actually made
 * @param {{ requesterPoint: string, grinderPoint: string }} [p.nonCustody]
 * @param {string} [p.nonce]
 * @param {string} [p.issuedAt] ISO timestamp
 * @returns {object}
 */
export function buildAttestation({ account, pattern, format, attempts, nonCustody, nonce, issuedAt }) {
	const address = String(account || '').trim();
	if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('account must be a 20-byte 0x address');
	if (!SUPPORTED_FORMATS.includes(format)) throw new Error(`unsupported format "${format}"`);

	const pat = {
		prefix: String(pattern?.prefix || '').replace(/^0x/i, ''),
		suffix: String(pattern?.suffix || ''),
		caseSensitive: !!pattern?.caseSensitive,
	};
	if (!pat.prefix && !pat.suffix) throw new Error('an attestation needs a prefix, a suffix, or both');
	if (!addressMatchesPattern(address, pat)) throw new Error('the address does not match the claimed pattern');

	if (format === FORMAT_SPLIT_KEY) {
		if (!nonCustody?.requesterPoint || !nonCustody?.grinderPoint) {
			throw new Error('a split-key attestation needs nonCustody: { requesterPoint, grinderPoint }');
		}
		if (!nonCustodyHolds(nonCustody.requesterPoint, nonCustody.grinderPoint, address)) {
			throw new Error('requesterPoint + grinderPoint does not equal the attested address');
		}
	}

	return {
		protocol: ATTESTATION_PROTOCOL,
		account: eip55Checksum(address),
		pattern: pat,
		format,
		attempts: Number.isFinite(attempts) ? Math.round(attempts) : 0,
		difficulty: {
			expectedAttempts: Math.round(expectedAttempts(pat)),
			model: 'hex-uniform/v1',
		},
		freshness: {
			nonce: nonce || randomNonce(),
			issuedAt: issuedAt || new Date().toISOString(),
		},
		...(nonCustody ? { nonCustody: { scheme: 'secp256k1-split-key/v1', ...nonCustody } } : {}),
	};
}

/**
 * Sign an attestation core with the issuer's secp256k1 key.
 *
 * The signature is 65 bytes, `r ‖ s ‖ v` with `v ∈ {27, 28}`: the layout
 * `ecrecover` expects, so the same document verifies in Solidity unchanged.
 *
 * @param {object} p
 * @param {object} p.core
 * @param {string|Uint8Array} p.signingKey 32-byte secp256k1 private key
 * @returns {object} the signed attestation
 */
export function signAttestation({ core, signingKey }) {
	const key = typeof signingKey === 'string' ? hexToBytes(signingKey.replace(/^0x/, '')) : signingKey;
	if (key.length !== 32) throw new Error('signingKey must be 32 bytes');

	const digest = attestationDigest(core);
	// @noble returns `[recovery, r, s]` for the recovered format; Ethereum wants
	// `[r, s, v]` with `v = 27 + recovery`, which is what `ecrecover` reads.
	const recovered = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
	const ethSignature = concatBytes(recovered.subarray(1), new Uint8Array([27 + recovered[0]]));

	return {
		...core,
		digest: `0x${bytesToHex(digest)}`,
		signature: `0x${bytesToHex(ethSignature)}`,
		issuer: eip55Checksum(addressFromPoint(secp256k1.Point.fromBytes(secp256k1.getPublicKey(key, false)))),
		signatureScheme: 'eip712-ecdsa-secp256k1',
	};
}

/**
 * Recover the signer address from an attestation.
 * @param {object} attestation
 * @returns {string} `0x…` checksummed address
 */
export function recoverIssuer(attestation) {
	const digest = attestationDigest(attestation);
	const sig = hexToBytes(String(attestation.signature || '').replace(/^0x/, ''));
	if (sig.length !== 65) throw new Error('signature must be 65 bytes (r, s, v)');
	const recovery = sig[64] - 27;
	if (recovery !== 0 && recovery !== 1) throw new Error('signature v must be 27 or 28');

	// Back to @noble's `[recovery, r, s]` layout to recover the public key.
	const recoveredForm = concatBytes(new Uint8Array([recovery]), sig.subarray(0, 64));
	const publicKey = secp256k1.recoverPublicKey(recoveredForm, digest, { prehash: false, format: 'recovered' });
	return eip55Checksum(addressFromPoint(secp256k1.Point.fromBytes(publicKey)));
}

// ── verifying ────────────────────────────────────────────────────────────────

/**
 * Verify an attestation end to end, recomputing every claim.
 *
 * Returns a per-check audit rather than a boolean, so a UI or CLI can show
 * exactly which claim failed and why.
 *
 * @param {object} attestation
 * @param {object} [opts]
 * @param {string[]} [opts.issuers] addresses that are allowed to have signed it.
 *   Without this, a self-signed forgery passes the signature check, and the
 *   audit says so.
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.freshnessWindowMs]
 * @returns {{ valid: boolean, checks: Array<{id:string,label:string,pass:boolean,detail:string}>, account: string, issuer: string }}
 */
export function verifyAttestation(attestation, opts = {}) {
	const checks = [];
	const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });
	const now = Number.isFinite(opts.now) ? opts.now : Date.now();

	if (!attestation || typeof attestation !== 'object') {
		add('shape', 'Attestation is well-formed', false, 'attestation is missing or not an object');
		return { valid: false, checks, account: '', issuer: '' };
	}
	if (attestation.protocol !== ATTESTATION_PROTOCOL) {
		add('protocol', 'Protocol version is supported', false, `document is "${attestation.protocol}", expected "${ATTESTATION_PROTOCOL}"`);
		return { valid: false, checks, account: attestation.account || '', issuer: '' };
	}
	add('protocol', 'Protocol version is supported', true, `${ATTESTATION_PROTOCOL} · ${attestation.format} grind`);

	// 1. The account is a well-formed, correctly checksummed address.
	{
		const raw = String(attestation.account || '');
		const wellFormed = /^0x[0-9a-fA-F]{40}$/.test(raw);
		add('account', 'Account is a valid EVM address', wellFormed && eip55Checksum(raw) === raw,
			wellFormed ? `${raw}` : 'not a 20-byte 0x-prefixed hex address');
	}

	// 2. The address really matches the pattern it claims.
	{
		const ok = addressMatchesPattern(attestation.account, attestation.pattern || {});
		const p = attestation.pattern || {};
		add('pattern', 'Address matches the attested pattern', ok,
			ok
				? `${attestation.account} matches ${p.prefix ? `prefix "${p.prefix}"` : ''}${p.prefix && p.suffix ? ' and ' : ''}${p.suffix ? `suffix "${p.suffix}"` : ''}${p.caseSensitive ? ' (EIP-55 case-sensitive)' : ''}`
				: 'the address does not satisfy the pattern in the document');
	}

	// 3. The difficulty claim is what the named model produces.
	{
		let expected = NaN;
		try {
			expected = Math.round(expectedAttempts(attestation.pattern || {}));
		} catch { /* handled by the comparison below */ }
		const claimed = Number(attestation.difficulty?.expectedAttempts);
		const ok = Number.isFinite(expected) && claimed === expected;
		add('difficulty', 'Difficulty claim is honest', ok,
			ok ? `expectedAttempts = ${expected.toLocaleString('en-US')} under ${attestation.difficulty?.model}`
			   : `document claims ${claimed}, the model gives ${expected}`);
	}

	// 4. Freshness: not issued in the future, and inside any window supplied.
	{
		const issued = Date.parse(attestation.freshness?.issuedAt || '');
		const nonceOk = /^0x[0-9a-fA-F]{64}$/.test(attestation.freshness?.nonce || '');
		let ok = Number.isFinite(issued) && nonceOk && issued <= now + DEFAULT_FUTURE_SKEW_MS;
		let detail = ok ? `issued ${attestation.freshness.issuedAt}` : 'missing, malformed, or future-dated issue time';
		if (ok && opts.freshnessWindowMs && now - issued > opts.freshnessWindowMs) {
			ok = false;
			detail = `issued ${Math.round((now - issued) / 86400000)} days ago, outside the requested freshness window`;
		}
		add('freshness', 'Freshness nonce and timestamp are sane', ok, detail);
	}

	// 5. Non-custody, for split-key grinds: the two published points add to the
	//    address, so the issuer provably never held the whole key.
	if (attestation.format === FORMAT_SPLIT_KEY || attestation.nonCustody) {
		const nc = attestation.nonCustody;
		const ok = !!nc && nonCustodyHolds(nc.requesterPoint, nc.grinderPoint, attestation.account);
		add('nonCustody', 'Issuer could not have held the private key', ok,
			ok ? 'requesterPoint + grinderPoint equals the attested address, so the issuer never had the requester half'
			   : 'the published points do not sum to the address, so the non-custody claim is broken');
	}

	// 6. The signature covers exactly these facts.
	let issuer = '';
	{
		let ok = false;
		let detail = '';
		try {
			issuer = recoverIssuer(attestation);
			ok = !!issuer;
			detail = ok ? `EIP-712 signature recovers to ${issuer}` : 'signature did not recover a signer';
			if (ok && attestation.issuer && attestation.issuer.toLowerCase() !== issuer.toLowerCase()) {
				ok = false;
				detail = `document names ${attestation.issuer} but the signature recovers to ${issuer}`;
			}
			if (ok && attestation.digest && attestation.digest.toLowerCase() !== `0x${bytesToHex(attestationDigest(attestation))}`) {
				ok = false;
				detail = 'the stated digest does not match the document';
			}
		} catch (err) {
			detail = err.message;
		}
		add('signature', 'EIP-712 signature is valid', ok, detail);
	}

	// 7. The signer is one this verifier accepts.
	{
		if (opts.issuers?.length) {
			const allowed = opts.issuers.map((a) => String(a).toLowerCase());
			const ok = !!issuer && allowed.includes(issuer.toLowerCase());
			add('issuerPinned', 'Signed by a published issuer key', ok,
				ok ? `${issuer} is in the published issuer list`
				   : `${issuer || 'unknown signer'} is not in the published issuer list, so this could be self-signed`);
		} else {
			add('issuerPinned', 'Signed by a published issuer key', false,
				'no issuer list supplied: fetch /.well-known/evm-vanity.json to pin the issuer, otherwise a self-signed document passes the signature check');
		}
	}

	return {
		valid: checks.every((c) => c.pass),
		checks,
		account: attestation.account || '',
		issuer,
	};
}
