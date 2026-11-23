import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runReplays } from '../scripts/offload-replay.mjs';

describe('Ring 3 真实故障脱敏回放回归套件 (L2)', () => {
  it('全部真实故障回放夹具 100% 通过', () => {
    const res = runReplays();
    assert.equal(res.ok, true);
    assert.equal(res.total >= 5, true);
  });
});
