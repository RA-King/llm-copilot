/**
 * duplicationGuard.ts
 *
 * Prevents the ghost text from suggesting code that already exists in the file.
 *
 * Three levels of protection:
 *
 * 1. LINE-LEVEL   — every line of the completion is checked against every line
 *                   in the surrounding context (prefix + suffix). Any completion
 *                   line that already exists verbatim (after normalisation) is
 *                   evidence of duplication.
 *
 * 2. BLOCK-LEVEL  — the entire completion (or a sliding window of N lines) is
 *                   checked against the prefix as a contiguous block. If the
 *                   completion as a whole already appears in the file, reject it.
 *
 * 3. ECHO-STRIP   — if the LLM echoed back the already-typed content at the
 *                   start of the suggestion, strip it rather than rejecting
 *                   the whole suggestion.
 *
 * Normalisation rules (applied before every comparison):
 *   - Strip leading/trailing whitespace from each line
 *   - Collapse internal runs of whitespace to a single space
 *   - Ignore empty lines
 *   - Ignore lines that are pure punctuation / braces only: `{`, `}`, `(`, `)`, `;`
 */

// ─── Normalisation ─────────────────────────────────────────────────────────────

/** Normalise a single line for comparison: trim, collapse whitespace */
function normLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Return true if a normalised line is too trivial to use as a duplicate signal */
function isTrivialLine(norm: string): boolean {
  if (norm.length < 4) { return true; }
  // Pure structural punctuation — these appear everywhere
  if (/^[{}()[\];,]+$/.test(norm)) { return true; }
  // Only a closing brace with optional semicolon/comma
  if (/^\}\s*[;,]?$/.test(norm)) { return true; }
  // Comment-only lines
  if (/^(\/\/|\/\*|\*|#)/.test(norm)) { return true; }
  return false;
}

// ─── Build a lookup of existing lines ─────────────────────────────────────────

/**
 * Build a Set of normalised lines from a block of existing code.
 * Used as O(1) lookup during per-line checking.
 */
function buildExistingLineSet(existingText: string): Set<string> {
  const set = new Set<string>();
  for (const line of existingText.split('\n')) {
    const norm = normLine(line);
    if (!isTrivialLine(norm)) {
      set.add(norm);
    }
  }
  return set;
}

// ─── Level 1: per-line duplication check ──────────────────────────────────────

/**
 * Check every non-trivial line of the completion against existing lines.
 *
 * Policy:
 *  - If MORE THAN HALF of the non-trivial lines already exist → reject entirely
 *  - Otherwise → strip the duplicate lines and return the remainder
 *
 * Stripping rather than always rejecting means single-line suggestions that
 * happen to share a closing brace with existing code don't get dropped entirely.
 */
export function deduplicateLines(
  completion: string,
  prefix: string,
  suffix: string
): string | null {
  const existingSet = buildExistingLineSet(prefix + '\n' + suffix);
  const completionLines = completion.split('\n');

  const nonTrivialLines = completionLines.filter(l => !isTrivialLine(normLine(l)));
  if (nonTrivialLines.length === 0) { return null; }

  // Count how many non-trivial lines are already in the file
  let duplicateCount = 0;
  for (const line of nonTrivialLines) {
    if (existingSet.has(normLine(line))) {
      duplicateCount++;
    }
  }

  // If over half the meaningful lines already exist, the suggestion IS existing code
  const duplicateRatio = duplicateCount / nonTrivialLines.length;
  if (duplicateRatio > 0.5) {
    return null;
  }

  // Strip individual duplicate lines, keep the rest
  const filtered = completionLines.filter(line => {
    const norm = normLine(line);
    // Always keep trivial/structural lines (braces etc.) — they're part of shape
    if (isTrivialLine(norm)) { return true; }
    // Drop lines that already exist
    return !existingSet.has(norm);
  });

  const result = filtered.join('\n').trim();
  return result.length > 0 ? result : null;
}

// ─── Level 2: block-level duplication check ────────────────────────────────────

/**
 * Check whether the completion (as a contiguous block) already appears
 * in the prefix or suffix text.
 *
 * Uses a normalised comparison: collapses all whitespace so indentation
 * differences don't create false negatives.
 */
export function isBlockDuplicate(
  completion: string,
  prefix: string,
  suffix: string
): boolean {
  const normCompletion = normaliseBlock(completion);
  if (normCompletion.length < 20) { return false; } // too short to be meaningful

  const normPrefix = normaliseBlock(prefix);
  const normSuffix = normaliseBlock(suffix);

  return normPrefix.includes(normCompletion) || normSuffix.includes(normCompletion);
}

/** Normalise a multi-line block for substring matching */
function normaliseBlock(text: string): string {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ─── Level 3: echo-strip ───────────────────────────────────────────────────────

/**
 * If the LLM echoed the already-typed prefix back at the start of the
 * completion, strip it. Also strips if the completion starts by repeating
 * the last few lines of the prefix.
 */
export function stripEchoes(
  completion: string,
  prefix: string,
  typedOnCurrentLine: string
): string {
  let result = completion;

  // Strip echoed current-line prefix
  if (typedOnCurrentLine.trim()) {
    const typed = typedOnCurrentLine.trim();
    const compTrimmed = result.trimStart();
    if (compTrimmed.startsWith(typed)) {
      // Remove the echo, preserve any leading whitespace for indent
      const leadingWS = result.slice(0, result.length - result.trimStart().length);
      result = leadingWS + compTrimmed.slice(typed.length);
    }
  }

  // Strip echoed last lines of prefix
  // Get the last 3 non-trivial lines of the prefix
  const prefixLines = prefix
    .split('\n')
    .map(l => l.trim())
    .filter(l => !isTrivialLine(l))
    .slice(-3);

  const compLines = result.split('\n');

  // Remove from the top of the completion any lines that repeat trailing prefix
  let stripCount = 0;
  for (let i = 0; i < Math.min(compLines.length, prefixLines.length); i++) {
    const compNorm = normLine(compLines[i]);
    if (!isTrivialLine(compNorm) && prefixLines.includes(compNorm)) {
      stripCount = i + 1;
    } else {
      break;
    }
  }
  if (stripCount > 0) {
    result = compLines.slice(stripCount).join('\n');
  }

  // Remove leading blank lines left by stripping
  result = result.replace(/^\n+/, '');

  return result;
}

// ─── Combined guard (main entry point) ────────────────────────────────────────

/**
 * Run all duplication checks in order. Returns the cleaned completion
 * string, or null if the completion should be suppressed entirely.
 *
 * @param completion  The formatted completion text from the LLM
 * @param prefix      All document text before the cursor
 * @param suffix      All document text after the cursor
 * @param typedOnLine What the user has already typed on the current line
 */
export function guardAgainstDuplication(
  completion: string,
  prefix: string,
  suffix: string,
  typedOnLine: string
): string | null {
  if (!completion.trim()) { return null; }

  // Level 3 first: strip echoes before comparing against existing code
  let cleaned = stripEchoes(completion, prefix, typedOnLine);
  if (!cleaned.trim()) { return null; }

  // Level 2: block-level check — is this entire suggestion already in the file?
  if (isBlockDuplicate(cleaned, prefix, suffix)) { return null; }

  // Level 1: per-line check — strip/reject duplicate lines
  const deduped = deduplicateLines(cleaned, prefix, suffix);
  if (!deduped) { return null; }

  return deduped;
}
