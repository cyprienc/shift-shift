"""Run real VS Code profiles; Pylance readiness is taken from its own log."""
import json, os, pathlib, re, shutil, subprocess, sys, time, tempfile
BASE=pathlib.Path(os.environ['SHIFT_BENCH_TOOLS']).resolve()
CORPUS=pathlib.Path(os.environ['SHIFT_BENCH_CORPUS']).resolve()
APP=os.environ.get('SHIFT_BENCH_CODE','/Applications/Visual Studio Code.app/Contents/MacOS/Code')
ENGINE=str(pathlib.Path(__file__).resolve().parents[1]/'engine/target/release/shift-shift-worker')
def descendants(pid,rows):
    ids={pid}
    while True:
        before=len(ids)
        ids.update(r['pid'] for r in rows if r['ppid'] in ids)
        if before==len(ids):return ids

def run(mode,n):
    run=CORPUS/f'{mode}-{n}';run.mkdir(parents=True,exist_ok=True)
    # macOS Unix-domain socket paths must be shorter than 104 bytes.
    profile=pathlib.Path(tempfile.mkdtemp(prefix='shift-bench-',dir='/tmp'))
    user=profile/'user';ext=run/'extensions';(user/'User').mkdir(parents=True,exist_ok=True);ext.mkdir(exist_ok=True)
    (run/'profile.json').write_text(json.dumps({'userDataDir':str(user)}))
    if mode!='rust':
        for name,publisher in [('python','ms-python'),('vscode-pylance','ms-python')]:
            src=BASE/'benchmark-extensions'/name/'extension';m=json.loads((src/'package.json').read_text());
            link=ext/f'{publisher}.{name}-{m["version"]}'
            if not link.exists():os.symlink(src,link)
    settings={'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoUpdate':False,'extensions.autoCheckUpdates':False,'security.workspace.trust.enabled':False,'workbench.startupEditor':'none','window.restoreWindows':'none','python.defaultInterpreterPath':sys.executable,'python.analysis.indexing':True,'python.analysis.userFileIndexingLimit':2000 if mode=='pylance-default' else -1,'python.analysis.logLevel':'Information','python.analysis.diagnosticMode':'openFilesOnly','python.analysis.autoSearchPaths':False,'python.analysis.include':['**/*.py','**/*.pyi'],'python.analysis.exclude':['**/.venv/**','**/node_modules/**'],'python.analysis.includeVenvSymbolsInSymbolSearch':False,'python.analysis.includeExtraPathSymbolsInSymbolSearch':False,'python.analysis.userFileIndexFollowSymlinkedFolders':False,'python.analysis.packageIndexDepths':[],'python.analysis.nodeExecutable':os.environ.get('SHIFT_BENCH_NODE','node') if mode=='pylance-unlimited' else '', 'python.analysis.nodeArguments':['--max-old-space-size=16384'],'python.experiments.enabled':False,'python.useEnvironmentsExtension':False}
    (user/'User/settings.json').write_text(json.dumps(settings,indent=2));out=run/'results.json';ready=run/'ready'
    env=os.environ.copy();env.update(SHIFT_BENCH_OUTPUT=str(out),SHIFT_BENCH_ROOT=str(CORPUS/'corpus'),SHIFT_BENCH_MODE=mode,SHIFT_BENCH_QUERIES=str(CORPUS/'queries.json'),SHIFT_BENCH_BINARY=ENGINE,SHIFT_BENCH_READY=str(ready))
    log=(run/'launcher.log').open('w');start=time.monotonic()
    process=subprocess.Popen([APP,'--new-window','--user-data-dir',str(user),'--extensions-dir',str(ext),'--extensionDevelopmentPath='+str(BASE/'benchmark-controller'),'--disable-extension','vscode.git','--disable-extension','vscode.github-authentication','--disable-extension','vscode.microsoft-authentication','--skip-welcome','--skip-release-notes',str(CORPUS/'corpus')],env=env,stdout=log,stderr=log)
    metrics=[];index_messages=[];last_print=0;deadline=start+900
    while time.monotonic()<deadline:
        elapsed=time.monotonic()-start
        ps=subprocess.run(['ps','-axo','pid,ppid,rss,pcpu,command'],capture_output=True,text=True).stdout
        rows=[]
        for line in ps.splitlines()[1:]:
            p=line.split(None,4)
            if len(p)==5:
                try:rows.append({'pid':int(p[0]),'ppid':int(p[1]),'rssKiB':int(p[2]),'cpu':float(p[3]),'command':p[4]})
                except ValueError:pass
        ids=descendants(process.pid,rows);ours=[r for r in rows if r['pid'] in ids];back=[r for r in ours if 'shift-shift-worker' in r['command'] or 'server.bundle.js' in r['command'] or 'server.js' in r['command']]
        metrics.append({'seconds':elapsed,'allRssKiB':sum(r['rssKiB'] for r in ours),'backendRssKiB':sum(r['rssKiB'] for r in back),'processes':ours})
        if mode!='rust' and not ready.exists():
            for f in (user/'logs').glob('**/*'):
                if not f.is_file() or 'Pylance' not in f.name and 'Python Language Server' not in str(f):continue
                try:text=f.read_text(errors='replace')
                except OSError:continue
                lines=[l for l in text.splitlines() if re.search(r'index|scan|analyz',l,re.I)]
                index_messages=lines[-40:]
                if re.search(r'Indexing finished|indexing finished|indexed \d+ files|indexing:.*completed',text):
                    ready.write_text(json.dumps({'elapsed':elapsed,'log':str(f),'messages':index_messages}));print(mode,n,'ready',round(elapsed,2),flush=True);break
        if out.exists():break
        if elapsed-last_print>30:print(mode,n,'running',round(elapsed),index_messages[-2:],flush=True);last_print=elapsed
        if process.poll() is not None:break
        time.sleep(.25)
    (run/'process-metrics.json').write_text(json.dumps(metrics));(run/'index-messages.json').write_text(json.dumps(index_messages,indent=2))
    provider_errors=[]
    for f in (user/'logs').glob('**/Python Language Server.log'):
        provider_errors.extend(line for line in f.read_text(errors='replace').splitlines() if re.search(r'Maximum call stack|workspace/symbol failed|heap out of memory|SIGABRT',line))
    (run/'provider-errors.json').write_text(json.dumps(provider_errors,indent=2))
    if not out.exists():print('FAILED',mode,n,'no results',process.poll(),flush=True)
    else: print('RESULT',mode,n, str(out),out.stat().st_size,flush=True)
    if process.poll() is None:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill()
    log.close()
    return run
if __name__=='__main__':
    for mode in sys.argv[1:] or ['rust','pylance-default','pylance-unlimited']:
        run(mode,int(os.environ.get('SHIFT_BENCH_RUN','0')))
