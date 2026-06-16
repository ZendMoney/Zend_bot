import path from 'path';

/** Absolute cache path — mount a Railway volume here (e.g. /data/qvac). */
const cacheDirectory = process.env.QVAC_MODEL_DIR?.trim() || '/data/qvac';

export default {
  cacheDirectory: path.isAbsolute(cacheDirectory)
    ? cacheDirectory
    : path.resolve(cacheDirectory),
  // Reduce sdk:server noise on Railway (progress still logged by our throttled helper)
  loggerLevel: 'warn',
  loggerConsoleOutput: true,
};