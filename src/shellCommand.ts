import { spawn, execFile } from 'child_process';

/**
 * Runs one shell command for the agent. A command line often starts more than
 * the shell — `npm test` runs node, a watcher runs forever — so stopping it
 * means stopping that whole tree, not just the shell at the top of it. On
 * POSIX the command gets a process group of its own and the group is
 * signalled; on Windows taskkill walks the tree.
 */

export interface ShellResult {
  /** The exit code, or null when the command was stopped. */
  code: number | null;
  /** stdout and stderr interleaved as they arrived, capped at maxOutput. */
  output: string;
  timedOut: boolean;
  stopped: boolean;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutput?: number;
}

export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const { cwd, timeoutMs, signal, env, maxOutput = 4 * 1024 * 1024 } = options;
  if (signal.aborted) { return Promise.resolve({ code: null, output: '', timedOut: false, stopped: true }); }

  const windows = process.platform === 'win32';
  return new Promise(resolve => {
    const child = spawn(command, { cwd, env, shell: true, detached: !windows, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let clipped = false;
    let timedOut = false;
    let stopped = false;

    const collect = (chunk: Buffer) => {
      const room = maxOutput - size;
      if (chunk.length > room) { clipped = true; }
      if (room <= 0) { return; }
      chunks.push(chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const killTree = () => {
      // Even after the shell exits, something it started in the background can hold its output open.
      if (child.pid === undefined) { return; }
      if (windows) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = () => { stopped = true; killTree(); };
    signal.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      let output = Buffer.concat(chunks).toString('utf8');
      if (clipped) { output += '\n… (output cut off)'; }
      if (error) { output += `${output ? '\n' : ''}${error.message}`; }
      resolve({ code: timedOut || stopped ? null : code, output, timedOut, stopped });
    };
    child.on('error', err => finish(127, err));
    child.on('close', code => finish(code ?? 1));
  });
}
