// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WizChat from './WizChat';
import type { WizChatController, WizMessage } from '../../hooks/useWizChat';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);
function controller(overrides: Partial<WizChatController> = {}): WizChatController {
  return {
    messages: [], generation: 1, conversationId: 1, isRunning: false, isCreatingConversation: false,
    conversationError: null, isSendDisabled: false, send: vi.fn(async () => {}),
    newChat: vi.fn(), retryConversation: vi.fn(async () => {}), limit: null, isProcessing: false,
    dismissLimit: vi.fn(), dismissProcessing: vi.fn(), ...overrides,
  };
}
function answer(content: string): WizMessage {
  return { id: 'answer', role: 'assistant', content, createdAt: new Date(0), status: 'complete' };
}
function view(chat: WizChatController, onSeek = vi.fn(), questions?: string[]) {
  return <WizChat key={chat.generation} chat={chat} isReady suggestedQuestions={questions} onSeek={onSeek} statusBanner={null} />;
}

describe('WizChat', () => {
  it('fills suggestions without sending and supports multiline submission', async () => {
    const user = userEvent.setup();
    const chat = controller();
    render(view(chat, undefined, ['First question', 'Second question', 'Third question']));
    await user.click(screen.getByRole('button', { name: 'First question' }));
    const input = screen.getByRole('textbox', { name: 'Message Wiz' });
    expect((input as HTMLTextAreaElement).value).toBe('First question');
    expect(chat.send).not.toHaveBeenCalled();
    await user.click(input);
    await user.keyboard('{Shift>}{Enter}{/Shift}More{Enter}');
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('First question\nMore'));
    expect((input as HTMLTextAreaElement).value).toBe('');
  }, 15000);

  it('allows typing while running, blocks sends, and preserves the draft on completion and ID assignment', async () => {
    const user = userEvent.setup();
    const chat = controller({ messages: [answer('Partial')], isRunning: true, isSendDisabled: true });
    const rendered = render(view(chat));
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(input, 'Next question');
    await user.keyboard('{Enter}');
    expect(chat.send).not.toHaveBeenCalled();
    expect(input.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true);
    rendered.rerender(view({ ...chat, messages: [answer('Complete')], isRunning: false, isSendDisabled: false, conversationId: 2 }));
    expect(input.value).toBe('Next question\n');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(chat.send).toHaveBeenCalledWith('Next question\n');
  }, 15000);

  it('clears the composer on workspace generation change and exposes no unsupported actions', async () => {
    const user = userEvent.setup();
    const chat = controller({ messages: [answer('Hello')] });
    const rendered = render(view(chat));
    await user.type(screen.getByRole('textbox'), 'Draft');
    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(chat.newChat).toHaveBeenCalledOnce();
    rendered.rerender(view({ ...chat, messages: [], generation: 2 }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    for (const name of ['Stop', 'Regenerate', 'Edit', 'History']) expect(screen.queryByRole('button', { name })).toBeNull();
  }, 15000);

  it('renders Markdown and timestamp groups as accessible seek buttons', async () => {
    const seek = vi.fn();
    render(view(controller({ messages: [answer('**Summary**\n\n- See [01:23, 1:02:03].')] }), seek));
    expect(screen.getByText('Summary').tagName).toBe('STRONG');
    await userEvent.click(screen.getByRole('button', { name: 'Seek video to 1:23' }));
    await userEvent.click(screen.getByRole('button', { name: 'Seek video to 1:02:03' }));
    expect(seek.mock.calls).toEqual([[83], [3723]]);
  }, 15000);

  it('leaves code, links, reference links, and images outside citation transformation', () => {
    const text = '`[1:23]`\n\n```text\n[2:34]\n```\n\n[3:45](https://example.com)\n\n[4:56][ref]\n\n[ref]: https://example.org\n\n![5:67](https://example.com/image.png)';
    const rendered = render(view(controller({ messages: [answer(text)] })));
    expect(screen.queryByRole('button', { name: /Seek video/ })).toBeNull();
    expect(screen.getByRole('link', { name: '3:45' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.getByRole('link', { name: '4:56' }).getAttribute('href')).toBe('https://example.org');
    expect(rendered.container.querySelector('pre')?.textContent).toContain('[2:34]');
    expect(rendered.container.querySelector('a button')).toBeNull();
  }, 15000);

  it('reparses streamed partial citations and lets a completed Markdown link supersede a citation', async () => {
    const chat = controller({ messages: [answer('See [1:')], isRunning: true, isSendDisabled: true });
    const rendered = render(view(chat));
    expect(screen.queryByRole('button', { name: /Seek video/ })).toBeNull();
    rendered.rerender(view({ ...chat, messages: [answer('See [1:23, 2:')] }));
    expect(screen.queryByRole('button', { name: /Seek video/ })).toBeNull();
    rendered.rerender(view({ ...chat, messages: [answer('See [1:23, 2:34]')] }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Seek video/ })).toHaveLength(2));
    rendered.rerender(view({ ...chat, messages: [answer('See [1:23]')] }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Seek video/ })).toHaveLength(1));
    rendered.rerender(view({ ...chat, messages: [answer('See [1:23](')] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Seek video/ })).toBeNull());
    rendered.rerender(view({ ...chat, messages: [answer('See [1:23](https://example.com)')] }));
    await waitFor(() => expect(screen.getByRole('link', { name: '1:23' })).toBeTruthy());
    expect(rendered.container.querySelector('a button')).toBeNull();
  }, 15000);

  it('uses assistant-ui copy feedback and keeps errors out of copied answer text', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(view(controller({ messages: [{ ...answer('Partial answer'), status: 'error', error: { message: 'Interrupted', requestId: 'ref-1' } }] })));
    expect(screen.getByRole('alert').textContent).toContain('ref-1');
    await user.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Partial answer'));
    expect(screen.getByRole('button', { name: 'Copied answer' })).toBeTruthy();
    await act(async () => {});
  }, 15000);
});
