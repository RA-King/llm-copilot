import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runShell } from '../src/shellCommand';

const posix = process.platform !== 'win32';
const run = (command: string, timeoutMs = 10000, signal = new AbortController().signal, maxOutput?: number) =>
  runShell(command, { cwd: os.tmpdir(), timeoutMs, signal, maxOutput });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('runShell', () => {
  it('returns the exit code and both output streams', async () => {
    const result = await run('echo out; echo err 1>&2; exit 3');
    expect(result.code).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result.timedOut || result.stopped).toBe(false);
  });

  it('caps the output', async () => {
    const result = await run('printf "%0500d" 0', 10000, new AbortController().signal, 100);
    expect(result.output).toMatch(/^0{100}\n… \(output cut off\)$/);
  });

  it('does not start a command that was stopped before it ran', async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = path.join(os.tmpdir(), `llm-shell-${process.pid}-never`);
    const result = await run(`touch ${marker}`, 10000, controller.signal);
    expect(result.stopped).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  (posix ? it : it.skip)('stops the processes the command started, not just the shell', async () => {
    const pidFile = path.join(os.tmpdir(), `llm-shell-${process.pid}-child`);
    const controller = new AbortController();
    const pending = run(`sleep 30 & echo $! > ${pidFile}; wait`, 10000, controller.signal);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) { await new Promise(r => setTimeout(r, 20)); }
    const child = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    fs.unlinkSync(pidFile);
    expect(alive(child)).toBe(true);

    controller.abort();
    const result = await pending;
    expect(result.stopped).toBe(true);
    expect(result.code).toBeNull();
    for (let i = 0; i < 50 && alive(child); i++) { await new Promise(r => setTimeout(r, 20)); }
    expect(alive(child)).toBe(false);
  });

  (posix ? it : it.skip)('times out a background process that outlives the shell', async () => {
    const started = Date.now();
    const result = await run('sleep 30 &', 300);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  (posix ? it : it.skip)('times out the whole tree', async () => {
    const result = await run('sleep 30 & wait', 300);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });
});
