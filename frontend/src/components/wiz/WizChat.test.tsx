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
  return { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: content }], createdAt: new Date(0), status: 'complete' };
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

  it('renders Markdown blocks and structured citations in order with accessible seeking', async () => {
    const seek = vi.fn();
    const message = answer('# Summary\n\n**Bold** and *italic*\n\n- First\n- Second\n\n> Quote');
    message.parts.push(
      { type: 'citation', chunk_id: 'chunk_a', start_seconds: 83.25, end_seconds: 90 },
      { type: 'text', text: '```js\nconst x = 1;\n```\n\n1. One\n2. Two' },
      { type: 'citation', chunk_id: 'chunk_b', start_seconds: 3723, end_seconds: 3730 },
    );
    const rendered = render(view(controller({ messages: [message] }), seek));
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByText('Bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(rendered.container.querySelector('blockquote')?.textContent).toContain('Quote');
    expect(rendered.container.querySelector('pre')?.textContent).toContain('const x = 1;');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Seek video to 1:23' }));
    const later = screen.getByRole('button', { name: 'Seek video to 1:02:03' });
    later.focus();
    await userEvent.keyboard('{Enter}');
    expect(seek.mock.calls).toEqual([[83.25], [3723]]);
    const first = screen.getByRole('button', { name: 'Seek video to 1:23' });
    expect(first.compareDocumentPosition(rendered.container.querySelector('pre')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('never infers citations from generated timestamp text', () => {
    render(view(controller({ messages: [answer('See [1:23] and [[timestamp:83]] and {{chunk:42}}.')] })));
    expect(screen.queryByRole('button', { name: /Seek video/ })).toBeNull();
  });

  it('uses assistant-ui copy feedback and keeps errors out of copied answer text', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const partial = answer('Partial answer');
    partial.parts.push({ type: 'citation', chunk_id: 'chunk_x', start_seconds: 0, end_seconds: 2 },
      { type: 'text', text: '**More**' });
    render(view(controller({ messages: [{ ...partial, status: 'error', error: { message: 'Interrupted', requestId: 'ref-1' } }] })));
    expect(screen.getByRole('alert').textContent).toContain('ref-1');
    await user.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Partial answer\n\n**More**'));
    expect(screen.getByRole('button', { name: 'Copied answer' })).toBeTruthy();
    await act(async () => {});
  }, 15000);
});
