/**
 * Sleep for a random duration between min and max milliseconds.
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Human-like click delay: 400–1200ms
 */
export const clickDelay = () => randomDelay(400, 1200)

/**
 * Human-like typing delay per character: 40–120ms
 */
export const typeDelay = () => randomDelay(40, 120)

/**
 * Between-location scan pause: 800–3000ms
 */
export const scanPause = () => randomDelay(800, 3000)

/**
 * Jittered next-scan interval in minutes → ms
 */
export function nextScanIntervalMs(minMinutes: number, maxMinutes: number): number {
  const baseMs = (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60_000
  const jitter = (Math.random() - 0.5) * 0.2 * baseMs  // ±10% jitter
  return Math.round(baseMs + jitter)
}

/**
 * Shuffle an array (Fisher-Yates)
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
