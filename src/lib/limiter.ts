import { ApiError } from './errors.js';

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueued) throw new ApiError('SERVER_BUSY');
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await job();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  get stats() {
    return { active: this.active, queued: this.queue.length };
  }
}
