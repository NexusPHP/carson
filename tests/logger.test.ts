import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger.js';
import type { Logger as PinoLogger } from 'pino';

const makeRootLog = (): PinoLogger => {
  const childMock = vi.fn();
  const root = { child: childMock } as unknown as PinoLogger;
  childMock.mockReturnValue(root);

  return root;
};

describe('logger', () => {
  beforeEach(() => {
    logger.reset();
  });

  it('throws when for() is called before init()', () => {
    expect(() => logger.for('carson')).toThrow('Logger has not been initialized');
  });

  it('returns a child logger tagged with the given name after init()', () => {
    const root = makeRootLog();
    logger.init(root);

    const child = logger.for('welcome');

    expect(child).toBe(root);
    expect(root.child).toHaveBeenCalledWith({ name: 'welcome' });
  });

  it('reset() restores the uninitialized state', () => {
    logger.init(makeRootLog());
    logger.reset();

    expect(() => logger.for('carson')).toThrow('Logger has not been initialized');
  });
});
