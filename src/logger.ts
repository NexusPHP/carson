// Module-level singleton that wraps probot's pino logger and hands out
// named child loggers. The child's `name` is what the pretty printer
// renders in the parens prefix, so `logger.for('welcome')` produces
// `INFO (welcome): ...` lines.

import type { Logger as PinoLogger } from 'pino';

class Logger {
  #root: PinoLogger | null = null;

  public init(root: PinoLogger): void {
    this.#root = root;
  }

  public reset(): void {
    this.#root = null;
  }

  public for(name: string): PinoLogger {
    if (this.#root === null) {
      throw new Error('Logger has not been initialized. Call logger.init(probot.log) first.');
    }

    return this.#root.child({ name });
  }
}

export const logger = new Logger();
