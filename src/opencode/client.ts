import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type {
  OcSession,
  OcMessage,
  OcProvidersResponse,
  OcConfig,
  OcSessionStatus,
} from "./types.js";

class OpenCodeClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor() {
    this.baseUrl = config.opencode.apiUrl;
    this.headers = { "Content-Type": "application/json" };
    if (config.opencode.password) {
      const encoded = Buffer.from(`opencode:${config.opencode.password}`).toString("base64");
      this.headers["Authorization"] = `Basic ${encoded}`;
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    logger.debug(`API ${init?.method ?? "GET"} ${path}`);
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers, ...init?.headers },
      // Never hang silently: busy sessions can stall prompt_async for minutes.
      signal: init?.signal ?? AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${res.status}: ${path} - ${body}`);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/session`, {
        headers: this.headers,
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Sessions
  /**
   * List sessions, optionally scoped to one project directory.
   *
   * Server fact (verified 2026-10-14): plain GET /session returns only the
   * serve daemon's current-project subset (4 of ~70 here) — NOT everything.
   * Always pass a directory for complete results.
   */
  async listSessions(directory?: string): Promise<OcSession[]> {
    const path = directory ? `/session?directory=${encodeURIComponent(directory)}` : "/session";
    return this.request<OcSession[]>(path);
  }

  /**
   * List sessions across all known project directories (union, deduped).
   * The plain list endpoint is project-scoped server-side, so a single call
   * silently hides most sessions — this is what made sessions "unfindable".
   */
  async listAllSessions(extraDirs: string[] = []): Promise<OcSession[]> {
    const dirs = new Set<string>(extraDirs);
    const base = config.opencode.defaultDir;
    dirs.add(base);
    const { homedir } = await import("node:os");
    dirs.add(homedir());
    try {
      const { readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".")) dirs.add(join(base, e.name));
      }
    } catch {
      // fall back to whatever dirs were given
    }
    const seen = new Map<string, OcSession>();
    await Promise.all(
      [...dirs].map(async (d) => {
        try {
          for (const s of await this.listSessions(d)) seen.set(s.id, s);
        } catch {
          // one bad dir must not kill the whole listing
        }
      }),
    );
    // Sessions outside every known dir (e.g. home, /tmp): also pull
    // the unfiltered list — it carries the daemon's current project subset.
    try {
      for (const s of await this.listSessions()) seen.set(s.id, s);
    } catch {
      // ignore
    }
    return [...seen.values()];
  }

  async getSession(sessionId: string): Promise<OcSession> {
    return this.request<OcSession>(`/session/${sessionId}`);
  }

  async createSession(directory?: string): Promise<OcSession> {
    return this.request<OcSession>("/session", {
      method: "POST",
      body: JSON.stringify(directory ? { directory } : {}),
    });
  }

  /**
   * Create a session for a project directory with phone approvals ON.
   *
   * Two hard server facts shape this (all verified by probing 2026-10-14):
   * - POST /session honors `permission` rules: bash/edit/write ask-rules make
   *   the server emit permission.asked, which the bot turns into Approve/Deny
   *   buttons. Without rules the server auto-allows everything silently.
   * - POST /session IGNORES directory/projectID: sessions land in the serve
   *   daemon's own directory. So the caller records the INTENDED project dir
   *   in the bot's project map, and a primer anchors the agent to it
   *   (absolute paths for all file work).
   */
  async createSessionInDir(
    directory: string,
    model?: { providerID: string; modelID: string },
  ): Promise<OcSession> {
    const rules = [
      { permission: "bash", action: "ask", pattern: "*" },
      { permission: "edit", action: "ask", pattern: "*" },
      { permission: "write", action: "ask", pattern: "*" },
    ];
    const session = await this.request<OcSession>("/session", {
      method: "POST",
      body: JSON.stringify({ permission: rules }),
    });
    logger.info("Created ask-mode session", { id: session.id, intendedDir: directory });
    // Primer: anchor the agent to the project dir (one tiny generation).
    // AWAITED: the primer's answer must complete before the session is
    // handed out, otherwise a first user prompt races it and reply
    // attribution can deliver the primer's answer to the user.
    const m = model ?? config.defaults.model;
    const createTs = Date.now();
    await this.sendMessageAsync(session.id,
      `You are working on the project at ${directory}. Use it as your working directory for all file operations (absolute paths, or cd there first). Reply with exactly: ready`,
      { model: m },
    );
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const messages = await this.getMessages(session.id);
        const done = messages.some(
          (mm) => mm.info.role === "assistant" && mm.info.time.created >= createTs && mm.info.time.completed != null,
        );
        if (done) break;
      } catch {
        // keep waiting
      }
    }
    return this.getSession(session.id).catch(() => session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<unknown>(`/session/${sessionId}`, { method: "DELETE" });
  }

  async getSessionStatus(): Promise<OcSessionStatus> {
    return this.request<OcSessionStatus>("/session/status");
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>(`/session/${sessionId}/abort`, { method: "POST" });
  }

  async forkSession(sessionId: string, messageId?: string): Promise<OcSession> {
    return this.request<OcSession>(`/session/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify(messageId ? { messageID: messageId } : {}),
    });
  }

  async shareSession(sessionId: string): Promise<{ url: string }> {
    return this.request<{ url: string }>(`/session/${sessionId}/share`, {
      method: "POST",
    });
  }

  async summarizeSession(sessionId: string): Promise<void> {
    await this.request<unknown>(`/session/${sessionId}/summarize`, { method: "POST" });
  }

  // Messages
  async getMessages(sessionId: string): Promise<OcMessage[]> {
    return this.request<OcMessage[]>(`/session/${sessionId}/message`);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: { model?: { providerID: string; modelID: string }; agent?: string }
  ): Promise<OcMessage> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
    };
    if (options?.model) body["model"] = options.model;
    if (options?.agent) body["agent"] = options.agent;

    return this.request<OcMessage>(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async sendMessageAsync(
    sessionId: string,
    text: string,
    options?: { model?: { providerID: string; modelID: string }; agent?: string }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
    };
    if (options?.model) body["model"] = options.model;
    if (options?.agent) body["agent"] = options.agent;

    await this.request<unknown>(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async replyPermission(sessionId: string, requestId: string, reply: "once" | "reject"): Promise<void> {
    // Verified live 2026-10-14: top-level route, 200 on real requests.
    // (The /api/session/... variant 404s with PermissionNotFoundError.)
    void sessionId;
    await this.request<unknown>(`/permission/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    await this.request<unknown>(`/question/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.request<unknown>(`/question/${requestId}/reject`, {
      method: "POST",
    });
  }

  async sendCommand(sessionId: string, command: string): Promise<void> {
    await this.request<unknown>(`/session/${sessionId}/command`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }

  async revertMessage(sessionId: string, messageId: string): Promise<void> {
    await this.request<unknown>(`/session/${sessionId}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageID: messageId }),
    });
  }

  // Config & Providers
  async getConfig(): Promise<OcConfig> {
    return this.request<OcConfig>("/config");
  }

  async getProviders(): Promise<OcProvidersResponse> {
    return this.request<OcProvidersResponse>("/config/providers");
  }

  // Event stream URL (for SSE)
  get eventStreamUrl(): string {
    return `${this.baseUrl}/event`;
  }

  get authHeaders(): Record<string, string> {
    return { ...this.headers };
  }
}

export const opencode = new OpenCodeClient();
