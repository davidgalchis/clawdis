import fs from "node:fs/promises";
import path from "node:path";
import { claudeCodeSpec } from "../agents/claude-code.js";
import type {
  AgentMeta,
  AgentToolResult,
  PermissionMode,
} from "../agents/types.js";
import type { ClawdisConfig, ProgressConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { runClaudeCode } from "../process/claude-code-runner.js";
import { enqueueCommand } from "../process/command-queue.js";
import { resolveUserPath } from "../utils.js";
import { applyTemplate, type TemplateContext } from "./templating.js";
import { formatToolAggregate, shortenMeta } from "./tool-meta.js";
import type { ReplyPayload } from "./types.js";

function stripStructuralPrefixes(text: string): string {
  return text
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNonJsonText(raw: string): string | undefined {
  const kept: string[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      // JSON protocol frame → never surface directly.
    } catch {
      kept.push(line);
    }
  }
  const text = kept.join("\n").trim();
  return text ? text : undefined;
}

type CommandReplyConfig = NonNullable<ClawdisConfig["inbound"]>["reply"] & {
  mode: "command";
};

type EnqueueCommandFn = typeof enqueueCommand;

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";

type CommandReplyParams = {
  reply: CommandReplyConfig;
  templatingCtx: TemplateContext;
  sendSystemOnce: boolean;
  isNewSession: boolean;
  isFirstTurnInSession: boolean;
  systemSent: boolean;
  timeoutMs: number;
  timeoutSeconds: number;
  enqueue?: EnqueueCommandFn;
  thinkLevel?: ThinkLevel;
  verboseLevel?: "off" | "on";
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when Claude reports its actual session ID (may differ from input for forked sessions) */
  onSessionReady?: (info: { sessionId: string; cwd?: string }) => void;
  runId?: string;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  permissionMode?: PermissionMode;
  /** Auto-continue when output looks incomplete */
  autoContinue?: boolean;
  /** Max auto-continue attempts (default: 3) */
  autoContinueMax?: number;
  /** Tracking ID for cancellation (e.g., chat ID) */
  trackingId?: string;
  /** Progress visibility settings */
  progressConfig?: ProgressConfig;
};

export type CommandReplyMeta = {
  durationMs: number;
  queuedMs?: number;
  queuedAhead?: number;
  /** Output looks incomplete (ends with colon, "let me try", etc.) */
  looksIncomplete?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  killed?: boolean;
  agentMeta?: AgentMeta;
};

export type CommandReplyResult = {
  payloads?: ReplyPayload[];
  meta: CommandReplyMeta;
};

function normalizeToolResults(
  toolResults?: Array<string | AgentToolResult>,
): AgentToolResult[] {
  if (!toolResults) return [];
  return toolResults
    .map((tr) => (typeof tr === "string" ? { text: tr } : tr))
    .map((tr) => ({
      text: (tr.text ?? "").trim(),
      toolName: tr.toolName?.trim() || undefined,
      meta: tr.meta ? shortenMeta(tr.meta) : undefined,
    }))
    .filter((tr) => tr.text.length > 0);
}

export async function runCommandReply(
  params: CommandReplyParams,
): Promise<CommandReplyResult> {
  const logger = getChildLogger({ module: "command-reply" });
  const verboseLog = (msg: string) => {
    logger.debug(msg);
    if (isVerbose()) logVerbose(msg);
  };

  const {
    reply,
    templatingCtx,
    sendSystemOnce,
    isNewSession,
    isFirstTurnInSession,
    systemSent,
    timeoutMs,
    timeoutSeconds,
    enqueue = enqueueCommand,
    thinkLevel,
    verboseLevel,
    onPartialReply,
  } = params;

  const resolvedCwd =
    typeof reply.cwd === "string" && reply.cwd.trim()
      ? resolveUserPath(reply.cwd)
      : undefined;
  if (resolvedCwd) {
    try {
      await fs.mkdir(resolvedCwd, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to create reply.cwd directory (${resolvedCwd}): ${String(err)}`,
      );
    }
  }

  if (!reply.command?.length) {
    throw new Error("reply.command is required for mode=command");
  }
  const agentCfg = reply.agent ?? { kind: "claude-code" };
  const agent = claudeCodeSpec;
  const agentKind = "claude-code";
  const rawCommand = reply.command;
  const hasBodyTemplate = rawCommand.some((part) =>
    /\{\{Body(Stripped)?\}\}/.test(part),
  );
  let argv = rawCommand.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  let prefixOffset = 0;
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
    prefixOffset = 1;
  }

  // Extract (or synthesize) the prompt body so RPC mode works even when the
  // command array omits {{Body}} (common for tau --mode rpc configs).
  let bodyArg: string | undefined;
  if (hasBodyTemplate) {
    const idx = rawCommand.findIndex((part) =>
      /\{\{Body(Stripped)?\}\}/.test(part),
    );
    const templatedIdx = idx >= 0 ? idx + prefixOffset : -1;
    if (templatedIdx >= 0 && templatedIdx < argv.length) {
      bodyArg = argv.splice(templatedIdx, 1)[0];
    }
  }
  if (!bodyArg) {
    bodyArg = templatingCtx.Body ?? templatingCtx.BodyStripped ?? "";
  }

  // Default body index is last arg after we append it below.
  let bodyIndex = Math.max(argv.length, 0);

  const bodyMarker = `__clawdis_body__${Math.random().toString(36).slice(2)}`;
  let sessionArgList: string[] = [];
  let insertSessionBeforeBody = true;

  // Session args prepared (templated) and injected generically
  // Claude Code uses --session-id to specify which session to use/create
  if (reply.session) {
    // For Claude Code session handling:
    // - New sessions: use --session-id to create with our UUID
    // - Resume: use --resume <sessionId> --fork-session to load specific session and fork
    //   (--resume loads the exact session for context, --fork-session creates new ID to avoid locks)
    const defaultSessionArgs = {
      newArgs: ["--session-id", "{{SessionId}}"],
      resumeArgs: ["--resume", "{{SessionId}}", "--fork-session"],
    };
    const defaultNew = defaultSessionArgs.newArgs;
    const defaultResume = defaultSessionArgs.resumeArgs;
    // Use newArgs if this is a new session OR if we've never sent to Claude yet
    // (isFirstTurnInSession means systemSent is false, so Claude doesn't know this session ID)
    const useNewSessionArgs = isNewSession || isFirstTurnInSession;
    sessionArgList = (
      useNewSessionArgs
        ? (reply.session.sessionArgNew ?? defaultNew)
        : (reply.session.sessionArgResume ?? defaultResume)
    ).map((p) => applyTemplate(p, templatingCtx));

    insertSessionBeforeBody = reply.session.sessionArgBeforeBody ?? true;
  }

  if (insertSessionBeforeBody && sessionArgList.length) {
    argv = [...argv, ...sessionArgList];
  }

  argv = [...argv, `${bodyMarker}${bodyArg}`];
  bodyIndex = argv.length - 1;

  if (!insertSessionBeforeBody && sessionArgList.length) {
    argv = [...argv, ...sessionArgList];
  }

  if (thinkLevel && thinkLevel !== "off") {
    const hasThinkingFlag = argv.some(
      (p, i) =>
        p === "--thinking" ||
        (i > 0 && argv[i - 1] === "--thinking") ||
        p.startsWith("--thinking="),
    );
    if (!hasThinkingFlag) {
      argv.splice(bodyIndex, 0, "--thinking", thinkLevel);
      bodyIndex += 2;
    }
  }
  const builtArgv = agent.buildArgs({
    argv,
    bodyIndex,
    isNewSession,
    sessionId: templatingCtx.SessionId,
    provider: agentCfg.provider,
    model: agentCfg.model,
    sendSystemOnce,
    systemSent,
    identityPrefix: agentCfg.identityPrefix,
    format: agentCfg.format,
    permissionMode: params.permissionMode,
    cwd: resolvedCwd,
  });

  const promptIndex = builtArgv.findIndex(
    (arg) => typeof arg === "string" && arg.includes(bodyMarker),
  );
  const promptArg: string =
    promptIndex >= 0
      ? (builtArgv[promptIndex] as string).replace(bodyMarker, "")
      : ((builtArgv[builtArgv.length - 1] as string | undefined) ?? "");

  const finalArgv = builtArgv.map((arg, idx) => {
    if (idx === promptIndex && typeof arg === "string") return promptArg;
    return typeof arg === "string" ? arg.replace(bodyMarker, "") : arg;
  });

  // For Claude Code, we run the command directly (no RPC mode like Pi).
  // The finalArgv already has all the necessary flags from buildArgs.

  logVerbose(
    `Running command auto-reply: ${finalArgv.join(" ")}${resolvedCwd ? ` (cwd: ${resolvedCwd})` : ""}`,
  );
  logger.info(
    {
      agent: agentKind,
      sessionId: templatingCtx.SessionId,
      newSession: isNewSession,
      cwd: resolvedCwd,
      command: finalArgv.slice(0, -1), // omit body to reduce noise
    },
    "command auto-reply start",
  );

  const started = Date.now();
  let queuedMs: number | undefined;
  let queuedAhead: number | undefined;
  try {
    let pendingToolName: string | undefined;
    let pendingMetas: string[] = [];
    let pendingTimer: NodeJS.Timeout | null = null;
    let streamedAny = false;
    const flushPendingTool = () => {
      if (!onPartialReply) return;
      if (!pendingToolName && pendingMetas.length === 0) return;
      const text = formatToolAggregate(pendingToolName, pendingMetas);
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(text);
      void onPartialReply({
        text: cleanedText,
        mediaUrls: mediaFound?.length ? mediaFound : undefined,
      } as ReplyPayload);
      streamedAny = true;
      pendingToolName = undefined;
      pendingMetas = [];
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };

    // Track tools executed for summary footer
    const toolsExecuted: Array<{ name: string; detail: string }> = [];

    const run = async () => {
      logVerbose(
        `claude-code prompt (${promptArg?.length ?? 0} chars): ${(promptArg ?? "").slice(0, 200).replace(/\n/g, "\\n")}`,
      );

      // Run Claude Code directly (no RPC mode).
      const result = await runClaudeCode({
        argv: finalArgv,
        cwd: resolvedCwd,
        timeoutMs,
        trackingId: params.trackingId,
        onLine: (line: string) => {
          // Try to parse streaming JSON events
          try {
            const ev = JSON.parse(line) as {
              type?: string;
              subtype?: string;
              session_id?: string;
              tool?: string;
              tool_input?: Record<string, unknown>;
              message?: {
                role?: string;
                content?: Array<{
                  type?: string;
                  text?: string;
                  name?: string;
                  input?: Record<string, unknown>;
                  content?: string | Array<{ type?: string; text?: string }>;
                }>;
              };
            };

            // Capture actual session ID from init event (may differ for forked sessions)
            if (
              ev.type === "system" &&
              ev.subtype === "init" &&
              ev.session_id
            ) {
              params.onSessionReady?.({
                sessionId: ev.session_id,
                cwd: resolvedCwd,
              });
            }

            // Capture tool results (especially Task output)
            if (ev.type === "user" && ev.message?.role === "user") {
              const content = ev.message.content ?? [];
              for (const c of content) {
                if (c.type === "tool_result" && c.content && onPartialReply) {
                  // Extract text from tool result
                  const resultText =
                    typeof c.content === "string"
                      ? c.content
                      : Array.isArray(c.content)
                        ? c.content
                            .filter(
                              (x: { type?: string; text?: string }) =>
                                x.type === "text",
                            )
                            .map((x: { text?: string }) => x.text)
                            .join("\n")
                        : "";
                  if (resultText && resultText.length > 0) {
                    // Show truncated result (Task outputs can be long)
                    const preview =
                      resultText.length > 500
                        ? resultText.slice(0, 497) + "..."
                        : resultText;
                    void onPartialReply({
                      text: `📤 Result:\n${preview}`,
                    });
                  }
                }
              }
            }

            // Forward agent events
            if (ev.type === "assistant" && ev.message?.role === "assistant") {
              const content = ev.message.content ?? [];

              // Progress config with defaults
              const showTaskDescriptions =
                params.progressConfig?.taskDescriptions ?? true;
              const showThinking =
                params.progressConfig?.thinkingPreviews ?? false;
              const thinkingMaxChars =
                params.progressConfig?.thinkingMaxChars ?? 100;

              // Check for thinking blocks and tool use
              for (const c of content) {
                // Handle thinking blocks
                if (
                  c.type === "thinking" &&
                  (c as { thinking?: string }).thinking &&
                  showThinking &&
                  onPartialReply
                ) {
                  const thinkingText = String(
                    (c as { thinking?: string }).thinking,
                  );
                  const preview =
                    thinkingText.length > thinkingMaxChars
                      ? thinkingText.slice(0, thinkingMaxChars - 3) + "..."
                      : thinkingText;
                  // Clean up for display (single line)
                  const cleanPreview = preview.replace(/\n+/g, " ").trim();
                  void onPartialReply({
                    text: `🧠 ${cleanPreview}`,
                  });
                }

                if (c.type === "tool_use" && c.name) {
                  const toolName = c.name;
                  const input = c.input ?? {};
                  let detail = "";

                  // Extract useful details based on tool type
                  if (toolName === "Read" && input.file_path) {
                    detail = String(input.file_path);
                  } else if (toolName === "Edit" && input.file_path) {
                    detail = String(input.file_path);
                  } else if (toolName === "Write" && input.file_path) {
                    detail = String(input.file_path);
                  } else if (toolName === "Bash" && input.command) {
                    const cmd = String(input.command).slice(0, 40);
                    detail = `\`${cmd}${String(input.command).length > 40 ? "..." : ""}\``;
                  } else if (toolName === "Glob" && input.pattern) {
                    detail = String(input.pattern);
                  } else if (toolName === "Grep" && input.pattern) {
                    detail = String(input.pattern);
                  } else if (toolName === "Task") {
                    detail = input.description ? String(input.description) : "";
                  }

                  // Track for footer
                  toolsExecuted.push({ name: toolName, detail });

                  // Send partial reply if callback provided
                  if (onPartialReply) {
                    // Use special format for Task tool to highlight what's being worked on
                    if (toolName === "Task" && showTaskDescriptions && detail) {
                      void onPartialReply({
                        text: `📋 Task: ${detail}`,
                      });
                    } else {
                      void onPartialReply({
                        text: `🔧 ${toolName}${detail ? ` ${detail}` : ""}`,
                      });
                    }
                  }
                }
              }

              // Forward text content
              const text = content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("\n")
                .trim();
              if (text) {
                params.onAgentEvent?.({
                  stream: "assistant",
                  data: { text },
                });
              }
            }

            // Handle streaming text deltas (content_block_delta events)
            const showStreaming = params.progressConfig?.streamingText ?? false;
            const streamingMaxChars =
              params.progressConfig?.streamingMaxChars ?? 200;
            if (showStreaming && onPartialReply) {
              // Check for content_block_delta with text_delta
              const evAny = ev as {
                type?: string;
                delta?: { type?: string; text?: string };
                index?: number;
              };
              if (
                evAny.type === "content_block_delta" &&
                evAny.delta?.type === "text_delta" &&
                evAny.delta?.text
              ) {
                const deltaText = evAny.delta.text;
                // Only show if it's substantial (not just whitespace)
                const trimmed = deltaText.trim();
                if (trimmed.length > 5) {
                  const preview =
                    trimmed.length > streamingMaxChars
                      ? trimmed.slice(0, streamingMaxChars - 3) + "..."
                      : trimmed;
                  void onPartialReply({
                    text: `💬 ${preview}`,
                  });
                }
              }
            }
          } catch {
            // Not JSON, ignore
          }
        },
      });

      flushPendingTool();
      return result;
    };

    const { stdout, stderr, code, signal, killed, timedOut } = await enqueue(
      run,
      {
        onWait: (waitMs, ahead) => {
          queuedMs = waitMs;
          queuedAhead = ahead;
          if (isVerbose()) {
            logVerbose(
              `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
            );
          }
        },
      },
    );
    const stdoutUsed = stdout;
    const stderrUsed = stderr;
    const codeUsed = code;
    const signalUsed = signal;
    const killedUsed = killed;
    const timedOutUsed = timedOut;
    const rawStdout = stdoutUsed.trim();
    let mediaFromCommand: string[] | undefined;
    // For Claude Code, pass the raw output to parseOutput (it handles JSON parsing)
    const trimmed = rawStdout;
    if (stderrUsed?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderrUsed.trim()}`);
    }

    const logFailure = () => {
      const truncate = (s?: string) =>
        s ? (s.length > 4000 ? `${s.slice(0, 4000)}…` : s) : undefined;
      logger.warn(
        {
          code: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          argv: finalArgv,
          cwd: resolvedCwd,
          stdout: truncate(rawStdout),
          stderr: truncate(stderrUsed),
        },
        "command auto-reply failed",
      );
    };

    const parsed = trimmed ? agent.parseOutput(trimmed) : undefined;

    // Collect assistant texts and tool results from parseOutput (tau RPC can emit many).
    const parsedTexts =
      parsed?.texts?.map((t) => t.trim()).filter(Boolean) ?? [];
    const parsedToolResults = normalizeToolResults(parsed?.toolResults);
    const hasParsedContent =
      parsedTexts.length > 0 || parsedToolResults.length > 0;

    type ReplyItem = { text: string; media?: string[] };
    const replyItems: ReplyItem[] = [];

    const includeToolResultsInline =
      verboseLevel === "on" && !onPartialReply && parsedToolResults.length > 0;

    if (includeToolResultsInline) {
      const aggregated = parsedToolResults.reduce<
        { toolName?: string; metas: string[]; previews: string[] }[]
      >((acc, tr) => {
        const last = acc.at(-1);
        if (last && last.toolName === tr.toolName) {
          if (tr.meta) last.metas.push(tr.meta);
          if (tr.text) last.previews.push(tr.text);
        } else {
          acc.push({
            toolName: tr.toolName,
            metas: tr.meta ? [tr.meta] : [],
            previews: tr.text ? [tr.text] : [],
          });
        }
        return acc;
      }, []);

      const emojiForTool = (tool?: string) => {
        const t = (tool ?? "").toLowerCase();
        if (t === "bash" || t === "shell") return "💻";
        if (t === "read") return "📄";
        if (t === "write") return "✍️";
        if (t === "edit") return "📝";
        if (t === "attach") return "📎";
        return "🛠️";
      };

      const stripToolPrefix = (text: string) =>
        text.replace(/^\[🛠️ [^\]]+\]\s*/, "");

      const formatPreview = (texts: string[]) => {
        const joined = texts.join(" ").trim();
        if (!joined) return "";
        const clipped =
          joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
        return ` — “${clipped}”`;
      };

      for (const tr of aggregated) {
        const prefix = formatToolAggregate(tr.toolName, tr.metas);
        const preview = formatPreview(tr.previews);
        const decorated = `${emojiForTool(tr.toolName)} ${stripToolPrefix(prefix)}${preview}`;
        const { text: cleanedText, mediaUrls: mediaFound } =
          splitMediaFromOutput(decorated);
        replyItems.push({
          text: cleanedText,
          media: mediaFound?.length ? mediaFound : undefined,
        });
      }
    }

    for (const t of parsedTexts) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(t);
      replyItems.push({
        text: cleanedText,
        media: mediaFound?.length ? mediaFound : undefined,
      });
    }

    // If parser gave nothing, fall back to any non-JSON stdout the child may have emitted.
    const fallbackText = extractNonJsonText(rawStdout);
    const normalize = (s?: string) =>
      stripStructuralPrefixes((s ?? "").trim()).toLowerCase();
    const bodyNorm = normalize(
      templatingCtx.Body ?? templatingCtx.BodyStripped,
    );
    const fallbackNorm = normalize(fallbackText);
    const promptEcho =
      fallbackText &&
      (fallbackText === (templatingCtx.Body ?? "") ||
        fallbackText === (templatingCtx.BodyStripped ?? "") ||
        (bodyNorm.length > 0 && bodyNorm === fallbackNorm));
    const safeFallbackText = promptEcho ? undefined : fallbackText;

    if (replyItems.length === 0 && safeFallbackText && !hasParsedContent) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(safeFallbackText);
      if (cleanedText || mediaFound?.length) {
        replyItems.push({
          text: cleanedText,
          media: mediaFound?.length ? mediaFound : undefined,
        });
      }
    }

    // No content at all → fallback notice.
    if (replyItems.length === 0) {
      const meta = parsed?.meta?.extra?.summary ?? undefined;
      replyItems.push({
        text: `(command produced no output${meta ? `; ${meta}` : ""})`,
      });
      verboseLog("No text/media produced; injecting fallback notice to user");
      logFailure();
    }

    // Detect incomplete output for footer and auto-continue
    const lastText = replyItems[replyItems.length - 1]?.text ?? "";
    const trimmedLast = lastText.trim();
    const textLooksIncomplete =
      replyItems.length > 0 &&
      (/[:]\s*$/.test(trimmedLast) ||
        /[?]\s*$/.test(trimmedLast) ||
        /\b(next step|here'?s what|i('ll| will) (now|next)|let me|going to)\b/i.test(trimmedLast) ||
        /\b(now|next|try|check|run|test|let me|going to)\s*[:.!]?\s*$/i.test(
          trimmedLast,
        ));
    // Also mark as incomplete if process was killed (timeout) or produced no output while tools ran
    const processWasKilled = killedUsed === true || timedOutUsed === true;
    const noOutputButToolsRan =
      replyItems.length === 0 && toolsExecuted.length > 0;
    const outputLooksIncomplete =
      textLooksIncomplete || processWasKilled || noOutputButToolsRan;

    // Add footer when output looks incomplete and tools were executed
    if (outputLooksIncomplete && toolsExecuted.length > 0) {
      // Aggregate tools by name for concise summary
      const toolCounts = new Map<string, number>();
      for (const t of toolsExecuted) {
        toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);
      }
      const toolSummary = [...toolCounts.entries()]
        .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
        .join(", ");
      const footer = `\n\n📋 _Tools executed: ${toolSummary}_`;
      replyItems[replyItems.length - 1].text = trimmedLast + footer;
    }

    verboseLog(
      `Command auto-reply stdout produced ${replyItems.length} message(s)`,
    );
    const elapsed = Date.now() - started;
    verboseLog(`Command auto-reply finished in ${elapsed}ms`);
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: resolvedCwd },
      "command auto-reply finished",
    );
    if ((codeUsed ?? 0) !== 0) {
      logFailure();
      console.error(
        `Command auto-reply exited with code ${codeUsed ?? "unknown"} (signal: ${signalUsed ?? "none"})`,
      );
      // Include any partial output or stderr in error message
      const summarySource = trimmed;
      const partialOut = summarySource
        ? `\n\nOutput: ${summarySource.slice(0, 500)}${summarySource.length > 500 ? "..." : ""}`
        : "";
      const errorText = `⚠️ Command exited with code ${codeUsed ?? "unknown"}${signalUsed ? ` (${signalUsed})` : ""}${partialOut}`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          agentMeta: parsed?.meta,
        },
      };
    }
    if (killedUsed && !signalUsed) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${codeUsed ?? "unknown"})`,
      );
      const errorText = `⚠️ Command was killed before completion (exit code ${codeUsed ?? "unknown"})`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: codeUsed,
          signal: signalUsed,
          killed: killedUsed,
          agentMeta: parsed?.meta,
        },
      };
    }
    const meta: CommandReplyMeta = {
      durationMs: Date.now() - started,
      queuedMs,
      queuedAhead,
      looksIncomplete: outputLooksIncomplete,
      exitCode: codeUsed,
      signal: signalUsed,
      killed: killedUsed,
      agentMeta: parsed?.meta,
    };

    const payloads: ReplyPayload[] = [];

    // Build each reply item sequentially (delivery handled by caller).
    for (const item of replyItems) {
      let mediaUrls =
        item.media ??
        mediaFromCommand ??
        (reply.mediaUrl ? [reply.mediaUrl] : undefined);

      // If mediaMaxMb is set, skip local media paths larger than the cap.
      if (mediaUrls?.length && reply.mediaMaxMb) {
        const maxBytes = reply.mediaMaxMb * 1024 * 1024;
        const filtered: string[] = [];
        for (const url of mediaUrls) {
          if (/^https?:\/\//i.test(url)) {
            filtered.push(url);
            continue;
          }
          const abs = path.isAbsolute(url) ? url : path.resolve(url);
          try {
            const stats = await fs.stat(abs);
            if (stats.size <= maxBytes) {
              filtered.push(url);
            } else if (isVerbose()) {
              logVerbose(
                `Skipping media ${url} (${(stats.size / (1024 * 1024)).toFixed(2)}MB) over cap ${reply.mediaMaxMb}MB`,
              );
            }
          } catch {
            filtered.push(url);
          }
        }
        mediaUrls = filtered;
      }

      const payload =
        item.text || mediaUrls?.length
          ? {
              text: item.text || undefined,
              mediaUrl: mediaUrls?.[0],
              mediaUrls,
            }
          : undefined;

      if (payload) payloads.push(payload);
    }

    verboseLog(`Command auto-reply meta: ${JSON.stringify(meta)}`);
    return { payloads: streamedAny && onPartialReply ? [] : payloads, meta };
  } catch (err) {
    const elapsed = Date.now() - started;
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: resolvedCwd },
      "command auto-reply failed",
    );
    const anyErr = err as { killed?: boolean; signal?: string };
    const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
    const errorObj = err as { stdout?: string; stderr?: string };
    if (errorObj.stderr?.trim()) {
      verboseLog(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
    }
    if (timeoutHit) {
      console.error(
        `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
      );
      const baseMsg =
        "Command timed out after " +
        `${timeoutSeconds}s${resolvedCwd ? ` (cwd: ${resolvedCwd})` : ""}. Try a shorter prompt or split the request.`;
      const partial = extractNonJsonText(errorObj.stdout ?? "");
      const partialSnippet =
        partial && partial.length > 800
          ? `${partial.slice(0, 800)}...`
          : partial;
      const text = partialSnippet
        ? `${baseMsg}\n\nPartial output before timeout:\n${partialSnippet}`
        : baseMsg;
      return {
        payloads: [{ text }],
        meta: {
          durationMs: elapsed,
          queuedMs,
          queuedAhead,
          exitCode: undefined,
          signal: anyErr.signal,
          killed: anyErr.killed,
        },
      };
    }
    logError(`Command auto-reply failed after ${elapsed}ms: ${String(err)}`);
    // Send error message to user so they know the command failed
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorText = `⚠️ Command failed: ${errMsg}`;
    return {
      payloads: [{ text: errorText }],
      meta: {
        durationMs: elapsed,
        queuedMs,
        queuedAhead,
        exitCode: undefined,
        signal: anyErr.signal,
        killed: anyErr.killed,
      },
    };
  }
}
