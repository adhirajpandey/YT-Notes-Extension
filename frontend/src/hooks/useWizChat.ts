import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, conversationsApi, normalizeApiError, normalizeFetchError, readSseEvents } from '../api';
import type { NormalizedApiError } from '../api/errors';
import { parseWizEvent, type MessagePart, type WizStreamEvent } from '../api/messageParts';
import { getToken } from '../lib/authUtils';

export interface WizMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  serverMessageId?: number;
  createdAt: Date;
  status?: 'running' | 'complete' | 'error';
  error?: { message: string; requestId?: string };
}

type Limit = { kind: 'guest' | 'user'; resetSeconds: number | null };
interface Session {
  generation: number;
  videoId: string;
  conversationId: number | null;
  creation?: Promise<number | null>;
  request?: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** VidWiz transport and state. UI libraries adapt these domain values at their boundary. */
export function useWizChat(videoId: string | null, isReady: boolean) {
  const [messages, setMessages] = useState<WizMessage[]>([]);
  const [generation, setGeneration] = useState(0);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [conversationError, setConversationError] = useState<NormalizedApiError | null>(null);
  const [limit, setLimit] = useState<Limit | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const active = useRef<Session | null>(null);
  const sequence = useRef(0);

  const createConversation = useCallback((session: Session): Promise<number | null> => {
    if (active.current !== session) return Promise.resolve(null);
    if (session.creation) return session.creation;
    if (session.conversationId !== null) return Promise.resolve(session.conversationId);
    setIsCreatingConversation(true);
    setConversationError(null);
    if (!getToken() && !sessionStorage.getItem('guestSessionId')) {
      sessionStorage.setItem('guestSessionId', crypto.randomUUID());
    }
    session.creation = (async () => {
      try {
        const result = await conversationsApi.createConversation({ video_id: session.videoId });
        if (active.current !== session) return null;
        session.conversationId = result.id;
        setConversationId(result.id);
        return result.id;
      } catch (error) {
        if (active.current !== session) return null;
        const normalized = normalizeApiError(error, 'Unable to start a conversation. Please try again.');
        if (!normalized.handled) setConversationError(normalized);
        return null;
      } finally {
        if (active.current === session) {
          session.creation = undefined;
          setIsCreatingConversation(false);
        }
      }
    })();
    return session.creation;
  }, []);

  const startSession = useCallback(() => {
    active.current?.request?.abort();
    const session: Session | null = videoId
      ? { generation: ++sequence.current, videoId, conversationId: null }
      : null;
    active.current = session;
    setGeneration(sequence.current);
    setConversationId(null);
    setMessages([]);
    setIsRunning(false);
    setIsCreatingConversation(Boolean(session));
    setConversationError(null);
    setLimit(null);
    setIsProcessing(false);
    // Defer the initial POST so React StrictMode's discarded effect creates no conversation.
    queueMicrotask(() => {
      if (session && active.current === session) void createConversation(session);
    });
  }, [videoId, createConversation]);

  useEffect(() => {
    startSession();
    return () => {
      active.current?.request?.abort();
      active.current = null;
    };
  }, [startSession]);

  const retryConversation = useCallback(async () => {
    const session = active.current;
    if (session) await createConversation(session);
  }, [createConversation]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    const session = active.current;
    if (!message || !session || session.videoId !== videoId || !isReady ||
        conversationError || session.creation || session.request || session.conversationId === null) return;
    const id = session.conversationId;
    const controller = new AbortController();
    // Synchronous guard, independent of the next React render.
    session.request = controller;
    const isCurrent = () => active.current === session && session.conversationId === id &&
      session.request === controller && !controller.signal.aborted;
    setIsRunning(true);
    const assistantId = crypto.randomUUID();
    setMessages(previous => [...previous,
      { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: message }], createdAt: new Date() },
      { id: assistantId, role: 'assistant', parts: [], createdAt: new Date(), status: 'running' },
    ]);
    const update = (patch: Partial<WizMessage>) => {
      if (isCurrent()) setMessages(previous => previous.map(item =>
        item.id === assistantId ? { ...item, ...patch } : item));
    };
    const removePlaceholder = () => {
      if (isCurrent()) setMessages(previous => previous.filter(item => item.id !== assistantId));
    };
    const parts: MessagePart[] = [];
    let requestId: string | undefined;
    let displayError: WizMessage['error'];
    try {
      const response = await apiFetch(conversationsApi.getSendMessageUrl(id), {
        method: 'POST', body: JSON.stringify({ message }), signal: controller.signal,
      });
      if (!isCurrent()) return;
      requestId = response.headers.get('X-Request-ID') ?? undefined;
      if (response.status === 401) {
        removePlaceholder();
        return;
      }
      if (response.status === 429) {
        const error = await normalizeFetchError(response, 'You have reached the current chat limit.');
        if (!isCurrent()) return;
        removePlaceholder();
        setLimit({ kind: getToken() ? 'user' : 'guest', resetSeconds: error.retryAfterSeconds ?? null });
        return;
      }
      if (response.status === 202) {
        let processingMessage = 'Transcript processing';
        try {
          const data: unknown = await response.json();
          if (isRecord(data) && typeof data.message === 'string') processingMessage = data.message;
        } catch { /* Keep the existing processing fallback. */ }
        if (!isCurrent()) return;
        update({ parts: [{ type: 'text', text: processingMessage }], status: 'complete' });
        setIsProcessing(true);
        return;
      }
      if (!response.ok) {
        const error = await normalizeFetchError(response, 'Chat is temporarily unavailable. Please try again.');
        displayError = { message: error.message, requestId: error.requestId ?? requestId };
        throw new Error('Chat request failed');
      }
      if (!response.body) {
        displayError = { message: 'The chat response could not be read. Please try again.', requestId };
        throw new Error('Missing response body');
      }
      let done = false;
      for await (const event of readSseEvents(response.body)) {
        if (!isCurrent()) return;
        let data: WizStreamEvent;
        try { data = parseWizEvent(JSON.parse(event.data)); } catch {
          displayError = { message: 'The server returned an invalid chat response.', requestId };
          throw new Error('Invalid stream event');
        }
        if (data.type === 'done') {
          done = true;
          update({ serverMessageId: data.message_id });
          break;
        }
        if (data.type === 'error') {
          displayError = { message: data.message, requestId };
          throw new Error('Stream error');
        }
        parts.push(data);
        update({ parts: [...parts] });
      }
      const hasText = parts.some(part => part.type === 'text' && part.text.trim());
      if (!hasText || !done) {
        update({ status: 'error', error: {
          message: parts.length ? 'The response was interrupted. Please try again.' : 'No response received. Please try again.',
          requestId,
        } });
      } else update({ status: 'complete' });
    } catch {
      update({ status: 'error', error: displayError ?? {
        message: 'The chat connection failed. Please try again.', requestId,
      } });
    } finally {
      if (isCurrent()) {
        session.request = undefined;
        setIsRunning(false);
      }
      // Release this Fetch stream only; this does not cancel server-side generation.
      controller.abort();
    }
  }, [videoId, isReady, conversationError]);

  return {
    messages, generation, conversationId, isRunning, isCreatingConversation, conversationError,
    isSendDisabled: isRunning || isCreatingConversation || !isReady || Boolean(conversationError) || conversationId === null,
    send, newChat: startSession, retryConversation, limit, isProcessing,
    dismissLimit: () => setLimit(null), dismissProcessing: () => setIsProcessing(false),
  };
}

export type WizChatController = ReturnType<typeof useWizChat>;
