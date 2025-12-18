import path from "node:path";

import type {
  AgentMeta,
  AgentParseResult,
  AgentSpec,
  BuildArgsContext,
  PermissionMode,
} from "./types.js";
import { normalizeUsage } from "./usage.js";

/**
 * Claude Code JSON output structure (--output-format json)
 */
type ClaudeCodeResult = {
  type: "result";
  subtype?: "success" | "error";
  is_error?: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
};

/**
 * Claude Code stream-json assistant message
 */
type ClaudeCodeAssistantEvent = {
  type: "assistant";
  message: {
    model?: string;
    role: "assistant";
    content: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
};

/**
 * Claude Code stream-json system init event
 */
type ClaudeCodeSystemEvent = {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
};

type ClaudeCodeEvent =
  | ClaudeCodeResult
  | ClaudeCodeAssistantEvent
  | ClaudeCodeSystemEvent;

function isClaudeCodeInvocation(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const base = path.basename(argv[0]).replace(/\.(m?js)$/i, "");
  return base === "claude" || base === "claude-code";
}

function parseClaudeCodeOutput(raw: string): AgentParseResult {
  const lines = raw.split(/\n+/).filter((l) => l.trim().startsWith("{"));

  const texts: string[] = [];
  let meta: AgentMeta | undefined;
  let sessionId: string | undefined;
  let lastModel: string | undefined;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as ClaudeCodeEvent;

      // Handle single-shot json output (--output-format json)
      if (evt.type === "result") {
        const result = evt as ClaudeCodeResult;
        if (result.result && !texts.includes(result.result)) {
          texts.push(result.result);
        }
        sessionId = result.session_id;
        lastModel = result.model;
        meta = {
          model: result.model,
          sessionId: result.session_id,
          usage: normalizeUsage({
            input: result.usage?.input_tokens,
            output: result.usage?.output_tokens,
            cacheRead: result.usage?.cache_read_input_tokens,
            cacheWrite: result.usage?.cache_creation_input_tokens,
          }),
        };
        continue;
      }

      // Handle streaming assistant messages
      if (evt.type === "assistant") {
        const assistantEvt = evt as ClaudeCodeAssistantEvent;
        if (assistantEvt.message?.role === "assistant") {
          const textContent = assistantEvt.message.content
            ?.filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n")
            .trim();
          if (textContent && !texts.includes(textContent)) {
            texts.push(textContent);
          }
          sessionId = assistantEvt.session_id;
          lastModel = assistantEvt.message.model;
        }
      }

      // Handle system init (captures session_id early)
      if (evt.type === "system") {
        const sysEvt = evt as ClaudeCodeSystemEvent;
        sessionId = sysEvt.session_id;
        lastModel = sysEvt.model;
      }
    } catch {
      // ignore malformed lines
    }
  }

  // Build meta if we found anything
  if (!meta && sessionId) {
    meta = {
      sessionId,
      model: lastModel,
    };
  }

  return { texts, meta };
}

export const claudeCodeSpec: AgentSpec = {
  kind: "claude-code",
  isInvocation: isClaudeCodeInvocation,
  buildArgs: (ctx: BuildArgsContext) => {
    const argv = [...ctx.argv];
    if (!isClaudeCodeInvocation(argv)) return argv;

    let bodyPos = ctx.bodyIndex;
    const hasFlag = (flag: string) =>
      argv.includes(flag) || argv.some((a) => a.startsWith(`${flag}=`));

    // Add --print flag for non-interactive mode
    if (!argv.includes("-p") && !argv.includes("--print")) {
      argv.splice(bodyPos, 0, "-p");
      bodyPos += 1;
    }

    // Add --output-format stream-json for real-time streaming (requires --verbose)
    if (!hasFlag("--output-format")) {
      argv.splice(bodyPos, 0, "--output-format", "stream-json", "--verbose");
      bodyPos += 3;
    }

    // Handle session continuation (skip if --resume already present)
    if (
      !ctx.isNewSession &&
      ctx.sessionId &&
      !hasFlag("--session-id") &&
      !hasFlag("--resume")
    ) {
      argv.splice(bodyPos, 0, "--session-id", ctx.sessionId);
      bodyPos += 2;
    }

    // Add model if specified
    if (ctx.model && !hasFlag("--model")) {
      argv.splice(bodyPos, 0, "--model", ctx.model);
      bodyPos += 2;
    }

    // Add permission mode (defaults to bypassPermissions for non-interactive)
    if (!hasFlag("--permission-mode")) {
      const mode: PermissionMode = ctx.permissionMode ?? "bypassPermissions";
      argv.splice(bodyPos, 0, "--permission-mode", mode);
      bodyPos += 2;
    }

    // Inject identity prefix into the prompt body if needed
    if (
      !(ctx.sendSystemOnce && ctx.systemSent) &&
      argv[bodyPos] &&
      ctx.identityPrefix
    ) {
      const existingBody = argv[bodyPos];
      argv[bodyPos] = [ctx.identityPrefix, existingBody]
        .filter(Boolean)
        .join("\n\n");
    }

    return argv;
  },
  parseOutput: parseClaudeCodeOutput,
};
