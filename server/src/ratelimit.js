// Fixed-window rate limiter kept in memory.
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Returns true when the call is allowed. */
  take(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.sweep(now);
    return entry.count <= this.limit;
  }

  /** True when the key has already used up its allowance (does not count as a hit). */
  isLimited(key, now = Date.now()) {
    const entry = this.hits.get(key);
    return Boolean(entry && entry.reset > now && entry.count >= this.limit);
  }

  sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}
