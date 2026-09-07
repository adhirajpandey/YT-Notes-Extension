export type TextPart = { type: 'text'; text: string };
export type CitationPart = {
  type: 'citation';
  chunk_id: string;
  start_seconds: number;
  end_seconds: number;
};
export type MessagePart = TextPart | CitationPart;
export type WizStreamEvent = MessagePart
  | { type: 'done'; message_id: number }
  | { type: 'error'; message: string };

export function parseWizEvent(value: unknown): WizStreamEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid stream event');
  }
  const data = value as Record<string, unknown>;
  switch (data.type) {
    case 'text':
      if (typeof data.text === 'string') return { type: 'text', text: data.text };
      break;
    case 'citation':
      if (typeof data.chunk_id === 'string' && data.chunk_id.length > 0 &&
          typeof data.start_seconds === 'number' && Number.isFinite(data.start_seconds) && data.start_seconds >= 0 &&
          typeof data.end_seconds === 'number' && Number.isFinite(data.end_seconds) && data.end_seconds >= data.start_seconds) {
        return { type: 'citation', chunk_id: data.chunk_id, start_seconds: data.start_seconds, end_seconds: data.end_seconds };
      }
      break;
    case 'done':
      if (typeof data.message_id === 'number' && Number.isSafeInteger(data.message_id) && data.message_id > 0) {
        return { type: 'done', message_id: data.message_id };
      }
      break;
    case 'error':
      if (typeof data.message === 'string' && data.message.length > 0) return { type: 'error', message: data.message };
  }
  throw new Error('Invalid stream event');
}
