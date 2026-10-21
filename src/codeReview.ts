import { ChatMessage } from './llmProvider';

/**
 * Review of a selection or of the uncommitted changes, answered as findings
 * pinned to lines. The model is shown every line with the number it has in
 * the file as it now stands, so the numbers it quotes back can be trusted
 * without it having to count through diff hunks.
 */

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface ReviewFinding {
  /** As the model wrote it; undefined when reviewing a single file. */
  file?: string;
  /** One-based. */
  line: number;
  severity: FindingSeverity;
  message: string;
}

/** Prefix each line with its one-based number, starting from `firstLine`. */
export function numberLines(code: string, firstLine: number): string {
  const lines = code.split('\n');
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(firstLine + i).padStart(width)} | ${l}`).join('\n');
}

/**
 * A unified diff rewritten so that every line still in the file carries its
 * new line number and removed lines are marked but unnumbered:
 *
 *   === src/app.ts
 *     41   unchanged
 *     42 + added
 *        - removed
 */
export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git')) { inHunk = false; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      if (target !== '/dev/null') { out.push(`=== ${target}`); }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('index ') || /^(new|deleted) file mode/.test(line)) { continue; }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      inHunk = true;
      out.push('   …');
      continue;
    }
    if (!inHunk) { continue; }

    if (line.startsWith('+')) { out.push(`${String(newLine++).padStart(5)} + ${line.slice(1)}`); }
    else if (line.startsWith('-')) { out.push(`      - ${line.slice(1)}`); }
    else if (line.startsWith(' ')) { out.push(`${String(newLine++).padStart(5)}   ${line.slice(1)}`); }
  }
  return out.join('\n');
}

const FORMAT =
  'Report each problem on its own line, exactly as:\n' +
  'path/to/file.ext:LINE: severity: message\n\n' +
  'severity is one of error, warning or info. LINE is the number shown beside the code. ' +
  'The message says what is wrong and what to do instead, in one or two sentences. ' +
  'Report real defects first — bugs, unhandled errors, security problems, races, wrong edge cases — ' +
  'then maintainability problems that matter. Do not comment on formatting or style a linter would catch, ' +
  'and do not praise. If there is nothing worth raising, reply with exactly: NO ISSUES';

export function buildReviewSelectionPrompt(code: string, language: string, file: string, firstLine: number): ChatMessage[] {
  return [
    { role: 'system', content: `You are a meticulous senior ${language} code reviewer.\n\n${FORMAT}` },
    { role: 'user', content: `Review this code from ${file}:\n\n${numberLines(code, firstLine)}` },
  ];
}

export function buildReviewChangesPrompt(annotatedDiff: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You are a meticulous senior code reviewer reviewing uncommitted changes. ' +
        'Lines marked + were added, lines marked - were removed, the rest are unchanged context. ' +
        'Review only what the change introduces or breaks.\n\n' + FORMAT,
    },
    { role: 'user', content: `Review these changes:\n\n${annotatedDiff}` },
  ];
}

export function parseReviewFindings(reply: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const raw of reply.split('\n')) {
    const line = raw.trim().replace(/^[-*•]\s+/, '').replace(/`/g, '');
    const m = /^(?:\[?([^\s:\]]+?)\]?:)?\s*(?:line\s+)?(\d+)\]?\s*[:\-–]\s*(error|warning|info|note|suggestion)\s*[:\-–]\s*(.+)$/i.exec(line);
    if (!m) { continue; }
    const severity = m[3].toLowerCase();
    findings.push({
      file: m[1] || undefined,
      line: parseInt(m[2], 10),
      severity: severity === 'error' || severity === 'warning' ? severity : 'info',
      message: m[4].trim(),
    });
  }
  return findings;
}
