const root = document.documentElement;

function storedTheme() {
  try { return localStorage.getItem('theme'); } catch { return null; }
}
const preferred = storedTheme() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
root.dataset.theme = preferred;

document.getElementById('theme').addEventListener('click', () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
});

document.querySelectorAll('[data-tabs]').forEach(group => {
  const name = group.dataset.tabs;
  group.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      group.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll(`[data-panel^="${name}:"]`).forEach(p =>
        p.classList.toggle('active', p.dataset.panel === `${name}:${tab.dataset.tab}`));
    });
  });
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const text = btn.parentElement.querySelector('pre').innerText;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1400);
  });
});

const providers = {
  ollama: {
    note: 'The default. Install Ollama, pull a model, and you are done — no key, nothing leaves your machine.',
    cfg: { provider: 'ollama', model: 'codellama', baseUrl: 'http://localhost:11434' },
  },
  lmstudio: {
    note: 'Load a model in LM Studio and start its Local Server.',
    cfg: { provider: 'lmstudio', model: 'your-loaded-model-name', baseUrl: 'http://localhost:1234' },
  },
  openai: {
    note: 'Key from platform.openai.com/api-keys.',
    cfg: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-...' },
  },
  anthropic: {
    note: 'Uses the Messages API. Key from console.anthropic.com.',
    cfg: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-...' },
  },
  gemini: {
    note: "Uses Gemini's OpenAI-compatible endpoint. Key from aistudio.google.com/apikey.",
    cfg: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: '...' },
  },
  deepseek: {
    note: 'OpenAI-compatible and strong at code. Key from platform.deepseek.com.',
    cfg: { provider: 'deepseek', model: 'deepseek-coder', apiKey: '...' },
  },
  grok: {
    note: 'Key from console.x.ai.',
    cfg: { provider: 'grok', model: 'grok-3-mini', apiKey: 'xai-...' },
  },
  mistral: {
    note: 'Codestral is tuned for code. Key from console.mistral.ai.',
    cfg: { provider: 'mistral', model: 'codestral-latest', apiKey: '...' },
  },
  groq: {
    note: 'Very fast inference, OpenAI-compatible. Key from console.groq.com/keys.',
    cfg: { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_...' },
  },
  openrouter: {
    note: 'One key, hundreds of models — use any OpenRouter model ID.',
    cfg: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', apiKey: 'sk-or-...' },
  },
  azure: {
    note: 'The base URL is your deployment root; the model is your deployment name.',
    cfg: {
      provider: 'azure',
      baseUrl: 'https://my-resource.openai.azure.com/openai/deployments/gpt-4o',
      model: 'gpt-4o',
      apiKey: '...',
      azureApiVersion: '2024-12-01-preview',
    },
  },
  claudecode: {
    note: 'Talks to a local Claude Code proxy. Common ports and paths are discovered automatically.',
    cfg: { provider: 'claudecode', model: 'claude-opus-4-5', claudeCodeBaseUrl: 'http://localhost:3000' },
  },
  custom: {
    note: 'Any server that speaks the OpenAI /v1/chat/completions API.',
    cfg: { provider: 'custom', baseUrl: 'https://your-endpoint.example.com', model: 'your-model', apiKey: '...optional...' },
  },
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function showProvider(id) {
  const p = providers[id];
  document.getElementById('prov-note').textContent = p.note;
  const lines = Object.entries(p.cfg).map(([k, v]) =>
    `  <span class="s">"llmCopilot.${k}"</span>: <span class="s">"${esc(v)}"</span>`);
  document.getElementById('prov-code').innerHTML = `{\n${lines.join(',\n')}\n}`;
  document.querySelectorAll('.prov').forEach(b => b.classList.toggle('active', b.dataset.p === id));
}
document.querySelectorAll('.prov').forEach(b => b.addEventListener('click', () => showProvider(b.dataset.p)));
showProvider('ollama');

// Hero: type a little, let the suggestion appear, accept it, start over.
const typed = document.getElementById('typed');
const ghost = document.getElementById('ghost');
const ghost2 = document.getElementById('ghost2');
const hint = document.getElementById('hint');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const prefix = 'if (';
const suggestion = 'order.status === <span class="s">\'open\'</span>) result.push(order);';
const tail = '<span class="k">return</span> result;';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function play() {
  for (;;) {
    typed.innerHTML = ''; ghost.innerHTML = ''; ghost2.innerHTML = '';
    hint.classList.remove('show');
    await wait(900);
    for (const ch of prefix) {
      typed.innerHTML = '<span class="k">' + typed.textContent + ch + '</span>';
      await wait(140);
    }
    typed.innerHTML = '<span class="k">if</span> (';
    await wait(450);
    ghost.innerHTML = suggestion.replace(/<span class="s">/, '<span>');
    ghost2.innerHTML = 'return result;';
    hint.classList.add('show');
    await wait(2200);
    typed.innerHTML = '<span class="k">if</span> (' + suggestion;
    ghost.innerHTML = '';
    ghost2.innerHTML = '';
    ghost2.parentNode.insertBefore(Object.assign(document.createElement('span'), { id: 'accepted', innerHTML: tail }), ghost2);
    hint.classList.remove('show');
    await wait(2600);
    document.getElementById('accepted').remove();
  }
}

if (reduced) {
  typed.innerHTML = '<span class="k">if</span> (';
  ghost.innerHTML = suggestion.replace(/<span class="s">/, '<span>');
  ghost2.textContent = 'return result;';
  hint.classList.add('show');
} else {
  play();
}
