// A token bucket. Every caller gets `capacity` tokens and earns `refillPerSecond` more.
export class Limiter {
  constructor(capacity = 20, refillPerSecond = 5) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.buckets = new Map();
  }
  take(key, now = Date.now()) {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond);
    bucket.at = now;
    if (bucket.tokens < 1) { this.buckets.set(key, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}
