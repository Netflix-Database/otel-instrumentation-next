import type { Logger as PinoLogger } from 'pino';
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger: PinoLogger = isProd ? pino() : (pino.transport({ target: 'pino-pretty', options: { colorize: true } }) as unknown as PinoLogger);
