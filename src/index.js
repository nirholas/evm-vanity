/**
 * Public library entry point for evm-vanity.
 *
 * Address helpers are exported directly for the common case. Protocol and
 * metadata modules are namespaced to avoid collisions between shared helper
 * names while keeping the package root useful.
 */
export * from './address.js';
export * as attestation from './attestation.js';
export * as chains from './chains.js';
export * as difficulty from './difficulty.js';
export * as splitKey from './split-key.js';
export * as validation from './validation.js';
