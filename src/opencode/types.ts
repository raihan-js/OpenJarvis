export interface OcSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  time: {
    created: number;
    updated: number;
  };
}

export interface OcMessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text" | "step-start" | "step-finish" | "tool" | "reasoning" | "snapshot" | "subtask";
  text?: string;
  snapshot?: string;
  tool?: string;
  callID?: string;
  state?: {
    status: "pending" | "running" | "completed" | "error";
    input?: unknown;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    error?: string;
    time?: { start: number; end: number };
  };
  reason?: string;
  cost?: number;
  tokens?: OcTokens;
  time?: { start: number; end: number };
}

export interface OcTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "system";
  time: { created: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  agent?: string;
  cost?: number;
  tokens?: OcTokens;
  finish?: string;
  path?: { cwd: string; root: string };
  summary?: { diffs: unknown[] };
  model?: { providerID: string; modelID: string };
}

export interface OcMessage {
  info: OcMessageInfo;
  parts: OcMessagePart[];
}

export interface OcProvider {
  id: string;
  source: string;
  name: string;
  env: string[];
  models: Record<string, OcModel>;
}

export interface OcModel {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  api?: { id: string; url: string; npm: string };
  limit?: { context: number; output: number };
  cost?: { input: number; output: number };
}

export interface OcConfig {
  $schema?: string;
  plugin?: string[];
  mcp?: Record<string, unknown>;
  lsp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  mode?: Record<string, unknown>;
  command?: Record<string, unknown>;
  default_agent?: string;
  tools?: Record<string, unknown>;
}

export interface OcProvidersResponse {
  providers: OcProvider[];
  default: Record<string, { model: string }>;
}

export interface OcSessionStatus {
  [sessionId: string]: { type: "busy" | "idle" | "completed" };
}

export interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
  sessionID?: string;
}

export interface OcMessagePartEvent extends OcEvent {
  type:
    | "message.updated"
    | "message.removed"
    | "message.part.updated"
    | "message.part.delta"
    | "message.part.removed";
  properties: {
    sessionID: string;
    messageID: string;
    part?: OcMessagePart;
    delta?: { type: "text"; content: string };
    info?: OcMessageInfo;
    [key: string]: unknown;
  };
}

export interface OcSessionEvent extends OcEvent {
  type:
    | "session.created"
    | "session.updated"
    | "session.deleted"
    | "session.status"
    | "session.error";
}
