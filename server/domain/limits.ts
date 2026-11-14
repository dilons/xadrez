// Limite de taxa por balde de fichas: `capacity` fichas de rajada, repostas a `perSecond` por segundo.

export class Bucket {
  private tokens: number;
  private last: number;
  readonly capacity: number;
  readonly perSecond: number;

  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, n = 1): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Cheio de novo: o balde pode ser descartado sem perder informação. */
  full(now: number): boolean {
    return this.tokens + ((now - this.last) / 1000) * this.perSecond >= this.capacity;
  }
}

/** Baldes por chave (por exemplo, por IP), com faxina dos que já encheram. */
export class KeyedBuckets {
  private map = new Map<string, Bucket>();
  readonly capacity: number;
  readonly perSecond: number;

  constructor(capacity: number, perSecond: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
  }

  take(key: string, now: number, n = 1): boolean {
    let b = this.map.get(key);
    if (!b) {
      b = new Bucket(this.capacity, this.perSecond, now);
      this.map.set(key, b);
    }
    return b.take(now, n);
  }

  sweep(now: number): void {
    for (const [k, b] of this.map) if (b.full(now)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}
