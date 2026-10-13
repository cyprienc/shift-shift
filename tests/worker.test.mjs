import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, workerEnvironment } from '../dist/client.mjs';
const binary=resolve('engine/target/release/shift-shift-worker');
async function fixture(budget=1024){const root=await realpath(await mkdtemp(join(tmpdir(),'shift-test-root-')));const c=new Client(binary,[root],[],budget);return {root,c,async close(){await c.stop();await rm(root,{recursive:true,force:true});}};}
async function ready(c){if(c.status?.ready)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('index timeout')),30000);const cb=s=>{if(s.ready){clearTimeout(timer);c.off('status',cb);resolve();}};c.on('status',cb);});}
const names=r=>r.results.map(x=>x.qualified);
test('worker environment excludes credentials and dynamic-loader injection',()=>{
 assert.deepEqual(workerEnvironment({LANG:'en_US.UTF-8',LC_ALL:'C',LC_CTYPE:'UTF-8',HOME:'/private',PATH:'/tools',AWS_SECRET_ACCESS_KEY:'secret',GITHUB_TOKEN:'secret',LD_PRELOAD:'/malicious.so',DYLD_INSERT_LIBRARIES:'/malicious.dylib',PYTHONPATH:'/project'}),{LANG:'en_US.UTF-8',LC_ALL:'C',LC_CTYPE:'UTF-8'});
});
test('independent index, exclusions, UTF-16, unsaved updates and removals',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,'a.py'),"a='😀'; café=1\nclass C:\n    FIELD: int\n    def method(self):\n        ignored=2\n        def nested():pass\n");
  await mkdir(join(f.root,'.venv'));await writeFile(join(f.root,'.venv','hidden.py'),'def forbidden():pass\n');await writeFile(join(f.root,'.gitignore'),'a.py\n');await symlink(join(f.root,'a.py'),join(f.root,'link.py'));
  await f.c.start();await ready(f.c);let r=await f.c.request({op:'query',query:'',mode:'symbols',limit:0});assert.deepEqual(names(r),['a','café','C','C.FIELD','C.method','C.method.nested']);assert.equal(r.results[1].column,8);assert.equal(f.c.status.indexed,2);
  await f.c.request({op:'update',path:join(f.root,'a.py'),text:'def replacement():pass\n'});r=await f.c.request({op:'query',query:'',mode:'symbols',limit:0});assert.deepEqual(names(r),['replacement']);
  await f.c.request({op:'update',path:join(f.root,'a.py')});r=await f.c.request({op:'query',query:'nested',mode:'symbols',limit:0});assert.equal(r.total,1);
  await assert.rejects(f.c.request({op:'update',path:'/etc/passwd'}),/outside/);
  await assert.rejects(f.c.request({op:'update',path:join(f.root,'link.py')}),/outside/);
  await f.c.request({op:'remove',path:join(f.root,'a.py')});r=await f.c.request({op:'query',query:'',mode:'symbols',limit:0});assert.equal(r.total,0);
 }finally{await f.close();}
});
test('disk spilling retains the complete result set and cleans up',async()=>{
 const f=await fixture(16);try{
  const source=Array.from({length:80000},(_,i)=>`VALUE_${i}=1`).join('\n');await writeFile(join(f.root,'large.py'),source);await f.c.start();await ready(f.c);
  assert.equal(f.c.status.storage,'disk');let r=await f.c.request({op:'query',query:'VALUE_',mode:'symbols',limit:0});assert.equal(r.total,80000);assert.equal(f.c.status.failed,0);
  await f.c.request({op:'update',path:join(f.root,'large.py'),text:'NEW=1\n'});r=await f.c.request({op:'query',query:'',mode:'symbols',limit:0});assert.deepEqual(names(r),['NEW']);
 }finally{await f.close();}
});
test('overlapping roots deduplicate, cancellation and incomplete syntax remain usable',async()=>{
 const f=await fixture();try{await mkdir(join(f.root,'nested'));await writeFile(join(f.root,'nested','a.py'),'def intact():pass\ndef broken(\n');const c=new Client(binary,[f.root,join(f.root,'nested')],[],1024);await c.start();await ready(c);assert.equal(c.status.indexed,1);assert.equal(c.status.parseErrors,1);const p=c.request({op:'query',query:'intact',mode:'symbols',limit:0});await c.request({op:'cancel'});const r=await p;assert.ok(r.cancelled||r.total===1);await c.stop();}finally{await f.close();}
});
test('result limit retains best matches without limiting the full index',async()=>{
 const f=await fixture();try{await writeFile(join(f.root,'a.py'),Array.from({length:5000},(_,i)=>`VALUE_${i}=1`).join('\n'));await f.c.start();await ready(f.c);const all=await f.c.request({op:'query',query:'VALUE_4',mode:'symbols',limit:0});const limited=await f.c.request({op:'query',query:'VALUE_4',mode:'symbols',limit:10});assert.equal(limited.total,all.total);assert.deepEqual(limited.results,all.results.slice(0,10));assert.equal(f.c.status.symbols,5000);}finally{await f.close();}
});
test('directory removal clears descendants and storage failures remain visible',async()=>{
 const f=await fixture(16);try{await mkdir(join(f.root,'env'));await writeFile(join(f.root,'env','a.py'),'def retained():pass\n');await f.c.start();await ready(f.c);assert.equal(f.c.status.indexed,1);await f.c.request({op:'remove',path:join(f.root,'env')});assert.equal((await f.c.request({op:'query',query:'',mode:'all',limit:0})).total,0);await f.c.request({op:'update',path:join(f.root,'env','a.py'),text:'x'.repeat(3*1024*1024)});const s=await f.c.request({op:'status'});assert.equal(s.failed,1);assert.match(Object.values(s.failures)[0],/budget/);}finally{await f.close();}
});
test('failed process startup still stops and cleans its temporary directory',async()=>{
 const c=new Client('/no-such-shift-worker',[],[],16);c.on('failure',()=>{});await assert.rejects(c.start(),/ENOENT/);await c.stop();
});
test('lowercase symbols are searchable before whole-workspace discovery completes',async()=>{
 const f=await fixture();let c;
 try {
  const first=join(f.root,'first'),later=join(f.root,'later'),last=join(f.root,'last');await mkdir(first);await mkdir(later);await mkdir(join(last,'removed'),{recursive:true});
  const target=join(first,'data.py');await writeFile(target,'class ExampleModel:\n    pass\n');
  await Promise.all(Array.from({length:31},(_,i)=>writeFile(join(first,`f${i}.txt`),'')));
  const source=Array.from({length:4000},(_,i)=>`def background_${i}(): pass`).join('\n');
  await Promise.all(Array.from({length:128},(_,i)=>writeFile(join(later,`f${i}.py`),source)));
  const changed=join(later,'edited.py');await writeFile(changed,'class BeforeEdit: pass\n');
  await writeFile(join(last,'removed','stale.py'),'class RemovedDuringScan: pass\n');
  c=new Client(binary,[first,later,last],[],1024);
  const partial=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('No incremental index progress')),30000);
   c.on('status',s=>{if(!s.ready&&s.indexed>0){clearTimeout(timer);resolve(s);}});
  });
  await c.start();const progress=await partial;
  assert.ok(progress.discovered<162,'discovery should still be in progress');
  const result=await c.request({op:'query',query:'examplemodel',mode:'symbols',limit:100});
  assert.equal(result.results[0]?.name,'ExampleModel');assert.equal(result.results[0]?.path,target);
  assert.equal(c.status.ready,false,'query should finish before indexing does');
  await c.request({op:'update',path:changed,text:'class EditedDuringScan: pass\n'});
  await c.request({op:'remove',path:join(last,'removed')});
  await c.request({op:'update',path:target,text:'class EditedExample:\n    pass\n'});
  await ready(c);assert.equal(c.status.indexed,161);assert.equal(c.status.discovered,162);
  assert.equal((await c.request({op:'query',query:'examplemodel',mode:'symbols',limit:100})).total,0);
  assert.equal((await c.request({op:'query',query:'editedexample',mode:'symbols',limit:100})).total,1);
  assert.equal((await c.request({op:'query',query:'editedduringscan',mode:'symbols',limit:100})).total,1);
  assert.equal((await c.request({op:'query',query:'removedduringscan',mode:'symbols',limit:100})).total,0);
 }finally{await c?.stop();await f.close();}
});
