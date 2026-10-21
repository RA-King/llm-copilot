import { ChatMessage } from './llmProvider';
import { numberLines } from './codeReview';

// ─── Fixing a diagnostic ──────────────────────────────────────────────────────

export interface DiagnosticFixRequest {
  language: string;
  file: string;
  /** The diagnostic messages being fixed, each with its line. */
  problems: string[];
  /** One-based number of the first line in `code`. */
  firstLine: number;
  code: string;
  /** Declarations from elsewhere in the project that the code refers to. */
  declarations?: string;
}

/**
 * Asks for the window around a problem back in full, corrected. Returning the
 * whole window rather than a patch is what lets the edit be applied without
 * the model having to get offsets right.
 */
export function buildDiagnosticFixPrompt(req: DiagnosticFixRequest): ChatMessage[] {
  const lastLine = req.firstLine + req.code.split('\n').length - 1;
  const declarations = req.declarations ? `\n\n${req.declarations}` : '';
  return [
    {
      role: 'system',
      content:
        `You are an expert ${req.language} programmer fixing a reported problem. ` +
        `Reply with lines ${req.firstLine}–${lastLine} rewritten so the problem is gone, as a single ` +
        `fenced ${req.language} code block, without the line numbers. Change only what the fix needs, ` +
        'keep every other line exactly as it is, and keep the indentation. No explanation.',
    },
    {
      role: 'user',
      content:
        `${req.file}\n\nProblems:\n${req.problems.map(p => `- ${p}`).join('\n')}\n\n` +
        `${numberLines(req.code, req.firstLine)}${declarations}`,
    },
  ];
}

/** The first fenced block in a reply, or the whole reply when it has none. */
export function extractCodeBlock(reply: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(reply);
  const code = fenced ? fenced[1] : reply;
  return code.replace(/\s+$/, '');
}

// ─── Terminal commands ────────────────────────────────────────────────────────

export function buildTerminalCommandPrompt(request: string, shell: string, platform: string, cwd?: string): ChatMessage[] {
  const where = cwd ? ` The working directory is ${cwd}.` : '';
  return [
    {
      role: 'system',
      content:
        `You turn requests into a single ${shell} command for ${platform}.${where} ` +
        'Reply with the command in one fenced code block, then one line explaining what it does. ' +
        'Prefer standard tools that are present by default. Chain steps with && rather than giving ' +
        'several commands. Never suggest anything destructive unless it was explicitly asked for.',
    },
    { role: 'user', content: request },
  ];
}

export interface TerminalSuggestion {
  command: string;
  explanation: string;
}

export function parseTerminalSuggestion(reply: string): TerminalSuggestion {
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(reply);
  let command: string;
  let explanation: string;
  if (fenced) {
    command = fenced[1];
    explanation = reply.slice(fenced.index + fenced[0].length);
  } else {
    const lines = reply.trim().split('\n');
    command = lines[0] ?? '';
    explanation = lines.slice(1).join(' ');
  }
  command = command.trim().split('\n').map(l => l.replace(/^\s*[$>%#]\s+/, '')).join('\n').trim();
  return { command, explanation: explanation.trim().replace(/\s+/g, ' ') };
}

// ─── Pull request descriptions ────────────────────────────────────────────────

export interface PullRequestMaterial {
  branch: string;
  base: string;
  log: string;
  stat: string;
  diff: string;
}

export function buildPullRequestPrompt(m: PullRequestMaterial, maxDiffChars = 12000): ChatMessage[] {
  const diff = m.diff.length > maxDiffChars ? `${m.diff.slice(0, maxDiffChars)}\n… (diff truncated)` : m.diff;
  return [
    {
      role: 'system',
      content:
        'You write pull request descriptions. Reply in markdown: the first line is the title on its own ' +
        '(no heading marker, under 70 characters, imperative), then a blank line, then a "## Summary" ' +
        'section of a few bullets on what changed and why, and a "## Testing" section on how it was or ' +
        'should be verified. Describe what the commits and diff actually show; do not invent motivation.',
    },
    {
      role: 'user',
      content:
        `Branch ${m.branch} into ${m.base}.\n\nCommits:\n${m.log || '(none)'}\n\n` +
        `Files changed:\n${m.stat || '(none)'}\n\nDiff:\n${diff}`,
    },
  ];
}
