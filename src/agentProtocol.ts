import { ChatMessage } from './llmProvider';

/**
 * The conversation between the agent loop and the model. Tool calls are
 * written as a tagged block of JSON rather than through a provider's native
 * tool-calling, so the same agent works with every provider — including a
 * local model that has never heard of function calling.
 *
 *   Reading the config to see how retries are set up.
 *   <tool name="read_file">
 *   {"path": "src/config.ts"}
 *   </tool>
 *
 * One call per reply; the result comes back as the next user message. A reply
 * with no call is the final answer.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** Argument name → what it is; a trailing `?` on the name marks it optional. */
  args: Record<string, string>;
}

export const AGENT_TOOLS: ToolSpec[] = [
  { name: 'list_files', description: 'List files in the workspace matching a glob.',
    args: { 'pattern?': 'glob, default "**/*"' } },
  { name: 'read_file', description: 'Read a file, with line numbers. Long files come back in parts; ask for the lines you need.',
    args: { path: 'workspace-relative path', 'start_line?': 'first line, 1-based', 'end_line?': 'last line, inclusive' } },
  { name: 'search_text', description: 'Search file contents. Returns path:line: text for each match.',
    args: { query: 'text to find', 'regex?': 'true to treat query as a regular expression', 'include?': 'glob limiting the files searched' } },
  { name: 'find_symbol', description: 'Find where a class, function, type or constant is declared.',
    args: { name: 'the identifier' } },
  { name: 'edit_file', description: 'Replace one exact passage of a file. search must match the file exactly, once; include enough surrounding lines to make it unique.',
    args: { path: 'workspace-relative path', search: 'the exact text to replace', replace: 'the new text' } },
  { name: 'create_file', description: 'Create a file, or overwrite one completely.',
    args: { path: 'workspace-relative path', content: 'the whole file' } },
  { name: 'get_problems', description: 'Errors and warnings the language servers report, for one file or the whole workspace.',
    args: { 'path?': 'workspace-relative path; omit for every file with problems' } },
  { name: 'run_command', description: 'Run a shell command in the workspace root and return its output and exit code. The user must approve each command.',
    args: { command: 'the command line' } },
];

export function buildAgentSystemPrompt(environment: string, tools: ToolSpec[] = AGENT_TOOLS): string {
  const toolList = tools.map(t => {
    const args = Object.entries(t.args).map(([k, v]) => `    ${k}: ${v}`).join('\n');
    return `- ${t.name}: ${t.description}${args ? `\n${args}` : ''}`;
  }).join('\n');

  return (
    'You are an autonomous coding agent working inside the user\'s project. You complete the task you are given ' +
    'by calling tools, one at a time, and reading what they return.\n\n' +
    `${environment}\n\n` +
    `Tools:\n${toolList}\n\n` +
    'To call a tool, write one short sentence saying what you are doing and why, then exactly one block:\n' +
    '<tool name="TOOL_NAME">\n{"arg": "value"}\n</tool>\n' +
    'The arguments are a JSON object. Stop after the block; the result arrives in the next message.\n\n' +
    'Work like a careful engineer: find and read the relevant code before changing it, make the smallest change ' +
    'that does the job, follow the conventions already in the code, and verify — check the problems in files ' +
    'you edited, and run the tests or build when there is one. Never edit a file you have not read. Do not ask ' +
    'the user questions you can answer by looking.\n\n' +
    'When the task is done, or cannot be done, reply without a tool block: a short summary of what you changed ' +
    'and why, and anything the user should check.'
  );
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentReply {
  /** What the model said outside the tool block. */
  text: string;
  call?: ToolCall;
  /** Set when a block was there but could not be read; sent back so the model can retry. */
  error?: string;
}

const TAGGED = /<tool\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/tool>|$)/;
const FENCED = /```(?:json)?\s*\n(\{[\s\S]*?"tool"\s*:[\s\S]*?\})\s*\n```/;

export function parseAgentReply(reply: string): AgentReply {
  const tagged = TAGGED.exec(reply);
  if (tagged) {
    const text = reply.slice(0, tagged.index).trim();
    const body = tagged[2].trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
    try {
      const args = body ? JSON.parse(body) : {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) { throw new Error('arguments must be a JSON object'); }
      return { text, call: { name: tagged[1], args } };
    } catch (err: any) {
      return { text, error: `The arguments to ${tagged[1]} are not valid JSON (${err.message}). Send the call again.` };
    }
  }

  // Some models fall back to a fenced {"tool": ..., "args": ...} object.
  const fenced = FENCED.exec(reply);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1]);
      if (typeof obj.tool === 'string') {
        return { text: reply.slice(0, fenced.index).trim(), call: { name: obj.tool, args: obj.args ?? obj.arguments ?? {} } };
      }
    } catch { /* not a call after all */ }
  }

  return { text: reply.trim() };
}

/** What the user sees of a reply: the prose, without the call block. */
export function visibleText(reply: string): string {
  const at = reply.search(/<tool\s+name/);
  return (at >= 0 ? reply.slice(0, at) : reply).trim();
}

export function stringArg(call: ToolCall, name: string, required = true): string | undefined {
  const value = call.args[name];
  if (value === undefined || value === null) {
    if (required) { throw new Error(`${call.name} needs "${name}"`); }
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

export function numberArg(call: ToolCall, name: string): number | undefined {
  const value = call.args[name];
  if (value === undefined || value === null || value === '') { return undefined; }
  const n = Number(value);
  if (!Number.isFinite(n)) { throw new Error(`"${name}" must be a number`); }
  return Math.floor(n);
}

/** Bounded tool output, keeping the start and the end, where errors usually are. */
export function truncate(text: string, max = 8000): string {
  if (text.length <= max) { return text; }
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… (${text.length - max} characters omitted) …\n${text.slice(text.length - tail)}`;
}

/**
 * Keeps the conversation inside a character budget by blanking the oldest
 * tool results first. The model's own messages are kept: they record what it
 * learned from those results, which is usually all it needs of them later.
 */
export function compactHistory(messages: ChatMessage[], budget: number): ChatMessage[] {
  const out = messages.map(m => ({ ...m }));
  let size = out.reduce((n, m) => n + m.content.length, 0);
  // Never touch the system prompt, the task, or the latest result.
  for (let i = 2; i < out.length - 1 && size > budget; i++) {
    const m = out[i];
    if (m.role !== 'user' || !m.content.startsWith('Result of ')) { continue; }
    const header = m.content.split('\n')[0];
    const replacement = `${header}\n(earlier result omitted to save space — call the tool again if you need it)`;
    if (replacement.length < m.content.length) {
      size -= m.content.length - replacement.length;
      m.content = replacement;
    }
  }
  return out;
}

/**
 * Where a search/replace edit applies. Unlike next-edit placement, an agent
 * edit must match exactly one place: a second match means the model has not
 * quoted enough to say which one it meant.
 */
export function findUnique(text: string, search: string): { start: number; end: number } | string {
  if (!search) { return 'search is empty'; }
  const first = text.indexOf(search);
  if (first >= 0) {
    const second = text.indexOf(search, first + 1);
    if (second >= 0) {
      const count = text.split(search).length - 1;
      return `search matches ${count} places; include more surrounding lines so it matches one`;
    }
    return { start: first, end: first + search.length };
  }

  // Tolerate trailing whitespace and line-ending differences, nothing more.
  const norm = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n');
  const lines = text.split('\n');
  const wanted = norm(search).split('\n');
  const offsets: number[] = [];
  let o = 0;
  for (const line of lines) { offsets.push(o); o += line.length + 1; }
  const hits: number[] = [];
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, j) => lines[i + j].replace(/\r$/, '').trimEnd() === w)) { hits.push(i); }
  }
  if (hits.length === 1) {
    const last = hits[0] + wanted.length - 1;
    return { start: offsets[hits[0]], end: offsets[last] + lines[last].replace(/\r$/, '').length };
  }
  if (hits.length > 1) { return `search matches ${hits.length} places; include more surrounding lines so it matches one`; }
  return 'search text not found in the file; read the file again and quote it exactly';
}

/**
 * A workspace-relative path made safe: no escaping the workspace through
 * `..`, no absolute paths outside it. Returns the normalised relative path or
 * an error message.
 */
export function safeRelativePath(input: string, root?: string): { path: string } | { error: string } {
  let p = input.trim().replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (p === r) { p = ''; } else if (p.startsWith(r + '/')) { p = p.slice(r.length + 1); }
  }
  if (/^([a-zA-Z]:)?\//.test(p)) { return { error: `${input} is outside the workspace` }; }
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') { continue; }
    if (part === '..') {
      if (parts.length === 0) { return { error: `${input} is outside the workspace` }; }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) { return { error: 'a file path is needed' }; }
  return { path: parts.join('/') };
}
