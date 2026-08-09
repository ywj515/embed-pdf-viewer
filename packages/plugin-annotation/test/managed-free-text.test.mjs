import test from 'node:test';
import assert from 'node:assert/strict';

import { quantizeManagedFreeTextFontSize as quantize } from '../src/lib/managed-free-text.ts';

test('quantizes managed FreeText font sizes to deterministic half points', () => {
  // Positive .25 ties round upward to the next half point.
  assert.equal(quantize(17.8596), 18);
  assert.equal(quantize(17.74), 17.5);
  assert.equal(quantize(17.75), 18);
  assert.equal(quantize(18), 18);
  assert.equal(quantize(18.24), 18);
  assert.equal(quantize(18.26), 18.5);
});
