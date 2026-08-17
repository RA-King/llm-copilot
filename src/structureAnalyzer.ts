import * as vscode from 'vscode';

export type StructureKind =
  | 'class-body' | 'interface-body' | 'function-body'
  | 'impl-body' | 'enum-body' | 'top-level'
  | 'after-class' | 'after-function' | 'unknown';

export type SuggestionKind =
  | 'constructor' | 'getter-setter' | 'method-implementation'
  | 'interface-implementation' | 'struct-init' | 'next-method'
  | 'next-statement' | 'next-declaration' | 'property' | 'enum-case' | 'generic';

export interface FieldInfo {
  name: string;
  type: string;
  hasGetter: boolean;
  hasSetter: boolean;
}

export interface MethodSignature {
  name: string;
  signature: string;
  implemented: boolean;
}

export interface StructureContext {
  structureKind: StructureKind;
  containerName: string;
  containerType: string;
  containerSignature: string;
  bestSuggestionKind: SuggestionKind;
  existingMembers: string[];
  surroundingContext: string;
  isEmpty: boolean;
  depthInContainer: number;
  language: string;
  fields: FieldInfo[];
  nextFieldNeedingAccessor: FieldInfo | null;
  unimplementedMethods: MethodSignature[];
  nextUnimplementedMethod: MethodSignature | null;
}

// ─── Safe document access ──────────────────────────────────────────────────────

/** Clamp a line number to valid document range [0, lineCount-1] */
function clampLine(n: number, doc: vscode.TextDocument): number {
  return Math.max(0, Math.min(n, doc.lineCount - 1));
}

/** Safe lineAt — never throws for out-of-range lines */
function safeLineAt(doc: vscode.TextDocument, line: number): string {
  const clamped = clampLine(line, doc);
  try { return doc.lineAt(clamped).text; } catch { return ''; }
}

/** Safe Range — clamps both ends to valid positions */
function safeRange(
  doc: vscode.TextDocument,
  startLine: number, startChar: number,
  endLine: number, endChar: number
): vscode.Range {
  const sl = clampLine(startLine, doc);
  const el = clampLine(endLine, doc);
  const sc = Math.max(0, Math.min(startChar, safeLineAt(doc, sl).length));
  const ec = Math.max(0, Math.min(endChar, safeLineAt(doc, el).length));
  // Ensure start <= end
  if (sl > el || (sl === el && sc > ec)) {
    return new vscode.Range(sl, sc, sl, sc);
  }
  return new vscode.Range(sl, sc, el, ec);
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

const CLASS_OPEN  = /^\s*(export\s+)?(abstract\s+|final\s+|sealed\s+)?(class|struct|record)\s+(\w+)/;
const IFACE_OPEN  = /^\s*(export\s+)?interface\s+(\w+)/;
const IMPL_OPEN   = /^\s*(pub\s+)?impl(\s*<[^>]*>)?\s+(\w+)/;
const ENUM_OPEN   = /^\s*(export\s+)?enum\s+(\w+)/;
const FN_OPEN     = /^\s*(pub\s+|async\s+|static\s+|private\s+|protected\s+|public\s+|override\s+|virtual\s+)*(async\s+)?(function\s+\w+|fn\s+\w+|\w+\s*\(|\w+\s*=\s*(async\s+)?\()/;
const MEMBER_NAME = /^\s*(public|private|protected|static|readonly|override|async|\s)*\s*(constructor|get|set|function|fn|def)?\s*(\w+)\s*[\(:{=]/;

const FIELD_PATTERNS: Record<string, RegExp[]> = {
  typescript:      [/^\s*(private|protected|public|readonly|\s)+(readonly\s+)?(\w+)\s*[!?]?\s*:\s*([\w<>\[\]| ,?]+)/],
  javascript:      [/^\s*(#?\w+)\s*[=;]/, /^\s*(private|protected|public|\s)+(\w+)\s*[=;:]/],
  java:            [/^\s*(private|protected|public|static|final|\s)+\s+([\w<>\[\]]+)\s+(\w+)\s*[=;]/],
  csharp:          [/^\s*(private|protected|public|static|readonly|\s)+([\w<>\[\]?]+)\s+(\w+)\s*[{=;]/],
  python:          [/^\s*self\.(\w+)\s*(?::\s*([\w\[\]|, ]+))?\s*=/, /^\s*(\w+)\s*:\s*([\w\[\]|, ]+)\s*$/],
  rust:            [/^\s+(pub\s+)?(\w+)\s*:\s*([\w<>\[\]&' ]+),?$/],
  go:              [/^\s+([A-Z]\w*)\s+([\w\[\]\*]+)\s*(?:`[^`]*`)?$/],
  cpp:             [/^\s*(private|protected|public|\s)*(static\s+|const\s+)?([\w:<>*& ]+)\s+(\w+)\s*[=;{]/],
  kotlin:          [/^\s*(private|protected|public|open|\s)*(val|var)\s+(\w+)\s*:\s*([\w<>\[\]?]+)/],
  swift:           [/^\s*(private|internal|public|\s)*(let|var)\s+(\w+)\s*:\s*([\w<>\[\]?]+)/],
};
FIELD_PATTERNS['typescriptreact'] = FIELD_PATTERNS['typescript'];
FIELD_PATTERNS['javascriptreact'] = FIELD_PATTERNS['javascript'];

// ─── Main export ───────────────────────────────────────────────────────────────

export function analyseStructure(
  document: vscode.TextDocument,
  position: vscode.Position
): StructureContext {
  // Guard: ensure position is valid
  if (document.lineCount === 0) { return emptyContext(document.languageId); }
  const safeLine = clampLine(position.line, document);

  const lang = document.languageId;
  const maxLookback = Math.min(safeLine, 150);

  let braceDepth = 0;
  let containerLine = -1;
  let containerType = '';
  let containerName = '';
  let containerSignature = '';
  const existingMembers: string[] = [];
  let linesInside = 0;

  // ── Step 1: scan backward to find the container ────────────────────────────
  for (let i = safeLine - 1; i >= safeLine - maxLookback && i >= 0; i--) {
    const raw = safeLineAt(document, i);
    const trimmed = raw.trim();

    for (let ci = raw.length - 1; ci >= 0; ci--) {
      if (raw[ci] === '}') { braceDepth++; }
      else if (raw[ci] === '{') {
        braceDepth--;
        if (braceDepth < 0) { containerLine = i; break; }
      }
    }

    if (containerLine === i) {
      const sigLines: string[] = [];
      for (let si = i; si < Math.min(i + 4, document.lineCount); si++) {
        sigLines.push(safeLineAt(document, si));
      }
      containerSignature = sigLines.join('\n');

      if (CLASS_OPEN.test(trimmed)) {
        const m = CLASS_OPEN.exec(trimmed)!;
        containerType = m[3]; containerName = m[4];
      } else if (IFACE_OPEN.test(trimmed)) {
        const m = IFACE_OPEN.exec(trimmed)!;
        containerType = 'interface'; containerName = m[2];
      } else if (IMPL_OPEN.test(trimmed)) {
        const m = IMPL_OPEN.exec(trimmed)!;
        containerType = 'impl'; containerName = m[3] ?? 'Self';
      } else if (ENUM_OPEN.test(trimmed)) {
        const m = ENUM_OPEN.exec(trimmed)!;
        containerType = 'enum'; containerName = m[2];
      } else if (FN_OPEN.test(trimmed)) {
        containerType = 'function';
        const m = trimmed.match(/(?:function\s+|fn\s+|def\s+|async\s+function\s+)(\w+)/);
        containerName = m?.[1] ?? 'anonymous';
      }
      break;
    }

    if (braceDepth === 0) {
      linesInside++;
      const mm = MEMBER_NAME.exec(raw);
      if (mm?.[3]) { existingMembers.push(mm[3]); }
    }
  }

  // ── Step 2: determine structure kind ──────────────────────────────────────
  let structureKind: StructureKind = 'unknown';
  if (containerLine === -1) { structureKind = 'top-level'; }
  else if (containerType === 'class' || containerType === 'struct' || containerType === 'record') { structureKind = 'class-body'; }
  else if (containerType === 'interface') { structureKind = 'interface-body'; }
  else if (containerType === 'impl') { structureKind = 'impl-body'; }
  else if (containerType === 'enum') { structureKind = 'enum-body'; }
  else if (containerType === 'function') { structureKind = 'function-body'; }

  // ── Step 3: scan fields and accessors ─────────────────────────────────────
  const fields = containerLine >= 0 && containerLine < document.lineCount
    ? scanFieldsAndAccessors(document, containerLine, lang)
    : [];

  const nextFieldNeedingAccessor = fields.find(f => !f.hasGetter && !f.hasSetter) ?? null;

  const bestSuggestionKind = pickSuggestionKind(structureKind, existingMembers, nextFieldNeedingAccessor);

  const ctxStart = Math.max(0, safeLine - 20);
  const surroundingContext = document.getText(safeRange(document, ctxStart, 0, safeLine, 0));

  return {
    structureKind, containerName, containerType, containerSignature,
    bestSuggestionKind, existingMembers, surroundingContext,
    isEmpty: linesInside < 2,
    depthInContainer: Math.max(0, braceDepth),
    language: lang,
    fields, nextFieldNeedingAccessor,
    unimplementedMethods: [], nextUnimplementedMethod: null,
  };
}

function emptyContext(language: string): StructureContext {
  return {
    structureKind: 'top-level', containerName: '', containerType: '',
    containerSignature: '', bestSuggestionKind: 'next-declaration',
    existingMembers: [], surroundingContext: '', isEmpty: true,
    depthInContainer: 0, language, fields: [],
    nextFieldNeedingAccessor: null, unimplementedMethods: [], nextUnimplementedMethod: null,
  };
}

// ─── Field + accessor scanner ──────────────────────────────────────────────────

function scanFieldsAndAccessors(
  document: vscode.TextDocument,
  containerLine: number,
  language: string
): FieldInfo[] {
  // containerLine is already validated by caller
  const rawFields: Array<{ name: string; type: string }> = [];
  const getterNames = new Set<string>();
  const setterNames = new Set<string>();

  const patterns = FIELD_PATTERNS[language] ?? FIELD_PATTERNS['typescript'];
  // Clamp end to document boundary
  const end = Math.min(containerLine + 200, document.lineCount);
  let depth = 0;

  for (let i = containerLine; i < end; i++) {
    const line = safeLineAt(document, i);
    const trimmed = line.trim();

    for (const ch of line) {
      if (ch === '{') { depth++; }
      else if (ch === '}') { depth--; if (depth <= 0) { break; } }
    }
    if (depth <= 0) { break; }
    if (depth !== 1) { continue; }

    // Detect getter: JS/TS get x()
    const getterM = /^\s*(?:public\s+|protected\s+)?get\s+(\w+)\s*\(/.exec(line);
    if (getterM) { getterNames.add(getterM[1]); continue; }

    // Detect getter: Java/C# getX( or GetX(
    const javaGetterM = /^\s*(?:public\s+|protected\s+)?(?:[\w<>\[\]]+\s+)?(?:get|Get)([A-Z]\w*)\s*\(/.exec(line);
    if (javaGetterM) { getterNames.add(javaGetterM[1][0].toLowerCase() + javaGetterM[1].slice(1)); continue; }

    // Detect getter: Python @property
    if (/^\s*@property\s*$/.test(trimmed)) {
      const nextLine = i + 1 < end ? safeLineAt(document, i + 1) : '';
      const pyM = /def\s+(\w+)/.exec(nextLine);
      if (pyM) { getterNames.add(pyM[1]); }
      continue;
    }

    // Detect setter: JS/TS set x(v)
    const setterM = /^\s*(?:public\s+|protected\s+)?set\s+(\w+)\s*\(/.exec(line);
    if (setterM) { setterNames.add(setterM[1]); continue; }

    // Detect setter: Java/C# setX(
    const javaSetterM = /^\s*(?:public\s+|protected\s+)?(?:void\s+)?(?:set|Set)([A-Z]\w*)\s*\(/.exec(line);
    if (javaSetterM) { setterNames.add(javaSetterM[1][0].toLowerCase() + javaSetterM[1].slice(1)); continue; }

    // Detect setter: Python @x.setter
    if (/^\s*@\w+\.setter\s*$/.test(trimmed)) {
      const nextLine = i + 1 < end ? safeLineAt(document, i + 1) : '';
      const pyM = /def\s+(\w+)/.exec(nextLine);
      if (pyM) { setterNames.add(pyM[1]); }
      continue;
    }

    // Detect field declaration
    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (!m) { continue; }

      let name = '', type = 'any';
      if (language === 'python') {
        name = m[1]; type = m[2] ?? 'Any';
      } else if (language === 'rust' || language === 'go') {
        name = m[language === 'rust' ? 2 : 1] ?? m[1];
        type = m[language === 'rust' ? 3 : 2] ?? 'unknown';
      } else {
        const groups = m.slice(1).filter(Boolean);
        const keywords = new Set(['private','public','protected','static','readonly','final','val','var','let','const','override','abstract']);
        const nameGroup = [...groups].reverse().find(g => /^[a-z_][a-zA-Z0-9_]*$/.test(g) && !keywords.has(g));
        const typeGroup = [...groups].reverse().find(g => g !== nameGroup && /^[A-Za-z]/.test(g) && !keywords.has(g));
        name = nameGroup ?? ''; type = typeGroup ?? 'any';
      }

      if (name && !rawFields.find(f => f.name === name)) {
        rawFields.push({ name, type: type.trim() });
      }
      break;
    }
  }

  return rawFields.map(f => ({
    name: f.name, type: f.type,
    hasGetter: getterNames.has(f.name),
    hasSetter: setterNames.has(f.name),
  }));
}

// ─── Suggestion kind picker ────────────────────────────────────────────────────

function pickSuggestionKind(
  kind: StructureKind, existing: string[], nextField: FieldInfo | null
): SuggestionKind {
  const hasConstructor = existing.some(m =>
    m === 'constructor' || m === '__init__' || m === 'init' || m === 'new'
  );
  switch (kind) {
    case 'class-body':
    case 'impl-body':
      if (!hasConstructor && existing.length === 0) { return 'constructor'; }
      if (nextField !== null) { return 'getter-setter'; }
      return 'next-method';
    case 'interface-body': return 'interface-implementation';
    case 'enum-body':      return 'enum-case';
    case 'function-body':  return 'next-statement';
    case 'top-level':      return 'next-declaration';
    default:               return 'generic';
  }
}

export function extractFields(
  document: vscode.TextDocument, containerLine: number, language: string
): Array<{ name: string; type: string }> {
  return scanFieldsAndAccessors(document, containerLine, language);
}
