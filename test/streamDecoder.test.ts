import { LineBuffer, readDelta } from '../src/streamDecoder';

describe('LineBuffer', () => {
  it('holds a line split across chunks until it completes', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('data: {"a"', 'sse')).toEqual([]);
    expect(buffer.push(':1}\n\ndata: [DONE]\n', 'sse')).toEqual(['{"a":1}', '[DONE]']);
  });

  it('skips SSE event and comment lines', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('event: content_block_delta\n: ping\ndata: {}\n', 'sse')).toEqual(['{}']);
  });

  it('passes NDJSON lines through and flushes the tail', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"x":1}\n{"x":', 'ndjson')).toEqual(['{"x":1}']);
    expect(buffer.push('2}', 'ndjson')).toEqual([]);
    expect(buffer.flush('ndjson')).toEqual(['{"x":2}']);
  });
});

describe('readDelta', () => {
  it('reads OpenAI-compatible deltas', () => {
    expect(readDelta('{"choices":[{"delta":{"content":"Hel"}}]}', 'openai')).toEqual({ text: 'Hel', done: false });
    expect(readDelta('[DONE]', 'openai').done).toBe(true);
  });

  it('reads Anthropic content deltas and the stop event', () => {
    expect(readDelta('{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}', 'anthropic').text).toBe('lo');
    expect(readDelta('{"type":"message_stop"}', 'anthropic').done).toBe(true);
    expect(readDelta('{"type":"ping"}', 'anthropic')).toEqual({ text: '', done: false });
  });

  it('reads Ollama chat lines', () => {
    expect(readDelta('{"message":{"content":"!"},"done":false}', 'ollama').text).toBe('!');
    expect(readDelta('{"message":{"content":""},"done":true}', 'ollama').done).toBe(true);
  });

  it('surfaces an error reported mid-stream', () => {
    expect(readDelta('{"type":"error","error":{"message":"overloaded"}}', 'anthropic').error).toBe('overloaded');
  });

  it('ignores a payload that is not JSON', () => {
    expect(readDelta('garbage', 'openai')).toEqual({ text: '', done: false });
  });
});
