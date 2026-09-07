/**
 * EVM EOA vanity grinder — main-thread API.
 *
 * Spawns a pool of Web Workers (one per logical core, capped) that race to
 * find a secp256k1 keypair whose Ethereum address matches the requested hex
 * prefix and/or suffix. First match wins; the rest are terminated.
 *
 * Usage:
 *   const { address, addressChecksum, privateKey, attempts, durationMs } =
 *     await grindEoaVanity({
 *       prefix: 'dead',
 *       onProgress: ({ attempts, rate, eta }) => updateUI(...),
 *       controller,                 // opt-in pause/resume/stop handle
 *       signal,
 *     });
 *
 * The returned `privateKey` is a 0x-prefixed 32-byte hex string — drop it
 * straight into MetaMask, ethers `new Wallet(privateKey)`, or viem
 * `privateKeyToAccount(privateKey)`. Everything happens in the browser; the
 * key is never transmitted anywhere.
 *
 * Casing of the pattern selects the matching mode (see validation.js):
 *   • all lowercase → case-insensitive match (fastest).
 *   • any uppercase → EIP-55 checksum match (~2× per letter, +1 keccak).
 */

import {
	validatePattern,
	estimateAttempts,
	formatTimeEstimate,
	letterCount,
	eip55Checksum,
} from './validation.js';

const DEFAULT_MAX_WORKERS = 8;

/**
 * @typedef {object} GrindOptions
 * @property {string} [prefix]              - Hex prefix (without 0x).
 * @property {string} [suffix]              - Hex suffix (without 0x).
 * @property {number} [maxWorkers]          - 1..hardwareConcurrency. Defaults to min(cores, 8).
 * @property {AbortSignal} [signal]         - Cancel the grind.
 * @property {GrindController} [controller] - Opt-in pause/resume/stop handle.
 * @property {(p: { attempts: number, rate: number, eta: string, sample?: string, paused?: boolean }) => void} [onProgress]
 */

/**
 * @typedef {object} GrindController
 * Pass a plain object as `opts.controller`; the methods are attached once the
 * worker pool is live. Pausing exits each worker's hot loop (cores are freed)
 * while preserving accumulated attempts so resume picks up where it left off.
 * @property {() => void} [pause]
 * @property {() => void} [resume]
 * @property {() => void} [stop]
 * @property {boolean} [paused]
 * @property {number} [workers]
 */

/**
 * @typedef {object} GrindResult
 * @property {string} address          - 0x… lowercase address.
 * @property {string} addressChecksum  - 0x… EIP-55 checksummed address.
 * @property {string} privateKey       - 0x… 32-byte private key.
 * @property {boolean} caseSensitive
 * @property {number} attempts
 * @property {number} durationMs
 * @property {number} workers
 */

/**
 * @param {GrindOptions} opts
 * @returns {Promise<GrindResult>}
 */
export function grindEoaVanity(opts = {}) {
	const { prefix = '', suffix = '', signal, onProgress } = opts;

	if (!prefix && !suffix) {
		return Promise.reject(new Error('prefix or suffix is required'));
	}

	let normPrefix = '', normSuffix = '';
	let caseSensitive = false;
	if (prefix) {
		const v = validatePattern(prefix);
		if (!v.valid) return Promise.reject(new Error(`invalid prefix: ${v.errors.join('; ')}`));
		normPrefix = v.normalized;
		if (v.caseSensitive) caseSensitive = true;
	}
	if (suffix) {
		const v = validatePattern(suffix);
		if (!v.valid) return Promise.reject(new Error(`invalid suffix: ${v.errors.join('; ')}`));
		normSuffix = v.normalized;
		if (v.caseSensitive) caseSensitive = true;
	}

	const hardware = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
	const requested = opts.maxWorkers || Math.min(hardware, DEFAULT_MAX_WORKERS);
	const cores = Math.max(1, Math.min(requested, hardware));

	const totalLetters = letterCount(normPrefix) + letterCount(normSuffix);
	const expected = estimateAttempts(normPrefix.length + normSuffix.length, totalLetters, caseSensitive);
	const startedAt = performance.now();

	/** @type {Worker[]} */
	const workers = [];
	const ratesByWorker = new Array(cores).fill(0);
	const attemptsByWorker = new Array(cores).fill(0);

	const stopAll = () => {
		for (const w of workers) {
			try { w.postMessage({ type: 'stop' }); } catch {}
			try { w.terminate(); } catch {}
		}
		workers.length = 0;
	};

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			stopAll();
			reject(new DOMException('vanity grind aborted', 'AbortError'));
		};
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
		}

		for (let idx = 0; idx < cores; idx++) {
			const w = new Worker(new URL('./eoa-grinder-worker.js', import.meta.url), { type: 'module' });
			workers.push(w);

			w.onmessage = (e) => {
				const msg = e.data;
				if (msg.type === 'match') {
					stopAll();
					if (signal) signal.removeEventListener('abort', onAbort);
					const totalAttempts = attemptsByWorker.reduce((a, b) => a + b, 0) + msg.attempts;
					// The worker already self-verifies the key against the address;
					// re-assert the shape here so a malformed message can never reach
					// the UI as a "wallet". privateKey is always a 0x 32-byte string.
					if (!/^0x[0-9a-f]{64}$/i.test(msg.privateKey || '') || !/^0x[0-9a-f]{40}$/i.test(msg.address || '')) {
						reject(new Error('vanity worker returned a malformed key'));
						return;
					}
					resolve({
						address:         msg.address,
						addressChecksum: msg.addressChecksum || ('0x' + eip55Checksum(msg.address.slice(2))),
						privateKey:      msg.privateKey,
						caseSensitive,
						attempts:        totalAttempts,
						durationMs:      performance.now() - startedAt,
						workers:         cores,
					});
				} else if (msg.type === 'progress') {
					attemptsByWorker[idx] = msg.attempts;
					ratesByWorker[idx] = msg.rate;
					if (onProgress) {
						const totalRate = ratesByWorker.reduce((a, b) => a + b, 0);
						const totalAttempts = attemptsByWorker.reduce((a, b) => a + b, 0);
						onProgress({
							attempts: totalAttempts,
							rate:     totalRate,
							eta:      formatTimeEstimate(Math.max(0, expected - totalAttempts), totalRate),
							sample:   msg.sample,
						});
					}
				} else if (msg.type === 'error') {
					stopAll();
					if (signal) signal.removeEventListener('abort', onAbort);
					reject(new Error(msg.message || 'vanity worker reported error'));
				}
			};

			w.onerror = (err) => {
				stopAll();
				if (signal) signal.removeEventListener('abort', onAbort);
				reject(err.error || new Error(err.message || 'vanity worker crashed'));
			};

			w.postMessage({ type: 'start', prefix: normPrefix, suffix: normSuffix, caseSensitive });
		}

		// Wire the opt-in controller now that the pool is live.
		const controller = opts.controller;
		if (controller) {
			controller.paused = false;
			controller.workers = cores;
			controller.pause = () => {
				if (controller.paused || workers.length === 0) return;
				controller.paused = true;
				for (const w of workers) {
					try { w.postMessage({ type: 'pause' }); } catch {}
				}
				if (onProgress) {
					const totalAttempts = attemptsByWorker.reduce((a, b) => a + b, 0);
					onProgress({ attempts: totalAttempts, rate: 0, eta: 'paused', paused: true });
				}
			};
			controller.resume = () => {
				if (!controller.paused || workers.length === 0) return;
				controller.paused = false;
				for (const w of workers) {
					try { w.postMessage({ type: 'resume' }); } catch {}
				}
			};
			controller.stop = onAbort;
		}
	});
}

export { validatePattern, estimateAttempts, formatTimeEstimate, letterCount, eip55Checksum };
