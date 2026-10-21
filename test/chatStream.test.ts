import * as http from 'http';
import { AddressInfo } from 'net';
import { chatStream } from '../src/llmProvider';
import { __setConfig, __resetConfig } from './__mocks__/vscode';

/** A local server that answers every request with the given chunks, spaced out. */
function serve(chunks: string[], gapMs = 5, status = 200): Promise<{ url: string; close: () => void; bodies: any[] }> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      bodies.push(JSON.parse(body));
      res.writeHead(status, { 'Content-Type': 'text/event-stream' });
      for (const chunk of chunks) {
        if (res.destroyed) { return; }
        res.write(chunk);
        await new Promise(r => setTimeout(r, gapMs));
      }
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), bodies });
  }));
}

describe('chatStream', () => {
  afterEach(() => __resetConfig());

  it('streams an OpenAI-compatible reply, including deltas split across chunks', async () => {
    const server = await serve([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',
      'ces":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    __setConfig('llmCopilot', { provider: 'custom', baseUrl: server.url, model: 'm', 'customInstructions.enabled': false });
    const seen: string[] = [];
    const reply = await chatStream([{ role: 'user', content: 'hi' }], t => seen.push(t));
    server.close();
    expect(seen).toEqual(['Hel', 'lo']);
    expect(reply).toBe('Hello');
    expect(server.bodies[0].stream).toBe(true);
  });

  it('streams Ollama NDJSON', async () => {
    const server = await serve(['{"message":{"content":"a"},"done":false}\n{"message":{"content":"b"},"done":true}']);
    __setConfig('llmCopilot', { provider: 'ollama', baseUrl: server.url, model: 'm', 'customInstructions.enabled': false });
    const reply = await chatStream([{ role: 'user', content: 'hi' }], () => {});
    server.close();
    expect(reply).toBe('ab');
  });

  it('keeps what arrived when stopped', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `data: {"choices":[{"delta":{"content":"${i},"}}]}\n\n`);
    const server = await serve(chunks, 20);
    __setConfig('llmCopilot', { provider: 'custom', baseUrl: server.url, model: 'm', 'customInstructions.enabled': false });
    const controller = new AbortController();
    const reply = await chatStream([{ role: 'user', content: 'hi' }], t => {
      if (t === '2,') { controller.abort(); }
    }, controller.signal);
    server.close();
    expect(reply.startsWith('0,1,2,')).toBe(true);
    expect(reply.length).toBeLessThan(40);
  });

  it('rejects with the provider error body', async () => {
    const server = await serve(['{"error":"bad key"}'], 1, 401);
    __setConfig('llmCopilot', { provider: 'custom', baseUrl: server.url, model: 'm', 'customInstructions.enabled': false });
    await expect(chatStream([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow('HTTP 401');
    server.close();
  });
});
