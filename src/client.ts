import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export interface Result { path: string; relative: string; name: string; qualified: string; kind: string; line: number; column: number; score: number }
export interface Status { discovered: number; indexed: number; pending: number; skipped: number; failed: number; symbols: number; parseErrors: number; indexBytes: number; budgetBytes: number; storage: string; ready: boolean; failures: Record<string,string>; parserIssues: Record<string,string>; elapsedMs?: number }
export interface Response { id: number; error?: string; results?: Result[]; total?: number; engineMs?: number; cancelled?: boolean; protocol?: number }
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['LANG','LC_ALL','LC_CTYPE']) if (source[name] !== undefined) env[name] = source[name];
  return env;
}
export class Client extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; chunks?: Result[] }>();
  private directory?: string;
  private closing = false;
  private stopping?: Promise<void>;
  private exited = false;
  pid?: number;
  status?: Status;
  constructor(readonly binary: string, readonly roots: string[], readonly exclude: string[], readonly budget: number) { super(); }
  async start(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'shift-shift-'));
    this.child = spawn(this.binary, [], { stdio: ['pipe','pipe','pipe'], shell: false, cwd: tmpdir(), env: workerEnvironment(process.env) });
    let stderr = '';
    this.child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    this.child.on('error', error => this.failed(error));
    this.child.on('close', () => { this.exited = true; });
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', line => {
      if (line.length > 64 * 1024 * 1024) { this.failed(new Error('Worker response exceeds 64 MiB')); this.child?.kill(); return; }
      let value: any; try { value = JSON.parse(line); } catch { this.failed(new Error('Invalid worker response')); return; }
      if (value.event === 'status') { this.status = value; this.emit('status', value); }
      const p = this.pending.get(value.id);
      if (p && Array.isArray(value.chunk)) { (p.chunks ??= []).push(...value.chunk); return; }
      if (p) { if (p.chunks) value.results = p.chunks; this.pending.delete(value.id); clearTimeout(p.timer); value.error ? p.reject(new Error(value.error)) : p.resolve(value); }
    });
    this.child.on('exit', (code, signal) => { reader.close(); if (!this.closing) this.failed(new Error(`Worker exited (${code ?? signal}) ${stderr}`)); });
    const ready = await this.request({ op: 'init', roots: this.roots, exclude: this.exclude, memoryBudgetMiB: this.budget, spillDir: this.directory });
    if (ready.protocol !== 1) throw new Error('Unsupported worker protocol');
    this.pid = ready.pid;
  }
  private failed(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  request(body: Record<string,unknown>, timeoutMs = 120_000): Promise<any> {
    if (!this.child?.stdin.writable || this.closing) return Promise.reject(new Error('Worker unavailable'));
    const id = ++this.sequence;
    const frame = JSON.stringify({ ...body, id }) + '\n';
    if (Buffer.byteLength(frame) > 16 * 1024 * 1024) return Promise.reject(new Error('Editor content exceeds protocol frame limit'));
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Worker ${body.op} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve,reject,timer });
      this.child!.stdin.write(frame, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async stop(): Promise<void> {
    return this.stopping ??= this.finishStop();
  }
  private async finishStop(): Promise<void> {
    this.closing = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker stopped')); } this.pending.clear();
    const child = this.child;
    if (child && !this.exited && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end(JSON.stringify({ id: ++this.sequence, op: 'shutdown' }) + '\n'); });
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.removeAllListeners();
  }
}
