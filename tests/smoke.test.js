import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../src/net/protocol.js';

test('protocol version is 2 (schema v2: rules/powerScale/roundAcc)', () => {
  assert.equal(PROTOCOL_VERSION, 2);
});
