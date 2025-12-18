import { claudeCodeSpec } from "./claude-code.js";
import type { AgentKind, AgentSpec } from "./types.js";

const specs: Record<AgentKind, AgentSpec> = {
  "claude-code": claudeCodeSpec,
};

export function getAgentSpec(kind: AgentKind): AgentSpec {
  return specs[kind];
}

export type {
  AgentKind,
  AgentMeta,
  AgentParseResult,
  PermissionMode,
} from "./types.js";
