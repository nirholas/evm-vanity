/**
 * worker_threads entry for the multi-core EOA grinder.
 *
 * One curve walk per worker from its own CSPRNG draw. Progress is posted often
 * enough that the pool's aggregate rate is accurate, and the loop checks its
 * own message-free exit condition rarely enough not to slow down.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

import { eip55Checksum, addressMatchesPattern } from './address.js';

const Point = secp256k1.Point;
const G = Point.BASE;
const N = Point.Fn.ORDER;
const RESEED_INTERVAL = 1_000_000;
const PROGRESS_INTERVAL = 2048;

const pattern = workerData;

function scalarToBytes(value) {
	let v = ((value % N) + N) % N;
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

function randomScalar() {
	const wide = new Uint8Array(64);
	crypto.getRandomValues(wide);
	let n = 0n;
	for (const byte of wide) n = (n << 8n) | BigInt(byte);
	const s = n % N;
	return s === 0n ? 1n : s;
}

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
		const check = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(privateKey, false).subarray(1)).subarray(12))}`;
		if (check === address) {
			parentPort.postMessage({
				type: 'hit',
				address,
				addressChecksum: eip55Checksum(address),
				privateKey: `0x${bytesToHex(privateKey)}`,
				attempts,
			});
			break;
		}
		// A mismatch here means the running point drifted from the scalar, which
		// must never ship a key. Report it instead of emitting a broken wallet.
		parentPort.postMessage({ type: 'error', message: 'worker self-check failed: derived key does not control the matched address' });
		break;
	}

	if (attempts % PROGRESS_INTERVAL === 0) parentPort.postMessage({ type: 'progress', attempts });

	if (sinceReseed >= RESEED_INTERVAL) {
		sinceReseed = 0;
		k = randomScalar();
		P = G.multiply(k);
		continue;
	}

	P = P.add(G);
	k = (k + 1n) % N;
}
