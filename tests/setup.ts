// @ts-expect-error bottleneck/light has no types
import Bottleneck from 'bottleneck/light.js';
import { vi } from 'vitest';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(() => ''),
}));

interface GroupInstance {
  instances: Record<string, unknown>;
  limiterOptions: { minTime?: number };
}

// Force bottleneck's per-group minTimes to 0 so tests do not wait on them.
const origKey = Bottleneck.Group.prototype.key;
Bottleneck.Group.prototype.key = function (this: GroupInstance, key = ''): unknown {
  this.limiterOptions.minTime = 0;

  return origKey.call(this, key);
};
