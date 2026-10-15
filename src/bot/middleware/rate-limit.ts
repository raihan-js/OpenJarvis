import type { Context, NextFunction } from "grammy";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

const buckets = new Map<number, { count: number; windowStart: number }>();

export async function rateLimitMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const now = Date.now();
  let bucket = buckets.get(userId);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(userId, bucket);
  }

  bucket.count++;

  if (bucket.count > MAX_REQUESTS) {
    await ctx.reply("🐌 Too many requests. Slow down for a minute.");
    return;
  }

  await next();
}
