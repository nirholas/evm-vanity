/**
 * Attestation verification page.
 *
 * Verification happens entirely in this tab, against the issuer list published
 * by the service, not against the address the document names for itself, which
 * is the check a self-signed forgery would pass. If the list cannot be fetched
 * the page says so and marks the pin unavailable rather than passing quietly.
 */

import { verifyAttestation } from '../attestation.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @type {string[] | null} */
let issuers = null;
let issuerError = '';

loadIssuers();

async function loadIssuers() {
	try {
		const r = await fetch('/.well-known/evm-vanity.json');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		issuers = Array.isArray(data.issuers) ? data.issuers.map((i) => i.address) : null;
		if (!issuers?.length) throw new Error('no issuers published');
	} catch (e) {
		issuerError = e.message;
	}
}

$('file').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	$('cert').value = await file.text();
	verify();
});

$('verify').addEventListener('click', verify);

function verify() {
	$('err').hidden = true;
	$('out').hidden = true;

	let doc;
	try {
		doc = JSON.parse($('cert').value);
	} catch {
		$('err').textContent = 'That is not valid JSON. Paste the whole attestation, including the outer braces.';
		$('err').hidden = false;
		return;
	}
	if (doc && doc.attestation && typeof doc.attestation === 'object') doc = doc.attestation;

	render(verifyAttestation(doc, issuers ? { issuers } : {}));
}

/** @param {ReturnType<typeof verifyAttestation>} result */
function render(result) {
	const passed = result.checks.filter((c) => c.pass).length;
	const banner = result.valid
		? `<h3 style="color:#4ade80">✓ Valid: ${passed}/${result.checks.length} checks passed</h3>`
		: `<h3 style="color:#f87171">✗ Not valid: ${result.checks.length - passed} check${result.checks.length - passed === 1 ? '' : 's'} failed</h3>`;

	const note = issuers
		? ''
		: `<p class="sub" style="color:var(--warn-fg);margin-top:.7rem">
				The published issuer list could not be loaded${issuerError ? ` (${esc(issuerError)})` : ''}, so the signature was checked without a pin.
				That catches tampering but not a forged issuer: retry when the service is reachable.
			</p>`;

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result" style="border-color:${result.valid ? 'rgba(74,222,128,.3)' : 'rgba(248,113,113,.35)'};background:${result.valid ? 'rgba(74,222,128,.05)' : 'rgba(248,113,113,.05)'}">
			${banner}
			<div class="out-row"><span class="k">Account</span><span class="v">${esc(result.account || 'not present')}</span></div>
			<div class="out-row"><span class="k">Signer</span><span class="v">${esc(result.issuer || 'not recovered')}</span></div>
			${result.checks.map((c) => `
				<div class="kv">
					<span class="k">${c.pass ? '<span style="color:#4ade80">✓</span>' : '<span style="color:#f87171">✗</span>'} ${esc(c.label)}</span>
					<span class="v" style="font-weight:400;font-size:.75rem;color:#999;text-align:right;max-width:58%">${esc(c.detail)}</span>
				</div>`).join('')}
			${note}
		</div>`;
}
