/**
 * Split-key delegation page.
 *
 * The whole protocol, driven from the browser:
 *
 *   1. generate k1 (secret, stays in this closure) and P1 = k1·G (public);
 *   2. POST P1 and the pattern to /api/splitkey/grind, repeatedly, until the
 *      remote grinder reports a hit. Each request is time-boxed server-side, so
 *      a long search is many short requests rather than one held connection;
 *   3. combine k = (k1 + k2) mod n here;
 *   4. verify locally before showing anything, because a grinder that returns a
 *      wrong offset must fail visibly rather than silently.
 *
 * k1 is never stored, never sent, and dies with the tab.
 */

import {
	generateRequesterShare, combineScalars, verifySplitKeyClaim, offsetPoint,
} from '../split-key.js';
import { validatePattern, MAX_PATTERN_LENGTH } from '../validation.js';
import { difficulty, rarity, formatAttempts, normalizePattern } from '../difficulty.js';
import { setGrindActivity } from './activity.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The requester's share for this tab. Regenerated on demand, never persisted. */
let share = null;
let running = false;
let stopped = false;

$('gen').addEventListener('click', () => {
	share = generateRequesterShare();
	$('p1').textContent = `${share.p1.slice(0, 26)}…${share.p1.slice(-8)}`;
	$('p1').title = share.p1;
	$('k1').textContent = 'held in memory only, never sent, never stored';
	$('share').hidden = false;
	$('gen').textContent = 'Generate a new share';
	update();
});

['prefix', 'suffix'].forEach((id) => $(id).addEventListener('input', update));
update();

function readPattern() {
	return {
		prefix: $('prefix').value.trim().replace(/^0x/i, ''),
		suffix: $('suffix').value.trim(),
	};
}

function update() {
	const { prefix, suffix } = readPattern();
	const errors = [];
	for (const [side, value] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) errors.push(`${side}: ${v.errors.join('; ')}`);
	}
	$('prefix').classList.toggle('invalid', errors.some((e) => e.startsWith('prefix')));
	$('suffix').classList.toggle('invalid', errors.some((e) => e.startsWith('suffix')));

	const p = normalizePattern({ prefix, suffix });
	$('case-tag').innerHTML = p.length && !errors.length
		? (p.caseSensitive
			? '<span class="case-tag case-cs">EIP-55 checksum</span>'
			: '<span class="case-tag case-ci">case-insensitive</span>')
		: '';

	if (!p.length) {
		$('est').textContent = 'type a pattern to see what it costs';
		$('run').disabled = true;
		return;
	}
	if (errors.length) {
		$('est').textContent = errors.join('; ');
		$('run').disabled = true;
		return;
	}
	if (p.length > MAX_PATTERN_LENGTH) {
		$('est').textContent = `a pattern longer than ${MAX_PATTERN_LENGTH} characters per side is not realistic`;
		$('run').disabled = true;
		return;
	}

	// The remote grinder walks the curve one point addition at a time in pure
	// JavaScript. Saying so up front is the difference between a useful tool and
	// a progress bar that never moves.
	const d = difficulty({ prefix, suffix });
	const r = rarity({ prefix, suffix });
	$('est').textContent = `${formatAttempts(d.p50)} offsets for an even chance · ${r.label}`;
	if (!share) $('est').textContent = 'generate your secret share first';
	$('run').disabled = !share || running;
}

$('cancel').addEventListener('click', () => { stopped = true; });

$('run').addEventListener('click', async () => {
	if (!share || running) return;
	const pattern = readPattern();
	running = true;
	stopped = false;
	$('run').disabled = true;
	$('cancel').hidden = false;
	$('progress').hidden = false;
	$('out').hidden = true;
	$('err').hidden = true;
	setGrindActivity(1);

	let rounds = 0;
	let attempts = 0;
	try {
		for (;;) {
			if (stopped) throw new Error('stopped');
			rounds++;
			$('rounds').textContent = rounds.toLocaleString();

			const r = await fetch('/api/splitkey/grind', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ p1: share.p1, ...pattern, timeBudgetMs: 8000 }),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

			attempts += data.attempts || 0;
			$('attempts').textContent = attempts.toLocaleString();

			if (data.found) {
				finish(data, pattern, attempts, rounds);
				return;
			}
		}
	} catch (e) {
		if (e.message !== 'stopped') {
			$('err').textContent = `Delegation failed: ${e.message}`;
			$('err').hidden = false;
		}
	} finally {
		running = false;
		$('cancel').hidden = true;
		$('progress').hidden = true;
		setGrindActivity(0);
		update();
	}
});

/**
 * Combine locally, check the grinder told the truth, and render the wallet.
 * @param {any} data
 * @param {{ prefix: string, suffix: string }} pattern
 * @param {number} attempts
 * @param {number} rounds
 */
function finish(data, pattern, attempts, rounds) {
	// Never trust the offset: re-derive the address from P1 and the offset, and
	// confirm it matches both the claim and the requested pattern.
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern });
	if (!claim.ok) {
		$('err').textContent = `The grinder returned an offset that does not produce the address it claimed (${claim.reason}). Nothing was accepted.`;
		$('err').hidden = false;
		return;
	}

	const combined = combineScalars(share.k1, data.offset);
	if (combined.address.toLowerCase() !== data.address.toLowerCase()) {
		$('err').textContent = 'Local combination disagreed with the delegated address. Nothing was accepted.';
		$('err').hidden = false;
		return;
	}

	const display = combined.addressChecksum;
	const body = display.slice(2);
	const head = pattern.prefix ? `<span class="pfx">${esc(body.slice(0, pattern.prefix.length))}</span>` : '';
	const tail = pattern.suffix ? `<span class="sfx">${esc(body.slice(body.length - pattern.suffix.length))}</span>` : '';
	const mid = body.slice(pattern.prefix.length, body.length - pattern.suffix.length);
	const grinderPoint = offsetPoint(data.offset);

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result">
			<h3>✦ Wallet ready. The grinder never held this key</h3>
			<div class="out-row"><span class="k">Address</span><span class="v">0x${head}${esc(mid)}${tail}</span></div>
			<div class="meta">${attempts.toLocaleString()} offsets over ${rounds} request${rounds === 1 ? '' : 's'}, verified locally before it was shown</div>

			<div class="kv"><span class="k">P1 (yours, public)</span><span class="v mono" style="font-size:.66rem">${esc(share.p1.slice(0, 22))}…</span></div>
			<div class="kv"><span class="k">k2·G (grinder's, public)</span><span class="v mono" style="font-size:.66rem">${esc(grinderPoint.slice(0, 22))}…</span></div>
			<div class="kv"><span class="k">address(P1 + k2·G)</span><span class="v" style="color:#4ade80">= the address above ✓</span></div>

			<div class="export">
				<h4>Raw private key</h4>
				<p class="sub">An ordinary secp256k1 key. Import it into MetaMask, ethers, viem or Rabby exactly like one you generated yourself.</p>
				<div class="out-row"><span class="v pk-blur" id="pk-text"></span></div>
				<div class="actions" style="margin-top:.5rem">
					<button id="pk-reveal" class="btn" type="button">Reveal</button>
					<button id="pk-copy" class="btn" type="button">Copy private key</button>
					<button id="dl" class="btn" type="button">⬇ Download</button>
					${data.attestation ? '<a class="btn" id="dl-cert" href="#" download="attestation.json">⬇ Attestation</a><a class="btn" href="/verify.html">Verify it →</a>' : ''}
				</div>
			</div>

			<div class="warn">
				<strong>Save it before you navigate away.</strong> Nothing about this key exists outside this tab: not on the grinder, not on this server, not anywhere.
			</div>
		</div>`;

	$('pk-text').textContent = combined.privateKey;

	let revealed = false;
	$('pk-reveal').addEventListener('click', () => {
		revealed = !revealed;
		$('pk-text').classList.toggle('pk-blur', !revealed);
		$('pk-reveal').textContent = revealed ? 'Hide' : 'Reveal';
	});
	$('pk-copy').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(combined.privateKey);
			$('pk-copy').textContent = 'Copied!';
		} catch {
			$('pk-copy').textContent = 'Copy failed';
		}
		setTimeout(() => { $('pk-copy').textContent = 'Copy private key'; }, 1500);
	});
	$('dl').addEventListener('click', () => {
		const blob = new Blob([JSON.stringify({
			scheme: 'secp256k1-split-key/v1',
			address: combined.addressChecksum,
			privateKey: combined.privateKey,
			note: 'An ordinary secp256k1 private key. The remote grinder held only an offset, which is useless without the k1 this browser generated.',
		}, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${combined.address.slice(2, 10)}-wallet.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	});

	if (data.attestation && $('dl-cert')) {
		const blob = new Blob([JSON.stringify(data.attestation, null, 2)], { type: 'application/json' });
		$('dl-cert').href = URL.createObjectURL(blob);
		$('dl-cert').download = `${combined.address.slice(2, 10)}-attestation.json`;
	}
}
