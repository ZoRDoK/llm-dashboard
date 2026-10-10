/**
 * Pino root logger.
 *
 * One root logger writes JSON lines to stdout; the destination is synchronous
 * so a line logged right before process.exit still reaches journald. Each
 * module takes a child logger via createLogger() whose `name` field names the
 * component, keeping lines greppable: journalctl --user -u ai-creds.service |
 * grep '"name":"manager"'.
 */
import { pino } from 'pino';

import { config } from './config.js';

const root = pino(
  {
    level: config.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
  },
  pino.destination({ dest: 1, sync: true }),
);

/** Component logger; `name` is the journald-greppable component id. */
export function createLogger(name: string): pino.Logger {
  return root.child({ name });
}
