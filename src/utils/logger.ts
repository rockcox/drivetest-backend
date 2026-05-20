import winston from 'winston'
import { config } from '../config'

export const logger = winston.createLogger({
  level: config.app.isDev ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    config.app.isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
            return `${timestamp} [${level}] ${message}${metaStr}`
          })
        )
      : winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
})

export function childLogger(context: string, meta?: Record<string, unknown>) {
  return logger.child({ context, ...meta })
}
