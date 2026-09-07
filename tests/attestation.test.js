/**
 * Attestations are EIP-712 typed data, so the tests care about two things: that
 * the digest is stable (a contract computing it independently must agree), and
 * that every way of lying is caught.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
	buildAttestation, signAttestation, verifyAttestation, recoverIssuer, attestationDigest,
	nonCustodyHash, TYPE_HASH, DOMAIN_SEPARATOR_HEX, ATTESTATION_TYPE,
} from '../src/attestation.js';
import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';
import { generateRequesterShare, grindSplitKeyOffset, offsetPoint } from '../src/split-key.js';

/** An issuer key and an account whose address starts with a known prefix. */
function fixture() {
	const issuerKey = secp256k1.utils.randomSecretKey();
	const accountKey = secp256k1.utils.randomSecretKey();
	const account = eip55Checksum(addressFromPrivateKey(accountKey));
	return { issuerKey, account, prefix: account.slice(2, 4).toLowerCase() };
}

test('an attestation round-trips and recovers its signer', () => {
	const { issuerKey, account, prefix } = fixture();
	const core = buildAttestation({ account, pattern: { prefix }, format: 'eoa', attempts: 4242 });
	const signed = signAttestation({ core, signingKey: issuerKey });

	assert.equal(signed.issuer, eip55Checksum(addressFromPrivateKey(issuerKey)));
	assert.equal(recoverIssuer(signed), signed.issuer);
	assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
	// v must be 27 or 28, which is what ecrecover accepts.
	const v = parseInt(signed.signature.slice(-2), 16);
	assert.ok(v === 27 || v === 28, `v was ${v}`);

	const result = verifyAttestation(signed, { issuers: [signed.issuer] });
	assert.equal(result.valid, true, JSON.stringify(result.checks.filter((c) => !c.pass)));
});

test('the EIP-712 constants are stable', () => {
	// A Solidity verifier hardcodes these. If they change, every deployed
	// verifier silently stops recognising documents, so they are pinned here.
	assert.equal(ATTESTATION_TYPE, 'VanityAttestation(address account,string prefix,string suffix,bool caseSensitive,string format,uint256 expectedAttempts,uint256 attempts,bytes32 nonce,uint256 issuedAt,bytes32 nonCustodyHash)');
	assert.match(TYPE_HASH, /^0x[0-9a-f]{64}$/);
	assert.match(DOMAIN_SEPARATOR_HEX, /^0x[0-9a-f]{64}$/);
});

test('the digest changes when any attested field changes', () => {
	const { account, prefix } = fixture();
	const base = buildAttestation({ account, pattern: { prefix }, format: 'eoa', attempts: 10 });
	const digest = attestationDigest(base);
	for (const mutate of [
		(a) => ({ ...a, attempts: 11 }),
		(a) => ({ ...a, format: 'create2' }),
		(a) => ({ ...a, pattern: { ...a.pattern, caseSensitive: true } }),
		(a) => ({ ...a, difficulty: { ...a.difficulty, expectedAttempts: 1 } }),
		(a) => ({ ...a, freshness: { ...a.freshness, nonce: `0x${'11'.repeat(32)}` } }),
	]) {
		assert.notDeepEqual(attestationDigest(mutate(base)), digest);
	}
});

test('tampering with a signed document is caught', () => {
	const { issuerKey, account, prefix } = fixture();
	const signed = signAttestation({ core: buildAttestation({ account, pattern: { prefix }, format: 'eoa', attempts: 10 }), signingKey: issuerKey });

	for (const [label, tampered] of [
		['attempts', { ...signed, attempts: 999_999 }],
		['difficulty', { ...signed, difficulty: { ...signed.difficulty, expectedAttempts: 1 } }],
		['issuer', { ...signed, issuer: eip55Checksum(`0x${'11'.repeat(20)}`) }],
	]) {
		const result = verifyAttestation(tampered, { issuers: [signed.issuer] });
		assert.equal(result.valid, false, `${label} tampering was not caught`);
	}
});

test('an unpinned verification refuses to call a self-signed document valid', () => {
	const { issuerKey, account, prefix } = fixture();
	const signed = signAttestation({ core: buildAttestation({ account, pattern: { prefix }, format: 'eoa' }), signingKey: issuerKey });

	const unpinned = verifyAttestation(signed);
	assert.equal(unpinned.valid, false);
	const check = unpinned.checks.find((c) => c.id === 'issuerPinned');
	assert.equal(check.pass, false);
	assert.match(check.detail, /self-signed/);

	// A signer who is not on the list also fails, even though the signature is real.
	const wrongList = verifyAttestation(signed, { issuers: [eip55Checksum(`0x${'22'.repeat(20)}`)] });
	assert.equal(wrongList.valid, false);
});

test('an attestation cannot describe an address that does not match', () => {
	const { account } = fixture();
	const wrong = account[2].toLowerCase() === 'f' ? '0000' : 'ffff';
	assert.throws(() => buildAttestation({ account, pattern: { prefix: wrong }, format: 'eoa' }), /does not match/);
});

test('a split-key attestation must carry a non-custody claim that holds', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	const grinderPoint = offsetPoint(hit.offset);

	// Missing entirely.
	assert.throws(
		() => buildAttestation({ account: hit.addressChecksum, pattern: { prefix: 'a' }, format: 'split-key' }),
		/nonCustody/,
	);
	// Present but wrong: the two points do not sum to the address.
	const other = generateRequesterShare();
	assert.throws(
		() => buildAttestation({
			account: hit.addressChecksum,
			pattern: { prefix: 'a' },
			format: 'split-key',
			nonCustody: { requesterPoint: other.p1, grinderPoint },
		}),
		/does not equal the attested address/,
	);
	// Correct.
	const core = buildAttestation({
		account: hit.addressChecksum,
		pattern: { prefix: 'a' },
		format: 'split-key',
		nonCustody: { requesterPoint: share.p1, grinderPoint },
	});
	assert.equal(core.nonCustody.scheme, 'secp256k1-split-key/v1');
	assert.notDeepEqual(nonCustodyHash(core.nonCustody), new Uint8Array(32));
});

test('an attestation with no non-custody claim hashes to zero', () => {
	assert.deepEqual(nonCustodyHash(undefined), new Uint8Array(32));
	assert.deepEqual(nonCustodyHash({ requesterPoint: '0x04' }), new Uint8Array(32));
});
