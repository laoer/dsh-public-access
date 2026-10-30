/**
 * Login throttling.
 *
 * A password form reachable from the network without any attempt limit is an
 * invitation to online guessing, and a per-address limit alone does not stop a
 * distributed attempt from a thousand addresses. Two layers, both in memory
 * (a restart clears them, which is acceptable: the cost of a reset is one
 * retry round, not a bypass):
 *
 * - per client address: {@link MAX_FAILURES} failures inside
 *   {@link FAILURE_WINDOW_MS} lock that address for {@link LOCKOUT_MS};
 * - global: once failures from all sources pass {@link GLOBAL_FREE_FAILURES}
 *   inside {@link GLOBAL_WINDOW_MS}, every *non-loopback* caller waits an
 *   exponentially growing penalty (doubling per {@link GLOBAL_STEP_FAILURES}),
 *   capped at {@link GLOBAL_MAX_MS}.
 *
 * A genuine loopback caller is exempt from the global penalty (but not from
 * its own per-address lockout) so a remote attacker cannot use the global
 * bucket to lock the administrator out of their own machine.
 *
 * `X-Forwarded-For` is deliberately not consulted: it is client-controlled and
 * would turn the limiter into a header-parsing guessing game. Behind a reverse
 * proxy every client shares the proxy's address, which makes the per-address
 * layer stricter than necessary but never weaker — raise `DSH_AUTH_MAX_FAILURES`
 * if that is the deployment shape.
 */

/** Failures per client address before a temporary lockout. */
export const MAX_FAILURES = 5
/** Sliding window for per-address failure counting. */
export const FAILURE_WINDOW_MS = 10 * 60_000
/** How long a locked-out address must wait. */
export const LOCKOUT_MS = 30_000
/** Global failures tolerated before the exponential penalty starts. */
export const GLOBAL_FREE_FAILURES = 20
/** Additional failures that double the global penalty. */
export const GLOBAL_STEP_FAILURES = 10
/** First global penalty step. */
export const GLOBAL_BASE_MS = 5_000
/** Upper bound of the global penalty. */
export const GLOBAL_MAX_MS = 5 * 60_000
/** Window used to count global failures. */
export const GLOBAL_WINDOW_MS = 60 * 60_000

/** One client address's failure record. */
interface ClientFailure {
  /** Failure timestamps inside the current window, oldest first. */
  stamps: number[]
  /** Wall-clock time the address is locked until (0 = not locked). */
  lockedUntil: number
}

/** Outcome of a pre-login rate-limit check. */
export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: 'client' | 'global' }

/** Read the client address of a request. */
export function clientIp(req: any): string {
  const address = req?.socket?.remoteAddress
  return typeof address === 'string' && address !== '' ? address : 'unknown'
}

/** Whether the request's transport peer is loopback. */
export function isLoopbackRequest(req: any): boolean {
  const ip = clientIp(req)
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')
}

/**
 * A bounded, self-pruning login limiter.
 *
 * The default instance is {@link loginRateLimiter}; tests construct their own
 * with a controllable clock.
 */
export class LoginRateLimiter {
  private readonly clients = new Map<string, ClientFailure>()
  /** Global failure timestamps inside the global window, oldest first. */
  private globalStamps: number[] = []
  private readonly now: () => number
  private readonly maxFailures: number
  private readonly maxClients: number

  /**
   * @param options clock and policy overrides (tests).
   */
  constructor(options: { now?: () => number; maxFailures?: number; maxClients?: number } = {}) {
    this.now = options.now ?? Date.now
    this.maxFailures = options.maxFailures ?? MAX_FAILURES
    this.maxClients = options.maxClients ?? 10_000
  }

  /**
   * Decide whether a login attempt may proceed.
   * @param req incoming request (only its socket is read).
   * @returns allowed, or how long the caller must wait.
   */
  check(req: any): RateLimitVerdict {
    const now = this.now()
    this.prune(now)
    const ip = clientIp(req)
    const record = this.clients.get(ip)
    if (record !== undefined && record.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)),
        scope: 'client'
      }
    }
    if (!isLoopbackRequest(req)) {
      const penalty = this.globalPenalty(now)
      if (penalty > 0) {
        const last = this.globalStamps[this.globalStamps.length - 1] ?? now
        const remaining = last + penalty - now
        if (remaining > 0) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
            scope: 'global'
          }
        }
      }
    }
    return { allowed: true }
  }

  /**
   * Record a failed attempt for a request.
   * @param req incoming request.
   */
  recordFailure(req: any): void {
    const now = this.now()
    const ip = clientIp(req)
    let record = this.clients.get(ip)
    if (record === undefined) {
      // Bound the map: a distributed attempt must not grow it without limit.
      if (this.clients.size >= this.maxClients) this.evictOldest()
      record = { stamps: [], lockedUntil: 0 }
      this.clients.set(ip, record)
    }
    record.stamps.push(now)
    if (record.stamps.length >= this.maxFailures) {
      record.stamps = []
      record.lockedUntil = now + LOCKOUT_MS
    }
    this.globalStamps.push(now)
    this.prune(now)
  }

  /**
   * Clear a client's failure record after a successful login.
   * @param req incoming request.
   */
  recordSuccess(req: any): void {
    this.clients.delete(clientIp(req))
  }

  /** Current global penalty in milliseconds (0 when none applies). */
  private globalPenalty(now: number): number {
    const count = this.globalStamps.length
    if (count < GLOBAL_FREE_FAILURES) return 0
    const step = Math.floor((count - GLOBAL_FREE_FAILURES) / GLOBAL_STEP_FAILURES)
    return Math.min(GLOBAL_BASE_MS * 2 ** step, GLOBAL_MAX_MS)
  }

  /** Drop expired records and the map's oldest entries when oversized. */
  private prune(now: number): void {
    const floor = now - FAILURE_WINDOW_MS
    this.globalStamps = this.globalStamps.filter((stamp) => stamp >= now - GLOBAL_WINDOW_MS)
    for (const [ip, record] of this.clients) {
      record.stamps = record.stamps.filter((stamp) => stamp >= floor)
      if (record.stamps.length === 0 && record.lockedUntil <= now) this.clients.delete(ip)
    }
    while (this.clients.size > this.maxClients) this.evictOldest()
  }

  /** Remove one entry to keep the map bounded (Map iteration is insertion order). */
  private evictOldest(): void {
    const first = this.clients.keys().next()
    if (!first.done) this.clients.delete(first.value)
  }
}

/** Process-wide limiter used by the login route. */
export const loginRateLimiter = new LoginRateLimiter()
