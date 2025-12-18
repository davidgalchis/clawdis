import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

export type PendingRequest = {
  chatId: string;
  sessionId: string;
  surface: "telegram" | "whatsapp";
  startedAt: number;
  message?: string;
  cwd?: string;
};

const PENDING_FILE = "~/.clawdis/pending.json";

function getPendingPath(): string {
  return resolveUserPath(PENDING_FILE);
}

export function loadPending(): Record<string, PendingRequest> {
  const filePath = getPendingPath();
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as Record<string, PendingRequest>;
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

export function savePending(pending: Record<string, PendingRequest>): void {
  const filePath = getPendingPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(pending, null, 2));
}

export function addPending(request: PendingRequest): string {
  const pending = loadPending();
  const key = `${request.surface}:${request.chatId}`;
  pending[key] = request;
  savePending(pending);
  return key;
}

export function removePending(key: string): void {
  const pending = loadPending();
  delete pending[key];
  savePending(pending);
}

export function removePendingByChat(surface: string, chatId: string): void {
  const key = `${surface}:${chatId}`;
  removePending(key);
}

export function getPendingRequests(): PendingRequest[] {
  const pending = loadPending();
  return Object.values(pending);
}

/**
 * Check if a Claude session has a completed result
 */
export function checkSessionCompleted(
  sessionId: string,
  cwd?: string,
): { completed: boolean; result?: string } {
  // Claude stores sessions in ~/.claude/projects/<encoded-path>/<sessionId>.jsonl
  const claudeDir = resolveUserPath("~/.claude/projects");

  // Find the session file - it could be in any project folder
  let sessionFile: string | undefined;

  if (cwd) {
    // Try the specific project folder first
    const encodedCwd = cwd.replace(/\//g, "-").replace(/^-/, "-");
    const projectDir = path.join(claudeDir, encodedCwd);
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      sessionFile = candidate;
    }
  }

  // Search all project folders if not found
  if (!sessionFile && fs.existsSync(claudeDir)) {
    try {
      const projects = fs.readdirSync(claudeDir);
      for (const project of projects) {
        const candidate = path.join(claudeDir, project, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          sessionFile = candidate;
          break;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  if (!sessionFile) {
    return { completed: false };
  }

  // Read the session file and check for result
  try {
    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");

    // Look for result event (search from end)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as { type?: string; result?: string };
        if (evt.type === "result" && evt.result) {
          return { completed: true, result: evt.result };
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  } catch {
    // Ignore read errors
  }

  return { completed: false };
}

/**
 * Check if a Claude session file exists (regardless of completion status)
 */
export function sessionFileExists(sessionId: string, cwd?: string): boolean {
  const claudeDir = resolveUserPath("~/.claude/projects");

  if (cwd) {
    // Try the specific project folder first
    const encodedCwd = cwd.replace(/\//g, "-").replace(/^-/, "-");
    const projectDir = path.join(claudeDir, encodedCwd);
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return true;
    }
  }

  // Search all project folders if not found
  if (fs.existsSync(claudeDir)) {
    try {
      const projects = fs.readdirSync(claudeDir);
      for (const project of projects) {
        const candidate = path.join(claudeDir, project, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          return true;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
}
