// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWizChat } from './useWizChat';
import { apiFetch, conversationsApi } from '../api';
import { getToken } from '../lib/authUtils';

vi.mock('../api', async importOriginal => ({
  ...await importOriginal<typeof import('../api')>(),
  apiFetch: vi.fn(),
  conversationsApi: { createConversation: vi.fn(), getSendMessageUrl: (id: number) => `/conversations/${id}/messages` },
}));
vi.mock('../lib/authUtils', () => ({ getToken: vi.fn(), getAuthHeaders: () => ({}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: new Response(body, { headers: { 'X-Request-ID': 'request-test' } }),
    write: (data: string) => controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`)),
    close: () => controller.close(),
  };
}
async function ready() {
  const hook = renderHook(({ video, isReady }) => useWizChat(video, isReady), { initialProps: { video: 'video-a', isReady: true }, wrapper: StrictMode });
  await waitFor(() => expect(hook.result.current.conversationId).toBe(1));
  return hook;
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  vi.mocked(getToken).mockReturnValue(null);
  let id = 0;
  vi.mocked(conversationsApi.createConversation).mockImplementation(async ({ video_id }) => ({ id: ++id, video_id, created_at: '' }));
});
afterEach(cleanup);

describe('useWizChat', () => {
  it('creates once in StrictMode, streams fully, and rejects same-tick and mid-stream sends', async () => {
    const hook = await ready();
    expect(conversationsApi.createConversation).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('guestSessionId')).toBeTruthy();
    const response = stream();
    vi.mocked(apiFetch).mockResolvedValue(response.response);
    let sending!: Promise<void>;
    act(() => { sending = hook.result.current.send('  Hello  '); void hook.result.current.send('duplicate'); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({ message: 'Hello' });
    await act(async () => response.write('{"content":"First"}'));
    expect(hook.result.current.messages[1].content).toBe('First');
    expect(hook.result.current.isRunning).toBe(true);
    await act(async () => hook.result.current.send('overlap'));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { response.write('{"content":" answer"}'); response.write('[DONE]'); await sending; });
    expect(hook.result.current.messages[1]).toMatchObject({ content: 'First answer', status: 'complete' });
    expect(hook.result.current.isRunning).toBe(false);
  });

  it.each([
    ['malformed', ['{bad'], 'invalid chat response'],
    ['invalid payload', ['{"content":42}'], 'invalid chat response'],
    ['empty', ['[DONE]'], 'No response received'],
    ['interrupted', ['{"content":"Partial"}'], 'response was interrupted'],
    ['server stream error', ['{"content":"Partial"}', '{"error":"Processing error"}'], 'Processing error'],
  ])('reports %s with a support reference and preserves partial content', async (_name, events, message) => {
    const hook = await ready();
    const response = stream();
    vi.mocked(apiFetch).mockResolvedValue(response.response);
    await act(async () => {
      const sending = hook.result.current.send('Hello');
      events.forEach(response.write); response.close(); await sending;
    });
    expect(hook.result.current.messages[1].error?.message).toContain(message);
    expect(hook.result.current.messages[1].error?.requestId).toBe('request-test');
    if (events[0].includes('Partial')) expect(hook.result.current.messages[1].content).toBe('Partial');
    expect(hook.result.current.isRunning).toBe(false);
  });

  it.each([false, true])('preserves quota modal handling for authenticated=%s', async authenticated => {
    const hook = await ready();
    if (authenticated) vi.mocked(getToken).mockReturnValue('token');
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ detail: 'Limit' }), { status: 429, headers: { 'Retry-After': '90' } }));
    await act(async () => hook.result.current.send('Hello'));
    expect(hook.result.current.limit).toEqual({ kind: authenticated ? 'user' : 'guest', resetSeconds: 90 });
    expect(hook.result.current.messages.map(m => m.role)).toEqual(['user']);
    expect(hook.result.current.isRunning).toBe(false);
  });

  it('preserves processing and authentication responses', async () => {
    const hook = await ready();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ message: 'Preparing transcript' }), { status: 202 }));
    await act(async () => hook.result.current.send('Hello'));
    expect(hook.result.current.isProcessing).toBe(true);
    expect(hook.result.current.messages[1].content).toBe('Preparing transcript');
    act(() => hook.result.current.dismissProcessing());
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 401 }));
    await act(async () => hook.result.current.send('Again'));
    expect(hook.result.current.messages).toHaveLength(3);
    expect(hook.result.current.limit).toBe(null);
  });

  it('handles HTTP, missing-body, and network failures', async () => {
    const hook = await ready();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 500, headers: { 'X-Request-ID': 'server-id' } }))
      .mockResolvedValueOnce(new Response(null))
      .mockRejectedValueOnce(new Error('network secret'));
    for (let index = 0; index < 3; index++) await act(async () => hook.result.current.send('Hello'));
    expect(hook.result.current.messages[1].error?.requestId).toBe('server-id');
    expect(hook.result.current.messages[3].error?.message).toContain('could not be read');
    expect(hook.result.current.messages[5].error?.message).toContain('connection failed');
    expect(hook.result.current.messages[5].error?.message).not.toContain('secret');
  });

  it('aborts New chat locally and ignores an old rejection/finally during a newer request', async () => {
    const hook = await ready();
    const old = deferred<Response>();
    const current = stream();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(current.response);
    let first!: Promise<void>;
    act(() => { first = hook.result.current.send('Old'); });
    const signal = vi.mocked(apiFetch).mock.calls[0][1]!.signal!;
    act(() => hook.result.current.newChat());
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(hook.result.current.conversationId).toBe(2));
    let second!: Promise<void>;
    act(() => { second = hook.result.current.send('New'); });
    await act(async () => { old.reject(new Error('old failure')); await first; });
    expect(hook.result.current.isRunning).toBe(true);
    expect(hook.result.current.messages).toHaveLength(2);
    expect(hook.result.current.messages[1].error).toBeUndefined();
    await act(async () => { current.write('{"content":"New answer"}'); current.write('[DONE]'); await second; });
    expect(hook.result.current.messages[1].content).toBe('New answer');
  });

  it.each([202, 429, 500])('ignores a stale parsed %s response', async status => {
    const hook = await ready();
    const body = deferred<unknown>();
    const response = new Response('{}', { status });
    vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.mocked(apiFetch).mockResolvedValue(response);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.send('Old'); });
    await waitFor(() => expect(response.json).toHaveBeenCalled());
    hook.rerender({ video: 'video-b', isReady: true });
    await waitFor(() => expect(hook.result.current.conversationId).toBe(2));
    await act(async () => { body.resolve({ message: 'Old processing', detail: 'Old error' }); await pending; });
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.limit).toBe(null);
    expect(hook.result.current.isProcessing).toBe(false);
  });

  it('ignores old streamed tokens after switching videos and aborts on unmount', async () => {
    const hook = await ready();
    const response = stream();
    vi.mocked(apiFetch).mockResolvedValue(response.response);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.send('Old'); });
    await act(async () => response.write('{"content":"Old"}'));
    const signal = vi.mocked(apiFetch).mock.calls[0][1]!.signal!;
    hook.rerender({ video: 'video-b', isReady: true });
    await waitFor(() => expect(hook.result.current.conversationId).toBe(2));
    await act(async () => { response.write('{"content":" stale"}'); await pending; });
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.messages).toEqual([]);
    const next = stream();
    vi.mocked(apiFetch).mockResolvedValue(next.response);
    act(() => { void hook.result.current.send('New'); });
    const nextSignal = vi.mocked(apiFetch).mock.calls[1][1]!.signal!;
    hook.unmount();
    expect(nextSignal.aborted).toBe(true);
    next.close();
  });

  it('retries creation, deduplicates retries, and ignores stale creation success', async () => {
    vi.mocked(conversationsApi.createConversation).mockRejectedValueOnce(new Error('failed'));
    const hook = renderHook(({ video }) => useWizChat(video, true), { initialProps: { video: 'video-a' } });
    await waitFor(() => expect(hook.result.current.conversationError).not.toBe(null));
    const old = deferred<Awaited<ReturnType<typeof conversationsApi.createConversation>>>();
    vi.mocked(conversationsApi.createConversation).mockReturnValueOnce(old.promise);
    act(() => { void hook.result.current.retryConversation(); void hook.result.current.retryConversation(); });
    expect(conversationsApi.createConversation).toHaveBeenCalledTimes(2);
    hook.rerender({ video: 'video-b' });
    await waitFor(() => expect(hook.result.current.conversationId).toBe(1));
    await act(async () => old.resolve({ id: 99, video_id: 'video-a', created_at: '' }));
    expect(hook.result.current.conversationId).toBe(1);
    expect(hook.result.current.conversationError).toBe(null);
  });
});
