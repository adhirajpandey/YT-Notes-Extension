import { useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  AssistantRuntimeProvider, useExternalStoreRuntime, useAui, useAuiState,
  ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ActionBarPrimitive,
} from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Check, Copy, RotateCcw, Sparkles } from 'lucide-react';
import type { WizChatController, WizMessage } from '../../hooks/useWizChat';
import ErrorState from '../ui/ErrorState';
import WizMarkdown from './WizMarkdown';
import WizCitation, { WizSeekProvider } from './WizCitation';
import './wiz-chat.css';

function convertMessage(message: WizMessage): ThreadMessageLike {
  return {
    id: message.id, role: message.role, createdAt: message.createdAt,
    content: message.parts.map(part => part.type === 'text' ? part
      : { type: 'data' as const, name: 'citation', data: part }),
    ...(message.role === 'assistant' ? {
      status: message.status === 'running' ? { type: 'running' as const }
        : message.status === 'error' ? { type: 'incomplete' as const, reason: 'error' as const }
        : { type: 'complete' as const, reason: 'stop' as const },
    } : {}),
    metadata: { custom: { displayError: message.error ?? null } },
  };
}

function UserMessage() {
  return <MessagePrimitive.Root className="flex justify-end py-3">
    <div className="max-w-[90%] rounded-2xl rounded-br-sm bg-violet-600 px-4 py-3 text-sm leading-6 whitespace-pre-wrap break-words text-white">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>;
}

function AssistantMessage() {
  const running = useAuiState(s => s.message.status?.type === 'running');
  const hasText = useAuiState(s => s.message.content.some(part => part.type === 'text' && part.text.length > 0));
  const error = useAuiState(s => s.message.metadata.custom.displayError) as WizMessage['error'];
  const copied = useAuiState(s => s.message.isCopied);
  return <MessagePrimitive.Root className="py-3 min-w-0">
    <div className="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground">
      <Sparkles className="size-3.5 text-violet-500" />Wiz
      {running && <span role="status" className="font-normal motion-safe:animate-pulse">{hasText ? 'Answering…' : 'Thinking…'}</span>}
    </div>
    <MessagePrimitive.Parts components={{ Text: WizMarkdown, data: { by_name: { citation: WizCitation } } }} />
    {error && <div role="alert" className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-foreground">
      <p>{error.message}</p>
      {error.requestId && <p className="mt-1 text-xs text-muted-foreground">Reference: {error.requestId}</p>}
    </div>}
    {hasText && !running && <ActionBarPrimitive.Root className="mt-2">
      <ActionBarPrimitive.Copy aria-label={copied ? 'Copied answer' : 'Copy answer'} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}

function StarterQuestions({ questions }: { questions?: string[] | null }) {
  const aui = useAui();
  return <div className="flex flex-col items-center justify-center text-center py-10 px-2">
    <div className="size-14 rounded-2xl bg-violet-500/10 flex items-center justify-center mb-4 border border-violet-500/20"><Sparkles className="size-7 text-violet-500" /></div>
    <h3 className="text-lg font-semibold mb-2">Ready to chat!</h3>
    <p className="text-muted-foreground text-sm max-w-xs leading-relaxed mb-6">Ask about this video. Follow timestamp citations to jump straight to the source.</p>
    {questions?.length === 3 && <div className="flex flex-col gap-2 w-full">
      {questions.map(question => <button key={question} type="button"
        onClick={() => { aui.composer.setText(question); }}
        className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-left text-sm text-foreground/80 hover:bg-muted hover:border-violet-500/40 transition-colors"
      >{question}</button>)}
    </div>}
  </div>;
}

interface Props {
  chat: WizChatController;
  isReady: boolean;
  suggestedQuestions?: string[] | null;
  onSeek: (seconds: number) => void;
  statusBanner: ReactNode;
}

export default function WizChat({ chat, isReady, suggestedQuestions, onSeek, statusBanner }: Props) {
  const { send } = chat;
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    await send(text);
  }, [send]);
  const runtime = useExternalStoreRuntime({
    messages: chat.messages, convertMessage, onNew,
    isRunning: chat.isRunning, isSendDisabled: chat.isSendDisabled,
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <WizSeekProvider value={onSeek}>
      <ThreadPrimitive.Root className="w-full lg:w-[45%] flex flex-col rounded-2xl bg-card border border-border overflow-hidden h-[560px] lg:h-auto lg:min-h-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2"><Sparkles className="size-4 text-violet-500" /><h2 className="text-sm font-semibold">Wiz Chat</h2></div>
          {chat.messages.length > 0 && <button type="button" onClick={chat.newChat} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"><RotateCcw className="size-3.5" />New</button>}
        </div>
        {statusBanner}
        <div className="relative flex flex-1 min-h-0 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 md:px-5 py-2" autoScroll>
            {chat.conversationError && <ErrorState compact title="Unable to start chat" message={chat.conversationError.message} referenceId={chat.conversationError.requestId} onRetry={() => void chat.retryConversation()} />}
            {isReady && !chat.conversationError && <ThreadPrimitive.Empty><StarterQuestions questions={suggestedQuestions} /></ThreadPrimitive.Empty>}
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <div className="sticky bottom-2 flex justify-center pointer-events-none">
              <ThreadPrimitive.ScrollToBottom aria-label="Scroll to latest message" className="pointer-events-auto rounded-full border border-border bg-card p-2 shadow-md disabled:hidden"><ArrowDown className="size-4" /></ThreadPrimitive.ScrollToBottom>
            </div>
          </ThreadPrimitive.Viewport>
        </div>
        <div className="p-3 md:p-4 border-t border-border">
          <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-input bg-muted/30 p-2 focus-within:border-violet-500/60 focus-within:ring-2 focus-within:ring-violet-500/10">
            <ComposerPrimitive.Input aria-label="Message Wiz" placeholder={isReady ? 'Ask about this video...' : 'Waiting for transcript...'} submitMode="enter" rows={1} className="flex-1 min-w-0 max-h-36 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground" />
            <ComposerPrimitive.Send aria-label="Send message" className="shrink-0 rounded-lg bg-violet-600 text-white p-2.5 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed"><ArrowUp className="size-4" /></ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Answers grounded in this video's transcript</p>
        </div>
      </ThreadPrimitive.Root>
    </WizSeekProvider>
  </AssistantRuntimeProvider>;
}
