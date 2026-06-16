/** Throttle QVAC download/load progress to avoid Railway log rate limits (500/sec). */
export function createThrottledProgressLogger(
  label: string,
  stepPercent = 10
): (progress: { percentage?: number }) => void {
  let lastLogged = -Infinity;

  return (progress) => {
    if (progress.percentage === undefined) return;
    const pct = progress.percentage;
    const bucket = Math.floor(pct / stepPercent) * stepPercent;
    const shouldLog =
      pct >= 100 ||
      bucket > lastLogged ||
      lastLogged === -Infinity;

    if (!shouldLog) return;

    console.log(`[QVAC] ${label}: ${pct.toFixed(1)}%`);
    lastLogged = bucket;
  };
}