import {Client} from '../dist/client.mjs';import {readFile,writeFile} from 'node:fs/promises';import {resolve} from 'node:path';import {performance} from 'node:perf_hooks';import {execFileSync} from 'node:child_process';
const base=resolve(process.argv[2]);const queries=JSON.parse(await readFile(base+'/queries.json','utf8'));const runs=[];
for(let run=0;run<Number(process.env.SHIFT_BENCH_REPEATS??5);run++){
 const c=new Client(resolve('engine/target/release/shift-shift-worker'),[base+'/corpus'],[],1024);const start=performance.now();let pid;
 const memory=[];let sampling;
 sampling=setInterval(()=>{if(!c.pid)return;try{memory.push(Number(execFileSync('ps',['-o','rss=','-p',String(c.pid)],{encoding:'utf8'}).trim()));}catch{}},100);
 await c.start();if(!c.status?.ready)await new Promise(r=>c.on('status',s=>{if(s.ready)r()}));const readyMs=performance.now()-start;const status=c.status;const samples=[];
 for(let pass=0;pass<3;pass++)for(let i=0;i<queries.length;i++){const q=queries[(i*73+pass*17)%queries.length];const start=performance.now();const r=await c.request({op:'query',query:q.query,mode:'symbols',limit:100});samples.push({type:q.type,ms:performance.now()-start,engineMs:r.engineMs,total:r.total});}
 clearInterval(sampling);await c.stop();runs.push({run,readyMs,status,samples,peakRssKiB:Math.max(...memory)});console.log(run,readyMs,status.indexed,status.symbols,Math.max(...memory));await writeFile(base+'/worker-benchmark.json',JSON.stringify({runs},null,2));
}
