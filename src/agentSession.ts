import { ChatMessage } from './llmProvider';
import {
  buildAgentSystemPrompt, compactHistory, parseAgentReply, truncate, visibleText, ToolCall,
} from './agentProtocol';

/**
 * The agent loop, with the model and the tools passed in. Nothing here knows
 * about VS Code, which is what lets the loop be tested with a scripted model
 * and fake tools.
 */

export interface ToolOutcome {
  ok: boolean;
  /** What goes back to the model. */
  output: string;
  /** One line for the user — "Read src/a.ts (120 lines)". */
  summary: string;
}

export interface AgentTools {
  run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface AgentModel {
  /** Streams one reply; resolves with all of it. */
  reply(messages: ChatMessage[], onDelta: (text: string) => void, signal: AbortSignal): Promise<string>;
}

export interface AgentObserver {
  /** A new model turn is starting. */
  turnStarted(step: number): void;
  /** Visible text of the turn so far, already stripped of the call block. */
  turnText(text: string): void;
  toolStarted(call: ToolCall): void;
  toolFinished(call: ToolCall, outcome: ToolOutcome): void;
}

export interface AgentResult {
  status: 'done' | 'stopped' | 'step-limit' | 'error';
  summary: string;
  steps: number;
}

export interface AgentOptions {
  maxSteps: number;
  /** Characters of conversation kept before old tool results are blanked. */
  historyBudget: number;
  environment: string;
}

export async function runAgent(
  task: string, model: AgentModel, tools: AgentTools, observer: AgentObserver,
  options: AgentOptions, signal: AbortSignal
): Promise<AgentResult> {
  let messages: ChatMessage[] = [
    { role: 'system', content: buildAgentSystemPrompt(options.environment) },
    { role: 'user', content: task },
  ];
  let malformed = 0;

  for (let step = 1; step <= options.maxSteps; step++) {
    if (signal.aborted) { return { status: 'stopped', summary: '', steps: step - 1 }; }
    observer.turnStarted(step);

    let streamed = '';
    let reply: string;
    try {
      reply = await model.reply(compactHistory(messages, options.historyBudget), delta => {
        streamed += delta;
        observer.turnText(visibleText(streamed));
      }, signal);
    } catch (err: any) {
      if (signal.aborted) { return { status: 'stopped', summary: '', steps: step }; }
      return { status: 'error', summary: err?.message ?? String(err), steps: step };
    }
    if (signal.aborted) { return { status: 'stopped', summary: visibleText(reply), steps: step }; }

    const parsed = parseAgentReply(reply);
    observer.turnText(parsed.text);
    messages.push({ role: 'assistant', content: reply });

    if (parsed.error) {
      // A garbled call gets two more chances before the run gives up on it.
      if (++malformed > 2) { return { status: 'error', summary: parsed.error, steps: step }; }
      messages.push({ role: 'user', content: parsed.error });
      continue;
    }
    if (!parsed.call) {
      return { status: 'done', summary: parsed.text, steps: step };
    }

    malformed = 0;
    observer.toolStarted(parsed.call);
    let outcome: ToolOutcome;
    try {
      outcome = await tools.run(parsed.call, signal);
    } catch (err: any) {
      outcome = { ok: false, output: `Error: ${err?.message ?? err}`, summary: `${parsed.call.name} failed: ${err?.message ?? err}` };
    }
    observer.toolFinished(parsed.call, outcome);
    if (signal.aborted) { return { status: 'stopped', summary: '', steps: step }; }

    messages.push({
      role: 'user',
      content: `Result of ${parsed.call.name}${outcome.ok ? '' : ' (failed)'}:\n${truncate(outcome.output)}`,
    });
    messages = compactHistory(messages, options.historyBudget);
  }

  return {
    status: 'step-limit',
    summary: `Stopped after ${options.maxSteps} steps without finishing. Raise llmCopilot.agent.maxSteps, or give it a narrower task.`,
    steps: options.maxSteps,
  };
}
