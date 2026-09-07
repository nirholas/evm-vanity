/**
 * Grinder page controller.
 *
 * Owns the pattern inputs, the difficulty read-out, the core selector, the live
 * grind, and everything the page shows once a key exists. The grind itself runs
 * in `../eoa-grinder.js`, which races one Web Worker per selected core.
 *
 * The private key lives in this module's closure and nowhere else: no storage,
 * no request body, no console. It leaves the tab only through a download or a
 * clipboard copy the visitor asked for.
 */

import { grindEoaVanity } from '../eoa-grinder.js';
import { validatePattern, MAX_PATTERN_LENGTH } from '../validation.js';
import { PRESET_CHIPS } from '../wordlist.js';
import { difficulty, rarity, formatDuration, formatAttempts, normalizePattern } from '../difficulty.js';
import { setGrindActivity } from './activity.js';
import { mountHero } from './hero.js';

const $ = (id) => document.getElementById(id);
const HEX_ALPHA = '0123456789abcdef';

/**
 * The hero strip: a candidate address, one quad per character, driven by the
 * same pattern and rate as the read-outs beside it. The cells the pattern covers
 * hold the characters that were asked for; the rest churn at the measured attempt
 * rate and lock to the real address when one is found.
 */
const heroStrip = mountHero(document.getElementById('hero'), {
	alphabet: HEX_ALPHA,
	length: 40,
	accent: '#a78bfa',
	accentAlt: '#22d3ee',
});

/**
 * Order-of-magnitude hot-loop rate for one secp256k1 point addition plus a
 * keccak in a worker. Used only for the pre-grind estimate; the live rate the
 * grinder reports is the real one.
 */
const RATE_PER_CORE = 12_000;

// ── Core selection ───────────────────────────────────────────────────────────
const HW_CORES = Math.max(1, navigator.hardwareConcurrency || 4);
const DEFAULT_CORES = Math.max(1, Math.min(HW_CORES, Math.round(HW_CORES / 2) || 1));
let cores = DEFAULT_CORES;

const coreSlider = $('core-count');
coreSlider.max = String(HW_CORES);
coreSlider.value = String(DEFAULT_CORES);
$('core-max').textContent = HW_CORES;
$('core-count-val').textContent = DEFAULT_CORES;
$('cores2').textContent = DEFAULT_CORES;

const presetVals = [...new Set([1, DEFAULT_CORES, HW_CORES])].sort((a, b) => a - b);
const presetLabel = (n) => (n === 1 ? '1 core' : n === HW_CORES ? `Max (${n})` : `${n}`);
$('core-ticks').innerHTML = presetVals
	.map((n) => `<button type="button" data-cores="${n}" aria-pressed="${n === DEFAULT_CORES}">${presetLabel(n)}</button>`)
	.join('');

function setCores(n) {
	cores = Math.max(1, Math.min(HW_CORES, n | 0));
	coreSlider.value = String(cores);
	$('core-count-val').textContent = cores;
	$('cores2').textContent = cores;
	$('core-ticks').querySelectorAll('button').forEach((b) => {
		b.setAttribute('aria-pressed', String(Number(b.dataset.cores) === cores));
	});
	update();
}
coreSlider.addEventListener('input', () => setCores(Number(coreSlider.value)));
$('core-ticks').querySelectorAll('button').forEach((b) => {
	b.addEventListener('click', () => setCores(Number(b.dataset.cores)));
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function sample(prefix = '', suffix = '') {
	const fillLen = Math.max(0, 40 - prefix.length - suffix.length);
	let mid = '';
	for (let i = 0; i < fillLen; i++) mid += HEX_ALPHA[Math.floor(Math.random() * 16)];
	return prefix + mid + suffix;
}

function fmtTime(seconds) {
	if (!Number.isFinite(seconds)) return 'never';
	if (seconds < 1) return '<1s';
	if (seconds < 60) return `~${Math.round(seconds)}s`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)}h`;
	if (seconds < 31536000) return `~${Math.round(seconds / 86400)}d`;
	return '>1y';
}

function readPattern() {
	return {
		prefix: $('prefix').value.trim().replace(/^0x/i, ''),
		suffix: $('suffix').value.trim(),
	};
}

function patternValid(v) {
	if (!v) return true;
	if (v.length > MAX_PATTERN_LENGTH) return false;
	return /^[0-9a-fA-F]+$/.test(v);
}

/** Rate for the current pattern: EIP-55 mode pays an extra keccak per attempt. */
function estSeconds(prefix, suffix) {
	const p = normalizePattern({ prefix, suffix });
	if (p.length === 0) return 0;
	const d = difficulty({ prefix, suffix });
	const ratePerCore = p.caseSensitive ? RATE_PER_CORE * 0.7 : RATE_PER_CORE;
	return d.p50 / (ratePerCore * cores);
}

// ── Wordlist chips ───────────────────────────────────────────────────────────
const chipsEl = $('word-chips');
PRESET_CHIPS.forEach((w) => {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'preset';
	b.textContent = w;
	b.addEventListener('click', () => {
		$('prefix').value = w;
		$('prefix').dispatchEvent(new Event('input'));
		$('prefix').focus();
	});
	chipsEl.appendChild(b);
});

// ── Live preview and validation ──────────────────────────────────────────────
let previewLoop = null;
function startPreviewLoop() {
	stopPreviewLoop();
	previewLoop = setInterval(() => {
		const { prefix, suffix } = readPattern();
		if ($('prefix').classList.contains('invalid') || $('suffix').classList.contains('invalid')) return;
		const rest = $('preview').querySelector('.rest:last-of-type');
		if (rest && (prefix || suffix)) rest.textContent = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
	}, 700);
}
function stopPreviewLoop() {
	if (previewLoop) clearInterval(previewLoop);
	previewLoop = null;
}

function update() {
	const { prefix, suffix } = readPattern();
	const pOk = patternValid(prefix);
	const sOk = patternValid(suffix);
	$('prefix').classList.toggle('invalid', !pOk);
	$('suffix').classList.toggle('invalid', !sOk);

	const total = prefix.length + suffix.length;
	document.querySelectorAll('.meter .seg').forEach((seg, i) => {
		seg.className = 'seg' + (total > i ? ` lit-${Math.min(total, 6)}` : '');
	});

	const p = normalizePattern({ prefix, suffix });
	$('case-tag').innerHTML = total > 0 && pOk && sOk
		? (p.caseSensitive
			? `<span class="case-tag case-cs">EIP-55 checksum · ${p.letters ? `${Math.pow(2, p.letters)}x harder` : 'case-sensitive'}</span>`
			: '<span class="case-tag case-ci">case-insensitive</span>')
		: '';

	if (!total) {
		heroStrip.setPattern('', '');
		$('preview').innerHTML = `<span class="rest">0x</span><span class="rest">${esc(sample())}</span>`;
		$('est').textContent = 'type a pattern to see estimated time';
		$('grind').disabled = true;
		return;
	}
	if (!pOk || !sOk) {
		$('preview').textContent = `invalid: hex only (0-9, a-f), max ${MAX_PATTERN_LENGTH} characters each`;
		$('est').textContent = '';
		$('grind').disabled = true;
		return;
	}

	const mid = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
	$('preview').innerHTML =
		'<span class="rest">0x</span>' +
		(prefix ? `<span class="pfx">${esc(prefix)}</span>` : '') +
		`<span class="rest">${esc(mid)}</span>` +
		(suffix ? `<span class="sfx">${esc(suffix)}</span>` : '');

	heroStrip.setPattern(prefix, suffix);
	const d = difficulty({ prefix, suffix });
	const r = rarity({ prefix, suffix });
	$('est').textContent = `${formatAttempts(d.p50)} attempts for an even chance · ${fmtTime(estSeconds(prefix, suffix))} on ${cores} cores · ${r.label}`;
	$('grind').disabled = false;
}

$('prefix').addEventListener('input', update);
$('suffix').addEventListener('input', update);
[$('prefix'), $('suffix')].forEach((el) => el.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !$('grind').disabled) $('grind').click();
}));
update();
startPreviewLoop();

// ── Grind lifecycle ──────────────────────────────────────────────────────────
let abort = null;
let controls = null;
let scanLoop = null;

function setCoreControlsDisabled(disabled) {
	coreSlider.disabled = disabled;
	$('core-ticks').querySelectorAll('button').forEach((b) => { b.disabled = disabled; });
	$('prefix').disabled = disabled;
	$('suffix').disabled = disabled;
}

function setPaused(paused) {
	$('pause').textContent = paused ? 'Resume' : 'Pause';
	$('pause').classList.toggle('primary', paused);
	$('paused-tag').hidden = !paused;
	$('progress').classList.toggle('paused', paused);
	setGrindActivity(paused ? 0 : 1);
}

function endGrindUI() {
	if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	$('pause').hidden = true;
	$('stop').hidden = true;
	setPaused(false);
	setCoreControlsDisabled(false);
	setGrindActivity(0);
	heroStrip.setActivity(0);
}

function showError(message) {
	$('error').textContent = message;
	$('error').hidden = false;
}

$('grind').addEventListener('click', async () => {
	const { prefix, suffix } = readPattern();
	if (prefix) { const v = validatePattern(prefix); if (!v.valid) return showError(`invalid prefix: ${v.errors.join('; ')}`); }
	if (suffix) { const v = validatePattern(suffix); if (!v.valid) return showError(`invalid suffix: ${v.errors.join('; ')}`); }

	$('grind').hidden = true;
	$('pause').hidden = false;
	$('stop').hidden = false;
	setPaused(false);
	setCoreControlsDisabled(true);
	$('progress').hidden = false;
	$('result').hidden = true;
	$('error').hidden = true;
	$('attempts').textContent = '0';
	$('rate').textContent = '0/s';
	$('cores2').textContent = cores;
	$('eta').textContent = fmtTime(estSeconds(prefix, suffix));
	stopPreviewLoop();

	scanLoop = setInterval(() => {
		if (controls?.paused) return;
		const mid = sample('', suffix).slice(0, 40 - prefix.length - suffix.length);
		$('scan').innerHTML =
			'<span style="color:#555">0x</span>' +
			(prefix ? `<span class="pfx">${esc(prefix)}</span>` : '') +
			`<span style="color:#555">${esc(mid)}</span>` +
			(suffix ? `<span class="sfx">${esc(suffix)}</span>` : '');
	}, 100);

	abort = new AbortController();
	controls = {};
	heroStrip.reset();
	heroStrip.setPattern(prefix, suffix);
	try {
		const result = await grindEoaVanity({
			prefix: prefix || undefined,
			suffix: suffix || undefined,
			maxWorkers: cores,
			controller: controls,
			signal: abort.signal,
			onProgress: ({ attempts, rate, eta, paused }) => {
				$('attempts').textContent = attempts.toLocaleString();
				$('rate').textContent = paused ? 'paused' : `${Math.round(rate).toLocaleString()}/s`;
				$('eta').textContent = eta;
				const load = paused ? 0 : Math.min(1, rate / (RATE_PER_CORE * cores));
				setGrindActivity(load);
				heroStrip.setActivity(load);
			},
		});
		renderResult(result, prefix, suffix);
	} catch (err) {
		endGrindUI();
		if (err?.name !== 'AbortError') showError(`Grind failed: ${err.message || err}`);
		$('grind').hidden = false;
		$('progress').hidden = true;
		startPreviewLoop();
	} finally {
		controls = null;
		if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	}
});

$('pause').addEventListener('click', () => {
	if (!controls) return;
	if (controls.paused) { controls.resume(); setPaused(false); }
	else { controls.pause(); setPaused(true); }
});
$('stop').addEventListener('click', () => abort?.abort());

// ── Result and export ────────────────────────────────────────────────────────
function renderResult(result, prefix, suffix) {
	endGrindUI();
	$('grind').hidden = false;
	$('grind').textContent = 'Generate another';
	$('progress').hidden = true;

	const display = result.caseSensitive ? result.addressChecksum : result.address;
	const body = display.slice(2);
	// Highlight what the address actually contains: under a case-insensitive
	// grind the spelling differs from the pattern that was typed.
	const head = prefix ? `<span class="pfx">${esc(body.slice(0, prefix.length))}</span>` : '';
	const tail = suffix ? `<span class="sfx">${esc(body.slice(body.length - suffix.length))}</span>` : '';
	const midText = body.slice(prefix.length, body.length - suffix.length);
	const rate = Math.round(result.attempts / (result.durationMs / 1000));
	const r = rarity({ prefix, suffix });
	// The strip stops being a simulation the moment there is an answer.
	heroStrip.lock(display);
	$('hero-caption').textContent = `${display.slice(0, 8)}…${display.slice(-4)} · found in ${result.attempts.toLocaleString()} attempts`;

	$('result').hidden = false;
	$('result').innerHTML = `
		<div class="result">
			<h3>✦ Wallet ready</h3>
			<div class="out-row"><span class="k">Address</span><span class="v">0x${head}${esc(midText)}${tail}</span></div>
			<div class="meta">
				${result.attempts.toLocaleString()} attempts in ${(result.durationMs / 1000).toFixed(1)}s
				across ${result.workers} cores (${rate.toLocaleString()}/s) · <strong>${esc(r.label)}</strong>, score ${r.score}
			</div>

			<div class="export">
				<h4>Encrypted keystore (recommended)</h4>
				<p class="sub">Password-encrypted JSON (Web3 Secret Storage V3, scrypt + AES-128-CTR). Import into MetaMask with <em>Import account, JSON File</em>, or into Geth or Foundry.</p>
				<div class="pk-field">
					<input id="ks-pass" type="password" placeholder="Choose a strong password" autocomplete="new-password" />
					<button id="ks-download" class="btn primary" type="button" style="flex:none">⬇ Download keystore</button>
				</div>
				<div id="ks-status"></div>
			</div>

			<div class="export">
				<h4>Raw private key</h4>
				<p class="sub">For a quick MetaMask <em>Import account, Private Key</em>. Anyone with this string controls the wallet: never paste it into a website and never share it.</p>
				<div class="out-row"><span class="v pk-blur" id="pk-text"></span></div>
				<div class="actions" style="margin-top:.5rem">
					<button id="pk-reveal" class="btn" type="button">Reveal</button>
					<button id="pk-copy" class="btn" type="button">Copy private key</button>
					<button id="addr-copy" class="btn" type="button">Copy address</button>
					<button id="attest" class="btn" type="button">Get an attestation</button>
				</div>
				<div id="attest-host"></div>
			</div>

			<div class="warn">
				<strong>This page does not store your key.</strong>
				Download the encrypted keystore or copy the private key before you navigate away: once this tab closes, the key is gone.
				Anyone with the key (or the keystore and its password) can spend funds at this address.
			</div>

			<div class="export">
				<h4>Where this address works</h4>
				<p class="sub">
					Everywhere. The address is derived from the key, so it is identical on Ethereum, Base, Arbitrum, Robinhood Chain, OP, Polygon, BNB and
					Avalanche, and on every EVM chain that does not exist yet. <a href="/chains.html">See the list</a>.
				</p>
			</div>
		</div>
	`;

	// Inject the key as text, never through an HTML template, so the secret is
	// not concatenated into markup anywhere.
	$('pk-text').textContent = result.privateKey;

	$('ks-download').addEventListener('click', async () => {
		const pass = $('ks-pass').value;
		if (!pass || pass.length < 8) {
			$('ks-status').innerHTML = '<div class="error">Use a password of at least 8 characters.</div>';
			return;
		}
		const btn = $('ks-download');
		btn.disabled = true;
		$('ks-status').innerHTML = '<div class="ok" id="ks-prog">Encrypting… 0%</div>';
		try {
			// ethers is loaded only when a keystore is actually exported: the
			// grinder itself runs on @noble, so the page never pays for it up front.
			const { Wallet } = await import('ethers');
			const wallet = new Wallet(result.privateKey);
			const json = await wallet.encrypt(pass, (pct) => {
				const el = $('ks-prog');
				if (el) el.textContent = `Encrypting… ${Math.round(pct * 100)}%`;
			});
			download(`UTC--keystore--${result.address.slice(2, 10)}.json`, json);
			$('ks-status').innerHTML = '<div class="ok">Downloaded. Keep the file <em>and</em> the password safe: neither alone recovers the wallet.</div>';
		} catch (e) {
			$('ks-status').innerHTML = `<div class="error">Encryption failed: ${esc(e.message || e)}</div>`;
		} finally {
			btn.disabled = false;
		}
	});

	let revealed = false;
	$('pk-reveal').addEventListener('click', () => {
		revealed = !revealed;
		$('pk-text').classList.toggle('pk-blur', !revealed);
		$('pk-reveal').textContent = revealed ? 'Hide' : 'Reveal';
	});
	$('pk-copy').addEventListener('click', () => copy(result.privateKey, 'pk-copy', 'Copy private key'));
	$('addr-copy').addEventListener('click', () => copy(display, 'addr-copy', 'Copy address'));
	$('attest').addEventListener('click', () => requestAttestation({ result, prefix, suffix }));
}

/**
 * Ask the API to sign an EIP-712 attestation for this address.
 *
 * Only public values are sent: the address, the pattern and the attempt count.
 * The attestation is a statement about provenance that anyone (including a
 * Solidity contract) can verify; it says nothing about the private key, which
 * the service has never seen.
 * @param {{ result: any, prefix: string, suffix: string }} ctx
 */
async function requestAttestation({ result, prefix, suffix }) {
	const host = $('attest-host');
	const btn = $('attest');
	btn.disabled = true;
	host.innerHTML = '<div class="ok" style="margin-top:.6rem">requesting a signed attestation…</div>';
	try {
		const r = await fetch('/api/attest', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				account: result.addressChecksum || result.address,
				prefix,
				suffix,
				caseSensitive: result.caseSensitive,
				attempts: result.attempts,
				format: 'eoa',
			}),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		const blob = new Blob([JSON.stringify(data.attestation, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		host.innerHTML = `
			<div class="ok" style="margin-top:.6rem">
				Attestation signed by ${esc(data.attestation.issuer)}.
				<div class="actions" style="margin-top:.5rem">
					<a class="btn" href="${url}" download="${esc(result.address.slice(2, 10))}-attestation.json">⬇ Download</a>
					<a class="btn" href="/verify.html">Verify it →</a>
				</div>
			</div>`;
	} catch (e) {
		host.innerHTML = `<div class="error" style="margin-top:.6rem">Attestation unavailable: ${esc(e.message)}. Your wallet above is unaffected.</div>`;
		btn.disabled = false;
	}
}

/** @param {string} filename @param {string} contents */
function download(filename, contents) {
	const blob = new Blob([contents], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/** @param {string} text @param {string} btnId @param {string} restoreLabel */
async function copy(text, btnId, restoreLabel) {
	try {
		await navigator.clipboard.writeText(text);
		$(btnId).textContent = 'Copied!';
	} catch {
		$(btnId).textContent = 'Copy failed';
	}
	setTimeout(() => { $(btnId).textContent = restoreLabel; }, 1500);
}
