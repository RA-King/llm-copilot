import * as vscode from 'vscode';

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private isLoading = false;
  private loadingInterval: NodeJS.Timeout | null = null;
  private loadingFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'llmCopilot.toggleEnabled';
    this.setIdle();
    this.updateVisibility();
  }

  setIdle() {
    this.stopLoading();
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    const enabled = cfg.get('enabled', true);
    const provider = cfg.get('provider', 'ollama');
    const model = cfg.get('model', 'codellama');
    this.statusBarItem.text = enabled
      ? `$(sparkle) LLM: ${provider}/${model}`
      : `$(circle-slash) LLM Copilot (disabled)`;
    this.statusBarItem.tooltip = enabled
      ? `LLM Copilot active — ${provider} / ${model}\nClick to toggle`
      : 'LLM Copilot disabled — click to enable';
    this.statusBarItem.color = enabled ? undefined : new vscode.ThemeColor('statusBar.foreground');
    this.statusBarItem.backgroundColor = undefined;
  }

  setLoading(message = 'Generating...') {
    if (this.isLoading) { return; }
    this.isLoading = true;
    this.frameIndex = 0;
    this.loadingInterval = setInterval(() => {
      this.statusBarItem.text = `${this.loadingFrames[this.frameIndex % this.loadingFrames.length]} ${message}`;
      this.frameIndex++;
    }, 80);
  }

  stopLoading() {
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
    this.isLoading = false;
  }

  setError(message: string) {
    this.stopLoading();
    this.statusBarItem.text = `$(error) LLM: ${message}`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    setTimeout(() => this.setIdle(), 4000);
  }

  setSuccess() {
    this.stopLoading();
    this.statusBarItem.text = `$(check) LLM: Connected`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    setTimeout(() => this.setIdle(), 2000);
  }

  updateVisibility() {
    const cfg = vscode.workspace.getConfiguration('llmCopilot');
    if (cfg.get('showStatusBar', true)) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  dispose() {
    this.stopLoading();
    this.statusBarItem.dispose();
  }
}
