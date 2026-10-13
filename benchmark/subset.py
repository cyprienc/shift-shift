"""Build a deterministic subset, or reconstruct the exact paths in a saved manifest."""
import json,pathlib,random,shutil,sys
full=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);count=int(sys.argv[3]) if len(sys.argv)>3 else 1000
manifest=json.loads((full/'manifest.json').read_text());queries=json.loads((full/'queries.json').read_text())
if len(sys.argv)>4:
    selected={x['path'] for x in json.loads(pathlib.Path(sys.argv[4]).read_text())['files']}
else:
    selected={q['target']['path'] for q in queries if 'target' in q}|{'__shift_shift_fixture__.py'}
    candidates=sorted(x['path'] for x in manifest['files'] if x['path'] not in selected)
    random.Random(20261012).shuffle(candidates);selected.update(candidates[:max(0,count-len(selected))])
root=out/'corpus';root.mkdir(parents=True,exist_ok=True)
files=[x for x in manifest['files'] if x['path'] in selected]
for x in files:
    dest=root/x['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(full/'corpus'/x['path'],dest)
(out/'manifest.json').write_text(json.dumps({'source':str(full),'commit':manifest.get('commit'),'files':files},indent=2))
shutil.copyfile(full/'queries.json',out/'queries.json')
with (out/'ground-truth.jsonl').open('w') as target:
    for line in (full/'ground-truth.jsonl').read_text().splitlines():
        if json.loads(line)['path'] in selected:target.write(line+'\n')
print('subset',len(files),'files',sum(x['bytes'] for x in files),'bytes')
