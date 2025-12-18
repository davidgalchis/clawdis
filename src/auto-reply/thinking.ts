export type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";
export type VerboseLevel = "off" | "on";

// Normalize user-provided thinking level strings to the canonical enum.
export function normalizeThinkLevel(
  raw?: string | null,
): ThinkLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off"].includes(key)) return "off";
  if (["min", "minimal"].includes(key)) return "minimal";
  if (["low", "thinkhard", "think-hard", "think_hard"].includes(key))
    return "low";
  if (["med", "medium", "thinkharder", "think-harder", "harder"].includes(key))
    return "medium";
  if (
    [
      "high",
      "ultra",
      "ultrathink",
      "think-hard",
      "thinkhardest",
      "highest",
      "max",
    ].includes(key)
  )
    return "high";
  if (["think"].includes(key)) return "minimal";
  return undefined;
}

// Normalize verbose flags used to toggle agent verbosity.
export function normalizeVerboseLevel(
  raw?: string | null,
): VerboseLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["off", "false", "no", "0"].includes(key)) return "off";
  if (["on", "full", "true", "yes", "1"].includes(key)) return "on";
  return undefined;
}

export type PermissionModeLevel =
  | "default"
  | "plan"
  | "bypassPermissions"
  | "acceptEdits";

// Normalize permission mode strings used for Claude Code --permission-mode flag.
export function normalizePermissionMode(
  raw?: string | null,
): PermissionModeLevel | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (["default", "normal", "standard"].includes(key)) return "default";
  if (["plan", "planning", "architect"].includes(key)) return "plan";
  if (
    [
      "bypass",
      "bypasspermissions",
      "bypass-permissions",
      "dangerous",
      "yolo",
    ].includes(key)
  )
    return "bypassPermissions";
  if (["accept", "acceptedits", "accept-edits", "auto"].includes(key))
    return "acceptEdits";
  return undefined;
}
