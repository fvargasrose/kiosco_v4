import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.LOG_FORMAT === 'pretty' && config.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
  base: { app: 'dentalkiosco-license-server' },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, remoteAddress: req.ip }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
});
