import { type ChildProcess, spawn } from "node:child_process";
import readline from "node:readline";

// Registry of running processes by chat ID for cancellation
const runningProcesses = new Map<string, ChildProcess>();

export type ClaudeCodeRunOptions = {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  onLine?: (line: string) => void;
  env?: Record<string, string>;
  /** Optional ID for tracking/cancellation (e.g., chat ID) */
  trackingId?: string;
};

/**
 * Cancel a running Claude process by its tracking ID.
 * Returns true if a process was found and killed.
 */
export function cancelClaudeProcess(trackingId: string): boolean {
  const proc = runningProcesses.get(trackingId);
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    // Give it a moment, then force kill if needed
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 2000);
    runningProcesses.delete(trackingId);
    return true;
  }
  return false;
}

/**
 * Check if there's a running process for the given tracking ID.
 */
export function hasRunningProcess(trackingId: string): boolean {
  const proc = runningProcesses.get(trackingId);
  return !!proc && !proc.killed;
}

export type ClaudeCodeResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
};

/**
 * Run Claude Code CLI directly via spawn.
 * Unlike Pi's RPC mode, Claude Code is invoked as a standard CLI process.
 */
export async function runClaudeCode(
  opts: ClaudeCodeRunOptions,
): Promise<ClaudeCodeResult> {
  const { argv, cwd, timeoutMs, onLine, env, trackingId } = opts;

  if (argv.length === 0) {
    throw new Error("Empty argv");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    // Register for cancellation if tracking ID provided
    if (trackingId) {
      runningProcesses.set(trackingId, child);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;

    // Stream stdout line by line
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      stdout += `${line}\n`;
      onLine?.(line);
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      rl.close();
      // Check if this was a cancellation
      if (trackingId) {
        cancelled = !runningProcesses.has(trackingId);
        runningProcesses.delete(trackingId);
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? 0,
        signal,
        killed: child.killed,
        timedOut,
        cancelled,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (trackingId) {
        runningProcesses.delete(trackingId);
      }
      reject(err);
    });

    // Close stdin immediately since we pass prompt via argv
    child.stdin.end();
  });
}

/**
 * Find the claude binary path
 */
export function findClaudeBinary(): string {
  // Default to 'claude' on PATH
  return "claude";
}
