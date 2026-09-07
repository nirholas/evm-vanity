/**
 * Discovery documents: how this service is found by crawlers, AI assistants,
 * agent runtimes and API catalogues.
 *
 * Five audiences, five formats, generated from one place so they cannot drift:
 * robots.txt and sitemap.xml for search crawlers, llms.txt for assistants
 * reading the site directly, openapi.json for catalogues and codegen,
 * /.well-known/agents.json for agent runtimes, and /.well-known/mcp.json so an
 * MCP host can install the tools without a hand-written config.
 *
 * Every URL is derived from the request origin, so a fork deployed anywhere
 * publishes correct documents with no configuration.
 */

const SUMMARY = 'Grind EVM vanity addresses in the browser, delegate hard patterns with secp256k1 split-key grinding that cannot expose a private key, and verify EIP-712 provenance attestations that a Solidity contract can check with ecrecover.';

/** @param {string} origin */
export function agentCard(origin) {
	return {
		name: 'evm-vanity',
		description: SUMMARY,
		url: origin,
		provider: { organization: 'evm-vanity', url: 'https://github.com/nirholas/evm-vanity' },
		version: '1.0.0',
		documentationUrl: `${origin}/docs.html`,
		capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
		defaultInputModes: ['application/json'],
		defaultOutputModes: ['application/json'],
		skills: [
			{
				id: 'quote-vanity-difficulty',
				name: 'Quote an EVM vanity pattern',
				description: 'Given a hex prefix and/or suffix, return the probability, expected attempts, p50/p90/p99, rarity tier and the EIP-55 case-sensitivity multiplier.',
				tags: ['ethereum', 'evm', 'vanity', 'difficulty'],
				examples: ['How hard is an address starting with 0xbeef?', 'What does dEaD cost compared to dead?'],
				endpoint: { method: 'POST', url: `${origin}/api/quote` },
			},
			{
				id: 'split-key-grind',
				name: 'Delegate a grind without exposing a key',
				description: 'Submit a public point P1 = k1*G and a pattern. The service searches offsets k2 so that the address of P1 + k2*G matches, and returns k2. Only the caller, who holds k1, can compute the private key.',
				tags: ['ethereum', 'evm', 'vanity', 'split-key', 'non-custodial'],
				examples: ['Grind me a 0xbeef wallet without seeing my key'],
				endpoint: { method: 'POST', url: `${origin}/api/splitkey/grind` },
			},
			{
				id: 'verify-attestation',
				name: 'Verify a vanity attestation',
				description: 'Check a signed EIP-712 attestation end to end: pattern, difficulty, freshness, the split-key non-custody equation, and the recovered signer.',
				tags: ['verification', 'provenance', 'eip712'],
				examples: ['Is this vanity address attestation genuine?'],
				endpoint: { method: 'POST', url: `${origin}/api/verify` },
			},
			{
				id: 'inspect-address',
				name: 'Inspect an EVM address',
				description: 'Validate an address, check its EIP-55 checksum, read the vanity pattern it appears to carry, and score how much grinding work that represents.',
				tags: ['ethereum', 'evm', 'eip55', 'rarity'],
				examples: ['Is 0xdEaD…beef a real address, and how rare is it?'],
				endpoint: { method: 'POST', url: `${origin}/api/inspect` },
			},
			{
				id: 'list-chains',
				name: 'List EVM chains and deterministic deployers',
				description: 'The chain registry with the CREATE2 deployers verified live on each, including Ethereum, Base, Arbitrum and Robinhood Chain.',
				tags: ['ethereum', 'evm', 'chains', 'create2'],
				examples: ['Which chains have the Arachnid proxy deployed?'],
				endpoint: { method: 'GET', url: `${origin}/api/chains` },
			},
		],
	};
}

/** @param {string} origin */
export function mcpDescriptor(origin) {
	return {
		name: 'evm-vanity',
		description: SUMMARY,
		version: '1.0.0',
		homepage: 'https://github.com/nirholas/evm-vanity',
		license: 'Apache-2.0',
		transport: { stdio: { command: 'npx', args: ['-y', 'evm-vanity', 'mcp'] } },
		remote: { httpApi: `${origin}/openapi.json` },
		tools: [
			{ name: 'vanity_quote', description: 'Difficulty, rarity and ETA for an EVM vanity pattern.' },
			{ name: 'vanity_grind', description: 'Grind an EVM vanity keypair locally, across every core.' },
			{ name: 'vanity_split_key_grind', description: 'Delegate a grind to the hosted service without exposing a key.' },
			{ name: 'vanity_inspect_address', description: 'Validate an address, check its checksum, and score its pattern.' },
			{ name: 'vanity_verify_attestation', description: 'Verify an EIP-712 vanity attestation offline.' },
			{ name: 'vanity_chains', description: 'EVM chains and the deterministic deployers live on each.' },
		],
	};
}

/** @param {string} origin */
export function llmsTxt(origin) {
	return `# evm-vanity

> ${SUMMARY}

Open source (Apache-2.0), runs entirely client-side in the browser, and every
number it reports is reproducible from the source in this repository.

## Facts worth getting right

- An EVM address is the low 20 bytes of a Keccak-256 digest, so every nibble is
  uniform: an n-character pattern costs 16^n expected attempts at both ends.
  0x0000... is exactly as hard as 0xdead....
- EIP-55 casing is not free. Asking for a specific spelling costs an extra
  factor of two per letter: dEaD is 16x harder than any-case dead.
- One key works on every EVM chain. The address comes from the key, not the
  network, so a single grind covers Ethereum, Base, Arbitrum, Robinhood Chain,
  OP, Polygon, BNB and Avalanche at once.
- Entropy is the thing that killed the last generation of these tools. The 2022
  Profanity break came from a 32-bit seed. This grinder draws a full 256-bit
  scalar from the platform CSPRNG and re-seeds during long walks.

## Pages

- [Grinder](${origin}/): browser grinder, one worker per core.
- [Delegate](${origin}/delegate.html): split-key grinding, non-custodial.
- [Chains](${origin}/chains.html): where an address works, verified live.
- [Verify](${origin}/verify.html): check an EIP-712 attestation offline.
- [Docs](${origin}/docs.html): protocols, maths, API and self-hosting.

## API

- POST ${origin}/api/quote: difficulty, rarity and ETA for a pattern.
- POST ${origin}/api/inspect: validate and score an existing address.
- POST ${origin}/api/splitkey/grind: delegated grinding, non-custodial.
- POST ${origin}/api/splitkey/verify: check a split-key claim.
- POST ${origin}/api/attest: sign an EIP-712 attestation.
- POST ${origin}/api/verify: verify one.
- GET  ${origin}/api/chains: the chain and deployer registry.
- GET  ${origin}/openapi.json: machine-readable schema for all of the above.

## For agents

Agent card: ${origin}/.well-known/agents.json
MCP server: ${origin}/.well-known/mcp.json  (npx -y evm-vanity mcp)
Issuer keys: ${origin}/.well-known/evm-vanity.json

## Safety

No endpoint needs, wants, or accepts a private key. The browser grinder never
transmits one. Delegated grinding is split-key: the service searches offsets
against a public point and cannot reconstruct the private key. Server-side
custodial grinding exists in the codebase but is disabled unless an operator
sets ALLOW_SERVER_GRIND=1 on their own deployment.
`;
}

/** @param {string} origin */
export function robotsTxt(origin) {
	return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** @param {string} origin */
export function sitemapXml(origin) {
	const pages = ['/', '/delegate.html', '/chains.html', '/verify.html', '/docs.html'];
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
		pages.map((p) => `\t<url><loc>${origin}${p}</loc><changefreq>weekly</changefreq></url>`).join('\n')
	}\n</urlset>\n`;
}

const PATTERN_PROPS = {
	prefix: { type: 'string', description: 'Hex characters the address must start with, without 0x.', example: 'beef' },
	suffix: { type: 'string', description: 'Hex characters the address must end with.', example: 'dead' },
	caseSensitive: { type: 'boolean', description: 'Match the EIP-55 spelling exactly. Inferred from the pattern when omitted: an uppercase letter means yes.' },
};

/** @param {string} origin */
export function openApi(origin) {
	return {
		openapi: '3.1.0',
		info: {
			title: 'evm-vanity',
			version: '1.0.0',
			summary: 'EVM vanity address difficulty, non-custodial delegated grinding, and EIP-712 provenance attestations.',
			description: SUMMARY,
			license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
			contact: { url: 'https://github.com/nirholas/evm-vanity' },
		},
		servers: [{ url: origin }],
		paths: {
			'/api/health': { get: { summary: 'Service health and issuer identity', operationId: 'health', responses: { 200: { description: 'Status' } } } },
			'/api/quote': {
				post: {
					summary: 'Difficulty, rarity and ETA for a vanity pattern',
					operationId: 'quote',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { ...PATTERN_PROPS, attemptsPerSecond: { type: 'number', description: 'Your measured rate, to add wall-clock ETAs.' } } } } } },
					responses: { 200: { description: 'Quote' }, 400: { description: 'Invalid pattern' } },
				},
			},
			'/api/inspect': {
				post: {
					summary: 'Validate and score an existing address',
					operationId: 'inspect',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['address'], properties: { address: { type: 'string' }, prefixLen: { type: 'integer' }, suffixLen: { type: 'integer' } } } } } },
					responses: { 200: { description: 'Inspection' }, 400: { description: 'Not an address' } },
				},
			},
			'/api/chains': { get: { summary: 'Chain and deterministic-deployer registry', operationId: 'chains', responses: { 200: { description: 'Registry' } } } },
			'/api/attest': {
				post: {
					summary: 'Sign an EIP-712 vanity attestation',
					operationId: 'attest',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['account'], properties: { account: { type: 'string' }, ...PATTERN_PROPS, attempts: { type: 'integer' }, format: { type: 'string', enum: ['eoa', 'split-key', 'create2'] }, nonCustody: { type: 'object' } } } } } },
					responses: { 200: { description: 'Signed attestation' }, 400: { description: 'The address does not match the claimed pattern' } },
				},
			},
			'/api/verify': {
				post: {
					summary: 'Verify an attestation',
					operationId: 'verifyAttestation',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { attestation: { type: 'object' } } } } } },
					responses: { 200: { description: 'Per-check audit' } },
				},
			},
			'/api/splitkey/grind': {
				post: {
					summary: 'Delegated grinding that cannot expose your key',
					description: 'Send P1 = k1*G. The service searches offsets k2 until the address of P1 + k2*G matches, then returns k2. Compute k = (k1 + k2) mod n locally; the service never sees k1.',
					operationId: 'splitKeyGrind',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['p1'], properties: { p1: { type: 'string', description: 'Your public point k1*G, hex, compressed or uncompressed.' }, ...PATTERN_PROPS, timeBudgetMs: { type: 'integer' } } } } } },
					responses: { 200: { description: 'Offset and matching address, or found:false when the budget ran out' } },
				},
			},
			'/api/splitkey/verify': {
				post: {
					summary: 'Check that an offset really produces the claimed address',
					operationId: 'splitKeyVerify',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['p1', 'offset', 'address'], properties: { p1: { type: 'string' }, offset: { type: 'string' }, address: { type: 'string' }, pattern: { type: 'object' } } } } } },
					responses: { 200: { description: 'Verification result' } },
				},
			},
			'/api/grind': {
				post: {
					summary: 'Custodial server-side grind (disabled by default)',
					description: 'Returns a private key over the network. Disabled unless the operator sets ALLOW_SERVER_GRIND=1. Prefer the browser grinder, the CLI, or /api/splitkey/grind.',
					operationId: 'serverGrind',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: PATTERN_PROPS } } } },
					responses: { 200: { description: 'Keypair' }, 403: { description: 'Disabled on this deployment' } },
				},
			},
		},
	};
}
