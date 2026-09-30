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
  - [Inline completions (ghost text)](#1-inline-completions-ghost-text)
  - [The project index](#5-the-project-index)
  - [Terminal & debug errors](#6-terminal--debug-errors--ctrlalte)
- [Commands reference](#commands-reference)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings reference](#settings-reference)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Inline ghost-text completions** — Copilot-style suggestions as you type; `Tab` to accept, `Esc` to dismiss.
- **Non-intrusive by construction** — never appears over code that follows the cursor, while you are deleting, inside a string or a comment, or on a line you have just dismissed a suggestion on. Sized to the cursor: one line mid-expression, a statement on an empty line, a block only where a block was just opened.
- **Snappy** — typing through a suggestion costs no round trip at all, and the wait before asking is set from the model's measured latency rather than a fixed guess.
- **Knows the whole application** — every declaration and import in the project is read once in the background and kept, so a completion or a fix is written against the real signature of anything in the codebase.
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
- **Terminal & debug error assist** — a failed command or an exception in the debugger opens a pane of candidate fixes, each carrying the file and line it edits and how sure the model is. Answers are written against the declarations, callers and manifest the project index resolved, not against guesses.
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

#### When it appears — and when it stays out of the way

Ghost text is unasked-for text on the screen, in the middle of writing. What
makes it tolerable is not how good the suggestions are, it is how reliably it
refuses to appear where it would be in the way. Every refusal below is applied
in one place, so the debounce timer and the completion provider always reach
the same verdict:

| It stays quiet when | Why |
|---|---|
| Real code follows the cursor on the line | Accepting would delete what you have already written. Whitespace and closing delimiters don't count — finishing an argument list from inside its own brackets is the normal case |
| You are deleting, undoing or pasting | You are removing something; answering with more is the worst case for intrusiveness |
| The cursor is inside a string or a comment | Code completion there is noise |
| You just pressed `Esc` on this line | The single most irritating thing an inline completion can do is come straight back. The refusal is remembered until you have typed six more characters, rewritten the line, or thirty seconds have passed |
| You have typed one character after a `.` | The editor's own completion list is instant, exact and already on screen. Raise or lower the threshold with `llmCopilot.ghostText.minIdentifierChars` |
| Text is selected, or there is a second cursor | You are doing something else |

And when it does appear, it is only as long as the cursor calls for:

| Where the cursor is | How much you get | Setting |
|---|---|---|
| Mid-expression | One line — it finishes the expression and stops | — |
| On an empty line in a body | A statement, or the two or three that clearly belong with it | `llmCopilot.ghostText.maxStatementLines` (3) |
| On the line after an opening brace | The body of the block that was just opened | `llmCopilot.ghostText.maxBlockLines` (12) |

The ceiling is both asked for in the prompt and enforced on the reply. A model
that writes past it is cut back at the last line where the snippet is still
balanced; if there is no such line inside the budget, the suggestion is dropped
rather than shown half-finished. A block-sized answer is only ever allowed where
a block was genuinely just opened — anywhere else it is demoted to a statement,
because otherwise "suggest the next line" turns into "write the rest of the
function".

#### Snappiness

Two things make it feel immediate rather than merely fast.

**Typing through a suggestion costs nothing.** When you type the characters a
suggestion was already proposing, the answer is the rest of that same
suggestion, and it is given with no round trip at all. Without this, every
keystroke through a suggestion re-asks the model — which both costs the latency
and risks the answer changing under your hands mid-word.

**The wait is measured, not guessed.** A fixed debounce is a guess at a number
that depends entirely on the model behind it: a local model answering in 120 ms
spends most of the latency you feel sitting in a 600 ms wait, while a hosted
frontier model taking two seconds just burns requests on cursors you have
already left. The wait now tracks the median round trip actually observed and
slides between `llmCopilot.ghostText.minDebounceMs` (150) and
`llmCopilot.debounceMs` (600). **LLM Copilot: Show Project Index Status** reports
what it has measured and what it is currently waiting. Turn it off with
`llmCopilot.ghostText.adaptiveDebounce: false` to go back to a fixed wait.

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

4. **What the code so far is working towards** — the piece that makes a
   suggestion feel like it followed your thought rather than pattern-matched
   your file. The verb in the enclosing function's name is read as a job
   (`fetchUserOrders` retrieves and returns; `validateEmail` checks and
   rejects; `collectActiveNames` accumulates into something and returns it).
   Against that reading it works out how far the body has got: which
   parameters nothing has referenced yet, which locals were declared and never
   read, whether a local was initialised to `[]`/`0`/`new ArrayList<>()` before
   the loop the cursor now sits in, how many guard clauses are already written,
   and whether the declared return type has been satisfied on the main path.
   From those facts it states, in one line, what the next statement most likely
   does — "add `user` to `result`, or skip it when it does not qualify",
   "return early, passing the error on to the caller", "guard `email` in the
   same style as the checks above" — and the model is told to continue that
   line of thought instead of starting a different one.

   The same reading decides *how much* to write. Mid-expression you get one
   line and a tight token budget; on an empty line inside a body, a statement
   or two; on the line after an opening brace, the block. Turn it off with
   `llmCopilot.intentInference: false`.

   The language-specific shapes this depends on — how a loop names what it
   iterates, how a local is declared, what counts as an empty initialiser, which
   types mean "returns nothing" — live in one table in `languageProfiles.ts`,
   covering TypeScript, JavaScript, Python, Java, Kotlin, Scala, Groovy, C#,
   C, C++, Rust, Go, Ruby, PHP, Swift and Dart. So `for _, user := range users`,
   `foreach ($users as $user)`, `users.each do |user|`, `for (user <- users)`
   and `for (const auto& user : users)` are all read as the same thing: a loop
   over `users` binding `user`.

5. **What the rest of the application contains** — the whole project is read
   once in the background and reduced to a symbol table and an import graph,
   so a completion can be given the *real* declaration of anything in the
   codebase rather than a plausible-looking guess. See
   [The project index](#the-project-index) below.

6. **The contract to satisfy** — the return type the completion must produce,
   the partial line it must continue without repeating, the number of lines it
   may occupy, and any problems the language server is already reporting
   nearby.

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

### 5. The project index

Most of the context above is about the cursor: the function it is in, the
types on the line, the block it sits inside. None of it can answer *"where is
`OrderRepository` declared"*, *"who calls this"* or *"what is this project" —*
and those are the questions a deep answer turns on. It is the difference
between a fix that compiles and a fix that is right.

So the whole workspace is read once and reduced to three things:

- **A symbol table** — every class, interface, function, method, type and
  constant, name to the file and *the declaration line itself*, so a lookup
  returns something quotable rather than a path.
- **An import graph, both ways** — forwards for what a file depends on,
  backwards for what depends on it. The second is what "will this change break
  anything" needs.
- **A digest of the project's shape** — languages, top-level layout, manifests
  and likely entry points, for the prompts that need orientation rather than
  detail.

Sixteen languages are read: TypeScript, JavaScript, TSX/JSX, Python, Java,
Kotlin, Scala, C#, Rust, Go, Ruby, PHP, Swift, Dart, C and C++. It is regex
over declaration lines, not a parser, deliberately — it has to cope with files
that do not currently compile and with languages you have no tooling installed
for, and it only ever needs the signature.

**Cost.** A full read of a mid-sized repository takes a couple of seconds,
which is unaffordable per keystroke and trivial once per session — so it runs
in the background after the window opens and nothing waits for it. The result
is written to disk keyed on each file's modification time and size, so a second
session re-reads only what changed, which is normally nothing. Saving a file
re-reads that one file; creating, deleting and renaming update the graph.

**What it buys.** On the completion path it is a couple of map lookups, which
is what makes cross-file context affordable on *every* keystroke instead of
only on invoke — and once it is warm, the workspace-wide regex sweep that used
to be the fallback is skipped entirely. On the error path it is the whole of
"deep context" below.

| Command | What it does |
|---|---|
| **LLM Copilot: Show Project Index Status** | Files and symbols held, how long the last build took, the project digest, and the measured ghost-text latency |
| **LLM Copilot: Rebuild Project Index** | Re-reads everything, with progress. Only needed after the project changed outside the editor |

| Setting | Default | |
|---|---|---|
| `llmCopilot.projectIndex.enabled` | `true` | Turn the whole thing off |
| `llmCopilot.projectIndex.maxFiles` | `4000` | Raise it if the status report says the ceiling was reached |
| `llmCopilot.projectIndex.maxFileSizeKb` | `256` | Generated bundles cost time and teach the model nothing |
| `llmCopilot.projectIndex.exclude` | `[]` | Extra globs, on top of `node_modules`, build output and VCS directories |
| `llmCopilot.projectIndex.completionBudgetChars` | `2400` | Characters of project context per completion; `0` leaves it on for errors only |

### 6. Terminal & debug errors — `Ctrl+Alt+E`

When a command fails in the terminal, or the debugger stops on an exception, the output is read for you: the exception and its message, the frames that name real files, and the source around the line that threw. What comes back is a short list of candidate fixes — one line each, most likely first — rather than one long answer that may have guessed the wrong cause.

**From the terminal.** Right-click in the terminal panel and choose **LLM Copilot: Explain Terminal Error**. A selection is used if there is one; otherwise the last command that exited non-zero is. On VS Code 1.93+ commands are captured automatically through shell integration — on older builds, or in a terminal that has not sourced the shell hooks, select the error text first.

**From the debugger.** Right-click in the call stack or variables view and choose **LLM Copilot: Explain Debug Error**. Exceptions the debugger stops on are captured with whatever the adapter knows about them; so is anything the program wrote before dying.

**From anywhere.** `Ctrl+Alt+E` (`Ctrl+Cmd+E` on macOS) lists every failure captured so far, newest first, so an error that has already scrolled away is still reachable.

#### What the answer is written against

The source at the failing line is the obvious context, and on its own it is
rarely enough. `undefined is not a function` at `repo.findByCustomer(id)`
cannot be answered from that line — the answer is in whatever `repo` is, what
that type declares, and who constructed it. A model given only the failing line
has to invent those, and it does: confidently, and wrongly.

So before the first question is asked, the [project index](#the-project-index)
is consulted and four more things go in with the error:

1. **Where the names involved are declared.** Every identifier the message
   printed, every symbol the trace's own frames named, and the identifiers on
   the failing line and its neighbours are looked up, and the real declaration
   of each is attached. The prompt says these are read from the project and
   must be used in preference to anything inferred.
2. **The callers of the failing file.** A fix that changes a signature has to
   be a fix for them too, and the answer is asked to say whether it is.
3. **What that file itself depends on.**
4. **The project manifest** — `package.json`, `pyproject.toml`, `go.mod`,
   `Cargo.toml`, `pom.xml` and the rest, trimmed to the fields that can
   actually explain a failure. Half of all runtime failures are a dependency, a
   version or a script.

Turn it off with `llmCopilot.errorAssist.deepContext: false`, or change how
much goes in with `llmCopilot.errorAssist.projectContextChars` (4000).

#### The pane

Each candidate fix carries **where it lands** — the file and line it edits,
shown in the right-hand column — and **how sure the model is** (likely,
possible, unlikely) rather than only an implicit ranking.

Picking one opens the chat sidebar with the question already asked — the error,
the resolved source, the project context and the approach chosen — and the
answer arrives with the edit in it. The conversation carries on from there like
any other. The pane also offers:

- **Work it through properly** — the full diagnosis, which is the reasoning the
  shortlist deliberately leaves out: what the runtime was doing, which of the
  resolved declarations are actually involved, the cause with its evidence, the
  change, and what else in the project the change affects. Where the evidence
  does not settle it, the answer says which candidates it is between and what
  one observation would tell them apart. The entry reports how much it has to
  work with — *"against 11 resolved names and 3 callers"*.
- **Explain this error** — what it means, no fix yet.
- **Ask something about it…** — your own question, with everything attached.
- **Open the failing file** at the line, plus **a jump to any other file a fix
  named**. A cause that lives one file away from the throw is common, and
  without this the pane makes you go and find it.
- **Copy the error text.**

A failure that happens while you are watching also raises a *Show solutions* notification. Turn that off with `llmCopilot.errorAssist.autoOffer`, or turn the whole feature off with `llmCopilot.errorAssist.enabled`.

### 7. Documentation comments — `Ctrl/Cmd+Shift+D`

Place your cursor on (or just above) a function/class/method and run **Generate Doc Comment**. The comment is produced in the right style for the language (JSDoc, Javadoc, XML doc, Python docstring, Rustdoc, etc.) and shown as ghost text — `Tab` to accept.

### 8. Class scaffolding

With the cursor inside a class/struct/interface, run any of:

- **Generate Constructor**
- **Generate Getters & Setters**
- **Implement Interface / Abstract Methods**
- **Generate All Class Members**

The extension analyzes the surrounding structure (fields, existing members, unimplemented methods) and generates only what's missing.

### 9. Generate unit tests — `Ctrl/Cmd+Shift+T`

Select a function or class and run **Generate Unit Tests**. Set `llmCopilot.testFramework` (e.g. `jest`, `pytest`, `JUnit`) to pin a framework, or leave it blank to auto-detect.

### 10. Commit messages — `Ctrl/Cmd+Shift+M`

Stage your changes, then run **Generate Commit Message**. It reads your staged diff and writes a Conventional Commits message.

### 11. Enable/disable & status

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
| `LLM Copilot: Explain Terminal Error` | Read the selected (or last failed) terminal output and offer fixes. |
| `LLM Copilot: Explain Debug Error` | Read what the debugger stopped on and offer fixes. |
| `LLM Copilot: Analyse a Recent Error` | Pick from every failure captured so far. |
| `LLM Copilot: Rebuild Project Index` | Re-read every declaration and import in the project. |
| `LLM Copilot: Show Project Index Status` | What the index holds, plus the measured ghost-text latency. |
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
| `Ctrl+Alt+E` | `Ctrl+Cmd+E` | Analyse a Recent Error (terminal or debugger) |

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
| `intentInference` | boolean | `true` | Read what the code so far is working towards — the job in the function's name, unused parameters and locals, the block the cursor is in, an unsatisfied return — and tell the model what the next statement most likely does. |
| `semanticContext` | boolean | `true` | Query the language server for resolved types, in-scope identifiers and cross-file declarations. |
| `semanticBudgetMs` | number | `600` | **Ceiling** on those queries (100–5000 ms). A timeout, not a wait — it adapts down to your language server's measured latency. |
| `prefetchContext` | boolean | `true` | Resolve context *during* the debounce instead of after it. The single largest latency win. |
| `workspaceScanBudgetMs` | number | `700` | Budget for the regex sweep over workspace files — the no-language-server fallback only (0–5000 ms). |
| `semanticMaxSymbols` | number | `30` | How many in-scope identifiers (with types) to show the model (0–100). |
| `semanticMaxDeclarations` | number | `4` | How many cross-file declarations to resolve and read in full (0–12). |
| `validateWithInterpreter` | boolean | `false` | Run the language's own syntax checker over each suggestion and discard the ones it rejects. |
| `interpreterTimeoutMs` | number | `2500` | Timeout for that checker (300–10000 ms). On timeout the suggestion is shown, not discarded. |
| `errorAssist.enabled` | boolean | `true` | Watch the terminal and the debug console for failures and offer solutions for them. |
| `errorAssist.autoOffer` | boolean | `true` | Raise a notification the moment something fails. Off = reach the pane from the menus or `Ctrl+Alt+E`. |
| `errorAssist.solutionCount` | number | `4` | How many candidate fixes the pane lists (2–8). |
| `errorAssist.contextLines` | number | `40` | Lines of source read around each failing line and sent with the error (10–200). |
| `errorAssist.maxOutputLines` | number | `120` | Most lines of captured output kept from a failed command or session (20–500). |
| `errorAssist.deepContext` | boolean | `true` | Send the error together with what the rest of the project says about it: where the names involved are declared, what imports the failing file, and the project manifest. |
| `errorAssist.projectContextChars` | number | `4000` | Characters of that project context sent with an error (0–40000). |
| `ghostText.adaptiveDebounce` | boolean | `true` | Set the wait before asking from the model's measured latency rather than a fixed guess. It slides between `ghostText.minDebounceMs` and `debounceMs`. |
| `ghostText.minDebounceMs` | number | `150` | Shortest wait the adaptive debounce will settle on (0–2000 ms). `debounceMs` remains the longest. |
| `ghostText.maxStatementLines` | number | `3` | Most lines a statement-sized suggestion may occupy (1–40). Longer replies are cut back to the last balanced line. |
| `ghostText.maxBlockLines` | number | `12` | Most lines a block-sized suggestion may occupy (1–80) — the body of a block that was just opened. |
| `ghostText.minIdentifierChars` | number | `2` | How much of an identifier must be typed before ghost text is offered (0–8). Below it, the editor's own completion list is the better answer. |
| `projectIndex.enabled` | boolean | `true` | Read every declaration and import in the project, in the background, so completions and error answers can use the real signatures from anywhere in the codebase. |
| `projectIndex.maxFiles` | number | `4000` | Most source files the index will hold (100–50000). |
| `projectIndex.maxFileSizeKb` | number | `256` | Files larger than this are skipped (16–4096 KB). |
| `projectIndex.exclude` | string[] | `[]` | Extra globs to keep out, on top of `node_modules`, build output and VCS directories. |
| `projectIndex.completionBudgetChars` | number | `2400` | Characters of project context sent with each completion (0–20000). `0` leaves it on for errors only. |

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
  "llmCopilot.intentInference": true,
  "llmCopilot.semanticContext": true,
  "llmCopilot.semanticBudgetMs": 600,
  "llmCopilot.semanticMaxDeclarations": 4,
  "llmCopilot.prefetchContext": true,

  // How ghost text behaves
  "llmCopilot.ghostText.adaptiveDebounce": true,
  "llmCopilot.ghostText.maxStatementLines": 3,
  "llmCopilot.ghostText.maxBlockLines": 12,

  // Know the whole application
  "llmCopilot.projectIndex.enabled": true,
  "llmCopilot.errorAssist.deepContext": true,

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
| `intentInference.ts` | Read the function's name, its unconsumed parameters, its dangling locals and the block the cursor is in, and predict what the next statement is doing. |
| `languageProfiles.ts` | One table of the per-language shapes: loop forms, local declarations, empty initialisers, void types, comment markers, block style. |
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
