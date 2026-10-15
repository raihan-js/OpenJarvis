import { logger } from "../utils/logger.js";
import { opencode } from "./client.js";
import type { OcEvent } from "./types.js";

type EventHandler = (event: OcEvent) => void;

class EventListener {
  private handlers = new Map<string, Set<EventHandler>>();
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastDataAt = 0;
  private bytesRead = 0;
  private eventsParsed = 0;

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => this.handlers.get(eventType)?.delete(handler);
  }

  onAny(handler: EventHandler): () => void {
    return this.on("*", handler);
  }

  async start(): Promise<void> {
    this.connect();
    // Watchdog: the stream should yield heartbeats every ~10s. If it goes
    // quiet for 45s the connection is dead but clean — force a reconnect
    // instead of hanging silently (which freezes live streaming).
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => {
        if (!this.abortController) return;
        const quietMs = Date.now() - this.lastDataAt;
        if (this.lastDataAt !== 0 && quietMs > 45_000) {
          logger.warn("SSE quiet too long, forcing reconnect", {
            quietMs,
            bytesRead: this.bytesRead,
            eventsParsed: this.eventsParsed,
          });
          this.abortController.abort();
        }
      }, 30_000);
      this.watchdogTimer.unref?.();
    }
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async connect(): Promise<void> {
    this.abortController = new AbortController();
    const url = opencode.eventStreamUrl;
    const headers = opencode.authHeaders;

    try {
      logger.debug("Connecting to SSE event stream");
      const res = await fetch(url, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }
      logger.info("SSE connected", { url });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      this.lastDataAt = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.lastDataAt = Date.now();
        this.bytesRead += value?.byteLength ?? 0;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6)) as OcEvent;
              this.eventsParsed++;
              this.emit(event);
            } catch {
              logger.debug("Failed to parse SSE event", { line });
            }
          }
        }
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) return;
      logger.warn("SSE connection lost", { error: String(err) });
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.abortController?.signal.aborted) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }

  private emit(event: OcEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try { handler(event); } catch (e) { logger.error("Event handler error", { error: String(e) }); }
      }
    }
    const anyHandlers = this.handlers.get("*");
    if (anyHandlers) {
      for (const handler of anyHandlers) {
        try { handler(event); } catch (e) { logger.error("Event handler error", { error: String(e) }); }
      }
    }
  }
}

export const events = new EventListener();
