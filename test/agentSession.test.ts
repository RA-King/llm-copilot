import { runAgent, AgentModel, AgentTools, AgentObserver, ToolOutcome } from '../src/agentSession';
import { ChatMessage } from '../src/llmProvider';
import { ToolCall } from '../src/agentProtocol';

/** A model that replies from a script, recording what it was sent. */
function scripted(replies: string[]): AgentModel & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    async reply(messages, onDelta) {
      seen.push(messages.map(m => ({ ...m })));
      const next = replies.shift();
      if (next === undefined) { throw new Error('script ran out'); }
      onDelta(next);
      return next;
    },
  };
}

function fakeTools(handler: (call: ToolCall) => ToolOutcome): AgentTools & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return { calls, async run(call) { calls.push(call); return handler(call); } };
}

function recorder(): AgentObserver & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    turnStarted: step => events.push(`turn ${step}`),
    turnText: () => { /* streamed text is not interesting here */ },
    toolStarted: call => events.push(`start ${call.name}`),
    toolFinished: (call, outcome) => events.push(`${outcome.ok ? 'ok' : 'failed'} ${call.name}`),
  };
}

const OPTIONS = { maxSteps: 10, historyBudget: 100000, environment: 'env' };
const call = (name: string, args: object) => `Doing it.\n<tool name="${name}">\n${JSON.stringify(args)}\n</tool>`;

describe('runAgent', () => {
  it('calls tools until the model answers without one', async () => {
    const model = scripted([
      call('read_file', { path: 'a.ts' }),
      call('edit_file', { path: 'a.ts', search: 'x', replace: 'y' }),
      'Changed x to y in a.ts.',
    ]);
    const tools = fakeTools(c => ({ ok: true, output: `did ${c.name}`, summary: c.name }));
    const observer = recorder();

    const result = await runAgent('rename x', model, tools, observer, OPTIONS, new AbortController().signal);

    expect(result).toEqual({ status: 'done', summary: 'Changed x to y in a.ts.', steps: 3 });
    expect(tools.calls.map(c => c.name)).toEqual(['read_file', 'edit_file']);
    expect(observer.events).toEqual([
      'turn 1', 'start read_file', 'ok read_file', 'turn 2', 'start edit_file', 'ok edit_file', 'turn 3',
    ]);
    // Each result goes back as the next user message.
    expect(model.seen[1][model.seen[1].length - 1]).toEqual({ role: 'user', content: 'Result of read_file:\ndid read_file' });
    expect(model.seen[0][1]).toEqual({ role: 'user', content: 'rename x' });
  });

  it('marks failed results and keeps going', async () => {
    const model = scripted([call('edit_file', { path: 'a.ts' }), 'Could not edit.']);
    const tools = fakeTools(() => ({ ok: false, output: 'not found', summary: 'failed' }));
    await runAgent('t', model, tools, recorder(), OPTIONS, new AbortController().signal);
    expect(model.seen[1][model.seen[1].length - 1].content).toBe('Result of edit_file (failed):\nnot found');
  });

  it('turns a tool that throws into a failed result', async () => {
    const model = scripted([call('read_file', {}), 'ok']);
    const tools: AgentTools = { async run() { throw new Error('read_file needs "path"'); } };
    await runAgent('t', model, tools, recorder(), OPTIONS, new AbortController().signal);
    expect(model.seen[1][model.seen[1].length - 1].content).toContain('Error: read_file needs "path"');
  });

  it('asks again after a garbled call, and gives up after three in a row', async () => {
    const garbled = '<tool name="read_file">{nope}</tool>';
    const retried = scripted([garbled, call('list_files', {}), 'done']);
    const result = await runAgent('t', retried, fakeTools(() => ({ ok: true, output: '', summary: '' })), recorder(), OPTIONS, new AbortController().signal);
    expect(result.status).toBe('done');
    expect(retried.seen[1][retried.seen[1].length - 1].content).toMatch(/not valid JSON/);

    const hopeless = scripted([garbled, garbled, garbled]);
    expect((await runAgent('t', hopeless, fakeTools(() => ({ ok: true, output: '', summary: '' })), recorder(), OPTIONS, new AbortController().signal)).status).toBe('error');
  });

  it('stops at the step limit', async () => {
    const model = scripted(Array.from({ length: 3 }, () => call('list_files', {})));
    const result = await runAgent('t', model, fakeTools(() => ({ ok: true, output: '', summary: '' })), recorder(),
      { ...OPTIONS, maxSteps: 3 }, new AbortController().signal);
    expect(result.status).toBe('step-limit');
    expect(result.steps).toBe(3);
  });

  it('stops when aborted during a tool', async () => {
    const controller = new AbortController();
    const model = scripted([call('run_command', { command: 'npm test' }), 'never reached']);
    const tools = fakeTools(() => { controller.abort(); return { ok: false, output: '', summary: '' }; });
    const result = await runAgent('t', model, tools, recorder(), OPTIONS, controller.signal);
    expect(result.status).toBe('stopped');
    expect(model.seen).toHaveLength(1);
  });

  it('reports a model failure as an error', async () => {
    const model = scripted([]);
    const result = await runAgent('t', model, fakeTools(() => ({ ok: true, output: '', summary: '' })), recorder(), OPTIONS, new AbortController().signal);
    expect(result).toEqual({ status: 'error', summary: 'script ran out', steps: 1 });
  });
});
