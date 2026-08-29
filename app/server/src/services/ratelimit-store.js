// A shared counter store for express-rate-limit, kept in MongoDB.
//
// The default store is a Map in one process. That is not a rate limiter once a
// second task exists — it is two rate limiters, each with the full budget, and
// the failure is silent: nothing errors, the ceiling simply doubles. It also
// resets to zero on every deploy, which is the one moment an attacker most
// wants it to.
//
// This is deliberately not `rate-limit-mongo`: that package predates the v7
// Store interface, and the whole thing is one upsert.

import { models } from '../db/models.js';

const bucketId = (prefix, key, windowMs) =>
  `${prefix}:${Math.floor(Date.now() / windowMs)}:${key}`;

export class MongoRateLimitStore {
  constructor({ prefix = 'rl' } = {}) {
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const windowStart = Math.floor(Date.now() / this.windowMs) * this.windowMs;
    const resetTime = new Date(windowStart + this.windowMs);
    const _id = bucketId(this.prefix, key, this.windowMs);

    try {
      const row = await models.rateLimits.findOneAndUpdate(
        { _id },
        { $inc: { hits: 1 }, $setOnInsert: { expiresAt: resetTime } },
        { upsert: true, returnDocument: 'after', lean: true },
      );
      return { totalHits: row?.hits ?? 1, resetTime };
    } catch (err) {
      // A limiter that cannot reach its store must not take the route down with
      // it. Fail open, loudly — the alternative is a Mongo hiccup locking every
      // person out of the library at once.
      console.error('[ratelimit] store unreachable, allowing through:', err.message);
      return { totalHits: 1, resetTime };
    }
  }

  async decrement(key) {
    const _id = bucketId(this.prefix, key, this.windowMs);
    await models.rateLimits.updateOne({ _id }, { $inc: { hits: -1 } }).catch(() => null);
  }

  async resetKey(key) {
    const _id = bucketId(this.prefix, key, this.windowMs);
    await models.rateLimits.deleteOne({ _id }).catch(() => null);
  }

  async resetAll() {
    await models.rateLimits.deleteMany({ _id: new RegExp(`^${this.prefix}:`) }).catch(() => null);
  }
}

/** Rows the TTL monitor has not got to yet. Cheap, and keeps the collection small. */
export async function sweep() {
  const out = await models.rateLimits.deleteMany({ expiresAt: { $lt: new Date() } });
  return out.deletedCount ?? 0;
}
