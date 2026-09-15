import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/index.js';

test('package root exports the supported library surface', () => {
  assert.equal(typeof api.addressFromPrivateKey, 'function');
  assert.equal(typeof api.inspectAddress, 'function');
  assert.equal(typeof api.attestation.verifyAttestation, 'function');
  assert.equal(typeof api.chains.getChain, 'function');
  assert.equal(typeof api.difficulty.expectedAttempts, 'function');
  assert.equal(typeof api.splitKey.generateRequesterShare, 'function');
  assert.equal(typeof api.validation.validatePattern, 'function');
});
