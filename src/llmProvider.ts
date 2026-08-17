import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { StructureContext } from './structureAnalyzer';

export type CompletionIntent = 'new-block' | 'new-statement' | 'completing-started';

export interface CompletionRequest {
  prefix: string; suffix: string; language: string; filename: string;
  intent: CompletionIntent; nestingDepth: number; structure: StructureContext;
  /** If the trigger was a keyword, the keyword itself (e.g. "function", "class") */
  keywordHint?: string;
  /** Relevant signatures from other workspace files */
  workspaceContext?: string;
}

export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }

export interface LLMConfig {
  provider: string; model: string; apiKey: string;
  baseUrl: string; maxTokens: number; temperature: number;
}

function getConfig(): LLMConfig {
  const cfg = vscode.workspace.getConfiguration('llmCopilot');
  return {
    provider: cfg.get('provider', 'ollama'), model: cfg.get('model', 'codellama'),
    apiKey: cfg.get('apiKey', ''), baseUrl: cfg.get('baseUrl', 'http://localhost:11434'),
    maxTokens: cfg.get('maxTokens', 256), temperature: cfg.get('temperature', 0.2),
  };
}

async function httpRequest(url: string, body: object, headers: Record<string,string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // WHATWG URL API — never use the legacy url.parse() which triggers DeprecationWarning
    let parsed: URL;
    try { parsed = new URL(url); }
    catch (e) { reject(new Error(`Invalid URL: ${url}`)); return; }

    const isHttps = parsed.protocol === 'https:';
    // parsed.port is '' when using the default port; convert explicitly
    const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);

    const req = (isHttps ? https : http).request({
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function ollamaComplete(prompt: string, cfg: LLMConfig): Promise<string> {
  const raw = await httpRequest(`${cfg.baseUrl.replace(/\/$/, '')}/api/generate`, {
    model: cfg.model, prompt, stream: false,
    options: { temperature: cfg.temperature, num_predict: cfg.maxTokens, stop: ['\n\n\n', '```'] },
  });
  return JSON.parse(raw).response || '';
}

async function ollamaChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const raw = await httpRequest(`${cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
    model: cfg.model, messages, stream: false, options: { temperature: cfg.temperature },
  });
  return JSON.parse(raw).message?.content || '';
}

function openaiBaseUrl(cfg: LLMConfig): string {
  const m: Record<string,string> = {
    openai: 'https://api.openai.com', groq: 'https://api.groq.com/openai',
    openrouter: 'https://openrouter.ai/api', lmstudio: cfg.baseUrl, custom: cfg.baseUrl,
  };
  return (m[cfg.provider] || cfg.baseUrl).replace(/\/$/, '');
}

async function openaiComplete(prompt: string, cfg: LLMConfig): Promise<string> {
  const hdrs: Record<string,string> = {};
  if (cfg.apiKey) hdrs['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === 'openrouter') { hdrs['HTTP-Referer'] = 'https://llm-copilot'; hdrs['X-Title'] = 'LLM Copilot'; }
  const raw = await httpRequest(`${openaiBaseUrl(cfg)}/v1/chat/completions`, {
    model: cfg.model, messages: [{ role: 'user', content: prompt }],
    max_tokens: cfg.maxTokens, temperature: cfg.temperature, stop: ['\n\n\n'],
  }, hdrs);
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}

async function openaiChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const hdrs: Record<string,string> = {};
  if (cfg.apiKey) hdrs['Authorization'] = `Bearer ${cfg.apiKey}`;
  const raw = await httpRequest(`${openaiBaseUrl(cfg)}/v1/chat/completions`, {
    model: cfg.model, messages, max_tokens: 2048, temperature: cfg.temperature,
  }, hdrs);
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}

async function anthropicChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const raw = await httpRequest('https://api.anthropic.com/v1/messages', {
    model: cfg.model || 'claude-3-5-sonnet-20241022', max_tokens: 2048,
    system: sys || undefined, messages: messages.filter(m => m.role !== 'system'),
  }, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' });
  return JSON.parse(raw).content?.[0]?.text || '';
}

async function mistralChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const raw = await httpRequest('https://api.mistral.ai/v1/chat/completions', {
    model: cfg.model || 'mistral-large-latest', messages, max_tokens: 2048, temperature: cfg.temperature,
  }, { Authorization: `Bearer ${cfg.apiKey}` });
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}
// ─── Google Gemini ────────────────────────────────────────────────────────────
// Uses Gemini's OpenAI-compatible endpoint (v1beta/openai) — same format as OpenAI.
async function geminiChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const model = cfg.model || 'gemini-2.5-flash';
  const raw = await httpRequest(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    { model, messages, max_tokens: 2048, temperature: cfg.temperature },
    { Authorization: `Bearer ${cfg.apiKey}` }
  );
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}

// ─── DeepSeek ─────────────────────────────────────────────────────────────────
// OpenAI-compatible API. Great for code (deepseek-coder, deepseek-reasoner).
async function deepseekChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const model = cfg.model || 'deepseek-chat';
  const raw = await httpRequest('https://api.deepseek.com/v1/chat/completions',
    { model, messages, max_tokens: 2048, temperature: cfg.temperature },
    { Authorization: `Bearer ${cfg.apiKey}` }
  );
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}

// ─── xAI Grok ─────────────────────────────────────────────────────────────────
// OpenAI-compatible API.
async function grokChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const model = cfg.model || 'grok-3-mini';
  const raw = await httpRequest('https://api.x.ai/v1/chat/completions',
    { model, messages, max_tokens: 2048, temperature: cfg.temperature },
    { Authorization: `Bearer ${cfg.apiKey}` }
  );
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}

// ─── Azure OpenAI ─────────────────────────────────────────────────────────────
// baseUrl = https://{resource}.openai.azure.com/openai/deployments/{deployment}
// model   = deployment name (included in URL, not body)
// apiKey  = Azure API key (header: api-key)
async function azureChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  const apiVersion = '2024-12-01-preview';
  const base = cfg.baseUrl.replace(/\/$/, '');
  const url  = `${base}/chat/completions?api-version=${apiVersion}`;
  const raw  = await httpRequest(url,
    { messages, max_tokens: 2048, temperature: cfg.temperature },
    { 'api-key': cfg.apiKey }
  );
  return JSON.parse(raw).choices?.[0]?.message?.content || '';
}
// ─── Claude Code (local CLI server) ──────────────────────────────────────────
//
// Claude Code CLI does not expose its own HTTP server. Users run a community
// proxy that wraps the CLI. Different proxies use different ports and paths:
//
//   claude-max-api-proxy  →  port 3456,  POST /v1/chat/completions
//   claude-code-api       →  port 8000,  POST /v1/chat/completions
//   copilot-api           →  port 4141,  POST /v1/chat/completions
//   claude-code-proxy     →  port 8082,  POST /v1/messages
//   direct ant CLI        →  port 3000,  POST /v1/messages
//
// We auto-discover the correct port+path combination by probing candidates.
// Once found it is cached for the session so subsequent calls are instant.

/** Known Claude Code proxy configurations to probe, in priority order */
const CLAUDE_CODE_CANDIDATES = [
  // (port, path, isAnthropic)
  [3000,  '/v1/messages',           true ],
  [3000,  '/v1/chat/completions',   false],
  [3456,  '/v1/chat/completions',   false],  // claude-max-api-proxy default
  [8000,  '/v1/chat/completions',   false],  // claude-code-api default
  [4141,  '/v1/chat/completions',   false],  // copilot-api default
  [8082,  '/v1/messages',           true ],  // claude-code-proxy default
  [8080,  '/v1/chat/completions',   false],
  [1234,  '/v1/chat/completions',   false],  // LM Studio also uses this
  [11435, '/v1/chat/completions',   false],
] as const;

interface DiscoveredEndpoint { port: number; path: string; isAnthropic: boolean; }
let _cachedEndpoint: DiscoveredEndpoint | null = null;
let _cachedBaseUrl = '';

function parseClaudeCodeResponse(raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (j.content?.[0]?.text)               { return j.content[0].text; }
    if (j.choices?.[0]?.message?.content)   { return j.choices[0].message.content; }
    return '';
  } catch { return ''; }
}

function buildClaudeCodeBody(
  messages: ChatMessage[], maxTokens: number, model: string, isAnthropic: boolean
): { body: Record<string,unknown>; headers: Record<string,string> } {
  const sysContent = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userMsgs   = messages.filter(m => m.role !== 'system');

  if (isAnthropic) {
    const body: Record<string,unknown> = {
      model,
      // user/assistant messages — no system role here
      messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
    };
    if (sysContent) {
      // Canonical Anthropic format: system as array of content blocks.
      // Plain-string system also accepted by most proxies, but content-block
      // array is the strict spec and avoids 422 from strict validators.
      body['system'] = [{ type: 'text', text: sysContent }];
    }
    return { body, headers: { 'anthropic-version': '2023-06-01' } };
  }

  // OpenAI-compatible: system stays inside messages array as role:'system'
  return {
    body: {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
    },
    headers: {},
  };
}

async function probeEndpoint(
  host: string, port: number, path: string, isAnthropic: boolean, model: string
): Promise<boolean> {
  const url = `http://${host}:${port}${path}`;
  const { body, headers } = buildClaudeCodeBody(
    [{ role: 'user', content: 'Reply with the single word OK.' }], 16, model, isAnthropic
  );
  try {
    const raw = await httpRequest(url, body, headers);
    // Must be a 200 with parseable JSON that has actual content
    const parsed = JSON.parse(raw);
    const hasContent =
      typeof parsed?.content?.[0]?.text === 'string' ||
      typeof parsed?.choices?.[0]?.message?.content === 'string';
    return hasContent;
  } catch (e: any) {
    return false; // 405, 404, connection refused, parse error → not a working endpoint
  }
}

async function discoverEndpoint(cfg: LLMConfig): Promise<DiscoveredEndpoint> {
  // Return cached result if baseUrl hasn't changed
  if (_cachedEndpoint && _cachedBaseUrl === cfg.baseUrl) { return _cachedEndpoint; }

  const model = cfg.model || 'claude-opus-4-5';
  const configuredBase = cfg.baseUrl.replace(/\/$/, '');

  // Check for explicit apiPath override in settings
  const apiPathOverride = (vscode.workspace.getConfiguration('llmCopilot').get('claudeCodeApiPath', '') as string).trim();
  if (apiPathOverride) {
    let parsed: URL;
    try { parsed = new URL(configuredBase); } catch { throw new Error(`Invalid baseUrl: ${configuredBase}`); }
    const port = parsed.port ? parseInt(parsed.port, 10) : 80;
    const isAnthropic = apiPathOverride.includes('messages');
    console.log(`[LLM Copilot/claudecode] using override path ${apiPathOverride}`);
    const ep = { port, path: apiPathOverride, isAnthropic };
    _cachedEndpoint = ep; _cachedBaseUrl = cfg.baseUrl;
    return ep;
  }

  // First try the configured baseUrl with each path
  let configuredHost = 'localhost';
  let configuredPort = 3000;
  try {
    const u = new URL(configuredBase);
    configuredHost = u.hostname;
    configuredPort = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  } catch { /* ignore */ }

  console.log(`[LLM Copilot/claudecode] discovering endpoint at ${configuredHost}:${configuredPort}…`);

  // Try configured port with both path styles first
  for (const [, path, isAnthropic] of CLAUDE_CODE_CANDIDATES.filter(([p]) => p === configuredPort)) {
    if (await probeEndpoint(configuredHost, configuredPort, path, isAnthropic as boolean, model)) {
      const ep = { port: configuredPort, path: path as string, isAnthropic: isAnthropic as boolean };
      console.log(`[LLM Copilot/claudecode] found at :${configuredPort}${path}`);
      _cachedEndpoint = ep; _cachedBaseUrl = cfg.baseUrl;
      return ep;
    }
  }

  // Then try all other known ports
  for (const [port, path, isAnthropic] of CLAUDE_CODE_CANDIDATES) {
    if (port === configuredPort) { continue; } // already tried
    if (await probeEndpoint(configuredHost, port as number, path as string, isAnthropic as boolean, model)) {
      const ep = { port: port as number, path: path as string, isAnthropic: isAnthropic as boolean };
      console.log(`[LLM Copilot/claudecode] auto-discovered at :${port}${path}`);
      _cachedEndpoint = ep; _cachedBaseUrl = cfg.baseUrl;
      return ep;
    }
  }

  throw new Error(
    `Claude Code proxy not found.\n` +
    `Tried ports: ${[...new Set(CLAUDE_CODE_CANDIDATES.map(([p]) => p))].join(', ')} on ${configuredHost}.\n` +
    `Make sure your proxy is running, then run "LLM Copilot: Diagnose Claude Code Connection".`
  );
}

async function claudeCodeRequest(
  messages: ChatMessage[],
  cfg: LLMConfig,
  maxTokens: number
): Promise<string> {
  const model = cfg.model || 'claude-opus-4-5';

  // Discover (or use cached) working endpoint
  const ep = await discoverEndpoint(cfg);

  const configuredBase = cfg.baseUrl.replace(/\/$/, '');
  let host = 'localhost';
  try { host = new URL(configuredBase).hostname; } catch { /* ignore */ }

  const url = `http://${host}:${ep.port}${ep.path}`;
  const { body, headers } = buildClaudeCodeBody(messages, maxTokens, model, ep.isAnthropic);

  try {
    const raw = await httpRequest(url, body, headers);
    return parseClaudeCodeResponse(raw);
  } catch (err: any) {
    // If the cached endpoint suddenly fails (proxy restarted on different port), clear cache and retry once
    if (/HTTP (405|404|501)/.test(err.message)) {
      console.log(`[LLM Copilot/claudecode] cached endpoint ${url} returned ${err.message.slice(0,20)}, clearing cache`);
      _cachedEndpoint = null;
      _cachedBaseUrl  = '';
      const ep2 = await discoverEndpoint(cfg);
      const url2 = `http://${host}:${ep2.port}${ep2.path}`;
      const { body: body2, headers: headers2 } = buildClaudeCodeBody(messages, maxTokens, model, ep2.isAnthropic);
      const raw = await httpRequest(url2, body2, headers2);
      return parseClaudeCodeResponse(raw);
    }
    throw err;
  }
}

async function claudeCodeComplete(prompt: string, cfg: LLMConfig): Promise<string> {
  return claudeCodeRequest([{ role: 'user', content: prompt }], cfg, cfg.maxTokens);
}

async function claudeCodeChat(messages: ChatMessage[], cfg: LLMConfig): Promise<string> {
  return claudeCodeRequest(messages, cfg, 2048);
}

/** Fetch available models — tries /v1/models on the discovered port */
export async function listClaudeCodeModels(baseUrl: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return []; }
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);
  return new Promise<string[]>((resolve) => {
    const req = (isHttps ? https : http).get({
      hostname: parsed.hostname, port,
      path: parsed.pathname + parsed.search,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
          resolve(models.length > 0 ? models : ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001']);
        } catch { resolve(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001']); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(3000, () => { req.destroy(); resolve([]); });
  });
}

export async function getCompletion(req: CompletionRequest): Promise<string> {
  const cfg = getConfig();
  const prompt = buildCompletionPrompt(req);
  if (cfg.provider === 'ollama') return ollamaComplete(prompt, cfg);
  if (cfg.provider === 'anthropic') return anthropicChat([{ role: 'user', content: prompt }], cfg);
  if (cfg.provider === 'mistral') return mistralChat([{ role: 'user', content: prompt }], cfg);
  if (cfg.provider === 'claudecode') return claudeCodeComplete(prompt, cfg);
  if (cfg.provider === 'gemini')    return geminiChat([{ role: 'user', content: prompt }], cfg);
  if (cfg.provider === 'deepseek')  return deepseekChat([{ role: 'user', content: prompt }], cfg);
  if (cfg.provider === 'grok')      return grokChat([{ role: 'user', content: prompt }], cfg);
  if (cfg.provider === 'azure')     return azureChat([{ role: 'user', content: prompt }], cfg);
  return openaiComplete(prompt, cfg);
}

export async function chat(messages: ChatMessage[]): Promise<string> {
  const cfg = getConfig();
  if (cfg.provider === 'ollama') return ollamaChat(messages, cfg);
  if (cfg.provider === 'anthropic') return anthropicChat(messages, cfg);
  if (cfg.provider === 'mistral') return mistralChat(messages, cfg);
  if (cfg.provider === 'claudecode') return claudeCodeChat(messages, cfg);
  if (cfg.provider === 'gemini')    return geminiChat(messages, cfg);
  if (cfg.provider === 'deepseek')  return deepseekChat(messages, cfg);
  if (cfg.provider === 'grok')      return grokChat(messages, cfg);
  if (cfg.provider === 'azure')     return azureChat(messages, cfg);
  return openaiChat(messages, cfg);
}

export async function testConnection(): Promise<{ success: boolean; message: string }> {
  const cfg = getConfig();
  try {
    if (cfg.provider === 'ollama') {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/tags`;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      await new Promise<void>((resolve, reject) => {
        const req = (isHttps ? https : http).get(url, res => {
          if (res.statusCode === 200) resolve(); else reject(new Error(`Status ${res.statusCode}`));
          res.resume();
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
        return { success: true, message: `Connected to Ollama at ${cfg.baseUrl}` };
    }
    // New providers all use OpenAI-compatible format — test with a short message
    if (['gemini','deepseek','grok','azure'].includes(cfg.provider)) {
      const result = await chat([{ role: 'user', content: 'Say OK.' }]);
      const modelInfo = cfg.model || '(default model)';
      return { success: true, message: `✅ Connected to ${cfg.provider} (${modelInfo}): ${result.slice(0,60)}` };
    }
    if (cfg.provider === 'claudecode') {
      try {
        // Reset cache so testConnection always re-probes
        _cachedEndpoint = null; _cachedBaseUrl = '';
        const ep = await discoverEndpoint(cfg);
        return {
          success: true,
          message: `Connected to Claude Code — port ${ep.port}, path ${ep.path} (${ep.isAnthropic ? 'Anthropic' : 'OpenAI'} format)`,
        };
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    }
    const result = await chat([{ role: 'user', content: 'Say OK.' }]);
    return { success: true, message: `Connected to ${cfg.provider} (${cfg.model}). Response: ${result.slice(0,50)}` };
  } catch (err: any) {
    return { success: false, message: `Connection failed: ${err.message}` };
  }
}

// ─── Completion prompt ────────────────────────────────────────────────────────

function buildCompletionPrompt(req: CompletionRequest): string {
  const s = req.structure;
  const lang = req.language;
  let structuralGuide = '';

  if (s.structureKind === 'class-body' || s.structureKind === 'impl-body') {
    const existing = s.existingMembers.length
      ? `Already implemented: ${s.existingMembers.join(', ')}.` : 'No members yet.';
    const hints: Record<string,string> = {
      constructor: `The ${s.containerType} has NO constructor yet. Generate a constructor that accepts all fields as parameters and assigns them. Include proper types.`,
      'getter-setter': s.nextFieldNeedingAccessor
        ? `Generate ONLY the getter and setter for the field "${s.nextFieldNeedingAccessor.name}" (type: ${s.nextFieldNeedingAccessor.type}). One field only — NOT all fields. Follow ${lang} naming conventions (get/set accessors for TS/JS, getFieldName/setFieldName for Java/C#, @property for Python).`
        : `Suggest the next logical method for "${s.containerName}".`,
      'next-method': `Suggest the next logical method for "${s.containerName}". Infer from existing members what is missing.`,
      property: `Suggest the next property/field declaration.`,
    };
    structuralGuide = `You are inside a ${s.containerType} named "${s.containerName}".
${existing}
${hints[s.bestSuggestionKind] ?? hints['next-method']}
Declaration: ${s.containerSignature}`;
  } else if (s.structureKind === 'interface-body') {
    structuralGuide = `You are inside an interface "${s.containerName}". Suggest the next method SIGNATURE only — no body. Interface: ${s.containerSignature}`;
  } else if (s.structureKind === 'function-body') {
    structuralGuide = `You are inside a function body (depth ${req.nestingDepth}). Suggest the next logical statement(s). Do NOT rewrite existing code.`;
  } else if (s.structureKind === 'enum-body') {
    structuralGuide = `You are inside enum "${s.containerName}". Suggest the next logical enum case/variant.`;
  } else {
    structuralGuide = `You are at the top level of a ${lang} file. Suggest the next logical declaration.`;
  }

  const workspaceSection = req.workspaceContext
    ? `
${req.workspaceContext}
`
    : '';

  return `You are an expert ${lang} code completion engine. Suggest ONLY new code — never rewrite existing code.

${structuralGuide}
${workspaceSection}
Rules: Output raw code ONLY. No markdown, no backticks, no explanation. Match indentation exactly.
For constructors: full implementation with all field assignments.
For getters/setters: complete pairs.
For methods: full implementation, not just signature.
Use correct type signatures from the workspace context above when referenced types appear.
Never repeat existing code above cursor.

File: ${req.filename}

\`\`\`${lang}
${req.prefix}<CURSOR>${req.suffix}
\`\`\`

Completion:`;
}

// ─── Scaffold / Smart prompts ─────────────────────────────────────────────────

export function buildImplementationPrompt(
  containerCode: string, language: string,
  kind: 'constructor' | 'getters-setters' | 'interface-impl' | 'all-members' | 'toString' | 'equals',
  interfaceCode?: string,
  /** When kind='getters-setters': target a single field instead of all fields */
  singleField?: { name: string; type: string }
): ChatMessage[] {
  const instructions: Record<string,string> = {
    constructor: `Generate ONLY a constructor for this ${language} class. All fields as parameters with types. Full body with field assignments.`,
    'getters-setters': singleField
      ? `Generate ONLY the getter and setter pair for the single field named "${singleField.name}" with type "${singleField.type}". ONE field only — do not generate accessors for any other field. Use ${language} naming conventions (get/set for TS/JS, getFieldName/setFieldName for Java/C#, @property for Python). Include the full implementation.`
      : `Generate ONLY getter and setter methods for all private/protected fields. Use ${language} naming conventions. Full implementations.`,
    'interface-impl': `Generate ONLY the full implementations of every method declared in the interface. Include complete method bodies.`,
    'all-members': `Generate the complete class implementation: constructor, getters/setters, toString/equals/hashCode (if applicable). Full bodies, not stubs.`,
    toString: `Generate ONLY a toString/display/fmt method that returns a meaningful string representation of the object.`,
    equals: `Generate ONLY equals/hashCode (Java/Kotlin) or __eq__/__hash__ (Python) or PartialEq (Rust) implementation.`,
  };
  const body = interfaceCode
    ? `${instructions[kind]}\n\nInterface:\n\`\`\`${language}\n${interfaceCode}\n\`\`\`\n\nClass:\n\`\`\`${language}\n${containerCode}\n\`\`\``
    : `${instructions[kind]}\n\n\`\`\`${language}\n${containerCode}\n\`\`\``;
  return [
    { role: 'system', content: `You are an expert ${language} programmer. Output ONLY raw code — no markdown fences, no explanation. Match the input indentation.` },
    { role: 'user', content: body },
  ];
}

export function buildTestPrompt(code: string, language: string, framework?: string): ChatMessage[] {
  const fw = framework ? `Use the ${framework} testing framework.` : 'Use the most common testing framework for the language.';
  return [
    { role: 'system', content: `You are an expert ${language} test engineer. Generate comprehensive unit tests. ${fw} Cover happy paths, edge cases, and error cases. Output only raw test code.` },
    { role: 'user', content: `Generate unit tests for:\n\`\`\`${language}\n${code}\n\`\`\`` },
  ];
}

export function buildRefactorPrompt(selectedCode: string, language: string, instruction: string): ChatMessage[] {
  return [
    { role: 'system', content: `You are an expert ${language} programmer. Perform the requested refactoring. Return ONLY the refactored code — no markdown, no explanation. Match surrounding indentation.` },
    { role: 'user', content: `Refactor this ${language} code.\nInstruction: ${instruction}\n\nCode:\n\`\`\`${language}\n${selectedCode}\n\`\`\`\n\nReturn only the refactored code:` },
  ];
}

export function buildExplainPrompt(code: string, language: string): ChatMessage[] {
  return [
    { role: 'system', content: 'You are an expert code reviewer. Give clear, concise explanations.' },
    { role: 'user', content: `Explain this ${language} code:\n\`\`\`${language}\n${code}\n\`\`\`` },
  ];
}

export function buildFixPrompt(code: string, language: string): ChatMessage[] {
  return [
    { role: 'system', content: 'You are an expert programmer. Fix bugs. Return only the corrected code.' },
    { role: 'user', content: `Fix bugs in this ${language} code:\n\`\`\`${language}\n${code}\n\`\`\`` },
  ];
}

export function buildDocstringPrompt(code: string, language: string): ChatMessage[] {
  return [
    { role: 'system', content: 'Generate documentation comments. Return only the comment.' },
    { role: 'user', content: `Generate a docstring for this ${language} code:\n\`\`\`${language}\n${code}\n\`\`\`` },
  ];
}

export function buildInlineChatPrompt(
  instruction: string, selectedCode: string | null,
  surroundingContext: string, language: string
): ChatMessage[] {
  const code = selectedCode ? `\n\nSelected code:\n\`\`\`${language}\n${selectedCode}\n\`\`\`` : '';
  const ctx = surroundingContext ? `\n\nContext:\n\`\`\`${language}\n${surroundingContext}\n\`\`\`` : '';
  return [
    { role: 'system', content: `You are an expert ${language} assistant in the editor. Be concise and direct. For code changes output only the modified code.` },
    { role: 'user', content: `${instruction}${code}${ctx}` },
  ];
}

export function buildCommitMessagePrompt(diff: string): ChatMessage[] {
  return [
    { role: 'system', content: 'Generate a concise git commit message in Conventional Commits format (type: description). Output ONLY the message.' },
    { role: 'user', content: `Write a commit message for this diff:\n\n${diff.slice(0, 3000)}` },
  ];
}

/** Run diagnostic probes against a Claude Code server and return result lines */
export async function diagnoseClaudeCode(baseUrl: string): Promise<string[]> {
  const results: string[] = [];
  const model = vscode.workspace.getConfiguration('llmCopilot').get('model', 'claude-opus-4-5') as string;
  let host = 'localhost';
  try { host = new URL(baseUrl).hostname; } catch { /* ignore */ }

  results.push(`Probing host: ${host}`);
  results.push(`Configured baseUrl: ${baseUrl}`);
  results.push('');

  for (const [port, path, isAnthropic] of CLAUDE_CODE_CANDIDATES) {
    const url = `http://${host}:${port}${path}`;
    const { body, headers } = buildClaudeCodeBody(
      [{ role: 'user', content: 'Say hi' }], 16, model, isAnthropic as boolean
    );
    try {
      const raw = await httpRequest(url, body, headers);
      const preview = raw.slice(0, 100).replace(/\n/g, ' ');
      results.push(`✅ PORT ${port}  ${path}  (${isAnthropic ? 'Anthropic' : 'OpenAI'} format)`);
      results.push(`   response: ${preview}`);
      results.push(`   → Set llmCopilot.baseUrl to "http://localhost:${port}" to use this`);
      if (isAnthropic) {
        results.push(`   → Or set llmCopilot.claudeCodeApiPath to "/v1/messages"`);
      } else {
        results.push(`   → Or set llmCopilot.claudeCodeApiPath to "/v1/chat/completions"`);
      }
    } catch (err: any) {
      const short = err.message.replace(/\n/g, ' ').slice(0, 80);
      results.push(`❌ PORT ${port}  ${path}: ${short}`);
    }
  }
  return results;
}

