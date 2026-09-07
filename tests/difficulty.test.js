/**
 * The difficulty model, pinned against first principles and against reality.
 * The claim being tested is that an EVM address is uniform in every nibble, and
 * that the only thing that changes the cost is EIP-55 casing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { probability, expectedAttempts, difficulty, rarity, normalizePattern, caseSensitivityCost, attemptsForConfidence } from '../src/difficulty.js';
import { addressFromPrivateKey, eip55Checksum, addressMatchesPattern, inspectAddress } from '../src/address.js';

test('every nibble is uniform: a prefix costs the same as a suffix', () => {
	assert.equal(expectedAttempts({ prefix: 'beef' }), 65536);
	assert.equal(expectedAttempts({ suffix: 'beef' }), 65536);
	assert.equal(expectedAttempts({ prefix: '0000' }), 65536);
	assert.equal(expectedAttempts({ prefix: 'be', suffix: 'ef' }), 65536);
});

test('each extra character is 16x', () => {
	for (let n = 1; n <= 6; n++) {
		assert.equal(expectedAttempts({ prefix: 'a'.repeat(n) }), Math.pow(16, n));
	}
});

test('EIP-55 casing costs 2x per letter, and nothing for digits', () => {
	assert.equal(caseSensitivityCost({ prefix: 'dEaD' }), 16);
	assert.equal(expectedAttempts({ prefix: 'dEaD' }), expectedAttempts({ prefix: 'dead' }) * 16);
	// Digits carry no case.
	assert.equal(caseSensitivityCost({ prefix: '1234', caseSensitive: true }), 1);
	// A lowercase pattern is case-insensitive unless the caller says otherwise.
	assert.equal(normalizePattern({ prefix: 'dead' }).caseSensitive, false);
	assert.equal(normalizePattern({ prefix: 'dEaD' }).caseSensitive, true);
});

test('an unreachable pattern is reported as impossible, not as cheap', () => {
	assert.equal(probability({ prefix: 'g' }), 0);
	assert.equal(expectedAttempts({ prefix: 'a'.repeat(41) }), Infinity);
	assert.equal(rarity({ prefix: 'a'.repeat(41) }).tier, 'mythic');
});

test('confidence percentiles bracket the mean the way a geometric process does', () => {
	const p = probability({ prefix: 'beef' });
	const d = difficulty({ prefix: 'beef' });
	// The median is below the mean, and p99 is well above it: the tail is the
	// number that matters when deciding whether to start a grind.
	assert.ok(d.p50 < d.expectedAttempts);
	assert.ok(d.p99 > d.expectedAttempts * 4);
	assert.ok(Math.abs(attemptsForConfidence(p, 0.5) - d.p50) < 1e-6);
	assert.throws(() => attemptsForConfidence(p, 1.5), RangeError);
});

test('real keypairs match the model', () => {
	// A one-nibble prefix should land about one time in sixteen. 3000 samples
	// separates that from any wrong model without making the suite slow.
	const SAMPLES = 3000;
	let hits = 0;
	for (let i = 0; i < SAMPLES; i++) {
		if (addressFromPrivateKey(secp256k1.utils.randomSecretKey())[2] === 'a') hits++;
	}
	const observed = hits / SAMPLES;
	const expected = 1 / 16;
	const stderr = Math.sqrt((expected * (1 - expected)) / SAMPLES);
	assert.ok(Math.abs(observed - expected) < 4 * stderr, `observed ${observed}, expected ${expected}`);
});

test('EIP-55 matches the reference vectors', () => {
	// From EIP-55 itself.
	for (const address of [
		'0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
		'0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
		'0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
		'0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
	]) {
		assert.equal(eip55Checksum(address.toLowerCase()), address);
		assert.equal(inspectAddress(address).checksummed, true);
	}
	// A mixed-case address that fails the checksum is a typo, and must be caught.
	const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
	assert.equal(inspectAddress(broken).valid, false);
});

test('matching respects the case mode', () => {
	const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
	assert.equal(addressMatchesPattern(address, { prefix: '5aae' }), true);
	assert.equal(addressMatchesPattern(address, { prefix: '5aAe', caseSensitive: true }), true);
	assert.equal(addressMatchesPattern(address, { prefix: '5AAE', caseSensitive: true }), false);
	assert.equal(addressMatchesPattern(address, { suffix: 'aed' }), true);
	assert.equal(addressMatchesPattern('not an address', { prefix: '5aae' }), false);
});
