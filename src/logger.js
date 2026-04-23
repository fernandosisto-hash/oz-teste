/**
 * Minimal zero-dependency structured logger.
 *
 * Emits one JSON object per line on stdout (or stderr for >= warn),
 * so it is machine-parseable out of the box and aggregators (stdout
 * collectors, k8s, Cloud Run, etc.) can ingest without a sidecar.
 *
 * Level is driven by `LOG_LEVEL` at call-time via `src/config.js` so
 * tests can adjust it dynamically without re-requiring the module.
 */

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold() {
  const raw = config.get('logLevel');
  return LEVELS[raw] ?? LEVELS.info;
}

function serialize(level, msg, meta) {
  const base = {
    level,
    time: new Date().toISOString(),
    msg,
  };
  if (meta && typeof meta === 'object') {
    Object.assign(base, meta);
  }
  try {
    return `${JSON.stringify(base)}\n`;
  } catch (_err) {
    // Fallback: meta had a circular/unserializable field.
    return `${JSON.stringify({
      level,
      time: base.time,
      msg,
      meta: '[unserializable]',
    })}\n`;
  }
}

function write(level, msg, meta) {
  if ((LEVELS[level] ?? LEVELS.info) < currentThreshold()) return;
  const line = serialize(level, msg, meta);
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(line);
}

module.exports = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  LEVELS,
};
