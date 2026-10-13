import * as vscode from 'vscode';
import { realpath, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import { Client, Result, Status } from './client';
let runtime: Runtime | undefined;
class Runtime implements vscode.Disposable {
  private client?: Client;
  private starting?: Promise<Client>;
  private crashCount = 0;
  private disposed = false;
  private stopped = false;
  private serial = Promise.resolve();
  private roots: string[] = [];
  private picker?: vscode.QuickPick<vscode.QuickPickItem & { result?: Result }>;
  private timers = new Map<string, NodeJS.Timeout>();
  private dirty = new Map<string,vscode.TextDocument>();
  private requestGeneration = 0;
  private shutdownPromise?: Promise<void>;
  private output = vscode.window.createOutputChannel('Shift Shift');
  private bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
  constructor(private context: vscode.ExtensionContext) { this.bar.command = 'shiftShift.status'; this.bar.text = '$(search) Shift Shift'; this.bar.show(); }
  async ready(): Promise<Client> {
    if (this.disposed || this.stopped) throw new Error('Worker stopped after repeated failure. Run Shift Shift: Reindex.');
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = undefined; }
  }
  private async launch(): Promise<Client> {
    const folders = vscode.workspace.workspaceFolders?.filter(x => x.uri.scheme === 'file') ?? [];
    this.roots = [...new Set(await Promise.all(folders.map(async x => { if ((await lstat(x.uri.fsPath)).isSymbolicLink()) throw new Error('Symlink workspace roots are unsupported'); return realpath(x.uri.fsPath); })))];
    if (!this.roots.length) throw new Error('Open a local or remote filesystem workspace first');
    const platform = `${process.platform}-${process.arch}`;
    const binary = join(this.context.extensionPath, 'bin', platform, 'shift-shift-worker');
    const checksums = JSON.parse(await readFile(join(this.context.extensionPath, 'bin', 'checksums.json'), 'utf8'));
    const bytes = await readFile(binary);
    if (this.disposed) throw new Error('Extension stopped');
    if (createHash('sha256').update(bytes).digest('hex') !== checksums[platform]) throw new Error('Bundled worker checksum mismatch');
    const cfg = vscode.workspace.getConfiguration('shiftShift');
    const client = new Client(binary, this.roots, cfg.get('exclude', []), cfg.get('memoryBudgetMiB', 1024));
    client.on('status', (s: Status) => { this.bar.text = `${s.ready ? '$(search)' : '$(sync~spin)'} ${s.indexed.toLocaleString()} files`; this.bar.tooltip = `${s.symbols.toLocaleString()} Python symbols; ${s.failed} failed; ${s.storage} index`; if (s.ready) this.output.appendLine(JSON.stringify(s)); });
    client.on('failure', (error: Error) => { void this.recover(client,error); });
    try { await client.start(); } catch (error) { await client.stop(); throw error; }
    if (this.disposed) { await client.stop(); throw new Error('Extension stopped'); }
    this.client = client;
    // Make the files already being edited searchable before the full scan reaches them.
    for (const doc of vscode.workspace.textDocuments) if (doc.languageId === 'python' && doc.uri.scheme === 'file') await this.update(doc.uri.fsPath,doc.isDirty ? doc.getText() : undefined);
    return client;
  }
  private async recover(client: Client,error: Error): Promise<void> {
    if (this.disposed || this.client !== client) return;
    this.client = undefined; await client.stop(); this.output.appendLine(error.message);
    if (++this.crashCount > 1) { this.stopped = true; this.bar.text = '$(error) Shift Shift'; void vscode.window.showErrorMessage(`Shift Shift stopped after repeated worker failure: ${error.message}`); return; }
    this.starting = undefined;
    try { await this.ready(); } catch (e) { this.stopped = true; this.output.appendLine(String(e)); void vscode.window.showErrorMessage(`Shift Shift could not restart: ${e}`); }
  }
  async reindex(): Promise<void> {
    this.serial = this.serial.catch(()=>{}).then(async () => { this.requestGeneration++; this.picker?.hide(); await this.starting?.catch(()=>{}); const c = this.client; this.client = undefined; await c?.stop(); this.stopped = false; this.crashCount = 0; this.starting = undefined; if(!this.disposed)await this.ready(); });
    return this.serial;
  }
  private async valid(path: string): Promise<boolean> {
    if (!isAbsolute(path)) return false;
    const root = this.roots.filter(r => { const p = relative(r,path); return p && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p); }).sort((a,b) => b.length-a.length)[0];
    if (!root) return false;
    let current = root;
    for (const part of relative(root,path).split(sep)) { current = join(current,part); try { if ((await lstat(current)).isSymbolicLink()) return false; } catch { return false; } }
    return true;
  }
  changed(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || !['python'].includes(doc.languageId)) return;
    const path = doc.uri.fsPath; const old = this.timers.get(path); if (old) clearTimeout(old);
    this.dirty.set(path,doc);
    this.timers.set(path,setTimeout(() => { this.timers.delete(path); this.dirty.delete(path); void this.update(path, doc.getText()); },100));
  }
  closed(doc: vscode.TextDocument): void { const path = doc.uri.fsPath; const old = this.timers.get(path); if (old) clearTimeout(old); this.timers.delete(path); this.dirty.delete(path); if (doc.languageId === 'python') void this.update(path); }
  async update(path: string,text?: string,remove = false): Promise<void> {
    try { if(this.disposed || this.stopped)return; const c = await this.ready(); if (!remove && (!await this.valid(path) || !(await lstat(path)).isFile())) return; if (text === undefined) { const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path && d.isDirty); text = open?.getText(); }
      await c.request({ op: remove ? 'remove' : 'update', path, ...(text === undefined ? {} : {text}) });
    } catch (e) { this.output.appendLine(`Update failed for ${path}: ${e}`); }
  }
  async showStatus(): Promise<void> { const c = await this.ready(); const s = await c.request({op:'status'}); this.output.appendLine(JSON.stringify(s,null,2)); this.output.show(true); }
  async search(): Promise<void> {
    const c = await this.ready(); this.picker?.dispose();
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { result?: Result }>(); this.picker = qp;
    qp.title = 'Shift Shift'; qp.placeholder = 'Search files and Python symbols · @ symbols · / files'; qp.matchOnDescription = false; qp.matchOnDetail = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight = 0;
    let progressPending = false;
    const refresh = () => { if (!inFlight && !timer && this.picker === qp) timer=setTimeout(()=>{ timer=undefined; void run(); },100); };
    const run = async () => {
      inFlight++; progressPending = false;
      const generation = ++this.requestGeneration; const input = qp.value; const mode = input.startsWith('@') ? 'symbols' : input.startsWith('/') ? 'files' : 'all'; const query = mode === 'all' ? input : input.slice(1).trimStart(); qp.busy = true;
      // Flush pending unsaved text before querying.
      for (const [path,doc] of this.dirty) { const t = this.timers.get(path); if(t) clearTimeout(t); this.timers.delete(path); this.dirty.delete(path); await this.update(path,doc.getText()); }
      try { const result = await c.request({op:'query', query, mode, limit:vscode.workspace.getConfiguration('shiftShift').get('resultLimit',100)});
        if (generation !== this.requestGeneration || this.picker !== qp || result.cancelled) return;
        qp.items = (result.results as Result[]).map(r => ({label:r.kind === 'file' ? `$(file) ${r.name}` : `$(symbol-${r.kind === 'typeAlias' ? 'class' : r.kind}) ${r.qualified}`, description:r.relative, detail:r.kind === 'file' ? undefined : `${r.kind} · line ${r.line+1}`, alwaysShow:true,result:r}));
        const s = c.status; qp.title = `Shift Shift · ${result.total.toLocaleString()} matches${s && !s.ready ? ` · indexing ${s.indexed.toLocaleString()}/${s.discovered.toLocaleString()}` : ''}`;
      } catch(e) { if (generation === this.requestGeneration) this.output.appendLine(String(e)); } finally { inFlight--; if(generation === this.requestGeneration) qp.busy = inFlight > 0; if(progressPending) refresh(); }
    };
    const change = qp.onDidChangeValue(() => { this.requestGeneration++; void c.request({op:'cancel'}).catch(()=>{}); if(timer) clearTimeout(timer); timer=setTimeout(()=>{ timer=undefined; void run(); },25); });
    const accept = qp.onDidAccept(async () => { const r = qp.selectedItems[0]?.result; if (!r || !await this.valid(r.path)) return;
      const uri = vscode.Uri.file(r.path); qp.hide(); if(r.kind === 'file') await vscode.commands.executeCommand('vscode.open',uri); else { const doc = await vscode.workspace.openTextDocument(uri); const pos = doc.validatePosition(new vscode.Position(r.line,r.column)); await vscode.window.showTextDocument(doc,{selection:new vscode.Range(pos,pos)}); }
    });
    // A progress refresh must not cancel a slower query before it can render.
    const progress = () => { progressPending=true; refresh(); }; c.on('status',progress);
    const hide = qp.onDidHide(() => { this.requestGeneration++; if(timer) clearTimeout(timer); void c.request({op:'cancel'}).catch(()=>{}); c.off('status',progress); change.dispose(); accept.dispose(); hide.dispose(); qp.dispose(); if(this.picker === qp) this.picker=undefined; });
    qp.show(); void run();
  }
  shutdown(): Promise<void> {
    if(this.shutdownPromise)return this.shutdownPromise;
    this.disposed = true; for(const t of this.timers.values())clearTimeout(t); this.picker?.hide(); this.output.dispose(); this.bar.dispose();
    this.shutdownPromise=(async()=>{await this.starting?.catch(()=>{});await this.client?.stop();this.client=undefined;})();return this.shutdownPromise;
  }
  dispose(): void { void this.shutdown(); }
}
export function activate(context: vscode.ExtensionContext): void {
  runtime = new Runtime(context); context.subscriptions.push(runtime);
  const wrap = (fn: () => Promise<void>) => () => fn().catch(e => vscode.window.showErrorMessage(`Shift Shift: ${e}`));
  context.subscriptions.push(vscode.commands.registerCommand('shiftShift.open',wrap(()=>runtime!.search())),vscode.commands.registerCommand('shiftShift.reindex',wrap(()=>runtime!.reindex())),vscode.commands.registerCommand('shiftShift.status',wrap(()=>runtime!.showStatus())));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e=>runtime!.changed(e.document)),vscode.workspace.onDidCloseTextDocument(d=>runtime!.closed(d)),vscode.workspace.onDidChangeWorkspaceFolders(wrap(()=>runtime!.reindex())),vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('shiftShift')) void runtime!.reindex().catch(()=>{});}));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(watcher,watcher.onDidCreate(u=>void runtime!.update(u.fsPath)),watcher.onDidChange(u=>void runtime!.update(u.fsPath)),watcher.onDidDelete(u=>void runtime!.update(u.fsPath,undefined,true)));
}
export async function deactivate(): Promise<void> { await runtime?.shutdown(); runtime=undefined; }
