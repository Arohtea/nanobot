import { useCallback, useEffect, useRef, useState } from "react";

import { useClient } from "@/providers/ClientProvider";
import i18n from "@/i18n";
import {
  ApiError,
  deleteSession as apiDeleteSession,
  fetchSessionMessages,
  listSessions,
} from "@/lib/api";
import { deriveTitle } from "@/lib/format";
import { toMediaAttachment } from "@/lib/media";
import type { ChatSummary, UIMessage } from "@/lib/types";

const EMPTY_MESSAGES: UIMessage[] = [];
const TOOL_ARG_KEYS: Record<string, string[]> = {
  read_file: ["path", "file_path"],
  write_file: ["path", "file_path"],
  edit: ["file_path", "path"],
  edit_file: ["file_path", "path"],
  glob: ["pattern"],
  grep: ["pattern"],
  exec: ["command"],
  web_search: ["query"],
  web_fetch: ["url"],
  list_dir: ["path"],
};

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function shorten(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function quote(value: string): string {
  return `"${shorten(value)}"`;
}

function formatToolCall(call: unknown): string {
  if (!call || typeof call !== "object") return "tool";
  const fn = (call as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") return "tool";
  const { name, arguments: rawArgs } = fn as { name?: unknown; arguments?: unknown };
  const toolName = typeof name === "string" && name.length > 0 ? name : "tool";
  const args = parseToolArgs(rawArgs);
  const value = firstStringArg(args, TOOL_ARG_KEYS[toolName] ?? []);

  if (!value) return toolName;
  if (toolName === "exec") return `$ ${shorten(value)}`;
  if (toolName === "read_file") return `read ${shorten(value)}`;
  if (toolName === "write_file") return `write ${shorten(value)}`;
  if (toolName === "edit" || toolName === "edit_file") return `edit ${shorten(value)}`;
  if (toolName === "list_dir") return `ls ${shorten(value)}`;
  if (toolName === "glob") return `glob ${quote(value)}`;
  if (toolName === "grep") return `grep ${quote(value)}`;
  if (toolName === "web_search") return `search ${quote(value)}`;
  if (toolName === "web_fetch") return `fetch ${shorten(value)}`;
  return `${toolName}(${quote(value)})`;
}

function toolTraceLines(message: {
  content: string;
  tool_calls?: unknown;
}): string[] | null {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return null;
  }
  const lines = message.tool_calls.map(formatToolCall);
  const content = message.content.trim();
  return content ? [content, ...lines] : lines;
}

/** Sidebar state: fetches the full session list and exposes create / delete actions. */
export function useSessions(): {
  sessions: ChatSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createChat: () => Promise<string>;
  deleteChat: (key: string) => Promise<void>;
} {
  const { client, token } = useClient();
  const [sessions, setSessions] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const rows = await listSessions(tokenRef.current);
      setSessions(rows);
      setError(null);
    } catch (e) {
      const msg =
        e instanceof ApiError ? `HTTP ${e.status}` : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createChat = useCallback(async (): Promise<string> => {
    const chatId = await client.newChat();
    const key = `websocket:${chatId}`;
    // Optimistic insert; a subsequent refresh will replace it with the
    // authoritative row once the server persists the session.
    setSessions((prev) => [
      {
        key,
        channel: "websocket",
        chatId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        preview: "",
      },
      ...prev.filter((s) => s.key !== key),
    ]);
    return chatId;
  }, [client]);

  const deleteChat = useCallback(
    async (key: string) => {
      await apiDeleteSession(tokenRef.current, key);
      setSessions((prev) => prev.filter((s) => s.key !== key));
    },
    [],
  );

  return { sessions, loading, error, refresh, createChat, deleteChat };
}

/** Lazy-load a session's on-disk messages the first time the UI displays it. */
export function useSessionHistory(key: string | null): {
  messages: UIMessage[];
  loading: boolean;
  error: string | null;
} {
  const { token } = useClient();
  const [state, setState] = useState<{
    key: string | null;
    messages: UIMessage[];
    loading: boolean;
    error: string | null;
  }>({
    key: null,
    messages: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!key) {
      setState({
        key: null,
        messages: [],
        loading: false,
        error: null,
      });
      return;
    }
    let cancelled = false;
    // Mark the new key as loading immediately so callers never see stale
    // messages from the previous session during the render right after a switch.
    setState({
      key,
      messages: [],
      loading: true,
      error: null,
    });
    (async () => {
      try {
        const body = await fetchSessionMessages(token, key);
        if (cancelled) return;
        const ui: UIMessage[] = body.messages.flatMap<UIMessage>((m, idx): UIMessage[] => {
          if (m.role === "assistant") {
            const traces = toolTraceLines(m);
            if (traces) {
              return [
                {
                  id: `hist-${idx}`,
                  role: "tool",
                  kind: "trace",
                  content: traces[traces.length - 1] ?? "",
                  traces,
                  createdAt: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
                },
              ];
            }
          }
          if (m.role !== "user" && m.role !== "assistant") return [];
          if (typeof m.content !== "string") return [];
          // Hydrate signed media URLs into generic UI attachments. Image-only
          // user turns still populate the legacy ``images`` slot so the
          // existing optimistic-send and lightbox paths remain unchanged.
          const media =
            Array.isArray(m.media_urls) && m.media_urls.length > 0
              ? m.media_urls.map((mu) => toMediaAttachment(mu))
              : undefined;
          const images =
            m.role === "user" && media?.every((item) => item.kind === "image")
              ? media.map((item) => ({ url: item.url, name: item.name }))
              : undefined;
          return [
            {
              id: `hist-${idx}`,
              role: m.role,
              content: m.content,
              createdAt: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
              ...(images ? { images } : {}),
              ...(media ? { media } : {}),
            },
          ];
        });
        setState({
          key,
          messages: ui,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        // A 404 just means the session hasn't been persisted yet (brand-new
        // chat, first message not sent). That's a normal state, not an error.
        if (e instanceof ApiError && e.status === 404) {
          setState({
            key,
            messages: [],
            loading: false,
            error: null,
          });
        } else {
          setState({
            key,
            messages: [],
            loading: false,
            error: (e as Error).message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, token]);

  if (!key) {
    return { messages: EMPTY_MESSAGES, loading: false, error: null };
  }

  // Even before the effect above commits its loading state, never surface the
  // previous session's payload for a brand-new key.
  if (state.key !== key) {
    return { messages: EMPTY_MESSAGES, loading: true, error: null };
  }

  return {
    messages: state.messages,
    loading: state.loading,
    error: state.error,
  };
}

/** Produce a compact display title for a session. */
export function sessionTitle(
  session: ChatSummary,
  firstUserMessage?: string,
): string {
  return deriveTitle(
    firstUserMessage || session.preview,
    i18n.t("chat.newChat"),
  );
}
