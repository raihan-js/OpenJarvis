import type { Context } from "grammy";
import { config } from "../../config.js";
import {
  isAuthorized,
  isOwner,
  getRole,
  getEntry,
  getAllUsers,
  grantAccess,
  revokeAccess,
} from "../../services/auth-store.js";
import { logger } from "../../utils/logger.js";
import { threadOf } from "../middleware/thread.js";

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map<number, { count: number; lastAttempt: number }>();

function checkBruteForce(userId: number): boolean {
  const record = failedAttempts.get(userId);
  if (!record) return false;
  if (record.count >= MAX_PIN_ATTEMPTS) {
    if (Date.now() - record.lastAttempt < LOCKOUT_MS) return true;
    failedAttempts.delete(userId);
  }
  return false;
}

function recordFailedAttempt(userId: number): void {
  const record = failedAttempts.get(userId) ?? { count: 0, lastAttempt: 0 };
  record.count++;
  record.lastAttempt = Date.now();
  failedAttempts.set(userId, record);
}

export async function authCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;

  if (isAuthorized(userId)) {
    await ctx.reply(`Already authenticated as *${getRole(userId)}*.`, { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
    return;
  }

  if (!config.auth.pin) {
    await ctx.reply("⛔ PIN auth is not configured. Contact the owner.", { message_thread_id: threadOf(ctx) });
    return;
  }

  if (checkBruteForce(userId)) {
    await ctx.reply("🔒 Too many failed attempts. Try again in 15 minutes.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const text = ctx.message?.text ?? "";
  const pin = text.split(/\s+/)[1];

  if (!pin) {
    await ctx.reply("Usage: /auth <PIN>", { message_thread_id: threadOf(ctx) });
    return;
  }

  if (pin !== config.auth.pin) {
    recordFailedAttempt(userId);
    const record = failedAttempts.get(userId)!;
    const remaining = MAX_PIN_ATTEMPTS - record.count;
    logger.warn("Failed PIN attempt", { userId, username: ctx.from?.username, remaining });
    await ctx.reply(`❌ Wrong PIN. ${remaining > 0 ? `${remaining} attempts left.` : "Locked for 15 minutes."}`, {
      message_thread_id: threadOf(ctx),
    });
    return;
  }

  failedAttempts.delete(userId);
  const hasAnyOwner = getAllUsers().some((u) => u.role === "owner");
  const role = hasAnyOwner ? "user" : "owner";

  grantAccess(userId, role, userId, ctx.from?.username);
  logger.info("User authenticated via PIN", { userId, username: ctx.from?.username, role });
  await ctx.reply(`✅ Authenticated as *${role}*. Use /help for commands.`, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
  });
}

export async function grantCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;

  if (!isOwner(userId)) {
    await ctx.reply("⛔ Only owners can use /grant.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const text = ctx.message?.text ?? "";
  const args = text.split(/\s+/).slice(1);
  const targetId = Number(args[0]);
  const role = (args[1] === "owner" ? "owner" : "user") as "owner" | "user";

  if (!targetId || isNaN(targetId)) {
    await ctx.reply("Usage: /grant <userId> [owner|user]", { message_thread_id: threadOf(ctx) });
    return;
  }

  grantAccess(targetId, role, userId);
  logger.info("Access granted", { targetId, role, grantedBy: userId });
  await ctx.reply(`✅ User \`${targetId}\` authorized as *${role}*.`, {
    parse_mode: "Markdown",
    message_thread_id: threadOf(ctx),
  });
}

export async function revokeCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;

  if (!isOwner(userId)) {
    await ctx.reply("⛔ Only owners can use /revoke.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const text = ctx.message?.text ?? "";
  const targetId = Number(text.split(/\s+/)[1]);

  if (!targetId || isNaN(targetId)) {
    await ctx.reply("Usage: /revoke <userId>", { message_thread_id: threadOf(ctx) });
    return;
  }

  if (targetId === userId) {
    await ctx.reply("❌ You cannot revoke your own access.", { message_thread_id: threadOf(ctx) });
    return;
  }

  const success = revokeAccess(targetId);
  if (success) {
    logger.info("Access revoked", { targetId, revokedBy: userId });
    await ctx.reply(`✅ Access revoked for \`${targetId}\`.`, {
      parse_mode: "Markdown",
      message_thread_id: threadOf(ctx),
    });
  } else {
    await ctx.reply("❌ User not found or is the last owner.", { message_thread_id: threadOf(ctx) });
  }
}

export async function whoamiCommand(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const entry = getEntry(userId);

  if (!entry) {
    await ctx.reply(`ID: \`${userId}\`\nStatus: not authorized`, {
      parse_mode: "Markdown",
      message_thread_id: threadOf(ctx),
    });
    return;
  }

  const lines = [
    `ID: \`${userId}\``,
    `Role: *${entry.role}*`,
    `Authorized by: \`${entry.grantedBy}\``,
    `Since: ${new Date(entry.grantedAt).toLocaleString("en-GB")}`,
  ];

  if (entry.role === "owner") {
    const users = getAllUsers();
    lines.push(`\nAuthorized users: ${users.length}`);
    for (const u of users) {
      const name = u.username ? `@${u.username}` : String(u.userId);
      lines.push(`  ${u.role === "owner" ? "👑" : "👤"} ${name} (\`${u.userId}\`)`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", message_thread_id: threadOf(ctx) });
}
