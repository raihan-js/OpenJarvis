import { homedir } from "node:os";
import { config } from "../config.js";

/** Path to the opencode binary (explicit config or the standard location). */
export function findBinary(): string {
  if (config.opencode.binPath) return config.opencode.binPath;
  const home = process.env["HOME"] ?? homedir();
  return `${home}/.opencode/bin/opencode`;
}
