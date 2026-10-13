"""Snapshot source and derive an independent definition inventory; never imports it."""
import ast, concurrent.futures, hashlib, json, os, pathlib, random, shutil, subprocess, sys, tokenize
EXCLUDES={'.git','.hg','.svn','.venv','venv','node_modules','__pycache__','.mypy_cache','.ruff_cache','.pytest_cache','target','build','dist','.cache','site-packages'}
def inventory(item):
    root, rel = item; path=root/rel
    try:
        with tokenize.open(path) as f: source=f.read()
        tree=ast.parse(source)
    except (SyntaxError,UnicodeError,ValueError,OSError) as e: return {'path':rel,'error':str(e)}
    records=[]; scope=[]
    def add(name,line,col,kind):
        text=source.splitlines()[line-1];column=len(text.encode('utf-8')[:col].decode('utf-8').encode('utf-16-le'))//2
        records.append({'name':name,'qualified':'.'.join([s[0] for s in scope]+[name]),'kind':kind,'line':line-1,'column':column})
    def binding(node,kind='variable'):
        if isinstance(node,ast.Name): add(node.id,node.lineno,node.col_offset,'constant' if kind=='variable' and node.id.isupper() else kind)
        elif isinstance(node,(ast.Tuple,ast.List)):
            for n in node.elts:binding(n,kind)
        elif isinstance(node,ast.Starred):binding(node.value,kind)
    def visit(node):
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
            kind='class' if isinstance(node,ast.ClassDef) else 'method' if scope and scope[-1][1] else 'function'
            # AST col_offset identifies def/class, not the name. Tokenize independently.
            import io
            tokens=tokenize.generate_tokens(io.StringIO(source).readline)
            start=(node.lineno,node.col_offset)
            seen=False
            for token in tokens:
                if token.start < start:continue
                if token.string in ('def','class'): seen=True;continue
                if seen and token.type==tokenize.NAME:
                    add(node.name,token.start[0],len(source.splitlines()[token.start[0]-1][:token.start[1]].encode('utf-8')),kind);break
            scope.append((node.name,kind=='class'))
            for n in node.body:visit(n)
            scope.pop();return
        if isinstance(node,ast.Assign) and (not scope or scope[-1][1]):
            for target in node.targets:binding(target)
            return
        if isinstance(node,ast.AnnAssign) and (not scope or scope[-1][1]):binding(node.target);return
        if isinstance(node,ast.TypeAlias) and (not scope or scope[-1][1]):binding(node.name,'typeAlias');return
        if isinstance(node,ast.expr):return
        for child in ast.iter_child_nodes(node):visit(child)
    visit(tree)
    return {'path':rel,'records':records}
def main():
    src=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();root=out/'corpus';root.mkdir(parents=True,exist_ok=True)
    paths=subprocess.check_output(['git','ls-files','-z'],cwd=src).decode().split('\0');manifest=[]
    for rel in paths:
        if not rel or any(p in EXCLUDES for p in pathlib.Path(rel).parts):continue
        p=src/rel
        if not p.is_file() or p.is_symlink() or any(x.is_symlink() for x in p.parents if x!=src and src in x.parents):continue
        # Only Python corpus ensures both backends have precisely the same candidate files.
        if p.suffix not in ('.py','.pyi'):continue
        dest=root/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
        manifest.append({'path':rel,'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
    fixture=root/'__shift_shift_fixture__.py';fixture.write_text("FIXTURE_CONSTANT = 7\nclass FixtureClass:\n    field: int\n    def method(self):\n        ignored_local = 1\n        def nested(): pass\ndef fixture_function(): pass\ntype FixtureAlias = list[int]\n")
    manifest.append({'path':fixture.name,'bytes':fixture.stat().st_size,'sha256':hashlib.sha256(fixture.read_bytes()).hexdigest()})
    (out/'manifest.json').write_text(json.dumps({'source':str(src),'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=src).decode().strip(),'files':manifest},indent=2))
    valid=[];errors=[]
    with concurrent.futures.ProcessPoolExecutor(max_workers=6) as pool, (out/'ground-truth.jsonl').open('w') as f:
        for i,result in enumerate(pool.map(inventory,[(root,x['path']) for x in manifest],chunksize=16)):
            f.write(json.dumps(result)+'\n')
            if 'records' in result:valid.extend((result['path'],r) for r in result['records'])
            else:errors.append(result)
            if i%2000==0:print('parsed',i,flush=True)
    rng=random.Random(20261012);candidates=[(p,r) for p,r in valid if r['kind'] in ('class','function','method') and len(r['name'])>=6 and not r['name'].startswith('__')];rng.shuffle(candidates)
    queries=[]
    for i,(p,r) in enumerate(candidates[:160]):
        name=r['name'];kind=i//40
        q=name if kind==0 else name[:max(3,len(name)//2)] if kind==1 else name[::2] if kind==2 else name[-max(3,len(name)//2):]
        queries.append({'query':q,'type':['exact','prefix','subsequence','suffix'][kind],'target':{'path':p,**r}})
    queries.extend({'query':f'__shift_shift_missing_{i:03d}_qzx','type':'missing'} for i in range(40))
    (out/'queries.json').write_text(json.dumps(queries,indent=2))
    (out/'inventory-summary.json').write_text(json.dumps({'files':len(manifest),'bytes':sum(x['bytes'] for x in manifest),'symbols':len(valid),'syntax_errors':len(errors),'errors':errors},indent=2))
    print('complete',len(manifest),len(valid),len(errors),flush=True)
if __name__=='__main__':main()
