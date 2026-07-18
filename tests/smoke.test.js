import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../src/net/protocol.js';

test('protocol version starts at 1', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});
