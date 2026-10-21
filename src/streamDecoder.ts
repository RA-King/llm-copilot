/**
 * Turns a streamed HTTP body into text deltas. Chunks arrive cut at arbitrary
 * byte boundaries, so lines are buffered until complete; each provider family
 * then wraps its tokens in a different envelope.
 *
 *   sse     OpenAI-compatible and Anthropic: `data: {...}` lines
 *   ndjson  Ollama: one JSON object per line
 */

export type StreamFraming = 'sse' | 'ndjson';
export type StreamDialect = 'openai' | 'anthropic' | 'ollama';

export class LineBuffer {
  private pending = '';

  /** Complete payloads in this chunk; a trailing partial line is held back. */
  push(chunk: string, framing: StreamFraming): string[] {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    return lines.map(l => unframe(l, framing)).filter((l): l is string => l !== undefined);
  }

  /** Whatever was left without a newline when the stream ended. */
  flush(framing: StreamFraming): string[] {
    const rest = unframe(this.pending, framing);
    this.pending = '';
    return rest === undefined ? [] : [rest];
  }
}

function unframe(line: string, framing: StreamFraming): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) { return undefined; }
  if (framing === 'ndjson') { return trimmed; }
  if (!trimmed.startsWith('data:')) { return undefined; }
  return trimmed.slice(5).trim();
}

export interface StreamDelta {
  text: string;
  done: boolean;
  /** An error the provider reported mid-stream. */
  error?: string;
}

export function readDelta(payload: string, dialect: StreamDialect): StreamDelta {
  if (payload === '[DONE]') { return { text: '', done: true }; }
  let json: any;
  try { json = JSON.parse(payload); } catch { return { text: '', done: false }; }

  if (json?.error) {
    const message = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error);
    return { text: '', done: true, error: message };
  }

  switch (dialect) {
    case 'anthropic':
      if (json.type === 'content_block_delta') { return { text: json.delta?.text ?? '', done: false }; }
      return { text: '', done: json.type === 'message_stop' };
    case 'ollama':
      return { text: json.message?.content ?? json.response ?? '', done: json.done === true };
    default: {
      const choice = json.choices?.[0];
      return { text: choice?.delta?.content ?? '', done: false };
    }
  }
}
