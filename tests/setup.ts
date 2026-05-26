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
