export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
  isHeartbeat?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when session info is available (for pending request tracking) */
  onSessionReady?: (info: {
    sessionId: string;
    cwd?: string;
  }) => Promise<void> | void;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};
