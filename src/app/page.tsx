"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useStreamingUIMessages } from "@convex-dev/agent/react";
import { api } from "../../convex/_generated/api";
import { ChatMarkdown } from "@/components/chat-markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { visibleStreamText, type StreamingMessagePart } from "@/lib/stream-display";

interface PauseAction {
  selector: string;
  type: string;
  name?: string;
  question?: string;
  options?: string[];
  argsPreview?: string;
}

interface AnswerPayload {
  selector: string;
  decision?: "allow" | "deny";
  content?: string;
}

interface ChatEvent {
  kind: "conversation" | "delta" | "tool" | "status" | "pause" | "error" | "done";
  text?: string;
  name?: string;
  code?: string;
  conversationId?: string;
  actions?: PauseAction[];
}

interface Msg {
  id?: string;
  operationKey?: string;
  runId?: string;
  role: "user" | "assistant";
  content: string;
  tools?: string[];
  toolState?: string;
  status?: string;
  pending?: boolean;
  pause?: PauseAction[];
}

type RunStatus = string | null | undefined;

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  _count: { messages: number };
  runStatus?: RunStatus;
  activeRun?: { _id?: string; status?: string } | null;
}

interface ConvexConversationSummary {
  _id?: string;
  title?: string;
  updatedAt?: number;
  summaryUpdatedAt?: number;
  messageCount?: number;
  latestRun?: { _id?: string; status?: string } | null;
  activeRun?: { _id?: string; status?: string } | null;
}

interface ConvexMessage {
  _id?: string;
  conversationId?: string;
  operationKey?: string;
  role?: string;
  content?: string;
  tools?: unknown;
  status?: string;
  pauseActions?: unknown;
  runId?: string;
}

interface ConversationRunState {
  latest?: { _id?: string; status?: string } | null;
  active?: { _id?: string; status?: string } | null;
}

interface ConvexConversationState {
  agentThreadId?: string;
}

interface ConvexAgentStreamMessage {
  id: string;
  text: string;
  status: string;
  agentName?: string;
  parts?: StreamingMessagePart[];
}

const anyApi = api as unknown as Record<string, Record<string, any>>;

interface DurableAdmission {
  admissionKind?: string;
  conversationId?: string;
  runId?: string;
  status?: string;
  queue?: { kind?: string; state?: string; code?: string };
  error?: string;
  code?: string;
  message?: string;
}

interface MentionableDocument {
  id: string;
  title: string;
  authorRole: string;
}

const EXAMPLE_REQUESTS = [
  "Research the top 3 vector databases of 2026 and save a comparison brief.",
  "What's on the board right now?",
  "Every weekday at 9am, check the board and summarize stuck tasks.",
];

const ACTIVE_RUN_STATUSES = new Set(["queued", "enqueued", "connecting", "running"]);
const WAITING_RUN_STATUSES = new Set(["waiting_for_user", "waiting_for_approval"]);
const RETRYING_STATUS = "retrying";

function isActiveStatus(status: RunStatus): boolean {
  return typeof status === "string" && (ACTIVE_RUN_STATUSES.has(status) || WAITING_RUN_STATUSES.has(status));
}

function isPendingMessageStatus(status?: string): boolean {
  return typeof status === "string" && (ACTIVE_RUN_STATUSES.has(status) || status === RETRYING_STATUS);
}

function isWorkerProcessingStatus(status: RunStatus): boolean {
  return typeof status === "string" && (ACTIVE_RUN_STATUSES.has(status) || status === RETRYING_STATUS);
}

function parseMessageTools(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function parseMessagePause(raw: unknown): PauseAction[] | undefined {
  return Array.isArray(raw) ? parsePauseArray(raw) : undefined;
}

function messageFromConvex(message: ConvexMessage): Msg {
  const id = message._id ?? `message-${message.runId ?? "unknown"}`;
  const role = message.role === "user" ? "user" : "assistant";
  const status = message.status ?? undefined;
  return {
    id,
    operationKey: message.operationKey,
    runId: message.runId,
    role,
    content: message.content ?? "",
    tools: parseMessageTools(message.tools),
    status,
    pending: role === "assistant" && isPendingMessageStatus(status),
    pause: parseMessagePause(message.pauseActions),
  };
}

function requestKey(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function summaryFromConvex(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as ConvexConversationSummary;
  if (!row._id || typeof row.title !== "string") return null;
  const activeRun = row.activeRun ?? null;
  return {
    id: String(row._id),
    title: row.title,
    updatedAt: new Date(typeof row.summaryUpdatedAt === "number" ? row.summaryUpdatedAt : row.updatedAt ?? Date.now()).toISOString(),
    _count: { messages: typeof row.messageCount === "number" ? row.messageCount : 0 },
    runStatus: activeRun?.status ?? row.latestRun?.status ?? null,
    activeRun: activeRun ? { _id: activeRun._id ? String(activeRun._id) : undefined, status: activeRun.status } : null,
  };
}

function documentFromConvex(value: unknown): MentionableDocument | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { _id?: string; title?: string; authorRole?: string };
  if (!row._id || typeof row.title !== "string") return null;
  return { id: String(row._id), title: row.title, authorRole: row.authorRole ?? "unknown" };
}

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachedDocumentIds, setAttachedDocumentIds] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [, setPendingPlaceholders] = useState<Record<string, Msg>>({});
  const pendingPlaceholdersRef = useRef<Record<string, Msg>>({});
  // Convex subscriptions can briefly deliver the pre-admission message list
  // after the optimistic send has rendered. Keep the local user bubble until
  // its operation-keyed durable row arrives, rather than flashing the prior
  // turn back into view.
  const pendingUserMessagesRef = useRef<Record<string, Msg[]>>({});
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const latestTurnRef = useRef<HTMLDivElement>(null);
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0);
  const [pinLatestTurn, setPinLatestTurn] = useState(false);
  const pinLatestTurnRef = useRef(false);
  const atLatestRef = useRef(true);
  const initialScrollConversationRef = useRef<string | null>(null);
  const pendingLatestScrollRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const selectedRef = useRef<string | null>(null);
  // Prevent late events from an in-flight request reclaiming a newly opened chat.
  const selectionEpochRef = useRef(0);

  const summaryRows = useQuery(anyApi.conversations.listSummaries, { limit: 200 }) as unknown;
  const conversations = useMemo(
    () => Array.isArray(summaryRows) ? summaryRows.map(summaryFromConvex).filter((row): row is ConversationSummary => row !== null) : [],
    [summaryRows],
  );
  const documentsRows = useQuery(anyApi.documents.list, { limit: 200 }) as unknown;
  const documents = useMemo(
    () => Array.isArray(documentsRows) ? documentsRows.map(documentFromConvex).filter((row): row is MentionableDocument => row !== null) : [],
    [documentsRows],
  );
  const selectedConversationState = useQuery(
    anyApi.conversations.conversationState,
    conversationId ? { conversationId: conversationId as never } : "skip",
  ) as ConvexConversationState | null | undefined;
  const agentThreadId = selectedConversationState?.agentThreadId;
  const selectedAgentStreams = useStreamingUIMessages(
    api.agentStreaming.list,
    conversationId && agentThreadId
      ? { conversationId: conversationId as never, threadId: agentThreadId }
      : "skip",
  ) as ConvexAgentStreamMessage[] | undefined;
  const selectedMessages = useQuery(
    anyApi.conversations.listMessages,
    conversationId ? { conversationId: conversationId as never, limit: 2000 } : "skip",
  ) as unknown;
  const selectedRunState = useQuery(
    anyApi.agentRuns.conversationRunState,
    conversationId ? { conversationId: conversationId as never } : "skip",
  ) as ConversationRunState | undefined;
  const runStatusByConversation = useMemo(() => {
    const statuses: Record<string, RunStatus> = {};
    for (const conversation of conversations) statuses[conversation.id] = conversation.runStatus ?? null;
    if (conversationId && selectedRunState) {
      statuses[conversationId] = selectedRunState.active?.status ?? selectedRunState.latest?.status ?? statuses[conversationId] ?? null;
    }
    return statuses;
  }, [conversationId, conversations, selectedRunState]);

  useEffect(() => { selectedRef.current = conversationId; }, [conversationId]);

  const setPlaceholderMap = (update: (current: Record<string, Msg>) => Record<string, Msg>) => {
    const next = update(pendingPlaceholdersRef.current);
    pendingPlaceholdersRef.current = next;
    setPendingPlaceholders(next);
  };

  useEffect(() => {
    if (!conversationId || !Array.isArray(selectedMessages)) return;
    const durableMessages = (selectedMessages as ConvexMessage[])
      .filter((message) => !message.conversationId || String(message.conversationId) === conversationId)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map(messageFromConvex);
    const placeholder = pendingPlaceholdersRef.current[conversationId];
    const pendingUsers = pendingUserMessagesRef.current[conversationId] ?? [];
    const persistedPendingUsers = pendingUsers.filter((pending) =>
      pending.operationKey && durableMessages.some((message) => message.operationKey === pending.operationKey),
    );
    if (persistedPendingUsers.length > 0) {
      const persistedKeys = new Set(persistedPendingUsers.map((message) => message.operationKey));
      const nextPendingUsers = pendingUsers.filter((message) => !persistedKeys.has(message.operationKey));
      if (nextPendingUsers.length > 0) pendingUserMessagesRef.current[conversationId] = nextPendingUsers;
      else delete pendingUserMessagesRef.current[conversationId];
    }
    const optimisticUsers = pendingUsers.filter((pending) =>
      !persistedPendingUsers.some((persisted) => persisted.operationKey === pending.operationKey),
    );
    const activeRun = selectedRunState?.active;
    const activeRunId = typeof activeRun?._id === "string" ? activeRun._id : undefined;
    const activeStatus = typeof activeRun?.status === "string" ? activeRun.status : undefined;
    const activeProcessing = !!activeRunId && typeof activeStatus === "string"
      && (ACTIVE_RUN_STATUSES.has(activeStatus) || activeStatus === RETRYING_STATUS);

    const componentStreams: Msg[] = (selectedAgentStreams ?? [])
      .filter((stream) => typeof stream.agentName === "string" && stream.agentName.length > 0)
      .map((stream) => {
        const runId = stream.agentName as string;
        // A component stream may remain marked "streaming" briefly after its
        // durable run completes. Only the current active run can be pending;
        // otherwise the stale stream would keep the UI on "Thinking" forever.
        const pending = stream.status === "streaming"
          && !!activeRunId
          && runId === activeRunId
          && activeProcessing;
        const toolParts = (stream.parts ?? [])
          .filter((part): part is { toolName: string; state?: string } => typeof part.toolName === "string" && part.toolName.length > 0);
        const tools = toolParts.map((part) => part.toolName);
        const latestToolPart = toolParts[toolParts.length - 1];
        return {
          id: stream.id,
          runId,
          role: "assistant" as const,
          content: visibleStreamText(stream.parts, stream.text ?? ""),
          tools,
          toolState: latestToolPart?.state,
          pending,
          status: pending ? activeStatus ?? "running" : "completed",
        };
      });

    // While an official component stream is live it supersedes a retry/final
    // app-table projection for the same run. Once the component stream is
    // finished, the durable chat message wins and prevents any duplicate row.
    const liveStreamRunIds = new Set(componentStreams.filter((message) => message.pending).map((message) => message.runId));
    const loaded = durableMessages.filter((message) =>
      message.role !== "assistant" || !message.runId || !liveStreamRunIds.has(message.runId));
    const visibleStreams = componentStreams.filter((stream) =>
      stream.pending || !durableMessages.some((message) => message.role === "assistant" && message.runId === stream.runId));
    const authoritative = [...loaded, ...optimisticUsers, ...visibleStreams];
    const hasActiveAssistant = !!activeRunId && authoritative.some((message) => message.role === "assistant" && message.runId === activeRunId);
    const latestUserIndex = authoritative.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
    const hasAssistantAfterLatestUser = latestUserIndex >= 0
      && authoritative.slice(latestUserIndex + 1).some((message) => message.role === "assistant");
    const hasPersistedAssistant = Boolean(
      (placeholder?.runId && authoritative.some((message) => message.role === "assistant" && message.runId === placeholder.runId))
      || hasActiveAssistant
      || (!activeRunId && hasAssistantAfterLatestUser),
    );
    if (hasPersistedAssistant) {
      setPlaceholderMap((current) => {
        if (!current[conversationId]) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    }

    const placeholderForActive = !!placeholder && (!placeholder.runId || placeholder.runId === activeRunId);
    let visiblePlaceholder = placeholder && !hasPersistedAssistant ? placeholder : undefined;
    if (activeProcessing && !hasActiveAssistant && !hasPersistedAssistant) {
      if (placeholderForActive) {
        visiblePlaceholder = {
          ...placeholder,
          runId: placeholder.runId ?? activeRunId,
          status: activeStatus,
          pending: true,
        };
        if (placeholder.runId !== activeRunId || placeholder.status !== activeStatus) {
          setPlaceholderMap((current) => ({
            ...current,
            [conversationId]: visiblePlaceholder as Msg,
          }));
        }
      } else {
        visiblePlaceholder = {
          id: `active:${activeRunId}`,
          runId: activeRunId,
          role: "assistant",
          content: "",
          tools: [],
          pending: true,
          status: activeStatus,
        };
      }
    }
    setMessages(visiblePlaceholder ? [...authoritative, visiblePlaceholder] : authoritative);
  }, [conversationId, selectedAgentStreams, selectedMessages, selectedRunState]);

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setHistoryOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  const latestUserIndex = useMemo(
    () => messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1),
    [messages],
  );

  const selectedStatus = conversationId
    ? selectedRunState?.active?.status ?? selectedRunState?.latest?.status ?? runStatusByConversation[conversationId] ?? null
    : null;
  const selectedBusy = isActiveStatus(selectedStatus) || Boolean(conversationId && submitting[conversationId]);
  const selectedWorkerProcessing = isWorkerProcessingStatus(selectedStatus) || Boolean(conversationId && submitting[conversationId]);
  const loadingConversation = Boolean(conversationId && (selectedConversationState === undefined || selectedMessages === undefined));
  const loadingConversationId = loadingConversation ? conversationId : null;

  const setAtLatest = (atLatest: boolean) => {
    atLatestRef.current = atLatest;
    setShowJumpToLatest(!atLatest);
  };

  const scrollToLatestTurn = (force = false, behavior: ScrollBehavior = "smooth") => {
    window.setTimeout(() => {
      const scrollArea = scrollAreaRef.current;
      const latestTurn = latestTurnRef.current;
      if (!scrollArea || !latestTurn || (!force && !atLatestRef.current)) return;
      const scrollAreaTop = scrollArea.getBoundingClientRect().top;
      const latestTurnTop = latestTurn.getBoundingClientRect().top;
      scrollArea.scrollTo({
        top: scrollArea.scrollTop + latestTurnTop - scrollAreaTop,
        behavior,
      });
    }, 50);
  };

  const scrollToBottom = (force = false, behavior: ScrollBehavior = "smooth") => {
    window.setTimeout(() => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea || (!force && !atLatestRef.current)) return;
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior });
    }, 50);
  };

  const followLatest = () => {
    if (pinLatestTurnRef.current) scrollToLatestTurn();
    else scrollToBottom();
  };

  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    setScrollViewportHeight(scrollArea.clientHeight);
    const onScroll = () => {
      if (!pinLatestTurnRef.current) {
        const distanceFromBottom = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop;
        setAtLatest(distanceFromBottom <= 72);
        return;
      }
      const latestTurn = latestTurnRef.current;
      if (!latestTurn) {
        setAtLatest(true);
        return;
      }
      const scrollAreaTop = scrollArea.getBoundingClientRect().top;
      const latestTurnTop = latestTurn.getBoundingClientRect().top;
      setAtLatest(latestTurnTop <= scrollAreaTop + 72);
    };
    const resizeObserver = new ResizeObserver(() => setScrollViewportHeight(scrollArea.clientHeight));
    resizeObserver.observe(scrollArea);
    scrollArea.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      resizeObserver.disconnect();
      scrollArea.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Position the transcript before the browser paints. Freshly sent turns and
  // conversations currently being worked on start at the latest turn; idle
  // previous conversations open at the bottom.
  useLayoutEffect(() => {
    const openingConversation = Boolean(
      conversationId
      && !loadingConversation
      && initialScrollConversationRef.current === conversationId,
    );
    if ((!openingConversation && !pendingLatestScrollRef.current) || latestUserIndex < 0) return;
    const scrollArea = scrollAreaRef.current;
    const latestTurn = latestTurnRef.current;
    if (!scrollArea || !latestTurn) return;

    const openAtLatestTurn = openingConversation && selectedWorkerProcessing;
    if (openingConversation && pinLatestTurn !== openAtLatestTurn) {
      pinLatestTurnRef.current = openAtLatestTurn;
      setPinLatestTurn(openAtLatestTurn);
      return;
    }

    if (openAtLatestTurn || !openingConversation) {
      const scrollAreaTop = scrollArea.getBoundingClientRect().top;
      const latestTurnTop = latestTurn.getBoundingClientRect().top;
      scrollArea.scrollTo({
        top: scrollArea.scrollTop + latestTurnTop - scrollAreaTop,
        behavior: "auto",
      });
    } else {
      scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: "auto" });
    }
    initialScrollConversationRef.current = null;
    pendingLatestScrollRef.current = false;
    atLatestRef.current = true;
    setShowJumpToLatest(false);
  }, [conversationId, latestUserIndex, loadingConversation, pinLatestTurn, scrollViewportHeight, selectedWorkerProcessing]);

  function jumpToLatest() {
    atLatestRef.current = true;
    setShowJumpToLatest(false);
    if (pinLatestTurnRef.current) scrollToLatestTurn(true);
    else scrollToBottom(true);
  }

  function selectConversation(id: string) {
    if (id === conversationId) return;
    const workerProcessing = isWorkerProcessingStatus(runStatusByConversation[id] ?? null) || Boolean(submitting[id]);
    selectionEpochRef.current += 1;
    selectedRef.current = id;
    initialScrollConversationRef.current = id;
    pendingLatestScrollRef.current = false;
    pinLatestTurnRef.current = workerProcessing;
    setPinLatestTurn(workerProcessing);
    setConversationId(id);
    setMessages([]);
    setShowJumpToLatest(false);
    atLatestRef.current = true;
    setHistoryOpen(false);
  }

  function newConversation() {
    selectionEpochRef.current += 1;
    selectedRef.current = null;
    initialScrollConversationRef.current = null;
    pendingLatestScrollRef.current = false;
    pinLatestTurnRef.current = false;
    setPinLatestTurn(false);
    setConversationId(null);
    setMessages([]);
    setShowJumpToLatest(false);
    atLatestRef.current = true;
    setInput("");
    setAttachedDocumentIds([]);
    setHistoryOpen(false);
  }

  async function deleteConversation() {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    const response = await fetch(`/api/conversations/${target.id}`, { method: "DELETE" });
    if (!response.ok) {
      setDeleting(false);
      return;
    }
    if (conversationId === target.id) newConversation();
    setDeleteTarget(null);
    setDeleting(false);
  }

  async function runTurn(body: Record<string, unknown>, userBubble?: string): Promise<boolean> {
    const targetConversation = typeof body.conversationId === "string" ? body.conversationId : conversationId;
    const key = typeof body.requestId === "string" ? body.requestId : requestKey();
    // A new conversation has no ID until admission. Scope it to this request,
    // rather than a shared "new" key that blocks every fresh composer.
    const targetKey = targetConversation ?? key;
    const isResume = body.answers !== undefined;
    const currentStatus = targetConversation ? runStatusByConversation[targetConversation] ?? null : null;
    if (submitting[targetKey] || (targetConversation && isActiveStatus(currentStatus) && !(isResume && WAITING_RUN_STATUSES.has(String(currentStatus))))) return false;
    const requestBody = { ...body, requestId: key };
    const requestSelection = selectedRef.current;
    const requestSelectionEpoch = selectionEpochRef.current;
    let streamConversationId = targetConversation;
    const ownsRequestSelection = () => selectionEpochRef.current === requestSelectionEpoch
      && (selectedRef.current === requestSelection
        || (requestSelection === null && streamConversationId !== undefined && selectedRef.current === streamConversationId));
    const placeholderId = `pending:${key}`;
    const messageOperationKey = `chat:${isResume ? "resume" : "start"}:${key}:message`;
    let admitted = false;
    setSubmitting((current) => ({ ...current, [targetKey]: true }));
    if (userBubble !== undefined && requestSelection === selectedRef.current) {
      const optimisticUser: Msg = {
        id: `user:${key}`,
        operationKey: messageOperationKey,
        role: "user",
        content: userBubble,
      };
      pendingUserMessagesRef.current[targetKey] = [
        ...(pendingUserMessagesRef.current[targetKey] ?? []),
        optimisticUser,
      ];
      pendingLatestScrollRef.current = true;
      pinLatestTurnRef.current = true;
      setPinLatestTurn(true);
      setMessages((current) => [...current, optimisticUser]);
    }
    if (requestSelection === selectedRef.current) {
      const placeholder: Msg = { id: placeholderId, role: "assistant", content: "", tools: [], pending: true, status: "queued" };
      setPlaceholderMap((current) => ({ ...current, [targetKey]: placeholder }));
      setMessages((current) => [...current, placeholder]);
    }
    // A newly submitted turn is the user's latest context, so bring it into
    // view even if the previous turn was being inspected above.
    if (userBubble === undefined) followLatest();

    let completed = false;
    let placeholderConversationKey = targetKey;
    let submissionKey = targetKey;
    try {
      let response: Response | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify(requestBody),
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 1) throw error;
        }
      }
      if (!response) throw lastError ?? new Error("chat request failed");
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const admission = await response.json().catch(() => ({})) as DurableAdmission;
        const accepted = admission.admissionKind === "accepted" || admission.admissionKind === "already_accepted";
        admitted = accepted;
        if (!response.ok && !accepted) throw new Error(admission.message ?? admission.error ?? `chat request failed (${response.status})`);
        const returnedConversationId = admission.conversationId;
        const returnedRunId = admission.runId;
        if (returnedConversationId) {
          placeholderConversationKey = returnedConversationId;
          if (submissionKey !== returnedConversationId) {
            setSubmitting((current) => {
              const next = { ...current, [returnedConversationId]: true };
              delete next[submissionKey];
              return next;
            });
            const pendingUsers = pendingUserMessagesRef.current[submissionKey];
            if (pendingUsers) {
              pendingUserMessagesRef.current[returnedConversationId] = pendingUsers.map((message) => ({
                ...message,
                runId: returnedRunId ?? message.runId,
              }));
              delete pendingUserMessagesRef.current[submissionKey];
            }
            submissionKey = returnedConversationId;
          } else if (returnedRunId) {
            pendingUserMessagesRef.current[submissionKey] = (pendingUserMessagesRef.current[submissionKey] ?? []).map((message) => ({
              ...message,
              runId: returnedRunId,
            }));
          }
          setPlaceholderMap((current) => {
            const next = { ...current, [returnedConversationId]: { id: placeholderId, runId: returnedRunId, role: "assistant" as const, content: "", tools: [], pending: true, status: admission.status ?? "queued" } };
            if (targetKey !== returnedConversationId) delete next[targetKey];
            return next;
          });
          if (ownsRequestSelection()) {
            selectedRef.current = returnedConversationId;
            setConversationId(returnedConversationId);
          }
        }
        completed = accepted && (admission.status === "completed" || admission.status === "failed" || admission.status === "cancelled");
      } else {
        if (!response.ok || !response.body) throw new Error(`chat request failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            const event = JSON.parse(payload) as ChatEvent;
            if (event.kind === "done" && event.name !== "error") completed = true;
            if (event.kind === "error") completed = false;
            if (event.kind === "conversation" && event.conversationId) streamConversationId = event.conversationId;
            if (ownsRequestSelection()) handleEvent(event);
          }
        }
      }
    } catch (error) {
      completed = false;
      if (ownsRequestSelection()) {
        setMessages((current) => current.map((message) => message.id === placeholderId
          ? { ...message, pending: false, status: "failed", content: `Connection error: ${String(error).slice(0, 200)}` }
          : message));
      }
    } finally {
      if (!admitted) {
        delete pendingUserMessagesRef.current[targetKey];
        if (submissionKey !== targetKey) delete pendingUserMessagesRef.current[submissionKey];
      }
      setSubmitting((current) => { const next = { ...current }; delete next[submissionKey]; return next; });
      setPlaceholderMap((current) => {
        const next = { ...current };
        if (completed) delete next[placeholderConversationKey];
        return next;
      });
      followLatest();
    }
    return completed;
  }

  function handleEvent(event: ChatEvent) {
    if (event.kind === "conversation" && event.conversationId) {
      setConversationId(event.conversationId);
      selectedRef.current = event.conversationId;
      return;
    }
    setMessages((current) => {
      if (current.length === 0) return current;
      const copy = [...current];
      const index = copy.length - 1;
      const last = { ...copy[index] };
      switch (event.kind) {
        case "delta": last.content += event.text ?? ""; break;
        case "tool": last.tools = [...(last.tools ?? []), event.name ?? "unknown tool"]; break;
        case "status": last.status = event.text ?? undefined; break;
        case "pause": last.pause = event.actions ?? []; last.pending = false; break;
        case "error": last.content = event.text ?? "The turn could not be completed."; last.status = event.code ?? "error"; last.pending = false; break;
        case "done": if (!last.content && event.text) last.content = event.text; last.pending = false; break;
      }
      copy[index] = last;
      return copy;
    });
    followLatest();
  }

  async function send() {
    const text = input.trim();
    if (!text || selectedBusy || loadingConversation) return;
    setInput("");
    setMentionOpen(false);
    const attached = documents.filter((document) => attachedDocumentIds.includes(document.id));
    setAttachedDocumentIds([]);
    const display = attached.length > 0 ? `${text}\n\nAttached: ${attached.map((document) => `@${document.title}`).join(", ")}` : text;
    await runTurn({ message: text, ...(conversationId ? { conversationId } : {}), documentIds: attached.map((document) => document.id) }, display);
  }

  const mentionQuery = useMemo(() => {
    const position = inputRef.current?.selectionStart ?? input.length;
    const match = input.slice(0, position).match(/(?:^|\s)@([^\s@]*)$/);
    return match ? match[1].toLowerCase() : null;
  }, [input]);
  const matchingDocuments = mentionQuery === null ? [] : documents
    .filter((document) => !attachedDocumentIds.includes(document.id))
    .filter((document) => document.title.toLowerCase().includes(mentionQuery))
    .slice(0, 5);

  function updateInput(value: string) {
    setInput(value);
    const position = inputRef.current?.selectionStart ?? value.length;
    setMentionOpen(/(?:^|\s)@([^\s@]*)$/.test(value.slice(0, position)));
  }

  function attachDocument(document: MentionableDocument) {
    const element = inputRef.current;
    const position = element?.selectionStart ?? input.length;
    const before = input.slice(0, position);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    const start = match ? before.length - match[0].length + (match[0].startsWith(" ") ? 1 : 0) : position;
    const next = `${input.slice(0, start)}@${document.title} ${input.slice(position)}`;
    setInput(next);
    setAttachedDocumentIds((current) => [...current, document.id]);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const cursor = start + document.title.length + 2;
      element?.focus();
      element?.setSelectionRange(cursor, cursor);
    });
  }

  async function answer(answers: AnswerPayload[]) {
    if (!conversationId || submitting[conversationId]) return;
    const summary = answers.map((answer) => answer.decision === "allow" ? "Approved" : answer.decision === "deny" ? "Denied" : answer.content?.trim() ?? "").filter(Boolean).join(" · ");
    const completed = await runTurn({ answers, conversationId }, summary);
    if (completed) {
      const selectors = new Set(answers.map((answer) => answer.selector));
      setMessages((current) => current.map((message) => {
        const pause = message.pause?.filter((action) => !selectors.has(action.selector));
        return message.pause ? { ...message, pause: pause?.length ? pause : undefined } : message;
      }));
    }
  }

  return (
    <main className="relative flex h-full min-w-0 bg-deck">
      <section className="console-grid relative flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-md border border-line-strong bg-panel text-ink-soft shadow-lg transition-colors hover:text-ink lg:hidden"
          aria-label="Open conversations"
        >
          <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true"><path d="M3.5 4.5h11v8H8l-3 2v-2H3.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6.5 7h5M6.5 9.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        </button>

        <div className="relative min-h-0 flex-1">
          <div ref={scrollAreaRef} className="scrollbar-none h-full overflow-y-auto px-4 py-6 sm:px-8">
            {loadingConversation ? (
              <ChatLoadingSkeleton />
            ) : messages.length === 0 ? (
              <EmptyState onPick={setInput} />
            ) : null}

            <div className="mx-auto max-w-3xl space-y-7">
              {messages.slice(0, Math.max(latestUserIndex, 0)).map((message, index) => (
                <Message
                  key={message.id ?? index}
                  message={message}
                  busy={Boolean(conversationId && submitting[conversationId])}
                  onAnswer={(a) => void answer(a)}
                />
              ))}
              {latestUserIndex >= 0 ? (
                <div
                  className="space-y-7"
                  style={pinLatestTurn ? { minHeight: scrollViewportHeight } : undefined}
                >
                  {messages.slice(latestUserIndex).map((message, turnIndex) => {
                    const index = latestUserIndex + turnIndex;
                    const rendered = (
                      <Message
                        key={message.id ?? index}
                        message={message}
                        busy={Boolean(conversationId && submitting[conversationId])}
                        onAnswer={(a) => void answer(a)}
                      />
                    );
                    if (turnIndex !== 0) return rendered;
                    return (
                      <div
                        key={`pinned-${message.id ?? index}`}
                        ref={latestTurnRef}
                        className="-mx-2 px-2 py-3 sm:-mx-4 sm:px-4"
                        aria-label="Latest message"
                      >
                        {rendered}
                      </div>
                    );
                  })}
                </div>
              ) : messages.map((message, index) => (
                <Message
                  key={message.id ?? index}
                  message={message}
                  busy={Boolean(conversationId && submitting[conversationId])}
                  onAnswer={(a) => void answer(a)}
                />
              ))}
            </div>
          </div>
          {showJumpToLatest && (
            <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center sm:inset-x-8">
              <button
                type="button"
                onClick={jumpToLatest}
                className="pointer-events-auto shrink-0 rounded-full border border-line-strong bg-panel-hi px-4 py-2 text-xs font-medium text-ink shadow-lg shadow-black/20 transition-colors hover:border-signal/60 hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50"
              >
                Jump to Latest
              </button>
            </div>
          )}
        </div>

        <footer className="bg-deck/90 p-3 backdrop-blur sm:p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="signal-glow mx-auto flex max-w-3xl flex-col rounded-2xl border border-line-strong bg-panel-hi px-4 pb-3 pt-3 focus-within:border-signal/60"
          >
            <label htmlFor="mission-input" className="sr-only">Assign work</label>
            {attachedDocumentIds.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{documents.filter((document) => attachedDocumentIds.includes(document.id)).map((document) => <span key={document.id} className="inline-flex items-center gap-1 rounded border border-signal/35 bg-signal/[0.08] px-2 py-1 text-[10px] text-signal"><span className="max-w-48 truncate">@{document.title}</span><button type="button" onClick={() => setAttachedDocumentIds((current) => current.filter((id) => id !== document.id))} className="ml-0.5 text-signal/75 hover:text-ink" aria-label={`Remove ${document.title}`}>×</button></span>)}</div>}
            <textarea
              id="mission-input"
              ref={inputRef}
              value={input}
              onChange={(event) => updateInput(event.target.value)}
              onClick={() => setMentionOpen(mentionQuery !== null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={selectedBusy ? "The fleet is working..." : "Assign work or ask a follow-up"}
              disabled={selectedBusy || loadingConversation}
              rows={2}
              className="scrollbar-none min-h-[58px] w-full resize-none border-0 bg-transparent text-sm leading-6 text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
            />
            {mentionOpen && matchingDocuments.length > 0 && <div className="mb-2 overflow-hidden rounded-md border border-line-strong bg-deck shadow-xl"><p className="border-b border-line px-3 py-2 font-mono text-[8px] uppercase tracking-[0.13em] text-ink-faint">Attach a document</p>{matchingDocuments.map((document) => <button key={document.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => attachDocument(document)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-panel-hi"><span className="text-signal">@</span><span className="min-w-0"><span className="block truncate text-xs font-medium text-ink">{document.title}</span><span className="mt-0.5 block text-[9px] text-ink-faint">{document.authorRole === "user" ? "Your document" : "Agent document"}</span></span></button>)}</div>}
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-ink-faint">Enter to send</span>
              <span className="text-[10px] text-ink-faint">Shift + Enter for a new line</span>
              <button
                type="submit"
                disabled={selectedBusy || loadingConversation || !input.trim()}
                className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal text-deck transition-transform hover:scale-[1.03] disabled:opacity-25"
                aria-label="Send request"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true"><path d="m4 10 11-6-3.3 12-2-4.2L4 10Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m9.7 11.8 2-2.2" stroke="currentColor" strokeWidth="1.6" /></svg>
              </button>
            </div>
          </form>
        </footer>
      </section>

      <aside className="hidden w-[286px] shrink-0 flex-col border-l border-line bg-panel/70 lg:flex">
        <SideContent
          conversations={conversations}
          activeId={conversationId}
          runStatusByConversation={runStatusByConversation}
          submitting={submitting}
          loadingConversationId={loadingConversationId}
          loadingConversations={summaryRows === undefined}
          onNew={newConversation}
          onSelect={selectConversation}
          onDelete={setDeleteTarget}
        />
      </aside>

      {historyOpen && (
        <div
          className="absolute inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-[2px] lg:hidden"
          onClick={() => setHistoryOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Conversations"
        >
          <aside
            className="flex h-full w-[min(330px,calc(100%-28px))] flex-col border-l border-line bg-panel shadow-[-24px_0_60px_rgba(0,0,0,.4)]"
            onClick={(event) => event.stopPropagation()}
          >
            <SideContent
              conversations={conversations}
              activeId={conversationId}
              runStatusByConversation={runStatusByConversation}
              submitting={submitting}
              loadingConversationId={loadingConversationId}
              loadingConversations={summaryRows === undefined}
              onClose={() => setHistoryOpen(false)}
              onNew={newConversation}
              onSelect={selectConversation}
              onDelete={setDeleteTarget}
            />
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this chat?"
        description={`"${deleteTarget?.title ?? "This chat"}" and all of its messages will be removed permanently.`}
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteConversation()}
      />

    </main>
  );
}

function SideContent({
  conversations,
  activeId,
  runStatusByConversation,
  submitting,
  loadingConversationId,
  loadingConversations,
  onNew,
  onSelect,
  onDelete,
  onClose,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  runStatusByConversation: Record<string, RunStatus>;
  submitting: Record<string, boolean>;
  loadingConversationId: string | null;
  loadingConversations: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-1 px-3">
        <span className="px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Conversations</span>
        <button
          type="button"
          onClick={onNew}
          aria-label="Start a new chat"
          className="ml-auto inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-panel-hi px-3 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-ink transition-colors hover:border-signal/60 hover:bg-signal/10 hover:text-ink disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-signal" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span>New chat</span>
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            aria-label="Close panel"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-3">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          runStatusByConversation={runStatusByConversation}
          submitting={submitting}
          loadingConversationId={loadingConversationId}
          loadingConversations={loadingConversations}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>
    </>
  );
}

function ConversationListSkeleton() {
  const widths = ["w-[82%]", "w-[64%]", "w-[74%]"];
  return (
    <div className="space-y-3" role="status" aria-label="Loading conversations">
      <span className="sr-only">Loading conversations…</span>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="h-2 w-2 rounded-full shimmer" />
        <div className="h-2 w-16 rounded-full shimmer" />
        <div className="ml-auto h-2 w-3 rounded-full shimmer" />
      </div>
      <div className="space-y-1">
        {widths.map((width) => (
          <div key={width} className="flex items-center gap-2 rounded-md px-3 py-2.5">
            <div className="h-3 w-3 shrink-0 rounded-sm shimmer" />
            <div className={`h-3 ${width} rounded shimmer`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConversationList({
  conversations,
  activeId,
  runStatusByConversation,
  submitting,
  loadingConversationId,
  loadingConversations,
  onSelect,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  runStatusByConversation: Record<string, RunStatus>;
  submitting: Record<string, boolean>;
  loadingConversationId: string | null;
  loadingConversations: boolean;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  if (loadingConversations) return <ConversationListSkeleton />;
  if (conversations.length === 0) {
    return <p className="px-2 py-4 text-xs leading-relaxed text-ink-faint">Past commands will appear here.</p>;
  }
  const groups = groupConversations(conversations);
  return groups.map((group) => (
    <details key={group.label} open className="group/day-group mb-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open/day-group:rotate-90" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {group.label}
        <span className="ml-auto tabular-nums">{group.items.length}</span>
      </summary>
      <div className="mt-1 space-y-1">
        {group.items.map((conversation) => {
          const status = runStatusByConversation[conversation.id] ?? conversation.runStatus;
          const workerProcessing = Boolean(submitting[conversation.id])
            || (typeof status === "string" && ACTIVE_RUN_STATUSES.has(status));

          return (
            <div
              key={conversation.id}
              className={`group/chat-row flex items-center gap-1 rounded-md transition-colors ${
                activeId === conversation.id ? "bg-panel-hi text-ink" : "text-ink-soft hover:bg-panel-hi hover:text-ink"
              }`}
            >
              <button
                onClick={() => onSelect(conversation.id)}
                disabled={loadingConversationId === conversation.id}
                className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong disabled:opacity-50"
              >
                <span className="line-clamp-2 text-xs font-medium leading-snug">{conversation.title}</span>
              </button>
              {workerProcessing ? (
                <span
                  className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center text-signal"
                  role="status"
                  aria-label={`${conversation.title} is being processed`}
                  title="Worker is processing this chat"
                >
                  <svg viewBox="0 0 20 20" className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true">
                    <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                    <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={isActiveStatus(status)}
                  onClick={() => onDelete(conversation)}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-colors hover:bg-signal/10 hover:text-signal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100"
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete conversation"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3m-5.1 0 .55 8h5.7l.55-8M7 7v3.2m2-3.2v3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </details>
  ));
}

function groupConversations(conversations: ConversationSummary[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const groups = [
    { label: "Today", items: [] as ConversationSummary[] },
    { label: "Yesterday", items: [] as ConversationSummary[] },
    { label: "Past week", items: [] as ConversationSummary[] },
  ];

  for (const conversation of conversations) {
    const updated = new Date(conversation.updatedAt);
    if (updated >= today) groups[0].items.push(conversation);
    else if (updated >= yesterday) groups[1].items.push(conversation);
    else groups[2].items.push(conversation);
  }

  return groups.filter((group) => group.items.length > 0);
}

interface HeroCopy {
  eyebrow: string;
  heading: string;
}

const DEFAULT_HERO: HeroCopy = {
  eyebrow: "Ready when you are",
  heading: "What are we getting done?",
};

function heroCopyForHour(hour: number): HeroCopy {
  if (hour < 5) return { eyebrow: "After hours", heading: "Burning the midnight oil?" };
  if (hour < 9) return { eyebrow: "Early start", heading: "Up early. What are we getting done?" };
  if (hour < 12) return { eyebrow: "Morning shift", heading: "What should we knock out this morning?" };
  if (hour < 17) return { eyebrow: "Afternoon run", heading: "What's next on the worklist?" };
  if (hour < 21) return { eyebrow: "Evening push", heading: "One more thing off the list?" };
  return { eyebrow: "Late shift", heading: "Up for a late-night jam session?" };
}

function ChatLoadingSkeleton() {
  return (
    <div
      className="mx-auto max-w-3xl space-y-8"
      role="status"
      aria-label="Loading conversation"
    >
      <span className="sr-only">Loading conversation…</span>
      <div className="flex justify-end">
        <div className="w-[min(70%,24rem)] space-y-2">
          <div className="ml-auto h-2 w-10 rounded-full shimmer" />
          <div className="ml-auto h-3 w-[78%] rounded shimmer" />
          <div className="ml-auto h-3 w-[56%] rounded shimmer" />
        </div>
      </div>
      <div className="relative space-y-3 pl-6 before:absolute before:bottom-0 before:left-[3px] before:top-0 before:w-px before:bg-line">
        <span aria-hidden="true" className="absolute left-0 top-1.5 h-[7px] w-[7px] rounded-full shimmer" />
        <div className="h-2 w-20 rounded-full shimmer" />
        <div className="space-y-2 pt-1">
          <div className="h-3 w-[92%] rounded shimmer" />
          <div className="h-3 w-[84%] rounded shimmer" />
          <div className="h-3 w-[61%] rounded shimmer" />
        </div>
      </div>
      <div className="relative space-y-3 pl-6 before:absolute before:bottom-0 before:left-[3px] before:top-0 before:w-px before:bg-line">
        <span aria-hidden="true" className="absolute left-0 top-1.5 h-[7px] w-[7px] rounded-full shimmer" />
        <div className="h-2 w-24 rounded-full shimmer" />
        <div className="h-3 w-[73%] rounded shimmer" />
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  const [hero, setHero] = useState<HeroCopy>(DEFAULT_HERO);

  useEffect(() => {
    const syncToClock = () => setHero(heroCopyForHour(new Date().getHours()));
    syncToClock();
    const timer = window.setInterval(syncToClock, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto mt-[4vh] max-w-3xl sm:mt-[6vh]">
      <div className="flex items-center gap-3">
        <span className="h-px w-8 bg-signal" />
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-signal">{hero.eyebrow}</p>
      </div>
      <h1 className="mt-4 max-w-2xl font-display text-[clamp(1.7rem,3.6vw,3rem)] font-extrabold leading-[1.02] tracking-[-0.04em] text-ink">{hero.heading}</h1>
      <p className="mt-4 max-w-lg text-sm leading-6 text-ink-soft">
        Brief the squad. It will break the work into tasks, run them in parallel,
        and pause before anything irreversible.
      </p>
      <div className="relative mt-6 space-y-1 pl-5 before:absolute before:bottom-4 before:left-[3px] before:top-4 before:w-px before:bg-line">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint">Try a request</p>
        {EXAMPLE_REQUESTS.map((request) => (
          <button
            key={request}
            onClick={() => onPick(request)}
            className="group relative flex w-full items-start gap-3 rounded-md px-3 py-3 text-left text-ink-soft transition-colors hover:bg-panel-hi hover:text-ink"
          >
            <span aria-hidden="true" className="absolute left-[-21px] top-[18px] h-[7px] w-[7px] rounded-full border border-line-strong bg-deck transition-colors group-hover:border-signal group-hover:bg-signal" />
            <span className="text-[13px] leading-relaxed">{request}</span>
            <svg viewBox="0 0 16 16" className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-signal" aria-hidden="true"><path d="M4 12 12 4m-5 0h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message, busy, onAnswer }: { message: Msg; busy: boolean; onAnswer?: (answers: AnswerPayload[]) => void }) {
  const completion = completionStatus(message.status);
  const failed = Boolean(completion?.failed);
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-right">
          <p className="mb-1 font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">You</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-6 before:absolute before:bottom-0 before:left-[3px] before:top-0 before:w-px before:bg-line">
      <span aria-hidden="true" className={`absolute left-0 top-1.5 h-[7px] w-[7px] rounded-full ${failed ? "bg-error" : message.pending ? "bg-signal led-live" : message.pause?.length ? "border border-state-blocked bg-state-blocked/30" : "border border-line bg-deck"}`} />
      <p className={`mb-2 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.2em] ${failed ? "text-error" : "text-state-working"}`}>
        {failed ? "Error" : "Squad Lead"}
        {message.pending && <span className="tool-activity-live text-ink-faint">{message.status === RETRYING_STATUS ? "Retrying" : "Thinking"}</span>}
        {!message.pending && message.pause?.length ? <span className="text-state-blocked">paused, input needed</span> : null}
      </p>
      {(message.tools?.length ?? 0) > 0 && (
        <ToolActivity tools={message.tools!} active={Boolean(message.pending)} state={message.toolState} />
      )}
      {failed ? (
        <div role="alert" className="mt-2 rounded-md border border-error/60 bg-error/10 px-3 py-2.5 text-sm leading-relaxed text-error">
          {message.content || "The response could not be completed."}
        </div>
      ) : message.content ? <ChatMarkdown>{message.content}</ChatMarkdown> : null}
      {!message.pending && (message.pause?.length ?? 0) > 0 && onAnswer && (
        <PauseBlock actions={message.pause!} busy={busy} onAnswer={onAnswer} />
      )}
      {completion && !completion.failed && !message.pending && (
        <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">
          {completion.text}
        </div>
      )}
    </div>
  );
}

function ToolActivity({ tools, active, state }: { tools: string[]; active: boolean; state?: string }) {
  const latest = tools[tools.length - 1];
  const extra = tools.length > 1 ? ` + ${tools.length - 1}` : "";
  const terminal = state === "output-available" || state === "output-error" || state === "output-denied" || state === "approval-requested";
  const live = active && !terminal;
  return (
    <details className="group mb-3 max-w-xl">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[10px] leading-relaxed text-ink-faint [&::-webkit-details-marker]:hidden">
        <span className={`min-w-0 truncate ${live ? "tool-activity-live" : ""}`}>{toolActivityLabel(latest, live, state)}{extra}</span>
        <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90" aria-hidden="true">
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="mt-1.5 border-l border-line pl-3">
        <ol className="space-y-1.5">
          {tools.map((tool, index) => (
            <li key={`${tool}-${index}`} className="flex items-start gap-2 font-mono text-[10px] leading-relaxed text-ink-soft">
              <span className="w-4 shrink-0 text-right tabular-nums text-ink-faint">{index + 1}</span>
              <code className="break-all">{tool}</code>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

const TOOL_ACTIVITY: Record<string, { active: string; done: string }> = {
  list_tools: { active: "Checking available actions", done: "Checked available actions" },
  get_tool_info: { active: "Reading action details", done: "Read action details" },
  call_tool: { active: "Using a connected service", done: "Used a connected service" },
  list_board: { active: "Checking the fleet", done: "Checked the fleet" },
  get_task: { active: "Reading task details", done: "Read task details" },
  create_mission: { active: "Creating a task group", done: "Created a task group" },
  create_task: { active: "Adding work to the board", done: "Added work to the board" },
  dispatch_task: { active: "Starting an agent", done: "Started an agent" },
  dispatch_ready: { active: "Starting ready agents", done: "Started ready agents" },
  create_schedule: { active: "Creating a schedule", done: "Created a schedule" },
  list_schedules: { active: "Checking schedules", done: "Checked schedules" },
  cancel_schedule: { active: "Cancelling a schedule", done: "Cancelled a schedule" },
  list_docs: { active: "Checking saved documents", done: "Checked saved documents" },
  get_doc: { active: "Reading a document", done: "Read a document" },
  save_document: { active: "Saving a document", done: "Saved a document" },
};

function toolActivityLabel(tool: string, active: boolean, state?: string): string {
  const base = tool.split(".").pop() ?? tool;
  const readable = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (state === "approval-requested") return `Waiting for approval · ${readable || "tool action"}`;
  if (state === "output-error") return `${readable || "Tool action"} failed`;
  if (state === "output-denied") return `${readable || "Tool action"} denied`;
  const known = TOOL_ACTIVITY[base];
  if (known) return active ? known.active : known.done;
  return `${active ? "Using" : "Used"} ${readable || "a tool"}`;
}

function completionStatus(status?: string): { text: string; failed: boolean } | null {
  if (!status) return null;
  const normalized = status.trim().toLowerCase();
  if (normalized === "failed" || normalized === "error" || normalized.includes("failed")) {
    return { text: "failed", failed: true };
  }
  if (["completed", "done", "unknown"].includes(normalized)) return null;
  const tokenMatch = status.match(/(?:^|·)\s*([\d,]+)\s+tokens\b/i);
  if (tokenMatch) return { text: `${tokenMatch[1]} tokens`, failed: false };
  const outputMatch = status.match(/\bout\s+([\d,]+)\b/i);
  return outputMatch ? { text: `${outputMatch[1]} tokens`, failed: false } : null;
}

function PauseBlock({
  actions,
  busy,
  onAnswer,
}: {
  actions: PauseAction[];
  busy: boolean;
  onAnswer: (answers: AnswerPayload[]) => void;
}) {
  return (
    <div className="mt-3 max-w-xl space-y-3">
      {actions.map((action) => (
        <PauseActionCard key={action.selector} action={action} busy={busy} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function PauseActionCard({
  action,
  busy,
  onAnswer,
}: {
  action: PauseAction;
  busy: boolean;
  onAnswer: (answers: AnswerPayload[]) => void;
}) {
  const [custom, setCustom] = useState("");

  const submitResponse = (content: string) => {
    if (!content.trim() || busy) return;
    onAnswer([{ selector: action.selector, content: content.trim() }]);
  };

  const isApproval = action.type === "tool.approval_required";
  const isQuestion = action.type === "tool.response_required";
  return (
    <div className={`rounded-lg border p-4 ${isQuestion ? "border-line-strong bg-panel-hi" : "border-signal/50 bg-signal/5"}`}>
      <p className={`mb-1 font-mono text-[8px] uppercase tracking-[0.2em] ${isQuestion ? "text-state-blocked" : "text-signal"}`}>
        {isQuestion ? "Orchestrator asks" : isApproval ? "Approval required" : `Paused · ${action.type}`}
      </p>
      {isApproval && action.name && <p className="mb-2 text-xs text-ink">{action.name}</p>}
      {action.question && (
        <p className="mb-3 text-sm leading-relaxed text-ink">{action.question}</p>
      )}
      {!isQuestion && (
        <pre className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded border border-line bg-deck p-2 font-mono text-[10px] text-ink-faint">
          {action.argsPreview}
        </pre>
      )}
      {isApproval && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onAnswer([{ selector: action.selector, decision: "allow" }])}
            disabled={busy}
            className="rounded-md bg-signal px-3 py-1.5 text-[11px] font-semibold text-deck transition-transform hover:scale-[1.02] disabled:opacity-25"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onAnswer([{ selector: action.selector, decision: "deny" }])}
            disabled={busy}
            className="rounded-md border border-line-strong bg-panel px-3 py-1.5 text-[11px] font-semibold text-ink-soft transition-colors hover:border-state-blocked hover:text-ink disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      )}
      {isQuestion && (action.options?.length ?? 0) > 0 && (
        <div className="mb-2 space-y-1.5">
          {action.options?.map((option) => (
            <button
              key={option}
              onClick={() => submitResponse(option)}
              disabled={busy}
              className="block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-left text-xs leading-snug text-ink transition-colors hover:border-signal hover:bg-signal/10 disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {isQuestion && <form
        onSubmit={(event) => {
          event.preventDefault();
          submitResponse(custom);
          setCustom("");
        }}
        className="flex gap-2"
      >
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Or type your own answer…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-line bg-deck px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={busy || !custom.trim()}
          className="rounded-md bg-signal px-3 py-1.5 text-[11px] font-semibold text-deck transition-transform hover:scale-[1.02] disabled:opacity-25"
        >
          Reply
        </button>
      </form>}
      {!isQuestion && !isApproval && (
        <p className="text-xs text-ink-soft">This pause needs a supported response outside chat.</p>
      )}
    </div>
  );
}

function parsePauseArray(parsed: unknown[]): PauseAction[] | undefined {
  const actions = parsed.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const action = item as Record<string, unknown>;
    if (typeof action.type !== "string" || typeof action.selector !== "string" || !action.selector.trim()) return [];
    return [{
      selector: action.selector,
      type: action.type,
      name: typeof action.name === "string" ? action.name : undefined,
      question: typeof action.question === "string" ? action.question : undefined,
      options: Array.isArray(action.options) && action.options.every((option) => typeof option === "string")
        ? action.options
        : undefined,
      argsPreview: typeof action.argsPreview === "string" ? action.argsPreview : undefined,
    }];
  });
  return actions.length > 0 ? actions : undefined;
}
