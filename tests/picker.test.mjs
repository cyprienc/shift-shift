import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

test('picker refresh is not starved by progress and open documents are indexed first',async()=>{
 const requests=[],commands=new Map();let client,picker,queryDelay=0;
 const disposable=()=>({dispose(){}});
 class FakeClient extends EventEmitter {
  constructor(){super();client=this;this.status={ready:false,indexed:1,discovered:1,symbols:1};}
  async start(){}
  async stop(){}
  async request(body){requests.push(body);if(body.op==='query'){await new Promise(r=>setTimeout(r,queryDelay));return {results:[{name:'ExampleModel',qualified:'ExampleModel',kind:'class',relative:'data.py',path:'/example/data.py',line:13,column:6}],total:1};}return {ok:true};}
 }
 const fixture=await realpath(await mkdtemp(join(tmpdir(),'shift-picker-test-')));
 const root=join(fixture,'workspace'),extensionPath=join(fixture,'extension'),platform=`${process.platform}-${process.arch}`;
 await mkdir(root);await mkdir(join(extensionPath,'bin',platform),{recursive:true});
 const bytes=Buffer.from('test worker; FakeClient does not execute this');
 await writeFile(join(extensionPath,'bin',platform,'shift-shift-worker'),bytes);
 await writeFile(join(extensionPath,'bin','checksums.json'),JSON.stringify({[platform]:createHash('sha256').update(bytes).digest('hex')}));
 const doc={languageId:'python',isDirty:false,uri:{scheme:'file',fsPath:join(root,'data.py')}};
 await writeFile(doc.uri.fsPath,'class ExampleModel: pass\n');
 const vscode={
  StatusBarAlignment:{Left:1},
  window:{
   createOutputChannel:()=>({appendLine(){},show(){},dispose(){}}),
   createStatusBarItem:()=>({show(){},dispose(){}}),showErrorMessage:e=>{throw Error(e);},
   createQuickPick:()=>{
    const events=new EventEmitter();
    picker={value:'',items:[],show(){},hide(){events.emit('hide');},dispose(){},
     change(value){this.value=value;events.emit('change');},
     onDidChangeValue:fn=>{events.on('change',fn);return disposable();},
     onDidAccept:fn=>{events.on('accept',fn);return disposable();},
     onDidHide:fn=>{events.on('hide',fn);return disposable();}};
    return picker;
   }
  },
  commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return disposable();}},
  workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],textDocuments:[doc],
   getConfiguration:()=>({get:(_name,fallback)=>fallback}),
   onDidChangeTextDocument:disposable,onDidCloseTextDocument:disposable,
   onDidChangeWorkspaceFolders:disposable,onDidChangeConfiguration:disposable,
   createFileSystemWatcher:()=>({dispose(){},onDidCreate:disposable,onDidChange:disposable,onDidDelete:disposable})}
 };
 const source=await readFile('src/extension.ts','utf8');
 const compiled=await transform(source,{loader:'ts',format:'cjs',target:'node20'});
 const module={exports:{}};const require=createRequire(import.meta.url);
 runInNewContext(compiled.code,{module,exports:module.exports,require:name=>name==='vscode'?vscode:name==='./client'?{Client:FakeClient}:require(name),process,setTimeout,clearTimeout});
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  module.exports.activate({extensionPath,subscriptions:[]});
  await commands.get('shiftShift.open')();await wait(10);
  assert.equal(requests[0].op,'update');assert.equal(requests[0].path,doc.uri.fsPath);
  picker.change('examplemodel');await wait(40);
  const before=requests.filter(r=>r.op==='query').length;
  const ticks=setInterval(()=>client.emit('status',client.status),20);
  try{await wait(340);}finally{clearInterval(ticks);}
  const after=requests.filter(r=>r.op==='query').length;
  assert.ok(after>before,'progress must refresh while events continue arriving');
  assert.equal(requests.filter(r=>r.op==='query').at(-1).query,'examplemodel');
  await wait(150);queryDelay=300;picker.items=[];
  const continuous=setInterval(()=>client.emit('status',client.status),20);
  try{await wait(650);}finally{clearInterval(continuous);}
  assert.equal(picker.items[0]?.result.name,'ExampleModel','queries slower than progress events must still render');
 }finally{await module.exports.deactivate();await rm(fixture,{recursive:true,force:true});}
});
