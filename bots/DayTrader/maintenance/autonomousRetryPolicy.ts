// DayTrader - Autonomous Repair Retry/Backoff Policy
//
// Technical failure from the autonomous development agent is never
// silently converted to human ownership: the issue stays owner_layer=
// 'development' and status='failed', with a bounded, exponentially growing
// backoff before the maintenance worker automatically reopens/retries it.
// Pure and dependency-free so the policy itself is trivially testable.

const BASE_BACKOFF_MS = 5 * 60_000; // 5 minutes
const MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6 hours

/**
 * Exponential backoff bounded by MAX_BACKOFF_MS, keyed off how many attempts
 * this issue has accumulated so far (issues.attempts, incremented once per
 * repair attempt). Never returns 0/negative, and never grows unbounded -
 * an issue that keeps failing is retried forever, just increasingly slowly,
 * rather than ever being handed to a human for a purely technical reason.
 */
export function computeAutonomousBackoffMs(attempts: number): number {
    const bounded = Math.max(1, attempts);
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, bounded - 1), MAX_BACKOFF_MS);
}

export function computeNextRetryAt(attempts: number, now: number = Date.now()): number {
    return now + computeAutonomousBackoffMs(attempts);
}
