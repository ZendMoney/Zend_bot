/**
 * Structured bot logging — every silent drop / error should go through here
 * so Railway always shows user id + reason.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).replace(/\n/g, ' ').slice(0, 200);
    parts.push(`${k}=${s.includes(' ') ? `"${s}"` : s}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

export function logInfo(tag: string, message: string, fields?: LogFields): void {
  console.log(`[${tag}] ${message}${formatFields(fields)}`);
}

export function logWarn(tag: string, message: string, fields?: LogFields): void {
  console.warn(`[${tag}] ${message}${formatFields(fields)}`);
}

export function logError(tag: string, message: string, err?: unknown, fields?: LogFields): void {
  const errMsg =
    err instanceof Error
      ? err.message
      : err != null
        ? String(err)
        : '';
  console.error(
    `[${tag}] ${message}${formatFields(fields)}${errMsg ? ` error="${errMsg.slice(0, 300)}"` : ''}`,
    err instanceof Error ? err.stack || err : err ?? ''
  );
}

/** Log a path that intentionally did not reply / finished early. */
export function logDrop(reason: string, fields?: LogFields): void {
  logWarn('Drop', reason, fields);
}

/** Install process-level handlers once (unhandled rejections / exceptions). */
let processHandlersInstalled = false;
export function installProcessErrorLogging(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on('unhandledRejection', (reason) => {
    logError('Process', 'unhandledRejection', reason);
  });

  process.on('uncaughtException', (err) => {
    logError('Process', 'uncaughtException', err);
  });
}
