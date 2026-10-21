/**
 * What a chat message asks for beyond its words: a leading slash command, and
 * `#` references that pull material into the request the way Copilot's chat
 * variables do.
 *
 *   #file:src/app.ts    the file, read in full (quoted paths may hold spaces)
 *   #selection          the editor selection
 *   #codebase           the parts of the project index that match the question
 *   #problems           the diagnostics in the active file
 *   #changes            the uncommitted git diff
 *   #terminalLastCommand
 *                       the last failure captured from the terminal or debugger
 */

export type ReferenceKind = 'file' | 'selection' | 'codebase' | 'problems' | 'changes' | 'terminalLastCommand';

export interface ChatReference {
  kind: ReferenceKind;
  /** The path, for `#file`. */
  arg?: string;
}

export interface ParsedChatInput {
  /** `/name` without the slash, lowercased; undefined when there is none. */
  command?: string;
  /** The message with the command and references taken out. */
  text: string;
  references: ChatReference[];
}

const NAMED: Record<string, ReferenceKind> = {
  selection: 'selection',
  codebase: 'codebase',
  problems: 'problems',
  changes: 'changes',
  terminallastcommand: 'terminalLastCommand',
  terminal: 'terminalLastCommand',
};

export function parseChatInput(raw: string): ParsedChatInput {
  let text = raw.trim();
  let command: string | undefined;

  const slash = /^\/([\w-]+)(?:\s+|$)/.exec(text);
  if (slash) {
    command = slash[1].toLowerCase();
    text = text.slice(slash[0].length);
  }

  const references: ChatReference[] = [];
  const seen = new Set<string>();
  const add = (ref: ChatReference) => {
    const key = `${ref.kind}:${ref.arg ?? ''}`;
    if (!seen.has(key)) { seen.add(key); references.push(ref); }
  };

  text = text.replace(/(^|\s)#file:(?:"([^"]+)"|(\S+))/g, (_m, lead: string, quoted?: string, bare?: string) => {
    const path = (quoted ?? bare ?? '').replace(/[.,;:!?)]+$/, '');
    add({ kind: 'file', arg: path });
    return `${lead}${path}`;
  });

  text = text.replace(/(^|\s)#([a-zA-Z]+)\b/g, (whole, lead: string, name: string) => {
    const kind = NAMED[name.toLowerCase()];
    if (!kind) { return whole; }
    add({ kind });
    return lead;
  });

  return { command, text: text.replace(/[ \t]{2,}/g, ' ').trim(), references };
}

export interface Attachment {
  label: string;
  /** Fence language; '' for prose. */
  language: string;
  content: string;
}

/** Attachments as the block that follows the question in the user message. */
export function renderAttachments(attachments: Attachment[]): string {
  return attachments
    .filter(a => a.content.trim())
    .map(a => a.language === ''
      ? `### ${a.label}\n${a.content.trim()}`
      : `### ${a.label}\n\`\`\`${a.language}\n${a.content.replace(/\s+$/, '')}\n\`\`\``)
    .join('\n\n');
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'it',
  'this', 'that', 'with', 'how', 'what', 'where', 'why', 'when', 'does', 'do', 'can', 'i', 'we',
  'my', 'our', 'me', 'you', 'there', 'which', 'who', 'from', 'by', 'as', 'at', 'into', 'about',
  'code', 'file', 'files', 'function', 'functions', 'class', 'method', 'project', 'codebase',
  'use', 'used', 'using', 'make', 'get', 'set', 'all', 'any', 'some', 'show', 'find', 'explain',
]);

/**
 * The words in a question worth looking up in the index: identifiers as
 * written, plus the parts of any camelCase or snake_case name, so "where is
 * the retry policy" and "RetryPolicy" reach the same declarations.
 */
export function searchTerms(question: string): string[] {
  const terms = new Set<string>();
  for (const token of question.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (token.length < 3 || STOP_WORDS.has(token.toLowerCase())) { continue; }
    terms.add(token);
    for (const part of token.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) {
      if (part.length >= 3 && !STOP_WORDS.has(part.toLowerCase())) { terms.add(part.toLowerCase()); }
    }
  }
  return [...terms].slice(0, 16);
}
