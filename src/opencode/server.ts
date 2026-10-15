import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { opencode } from "./client.js";
import { findBinary } from "./binary.js";

let serverProcess: ChildProcess | null = null;

export async function startServer(): Promise<void> {
  if (await opencode.isHealthy()) {
    logger.info("OpenCode server already running");
    return;
  }

  const bin = findBinary();
  const port = new URL(config.opencode.apiUrl).port || "4096";

  logger.info("Starting OpenCode server", { bin, port });

  const args = ["serve", "--port", port];
  serverProcess = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(config.opencode.password ? { OPENCODE_SERVER_PASSWORD: config.opencode.password } : {}),
    },
    detached: false,
  });

  serverProcess.on("error", (err) => {
    logger.error("OpenCode server process error", { error: String(err) });
    serverProcess = null;
  });

  serverProcess.on("exit", (code) => {
    logger.warn("OpenCode server exited", { code: code ?? -1 });
    serverProcess = null;
  });

  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) logger.debug(`[opencode] ${line}`);
  });

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) logger.debug(`[opencode:err] ${line}`);
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await opencode.isHealthy()) {
      logger.info("OpenCode server is ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("OpenCode server failed to start within 15s");
}

export function stopServer(): void {
  if (serverProcess) {
    logger.info("Stopping OpenCode server");
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

export function isServerManaged(): boolean {
  return serverProcess !== null;
}
