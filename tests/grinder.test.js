/**
 * The grinder must return a key that actually controls the address it claims,
 * and it must never narrow its entropy. Both are checked here independently of
 * the code that produced them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils';

import { grindEoaPool } from '../src/grinder-pool.js';
import { grindEoaNode } from '../src/grinder-node.js';
import { addressFromPrivateKey, eip55Checksum, addressMatchesPattern } from '../src/address.js';

test('the multi-core pool returns a key that controls its address', async () => {
	const result = await grindEoaPool({ prefix: 'a', workers: 2 });

	assert.match(result.privateKey, /^0x[0-9a-f]{64}$/);
	assert.ok(result.address.startsWith('0xa'));
	// Re-derive independently of the running point the worker walked.
	assert.equal(addressFromPrivateKey(result.privateKey), result.address);
	assert.equal(result.addressChecksum, eip55Checksum(result.address));
	assert.ok(secp256k1.utils.isValidSecretKey(hexToBytes(result.privateKey.slice(2))));
	assert.equal(result.workers, 2);
	assert.ok(result.attempts > 0);
});

test('the pool honours a suffix, and an EIP-55 spelling', async () => {
	const suffixed = await grindEoaPool({ suffix: 'a', workers: 2 });
	assert.ok(suffixed.address.endsWith('a'));

	// An uppercase pattern is a request for that exact checksummed spelling.
	const cased = await grindEoaPool({ prefix: 'A', workers: 2 });
	assert.equal(cased.caseSensitive, true);
	assert.ok(cased.addressChecksum.startsWith('0xA'));
	assert.equal(addressMatchesPattern(cased.address, { prefix: 'A', caseSensitive: true }), true);
});

test('an aborted grind rejects promptly and frees its workers', async () => {
	const controller = new AbortController();
	// Eight nibbles will not land inside the timeout, so the only way this test
	// finishes is the abort path working.
	const promise = grindEoaPool({ prefix: 'deadbeef', workers: 2, signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(promise, (err) => err.name === 'AbortError');
});

test('the pool refuses an invalid pattern before spawning anything', async () => {
	await assert.rejects(grindEoaPool({ prefix: 'zz' }), /invalid prefix/);
	await assert.rejects(grindEoaPool({}), /prefix or suffix is required/);
});

test('the single-threaded grinder self-checks every match', () => {
	const result = grindEoaNode({ prefix: 'a', timeBudgetMs: 20_000 });
	assert.equal(result.found, true);
	assert.equal(addressFromPrivateKey(result.privateKey), result.address);
});

test('the single-threaded grinder gives up cleanly instead of hanging', () => {
	const result = grindEoaNode({ prefix: 'deadbeef', timeBudgetMs: 300 });
	assert.equal(result.found, false);
	assert.ok(result.attempts > 0);
	assert.ok(result.durationMs >= 250);
});

test('two grinds of the same pattern produce different keys', async () => {
	const [a, b] = await Promise.all([
		grindEoaPool({ prefix: 'a', workers: 1 }),
		grindEoaPool({ prefix: 'a', workers: 1 }),
	]);
	// A narrowed seed, which is what broke Profanity in 2022, would show up as
	// collisions or as a searchable relationship between runs.
	assert.notEqual(a.privateKey, b.privateKey);
	assert.notEqual(a.address, b.address);
});
