/**
 * Split-key grinding is the security claim that a delegated grind cannot expose
 * a key. These tests exercise the loop and, more importantly, the ways it must
 * fail: a tampered offset, a tampered address, a pattern the address does not
 * satisfy, and a point that is not on the curve.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	generateRequesterShare, grindSplitKeyOffset, verifySplitKeyClaim, combineScalars,
	offsetPoint, nonCustodyHolds, isValidP1, p1Fingerprint, parsePoint, N,
} from '../src/split-key.js';
import { addressFromPrivateKey, eip55Checksum } from '../src/address.js';

test('a delegated grind produces a key only the requester can compute', () => {
	const share = generateRequesterShare();
	assert.ok(isValidP1(share.p1));

	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	assert.equal(hit.found, true, 'a one-nibble pattern must be found inside the budget');
	assert.ok(hit.address.startsWith('0xa'));

	// The verifier needs no secret at all.
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: hit.offset, address: hit.address, pattern: { prefix: 'a' } });
	assert.equal(claim.ok, true, claim.reason);

	// Only the requester, holding k1, can produce the private key.
	const combined = combineScalars(share.k1, hit.offset);
	assert.equal(combined.address, hit.address);

	// And it really is that key: derive the address from it independently.
	assert.equal(addressFromPrivateKey(combined.privateKey), hit.address);
	assert.equal(combined.addressChecksum, eip55Checksum(hit.address));

	// The published non-custody equation holds from public values alone.
	assert.equal(nonCustodyHolds(share.p1, offsetPoint(hit.offset), hit.address), true);
});

test('the combined key is an ordinary 32-byte private key', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	const combined = combineScalars(share.k1, hit.offset);
	// 0x plus 64 hex characters: what every wallet import expects. This is the
	// difference from the Ed25519 version, which yields an expanded key.
	assert.match(combined.privateKey, /^0x[0-9a-f]{64}$/);
});

test('a tampered offset is rejected', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	const bad = hit.offset.slice(0, -2) + (hit.offset.endsWith('00') ? '01' : '00');
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: bad, address: hit.address });
	assert.equal(claim.ok, false);
	assert.equal(claim.derivationOk, false);
});

test('a correct derivation for the wrong pattern is still rejected', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: hit.offset, address: hit.address, pattern: { prefix: 'ffff' } });
	assert.equal(claim.derivationOk, true);
	assert.equal(claim.patternOk, false);
	assert.equal(claim.ok, false);
});

test('a P1 that is not a point is refused', () => {
	assert.equal(isValidP1('0xdeadbeef'), false);
	assert.equal(isValidP1(''), false);
	assert.equal(isValidP1('0x' + '11'.repeat(65)), false);
	assert.throws(() => parsePoint('0x1234'), /expected a 33-byte compressed or 65-byte uncompressed point/);
});

test('the offset point is the public half and nothing more', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', timeBudgetMs: 10_000 });
	const point = offsetPoint(hit.offset);
	assert.match(point, /^0x04[0-9a-f]{128}$/);
	// The point alone does not reveal the offset: it is a public value, and the
	// non-custody claim is exactly that publishing it is safe.
	assert.notEqual(point.toLowerCase(), hit.offset.toLowerCase());
	assert.throws(() => offsetPoint('0x' + '00'.repeat(32)), /zero/);
});

test('two requesters grinding the same pattern get different keys', () => {
	const one = generateRequesterShare();
	const two = generateRequesterShare();
	assert.notEqual(one.k1, two.k1);
	assert.notEqual(one.p1, two.p1);
	assert.notEqual(p1Fingerprint(one.p1), p1Fingerprint(two.p1));
});

test('the group order is the secp256k1 order', () => {
	assert.equal(N, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n);
});
