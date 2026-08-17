# LLM Copilot

**AI-powered inline completions with smart scaffolding for VS Code — GitHub Copilot-level features using *any* LLM.**

LLM Copilot brings ghost-text autocomplete, inline chat, code actions (explain / fix / refactor / document), class scaffolding, unit-test generation, and commit-message generation to VS Code — powered by the provider and model of *your* choice. Run it fully local and free with Ollama or LM Studio, or connect to OpenAI, Anthropic, Gemini, DeepSeek, Grok, Mistral, Groq, OpenRouter, Azure, or any OpenAI-compatible endpoint.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Building & installing from source](#building--installing-from-source)
- [Quick start](#quick-start)
- [Connecting to an LLM provider](#connecting-to-an-llm-provider)
  - [Provider matrix](#provider-matrix)
  - [Local & free: Ollama](#local--free-ollama)
  - [Local & free: LM Studio](#local--free-lm-studio)
  - [OpenAI](#openai)
  - [Anthropic](#anthropic)
  - [Google Gemini](#google-gemini)
  - [DeepSeek](#deepseek)
  - [xAI Grok](#xai-grok)
  - [Mistral](#mistral)
  - [Groq](#groq)
  - [OpenRouter](#openrouter)
  - [Azure OpenAI](#azure-openai)
  - [Claude Code (local CLI proxy)](#claude-code-local-cli-proxy)
  - [Custom OpenAI-compatible endpoint](#custom-openai-compatible-endpoint)
- [Usage & tutorials](#usage--tutorials)
- [Commands reference](#commands-reference)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings reference](#settings-reference)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Inline ghost-text completions** — Copilot-style suggestions as you type; `Tab` to accept, `Esc` to dismiss.
- **Smart trigger detection** — completions fire on keywords (`function`, `class`, `def`, `fn`, …) and at meaningful cursor positions, not mid-word.
- **Duplication guard** — never suggests code that already exists in the file.
- **Auto-formatting** — suggestions are re-indented to match your file's tab/space style and surrounding blank-line rhythm.
- **Inline chat** (`Ctrl/Cmd+I`) — ask for a change right in the editor.
- **AI chat sidebar** — a full chat panel in the activity bar.
- **Code actions on a selection** — Explain, Fix, Refactor, Generate doc comment, Generate unit tests.
- **Scaffolding** — generate a constructor, getters/setters, interface/abstract-method implementations, or all class members.
- **Commit message generation** — Conventional Commits format from your staged diff.
- **Works across 15+ languages** — TypeScript, JavaScript, Python, Java, C#, C/C++, Rust, Go, Kotlin, Swift, Ruby, PHP, Scala, Dart, and more.

---

## Requirements

- **VS Code** `1.74.0` or newer.
- **Node.js** + **npm** (to build from source).
- **An LLM backend** — either a local runtime (Ollama / LM Studio, free) or an API key for a cloud provider.

---

## Building & installing from source

This extension is distributed as source. Compile it, then load it into VS Code.

```bash
# 1. Clone
git clone https://github.com/RA-King/llm-copilot.git
cd llm-copilot

# 2. Install dependencies
npm install

# 3. Compile TypeScript → out/
npm run compile
```

### Run it in a development window

Open the folder in VS Code and press **`F5`** ("Run Extension"). This launches a second VS Code window — the **Extension Development Host** — with LLM Copilot loaded. Use this to try it out and iterate.

### Package it as an installable `.vsix`

```bash
# Requires the VS Code packaging tool (install once):
npm install -g @vscode/vsce

# Produce llm-copilot-<version>.vsix
npm run package
```

Then install the `.vsix` in any VS Code instance:

- **Command line:** `code --install-extension llm-copilot-2.0.0.vsix`
- **UI:** Extensions view → `···` menu → **Install from VSIX…**

### Useful scripts

| Command | What it does |
|---|---|
| `npm run compile` | One-off TypeScript build into `out/`. |
| `npm run watch` | Rebuild on every save. |
| `npm test` | Run the Jest unit-test suite. |
| `npm run package` | Build a `.vsix` package (needs `@vscode/vsce`). |

---

## Quick start

1. **Install/launch** the extension (see above).
2. Open the **Command Palette** (`Ctrl/Cmd+Shift+P`) → **`LLM Copilot: Open Settings`**.
3. Pick a **provider** and **model**, and paste an **API key** if the provider needs one (see [Connecting to an LLM provider](#connecting-to-an-llm-provider)).
4. Run **`LLM Copilot: Test Connection`** to confirm it works.
5. Start typing in any code file — ghost-text suggestions appear. Press **`Tab`** to accept.

> The fastest zero-cost path: install **Ollama**, run `ollama pull codellama`, and you're ready with the default settings.

---

## Connecting to an LLM provider

All connection settings live under `llmCopilot.*` in VS Code settings. Open them with **`LLM Copilot: Open Settings`** or edit `settings.json` directly.

The three settings you'll touch most:

- **`llmCopilot.provider`** — which backend to use.
- **`llmCopilot.model`** — the model name/ID for that backend.
- **`llmCopilot.apiKey`** — your API key (cloud providers only).

### Provider matrix

| Provider | `provider` value | API key? | `baseUrl` used? | Example models |
|---|---|:---:|:---:|---|
| Ollama (local) | `ollama` | No | ✅ `http://localhost:11434` | `codellama`, `deepseek-coder:6.7b`, `llama3.2`, `gemma3` |
| LM Studio (local) | `lmstudio` | No | ✅ `http://localhost:1234` | any model loaded in LM Studio |
| OpenAI | `openai` | Yes | ❌ (fixed `api.openai.com`) | `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `o4-mini`, `o3` |
| Anthropic | `anthropic` | Yes | ❌ (fixed `api.anthropic.com`) | `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5-20251001` |
| Google Gemini | `gemini` | Yes | ❌ (fixed) | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` |
| DeepSeek | `deepseek` | Yes | ❌ (fixed) | `deepseek-chat`, `deepseek-coder`, `deepseek-reasoner` |
| xAI Grok | `grok` | Yes | ❌ (fixed `api.x.ai`) | `grok-3`, `grok-3-mini`, `grok-3-fast`, `grok-2` |
| Mistral | `mistral` | Yes | ❌ (fixed) | `mistral-large-latest`, `codestral-latest` |
| Groq | `groq` | Yes | ❌ (fixed) | `llama-3.3-70b-versatile`, `moonshotai/kimi-k2-instruct` |
| OpenRouter | `openrouter` | Yes | ❌ (fixed) | any OpenRouter model ID |
| Azure OpenAI | `azure` | Yes | ✅ your endpoint | your **deployment name** |
| Claude Code (local) | `claudecode` | No | ✅ `http://localhost:3000` | auto-detected from proxy |
| Custom | `custom` | Optional | ✅ your endpoint | any (OpenAI-compatible) |

> **Note on `baseUrl`:** For the hosted providers marked ❌, the endpoint is fixed in the extension — setting `baseUrl` has no effect. `baseUrl` only matters for **local** backends (Ollama, LM Studio), **Azure**, **Claude Code**, and **Custom**.

---

### Local & free: Ollama

The default provider — no API key, runs on your machine.

1. Install [Ollama](https://ollama.com) and start it (it listens on `http://localhost:11434`).
2. Pull a model, e.g.:
   ```bash
   ollama pull codellama          # good general code model
   ollama pull deepseek-coder:6.7b
   ollama pull llama3.2
   ```
3. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "ollama",
     "llmCopilot.model": "codellama",
     "llmCopilot.baseUrl": "http://localhost:11434"
   }
   ```

---

### Local & free: LM Studio

1. Install [LM Studio](https://lmstudio.ai), load a model, and start its **Local Server** (default `http://localhost:1234`).
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "lmstudio",
     "llmCopilot.model": "your-loaded-model-name",
     "llmCopilot.baseUrl": "http://localhost:1234"
   }
   ```

---

### OpenAI

1. Get an API key from <https://platform.openai.com/api-keys>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "openai",
     "llmCopilot.model": "gpt-4o-mini",
     "llmCopilot.apiKey": "sk-..."
   }
   ```

---

### Anthropic

Uses the Anthropic Messages API (`api.anthropic.com/v1/messages`).

1. Get an API key from <https://console.anthropic.com/settings/keys>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "anthropic",
     "llmCopilot.model": "claude-sonnet-4-5",
     "llmCopilot.apiKey": "sk-ant-..."
   }
   ```

---

### Google Gemini

Uses Gemini's OpenAI-compatible endpoint.

1. Get an API key from <https://aistudio.google.com/apikey>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "gemini",
     "llmCopilot.model": "gemini-2.5-flash",
     "llmCopilot.apiKey": "..."
   }
   ```

---

### DeepSeek

OpenAI-compatible; strong at code.

1. Get an API key from <https://platform.deepseek.com/api_keys>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "deepseek",
     "llmCopilot.model": "deepseek-coder",
     "llmCopilot.apiKey": "..."
   }
   ```

---

### xAI Grok

1. Get an API key from <https://console.x.ai>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "grok",
     "llmCopilot.model": "grok-3-mini",
     "llmCopilot.apiKey": "xai-..."
   }
   ```

---

### Mistral

1. Get an API key from <https://console.mistral.ai/api-keys>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "mistral",
     "llmCopilot.model": "codestral-latest",
     "llmCopilot.apiKey": "..."
   }
   ```

---

### Groq

Ultra-fast inference, OpenAI-compatible.

1. Get an API key from <https://console.groq.com/keys>.
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "groq",
     "llmCopilot.model": "llama-3.3-70b-versatile",
     "llmCopilot.apiKey": "gsk_..."
   }
   ```

---

### OpenRouter

One key, 100+ models.

1. Get an API key from <https://openrouter.ai/keys>.
2. Set `model` to any OpenRouter model ID (e.g. `anthropic/claude-sonnet-4.5`, `meta-llama/llama-3.3-70b-instruct`).
   ```jsonc
   {
     "llmCopilot.provider": "openrouter",
     "llmCopilot.model": "anthropic/claude-sonnet-4.5",
     "llmCopilot.apiKey": "sk-or-..."
   }
   ```

---

### Azure OpenAI

Azure includes the deployment in the URL and authenticates with an `api-key` header.

- **`baseUrl`** = `https://{resource}.openai.azure.com/openai/deployments/{deployment}`
- **`model`** = your deployment name
- **`apiKey`** = your Azure API key

```jsonc
{
  "llmCopilot.provider": "azure",
  "llmCopilot.baseUrl": "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
  "llmCopilot.model": "gpt-4o",
  "llmCopilot.apiKey": "...",
  "llmCopilot.azureApiVersion": "2024-12-01-preview"
}
```

---

### Claude Code (local CLI proxy)

Run Claude models locally through a community proxy that wraps the Claude Code CLI — no API key in the extension.

1. Start a Claude Code proxy (e.g. `claude-code-proxy`, `claude-max-api-proxy`, `claude-code-api`, `copilot-api`). The extension **auto-discovers** common ports (`3000`, `3456`, `8000`, `4141`, `8082`, `8080`, `1234`, `11435`) and paths (`/v1/messages`, `/v1/chat/completions`).
2. Settings:
   ```jsonc
   {
     "llmCopilot.provider": "claudecode",
     "llmCopilot.model": "claude-opus-4-5",
     "llmCopilot.claudeCodeBaseUrl": "http://localhost:3000"
   }
   ```
3. Helper commands:
   - **`LLM Copilot: List Claude Code Models`** — fetch available models from the proxy.
   - **`LLM Copilot: Diagnose Claude Code Connection`** — probe every known port/path and report which works.
   - If auto-detect fails, set **`llmCopilot.claudeCodeApiPath`** explicitly (e.g. `/v1/messages` or `/v1/chat/completions`).

---

### Custom OpenAI-compatible endpoint

Point at any server that speaks the OpenAI `/v1/chat/completions` API.

```jsonc
{
  "llmCopilot.provider": "custom",
  "llmCopilot.baseUrl": "https://your-endpoint.example.com",
  "llmCopilot.model": "your-model",
  "llmCopilot.apiKey": "...optional..."
}
```

---

## Usage & tutorials

### 1. Inline completions (ghost text)

Just type. When you start a new line, a declaration keyword, or a fresh statement, a grey suggestion appears.

- **Accept:** `Tab`
- **Dismiss:** `Esc`
- **Force a suggestion now:** `Ctrl/Cmd+Shift+Space` (**Trigger Inline Completion**)
- Auto-triggering can be turned off with `llmCopilot.autoTrigger: false` (then use the manual shortcut).

### 2. Inline chat — `Ctrl/Cmd+I`

Put your cursor in the editor (optionally select code), press `Ctrl/Cmd+I`, and type an instruction like *"convert this to async/await"* or *"add null checks."* The result is applied inline.

### 3. AI chat sidebar

Click the **LLM Copilot** icon in the activity bar to open the **AI Chat** panel for longer, multi-turn conversations. Also available via **`LLM Copilot: Open AI Chat`** (`Ctrl+Alt+I`, or `Ctrl+Cmd+I` on macOS).

### 4. Selection actions — work on highlighted code

Select code, then either press `Ctrl+Space` (**Show Selection Actions** — a menu of everything below) or use a specific command:

| Action | Shortcut | Command |
|---|---|---|
| Explain | `Ctrl/Cmd+Shift+E` | Explain Selected Code |
| Fix bugs | — | Fix Selected Code |
| Refactor | `Ctrl/Cmd+Shift+R` | Refactor Selected Code |
| Generate unit tests | `Ctrl/Cmd+Shift+T` | Generate Unit Tests |

Right-clicking a selection also shows these under the editor context menu.

### 5. Documentation comments — `Ctrl/Cmd+Shift+D`

Place your cursor on (or just above) a function/class/method and run **Generate Doc Comment**. The comment is produced in the right style for the language (JSDoc, Javadoc, XML doc, Python docstring, Rustdoc, etc.) and shown as ghost text — `Tab` to accept.

### 6. Class scaffolding

With the cursor inside a class/struct/interface, run any of:

- **Generate Constructor**
- **Generate Getters & Setters**
- **Implement Interface / Abstract Methods**
- **Generate All Class Members**

The extension analyzes the surrounding structure (fields, existing members, unimplemented methods) and generates only what's missing.

### 7. Generate unit tests — `Ctrl/Cmd+Shift+T`

Select a function or class and run **Generate Unit Tests**. Set `llmCopilot.testFramework` (e.g. `jest`, `pytest`, `JUnit`) to pin a framework, or leave it blank to auto-detect.

### 8. Commit messages — `Ctrl/Cmd+Shift+M`

Stage your changes, then run **Generate Commit Message**. It reads your staged diff and writes a Conventional Commits message.

### 9. Enable/disable & status

- **`LLM Copilot: Toggle Enable/Disable`** turns completions on/off.
- A status-bar item shows the current state (hide it with `llmCopilot.showStatusBar: false`).

---

## Commands reference

Open the Command Palette (`Ctrl/Cmd+Shift+P`) and type "LLM Copilot":

| Command | Description |
|---|---|
| `LLM Copilot: Trigger Inline Completion` | Force a ghost-text suggestion at the cursor. |
| `LLM Copilot: Inline Chat` | Ask for an inline edit. |
| `LLM Copilot: Open AI Chat` | Open the chat sidebar. |
| `LLM Copilot: Open Settings` | Jump to the extension's settings. |
| `LLM Copilot: Test Connection` | Verify the provider/model/key work. |
| `LLM Copilot: Toggle Enable/Disable` | Turn completions on/off. |
| `LLM Copilot: Explain Selected Code` | Explain the selection. |
| `LLM Copilot: Fix Selected Code` | Fix bugs in the selection. |
| `LLM Copilot: Refactor Selected Code` | Refactor the selection. |
| `LLM Copilot: Generate Doc Comment` | Doc comment for the declaration at the cursor. |
| `LLM Copilot: Generate Constructor` | Constructor for the current class. |
| `LLM Copilot: Generate Getters & Setters` | Accessors for the class fields. |
| `LLM Copilot: Implement Interface / Abstract Methods` | Implement declared methods. |
| `LLM Copilot: Generate All Class Members` | Full class scaffold. |
| `LLM Copilot: Generate Unit Tests` | Tests for the selection. |
| `LLM Copilot: Generate Commit Message` | Commit message from the staged diff. |
| `LLM Copilot: Show Selection Actions` | Quick-pick menu of actions for the selection. |
| `LLM Copilot: List Claude Code Models` | List models exposed by a Claude Code proxy. |
| `LLM Copilot: Diagnose Claude Code Connection` | Probe Claude Code proxy ports/paths. |

---

## Keyboard shortcuts

| Shortcut (Win/Linux) | Shortcut (macOS) | Action |
|---|---|---|
| `Ctrl+I` | `Cmd+I` | Inline Chat |
| `Ctrl+Shift+Space` | `Cmd+Shift+Space` | Trigger Inline Completion |
| `Ctrl+Alt+I` | `Ctrl+Cmd+I` | Open AI Chat |
| `Ctrl+Shift+E` | `Cmd+Shift+E` | Explain Selected Code |
| `Ctrl+Shift+R` | `Cmd+Shift+R` | Refactor Selected Code |
| `Ctrl+Shift+T` | `Cmd+Shift+T` | Generate Unit Tests |
| `Ctrl+Shift+D` | `Cmd+Shift+D` | Generate Doc Comment |
| `Ctrl+Shift+M` | `Cmd+Shift+M` | Generate Commit Message |
| `Ctrl+Space` | `Ctrl+Space` | Show Selection Actions (when text is selected) |

> Some default shortcuts overlap VS Code built-ins; rebind them in **Preferences → Keyboard Shortcuts** if needed.

---

## Settings reference

All settings are under the `llmCopilot.` prefix.

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable completions. |
| `provider` | enum | `ollama` | LLM backend (see the [provider matrix](#provider-matrix)). |
| `model` | string | `codellama` | Model name/ID for the provider. |
| `apiKey` | string | `""` | API key (cloud providers only). |
| `baseUrl` | string | `http://localhost:11434` | Endpoint for local/Azure/custom/Claude Code backends. |
| `maxTokens` | number | `256` | Max tokens for inline completions (10–2000). |
| `temperature` | number | `0.2` | Sampling temperature (0–2; lower = more deterministic). |
| `contextLines` | number | `50` | Lines of context sent before/after the cursor (5–200). |
| `debounceMs` | number | `500` | Debounce before auto-triggering (100–3000 ms). |
| `autoTrigger` | boolean | `true` | Auto-suggest as you type. |
| `showStatusBar` | boolean | `true` | Show the status-bar indicator. |
| `enabledLanguages` | string[] | `[]` | Restrict to these language IDs (empty = all). |
| `inlineChatEnabled` | boolean | `true` | Enable `Ctrl/Cmd+I` inline chat. |
| `testFramework` | string | `""` | Default test framework (blank = auto-detect). |
| `claudeCodeBaseUrl` | string | `http://localhost:3000` | Base URL of the Claude Code proxy. |
| `claudeCodeApiPath` | string | `""` | Override the Claude Code API path (blank = auto-detect). |
| `azureApiVersion` | string | `2024-12-01-preview` | Azure OpenAI API version. |

**Example `settings.json`:**

```jsonc
{
  "llmCopilot.enabled": true,
  "llmCopilot.provider": "openai",
  "llmCopilot.model": "gpt-4o-mini",
  "llmCopilot.apiKey": "sk-...",
  "llmCopilot.maxTokens": 256,
  "llmCopilot.temperature": 0.2,
  "llmCopilot.autoTrigger": true,
  "llmCopilot.enabledLanguages": ["typescript", "python"]
}
```

---

## Development

```bash
npm install       # install deps
npm run watch     # rebuild on save
# press F5 in VS Code to launch the Extension Development Host
npm test          # run the Jest unit tests
```

The project is written in TypeScript (`src/`), compiled to `out/`. Core logic is unit-tested with Jest (`test/`) — the tests mock the `vscode` API so pure logic (completion formatting, duplication guarding, structure analysis, prompt building, etc.) can run outside the editor.

Key modules:

| Module | Responsibility |
|---|---|
| `extension.ts` | Activation, command & provider registration. |
| `completionProvider.ts` | The inline (ghost-text) completion provider. |
| `llmProvider.ts` | All provider connections + prompt builders. |
| `contextAnalyzer.ts` / `structureAnalyzer.ts` | Understand the cursor's surroundings. |
| `formatter.ts` | Re-indent and clean LLM output. |
| `duplicationGuard.ts` | Suppress already-present code. |
| `keywordTrigger.ts` / `docTrigger.ts` | Decide when to fire completions / doc comments. |
| `chatViewProvider.ts` | The AI chat sidebar webview. |
| `selectionActions.ts` | Explain/fix/refactor/test actions. |
| `statusBar.ts` | Status-bar indicator. |

---

## Troubleshooting

- **No suggestions appear** — run **`LLM Copilot: Test Connection`**. Check that `enabled` is `true`, the provider/model are correct, and (for cloud) the API key is set. Confirm the language isn't excluded by `enabledLanguages`.
- **"Connection refused" with Ollama/LM Studio** — make sure the local server is running and `baseUrl` matches its port (`11434` for Ollama, `1234` for LM Studio).
- **Cloud provider returns 401/403** — the API key is missing or invalid for that provider.
- **Changing `baseUrl` does nothing** — expected for hosted providers (OpenAI, Anthropic, Gemini, DeepSeek, Grok, Mistral, Groq, OpenRouter); their endpoints are fixed. `baseUrl` only applies to Ollama, LM Studio, Azure, Claude Code, and Custom.
- **Claude Code proxy not found** — run **`LLM Copilot: Diagnose Claude Code Connection`**, then set `claudeCodeBaseUrl` (and if needed `claudeCodeApiPath`) to the reported port/path.
- **Suggestions are too short/long** — tune `maxTokens`; for more surrounding context raise `contextLines`.
- **Completions feel laggy or too eager** — adjust `debounceMs`, or set `autoTrigger: false` and trigger manually with `Ctrl/Cmd+Shift+Space`.

---

## License

Released under the [MIT License](LICENSE). © 2026 RA King.
