/**
 * The MCP server is how an assistant reaches this project, so its tool list and
 * shapes are a public contract. These tests drive it over a real stdio
 * transport, the way a host would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../mcp/index.js', import.meta.url));

/**
 * @template T
 * @param {(client: Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withClient(fn) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
	const client = new Client({ name: 'evm-vanity-tests', version: '1.0.0' });
	await client.connect(transport);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

/** @param {any} result @returns {any} */
const payload = (result) => JSON.parse(result.content[0].text);

test('the server exposes exactly the documented tools', async () => {
	const names = await withClient(async (client) => (await client.listTools()).tools.map((t) => t.name).sort());
	assert.deepEqual(names, [
		'vanity_chains',
		'vanity_grind',
		'vanity_inspect_address',
		'vanity_quote',
		'vanity_split_key_grind',
		'vanity_verify_attestation',
	]);
});

test('vanity_quote reports the case multiplier', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_quote', arguments: { prefix: 'dEaD', attemptsPerSecond: 17000 } }),
	));
	assert.equal(data.difficulty.caseCost, 16);
	assert.ok(data.difficulty.eta.p50Human);
	assert.ok(data.rarity.label);
});

test('vanity_grind returns a usable key', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_grind', arguments: { prefix: 'a' } }),
	));
	assert.match(data.privateKey, /^0x[0-9a-f]{64}$/);
	assert.ok(data.address.startsWith('0xa'));
});

test('vanity_inspect_address catches a broken checksum', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_inspect_address', arguments: { address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' } }),
	));
	assert.equal(data.checksum.valid, false);
});

test('vanity_chains includes Robinhood Chain', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_chains', arguments: {} }),
	));
	assert.ok(data.chains.some((c) => c.id === 4663));
	assert.equal(data.factories.length, 4);
});

test('a bad pattern comes back as a tool error, not a crash', async () => {
	const result = await withClient(async (client) => client.callTool({ name: 'vanity_quote', arguments: { prefix: 'zzzz' } }));
	assert.equal(result.isError, true);
	assert.match(payload(result).error, /invalid prefix/);
});
