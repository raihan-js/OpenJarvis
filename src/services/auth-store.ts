import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export type UserRole = "owner" | "user";

interface AuthEntry {
  userId: number;
  username?: string;
  role: UserRole;
  grantedBy: number;
  grantedAt: number;
}

interface AuthData {
  users: AuthEntry[];
}

const dataDir = config.auth.dataDir;
const filePath = join(dataDir, "auth.json");

let cache: AuthData | null = null;

function load(): AuthData {
  if (cache) return cache;

  if (!existsSync(filePath)) {
    cache = { users: [] };
    return cache;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    cache = JSON.parse(raw) as AuthData;
    return cache;
  } catch (err) {
    logger.error("Failed to read auth store, starting fresh", { error: String(err) });
    cache = { users: [] };
    return cache;
  }
}

function save(data: AuthData): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  cache = data;
}

function seedFromEnv(): void {
  const data = load();
  const envUsers = config.telegram.allowedUsers;

  if (envUsers.length === 0) return;

  let changed = false;
  for (let i = 0; i < envUsers.length; i++) {
    const userId = envUsers[i]!;
    if (data.users.some((u) => u.userId === userId)) continue;

    data.users.push({
      userId,
      role: i === 0 ? "owner" : "user",
      grantedBy: userId,
      grantedAt: Date.now(),
    });
    changed = true;
    logger.info("Seeded user from env", { userId, role: i === 0 ? "owner" : "user" });
  }

  if (changed) save(data);
}

export function initAuthStore(): void {
  load();
  seedFromEnv();
}

export function isAuthorized(userId: number): boolean {
  return load().users.some((u) => u.userId === userId);
}

export function getRole(userId: number): UserRole | null {
  const entry = load().users.find((u) => u.userId === userId);
  return entry?.role ?? null;
}

export function isOwner(userId: number): boolean {
  return getRole(userId) === "owner";
}

export function getEntry(userId: number): AuthEntry | undefined {
  return load().users.find((u) => u.userId === userId);
}

export function getAllUsers(): AuthEntry[] {
  return [...load().users];
}

export function grantAccess(
  userId: number,
  role: UserRole,
  grantedBy: number,
  username?: string
): boolean {
  const data = load();

  const existing = data.users.find((u) => u.userId === userId);
  if (existing) {
    existing.role = role;
    existing.username = username;
    save(data);
    return true;
  }

  data.users.push({
    userId,
    username,
    role,
    grantedBy,
    grantedAt: Date.now(),
  });
  save(data);
  return true;
}

export function revokeAccess(userId: number): boolean {
  const data = load();
  const idx = data.users.findIndex((u) => u.userId === userId);
  if (idx === -1) return false;

  if (data.users[idx]!.role === "owner") {
    const ownerCount = data.users.filter((u) => u.role === "owner").length;
    if (ownerCount <= 1) return false;
  }

  data.users.splice(idx, 1);
  save(data);
  return true;
}
