import { ChatMessage } from './llmProvider';

/**
 * Extract individual method/function signatures from an interface or abstract
 * class declaration. Returns one entry per method, in declaration order.
 */
export function extractMethodSignatures(
  interfaceCode: string,
  language: string
): Array<{ name: string; signature: string }> {
  const sigs: Array<{ name: string; signature: string }> = [];

  // Patterns: [regex to match a method signature line, capture group index for the name]
  type SigPattern = [RegExp, number];

  const patternsByLang: Record<string, SigPattern[]> = {
    typescript: [
      // methodName(params): ReturnType;
      [/^\s*(?:readonly\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[\w<>\[\]|,\s?]+)?\s*;/, 1],
      // methodName(params): ReturnType  (no semicolon — interface body shorthand)
      [/^\s*(\w+)\s*\([^)]*\)\s*:\s*[\w<>\[\]|,\s?]+\s*$/, 1],
    ],
    javascript: [
      [/^\s*(\w+)\s*\([^)]*\)\s*;/, 1],
    ],
    java: [
      [/^\s*(?:default\s+|static\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*;/, 1],
    ],
    csharp: [
      [/^\s*(?:[\w<>\[\]?]+)\s+(\w+)\s*\([^)]*\)\s*;/, 1],
      // Property: ReturnType Name { get; set; }
      [/^\s*(?:[\w<>\[\]?]+)\s+(\w+)\s*\{[^}]*\}/, 1],
    ],
    python: [
      // def methodName(self, ...)
      [/^\s*(?:@abstractmethod\s*)?def\s+(\w+)\s*\(/, 1],
    ],
    rust: [
      [/^\s*fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*->\s*[\w<>&' ]+)?\s*;/, 1],
    ],
    go: [
      // MethodName(params) ReturnType
      [/^\s*([A-Z]\w*)\s*\(/, 1],
    ],
    cpp: [
      [/^\s*virtual\s+(?:[\w:<>*& ]+)\s+(\w+)\s*\([^)]*\)(?:\s*const)?\s*(?:=\s*0)?\s*;/, 1],
    ],
    kotlin: [
      [/^\s*(?:abstract\s+|open\s+)?fun\s+(\w+)\s*(?:<[^>]*>)?\s*\(/, 1],
    ],
    swift: [
      [/^\s*func\s+(\w+)\s*\(/, 1],
    ],
    php: [
      [/^\s*(?:abstract\s+|public\s+|protected\s+)*function\s+(\w+)\s*\(/, 1],
    ],
  };

  // Alias shared patterns
  patternsByLang['typescriptreact'] = patternsByLang['typescript'];
  patternsByLang['javascriptreact'] = patternsByLang['javascript'];

  const patterns: SigPattern[] = patternsByLang[language] ?? [
    [/^\s*(?:[\w<>\[\]|]+\s+)?(\w+)\s*\([^)]*\)\s*;/, 1],
  ];

  const SKIP_KEYWORDS = new Set([
    'constructor', 'new', 'class', 'interface', 'enum', 'struct',
    'if', 'for', 'while', 'switch', 'try', 'catch',
  ]);

  const lines = interfaceCode.split('\n');
  for (const line of lines) {
    for (const [pattern, nameGroup] of patterns) {
      const m = pattern.exec(line);
      if (m && m[nameGroup] && !SKIP_KEYWORDS.has(m[nameGroup])) {
        // Avoid duplicates
        if (!sigs.find(s => s.name === m[nameGroup])) {
          sigs.push({ name: m[nameGroup], signature: line.trim() });
        }
        break;
      }
    }
  }

  return sigs;
}

/**
 * Build a chat prompt that asks the LLM to implement exactly ONE method.
 * Uses a focused system prompt to prevent the model from generating more.
 */
export function buildSingleMethodImplPrompt(
  methodSignature: string,
  classContext: string,
  language: string
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are an expert ${language} programmer implementing a single interface method. ` +
        `Output ONLY the complete implementation of the ONE method specified — ` +
        `no surrounding class, no markdown fences, no explanation. ` +
        `Include the method signature and its full body. Match the indentation of the class context.`,
    },
    {
      role: 'user',
      content:
        `Implement ONLY this single ${language} method (complete with signature and body):\n` +
        `${methodSignature}\n\n` +
        `Class context (use this to understand field types and naming):\n` +
        `\`\`\`${language}\n${classContext}\n\`\`\`\n\n` +
        `Return ONLY the implementation of this ONE method:`,
    },
  ];
}
