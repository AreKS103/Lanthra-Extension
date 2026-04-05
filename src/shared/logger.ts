// Structured logger for the content-script world.
// Prefix all output so it is easy to filter in DevTools.

const PREFIX = '[Lanthra]';

type Level = 'info' | 'warn' | 'error' | 'debug';

export function log(level: Level, msg: string, data?: unknown): void {
  if (data !== undefined) {
    console[level](PREFIX, msg, data);
  } else {
    console[level](PREFIX, msg);
  }
}
