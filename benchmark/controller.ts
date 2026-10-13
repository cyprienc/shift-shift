import * as vscode from 'vscode';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Client } from '../src/client';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function timed<T>(p:PromiseLike<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([p,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Provider query timed out after ${ms} ms`)),ms);})]);}finally{if(timer)clearTimeout(timer);}}
export async function activate(): Promise<void> {
  const out=process.env.SHIFT_BENCH_OUTPUT!;
  const events:any[]=[];
  const mark=(event:string,extra:any={})=>{events.push({event,ms:performance.now(),...extra});void writeFile(out+'.events',JSON.stringify(events,null,2));};
  try {
    const root=process.env.SHIFT_BENCH_ROOT!;const mode=process.env.SHIFT_BENCH_MODE!; const queries=JSON.parse(await readFile(process.env.SHIFT_BENCH_QUERIES!,'utf8'));
    const started=performance.now();let client:Client|undefined;let heartbeatMax=0;let lastBeat=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();heartbeatMax=Math.max(heartbeatMax,now-lastBeat-20);lastBeat=now;},20);
    mark('start',{mode,extensions:vscode.extensions.all.map(x=>x.id)});
    if(mode==='rust') { client=new Client(process.env.SHIFT_BENCH_BINARY!,[root],[],1024);await client.start();if(!client.status?.ready) await new Promise<void>(r=>{const cb=(s:any)=>{if(s.ready){client!.off('status',cb);r();}};client!.on('status',cb);});mark('index_ready',{status:client.status}); }
    else {
      const pylance=vscode.extensions.getExtension('ms-python.vscode-pylance'); if(!pylance) throw new Error('Pylance unavailable');
      mark('activate_python');await vscode.extensions.getExtension('ms-python.python')!.activate();mark('python_activated');
      const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(join(root,'__shift_shift_fixture__.py')));await vscode.window.showTextDocument(doc);
      // Actual readiness is observed from indexing completion logs by the external runner.
      const signal=process.env.SHIFT_BENCH_READY!;
      const deadline=Date.now()+10*60_000;let ready=false;
      while(Date.now()<deadline){try{await readFile(signal);const probe=await timed(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider','FixtureClass'),30000);if(probe?.some(x=>x.name==='FixtureClass')){ready=true;break;}}catch{}await delay(200);}
      if(!ready)throw new Error('Pylance did not reach observed indexing completion within 10 minutes');mark('index_ready');
    }
    const readyMs=performance.now()-started;
    const ask=async(q:string,matching='fuzzy')=>{
      if(client){const r=await client.request({op:'query',query:q,mode:'symbols',limit:0,matching});return {engineMs:r.engineMs,results:r.results.map((x:any)=>({path:relative(root,x.path),name:x.name,line:x.line,column:x.column,kind:x.kind}))};}
      const result=await timed(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider',q),30000);return {results:(result??[]).map(x=>({path:relative(root,x.location.uri.fsPath),name:x.name,line:x.location.range.start.line,column:x.location.range.start.character,kind:x.kind}))};
    };
    const samples:any[]=[];const raw=out+'.raw';await mkdir(raw,{recursive:true});const zip=promisify(gzip);const save=()=>writeFile(out+'.partial',JSON.stringify({mode,readyMs,samples,events}));
    for(let pass=0;pass<3;pass++){for(let i=0;i<queries.length;i++){const q=queries[(i*73+pass*17)%queries.length];const t=performance.now();const r=await ask(q.query);const ms=performance.now()-t;const targetFound=q.target?r.results.some((x:any)=>x.path===q.target.path&&x.name===q.target.name&&x.line===q.target.line):undefined;if(pass===0)await writeFile(join(raw,queries.indexOf(q)+'.json.gz'),await zip(JSON.stringify(r.results)));samples.push({query:q.query,type:q.type,pass,ms,engineMs:r.engineMs,count:r.results.length,targetFound});if(i%20===19)await save();}await save();mark('query_pass',{pass});}
    // Diagnostic: Rust literal-name substring search versus Pylance's own matching.
    // Pylance has no API to select the same predicate; these are not equivalent semantics.
    const comparable=[];for(const q of queries.filter((x:any)=>x.type!=='subsequence')){const t=performance.now();const r=await ask(q.query,'substring');const ms=performance.now()-t;await writeFile(join(raw,'substring-'+queries.indexOf(q)+'.json.gz'),await zip(JSON.stringify(r.results)));comparable.push({query:q.query,type:q.type,ms,engineMs:r.engineMs,count:r.results.length,targetFound:q.target?r.results.some((x:any)=>x.path===q.target.path&&x.name===q.target.name&&x.line===q.target.line):undefined});}
    const uri=vscode.Uri.file(join(root,'__shift_shift_fixture__.py'));const document=await vscode.workspace.openTextDocument(uri);const previous=document.getText();
    const editStart=performance.now();const edit=new vscode.WorkspaceEdit();edit.insert(uri,new vscode.Position(document.lineCount,0),'\ndef __shift_shift_edit_marker__(): pass\n');await vscode.workspace.applyEdit(edit);
    if(client)await client.request({op:'update',path:uri.fsPath,text:document.getText()});
    let visible=false;for(let i=0;i<200;i++){const r=await ask('__shift_shift_edit_marker__');if(r.results.some((x:any)=>x.name==='__shift_shift_edit_marker__')){visible=true;break;}await delay(10);}const editMs=performance.now()-editStart;
    const restore=new vscode.WorkspaceEdit();restore.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),previous);await vscode.workspace.applyEdit(restore);
    clearInterval(heartbeat);const status=client?.status;
    await writeFile(out,JSON.stringify({mode,readyMs,samples,comparable,editMs,editVisible:visible,heartbeatMax,status,events,vscode:vscode.version,pylance:vscode.extensions.getExtension('ms-python.vscode-pylance')?.packageJSON.version},null,2));mark('complete');await client?.stop();await vscode.commands.executeCommand('workbench.action.closeWindow');
  }catch(e){await writeFile(out,JSON.stringify({error:String(e),stack:e instanceof Error?e.stack:undefined,events},null,2));await vscode.commands.executeCommand('workbench.action.closeWindow');}
}
