/**
 * Chains page.
 *
 * Renders the registry, then re-verifies it: pressing the button makes your
 * browser call each chain's public RPC with `eth_getCode` and marks any row
 * where the repository disagrees with the chain. A table nobody can check is
 * just a claim.
 */

import { CHAINS, FACTORY_LABELS, probeFactories, addressUrl } from '../chains.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @type {Map<number, Awaited<ReturnType<typeof probeFactories>>>} */
const probed = new Map();

render();
renderFactories();

function render() {
	$('table').innerHTML = `
		<table class="api">
			<thead>
				<tr><th>Chain</th><th>Id</th><th>Deterministic deployers</th><th>Explorer</th></tr>
			</thead>
			<tbody>
				${CHAINS.map((chain) => {
					const result = probed.get(chain.id);
					const claimed = Object.keys(chain.factories).length;
					let cell = `${claimed} of 4`;
					if (result) {
						const mismatches = result.filter((r) => !r.agrees);
						const errors = result.filter((r) => r.actual === null);
						if (errors.length) {
							cell = `<span style="color:var(--warn-fg)">RPC unreachable</span>`;
						} else if (mismatches.length) {
							cell = `<span style="color:#f87171">${mismatches.length} row${mismatches.length === 1 ? '' : 's'} disagree</span>`;
						} else {
							cell = `<span style="color:#4ade80">${claimed} of 4, verified ✓</span>`;
						}
					}
					return `<tr>
						<td>${esc(chain.name)}${chain.testnet ? ' <span style="color:#666">(testnet)</span>' : ''}</td>
						<td><code>${chain.id}</code></td>
						<td>${cell}</td>
						<td><a href="${esc(chain.explorer)}" rel="noopener">${esc(new URL(chain.explorer).hostname)}</a></td>
					</tr>`;
				}).join('')}
			</tbody>
		</table>`;
}

function renderFactories() {
	$('factories').innerHTML = Object.entries(FACTORY_LABELS).map(([address, label]) => `
		<div class="kv">
			<span class="k">${esc(label)}</span>
			<span class="v mono" style="font-size:.7rem"><a href="${esc(addressUrl(1, address))}" rel="noopener">${esc(address)}</a></span>
		</div>`).join('') + `
		<p class="sub" style="margin-top:.8rem">
			A vanity <em>EOA</em> needs none of these: your key works on every chain by itself. They matter when you want a vanity
			<em>contract</em> address, where the address comes from a deployer, a salt and the init code rather than from a key.
		</p>`;
}

$('probe').addEventListener('click', async () => {
	const btn = $('probe');
	btn.disabled = true;
	let done = 0;
	for (const chain of CHAINS) {
		$('probe-status').textContent = `checking ${chain.name}… (${done}/${CHAINS.length})`;
		try {
			probed.set(chain.id, await probeFactories(chain, { timeoutMs: 12_000 }));
		} catch {
			probed.set(chain.id, Object.keys(FACTORY_LABELS).map((factory) => ({
				factory, label: FACTORY_LABELS[factory], claimed: !!chain.factories[factory], actual: null, agrees: false, error: 'unreachable',
			})));
		}
		done++;
		render();
	}
	const disagreeing = [...probed.values()].filter((rows) => rows.some((r) => !r.agrees && r.actual !== null)).length;
	$('probe-status').textContent = disagreeing
		? `${disagreeing} chain${disagreeing === 1 ? '' : 's'} disagree with this repository. Please open an issue.`
		: `all ${CHAINS.length} chains agree with this repository.`;
	btn.disabled = false;
});
