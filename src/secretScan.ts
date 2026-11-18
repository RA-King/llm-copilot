/**
 * Credentials written into code in plain text. Matched by the formats
 * providers give their keys, which is precise enough to report without a
 * model; a password assigned in code is matched by shape, and only when the
 * value is not a placeholder or a lookup.
 *
 * Used by code review, on the lines a change adds, and by the agent, on what
 * it writes.
 */

export interface SecretFinding {
  /** One-based line in the text scanned (or in the file, for a diff). */
  line: number;
  kind: string;
  /** The match with most of it masked, safe to show. */
  preview: string;
  /** For a diff, the file the line is in. */
  file?: string;
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Which capture group holds the secret itself; 0 for the whole match. */
  group?: number;
}

const RULES: Rule[] = [
  { kind: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-proj-[A-Za-z0-9_-]{40,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/ },
  { kind: 'Stripe secret key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { kind: 'SendGrid API key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'password in a connection string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{4,})@[^\s'"]+/i, group: 1 },
  {
    kind: 'hard-coded password',
    pattern: /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    group: 1,
  },
];

/** Values that stand in for a secret rather than being one. */
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]*%|\$[A-Z_][A-Z0-9_]*|.*(?:example|placeholder|changeme|change_me|your[_-]?|dummy|redacted|xxxx|test|sample|fake).*)$/i;

export function maskSecret(value: string): string {
  if (value.length <= 8) { return '*'.repeat(value.length); }
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 6, 20))}${value.slice(-2)}`;
}

/** Secrets on one line of code, at most one per rule. */
export function scanLine(text: string): { kind: string; preview: string }[] {
  const found: { kind: string; preview: string }[] = [];
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (!m) { continue; }
    const value = m[rule.group ?? 0];
    if (rule.group && PLACEHOLDER.test(value)) { continue; }
    found.push({ kind: rule.kind, preview: rule.kind === 'private key' ? m[0] : maskSecret(value) });
  }
  return found;
}

export function scanText(text: string, firstLine = 1): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    for (const hit of scanLine(line)) { findings.push({ line: firstLine + i, ...hit }); }
  });
  return findings;
}

/** Secrets on the lines a unified diff adds, with each line's number in the new file. */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file: string | undefined;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git')) { inHunk = false; file = undefined; continue; }
    if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      file = target === '/dev/null' ? undefined : target;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { newLine = parseInt(hunk[1], 10); inHunk = true; continue; }
    if (!inHunk) { continue; }

    if (line.startsWith('+')) {
      for (const hit of scanLine(line.slice(1))) { findings.push({ file, line: newLine, ...hit }); }
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return findings;
}

/** One sentence for a finding, the same wherever it is shown. */
export function describeSecret(finding: SecretFinding): string {
  return `Possible ${finding.kind} in plain text (${finding.preview}). ` +
    'Move it out of the code, into an environment variable or a secret store, and revoke it if it has been shared.';
}
