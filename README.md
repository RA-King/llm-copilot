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
- **Context-aware generation** — every suggestion is built from the enclosing method signature, the parameters and locals in scope, the fields of the enclosing type, and the required return type.
- **Reads the files your code depends on** — referenced types and functions are resolved to their real declarations, and those declarations are read out of the files they live in and sent with the request.
- **Language-server grounded** — where a language server is installed (tsserver, Pylance, rust-analyzer, gopls, jdt.ls, clangd, OmniSharp, …), the model is told exactly which identifiers are legal at the cursor and what type each one has.
- **Syntax-validated suggestions** — candidates are checked (and repaired) before they are ever displayed, optionally by the language's own parser.
- **Context resolved off the critical path** — all of the above happens *during* the debounce window, is shared across keystrokes, and adapts to your language server's real latency, so it costs no waiting.
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

#### What the model is told

A completion request is not just the surrounding lines. Before asking the model
for anything, the extension assembles the same picture a human reader would
build:

1. **The logical context at the cursor** — the enclosing function or method with
   its parameters *and their types*, its generics, its `throws` clause and its
   return type; the enclosing class/struct/interface and its fields; every
   local, loop variable and catch binding declared above the cursor; and, when
   the return type is not annotated, the `return` statements already written in
   the body. This is derived from the source itself, so it works for every
   supported language with no extra tooling.

2. **What the language's own analyser knows** — if a language server is
   installed for the file, it is queried for the resolved signature of the
   enclosing symbol, the type of the identifiers on the current line, the
   signature of the call being written, and the full list of identifiers that
   are *legal at that exact position*. The model is instructed to use only
   those names, which is what stops it inventing methods that do not exist.

3. **The declarations behind the names** — for the types and functions that
   matter to this completion, the language server is asked where each one is
   defined; those files are opened and the actual declaration is lifted out and
   included. Instead of guessing at `OrderRepository`, the model is shown it.

4. **The contract to satisfy** — the return type the completion must produce,
   the partial line it must continue without repeating, and any problems the
   language server is already reporting nearby.

Every one of these steps is time-boxed and fails soft: no language server, a
server that is still indexing, or a slow project degrades the suggestion
quality but never blocks or breaks the completion. Tune the budget with
`llmCopilot.semanticBudgetMs`, or turn the layer off with
`llmCopilot.semanticContext: false`.

#### Suggestions are checked before you see them

Two gates run on every candidate:

- **Structural validation (always on, free).** A delimiter-, string- and
  comment-aware scan of the snippet *in the position it will land in*. It
  discards suggestions that leave a string or bracket unclosed, that are prose
  rather than code, or that would be inserted into the middle of a string
  literal — and it **repairs** the most common LLM mistake, a trailing `}` that
  closes the block you were already inside, rather than throwing the suggestion
  away.

- **The language's own parser (opt-in).** Set
  `llmCopilot.validateWithInterpreter: true` and the file — with the suggestion
  spliced in — is handed to the real front-end for that language before the
  ghost text appears:

  | Language | Checker |
  |---|---|
  | TypeScript / TSX | the TypeScript parser, in-process (syntax only, no type check) |
  | JavaScript / JSX | `node --check` |
  | Python | `ast.parse` |
  | Ruby | `ruby -c` |
  | PHP | `php -l` |
  | Go | `gofmt -e` |
  | Lua | `luac -p` |
  | Shell | `bash -n` |

  Each of these parses without executing your code and without needing your
  dependencies resolved. If the checker is not installed, is too slow, or fails
  to launch, the suggestion is shown as normal — a missing compiler never costs
  you a completion. Verdicts are cached, so re-triggering at the same spot is
  free.

#### Latency

Everything above is designed to stay off the critical path.

The debounce window is time the extension is *deliberately* doing nothing —
waiting to see whether you keep typing. Context resolution doesn't depend on
anything that happens during it, so it runs inside that window rather than
after it:

```
before   [ debounce 500ms ] → [ gather context ] → [ LLM call ] → ghost text
after    [ debounce 500ms ]                      → [ LLM call ] → ghost text
         [ gather context ]
```

By the time the completion provider runs, the context is normally already
resolved and reading it costs nothing. Four further measures keep it that way:

- **Keystrokes share one gather.** The cache is keyed on what is *stable* while
  you type — the enclosing signature, the container, the line, and the
  member-access receiver — not on the document version. Typing `c` → `co` →
  `con` joins one in-flight request instead of starting three.
- **The budget adapts.** `semanticBudgetMs` is a timeout, not a wait: a
  responsive language server returns immediately regardless. The effective
  timeout tracks your server's measured latency, so a slow project can't
  repeatedly cost the full ceiling. A language with *no* server installed is
  skipped outright after a few empty answers, then re-probed a minute later.
- **The fallback is skipped when it isn't needed.** The workspace-wide regex
  sweep exists for languages with no language server. Once one has answered, it
  no longer runs at all — and when it does run, both the workspace file list and
  the per-file extraction are cached between keystrokes.
- **Validation is cheap.** Structural checking is a single linear pass:
  ~0.03 ms on a small file, ~1.3 ms on a 10,000-line one. The optional
  interpreter pass caches its verdicts, and on timeout shows the suggestion
  rather than making you wait.

If ghost text still feels slow, the remaining time is the model itself. Lower
`maxTokens`, pick a faster model, or run locally with Ollama/LM Studio.
Setting `prefetchContext: false` disables the overlap and is only useful for
diagnosing a problem.

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
| `semanticContext` | boolean | `true` | Query the language server for resolved types, in-scope identifiers and cross-file declarations. |
| `semanticBudgetMs` | number | `600` | **Ceiling** on those queries (100–5000 ms). A timeout, not a wait — it adapts down to your language server's measured latency. |
| `prefetchContext` | boolean | `true` | Resolve context *during* the debounce instead of after it. The single largest latency win. |
| `workspaceScanBudgetMs` | number | `700` | Budget for the regex sweep over workspace files — the no-language-server fallback only (0–5000 ms). |
| `semanticMaxSymbols` | number | `30` | How many in-scope identifiers (with types) to show the model (0–100). |
| `semanticMaxDeclarations` | number | `4` | How many cross-file declarations to resolve and read in full (0–12). |
| `validateWithInterpreter` | boolean | `false` | Run the language's own syntax checker over each suggestion and discard the ones it rejects. |
| `interpreterTimeoutMs` | number | `2500` | Timeout for that checker (300–10000 ms). On timeout the suggestion is shown, not discarded. |

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
  "llmCopilot.enabledLanguages": ["typescript", "python"],

  // Context depth
  "llmCopilot.semanticContext": true,
  "llmCopilot.semanticBudgetMs": 600,
  "llmCopilot.semanticMaxDeclarations": 4,
  "llmCopilot.prefetchContext": true,

  // Let the language's own parser vet each suggestion
  "llmCopilot.validateWithInterpreter": true
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
| `signatureExtractor.ts` | Parse the enclosing signature, scope chain and every binding in scope, straight from the source. |
| `semanticContext.ts` | Query the installed language server for resolved types, legal identifiers and cross-file declarations. |
| `workspaceContext.ts` | Regex-scan the workspace for related declarations (the no-language-server fallback). |
| `contextPrefetch.ts` | Resolve context during the debounce window and share it across keystrokes. |
| `snippetValidator.ts` | Structurally validate and repair a candidate, then optionally hand it to the language's own parser. |
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
