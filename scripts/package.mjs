import { readFile, mkdir, copyFile, chmod, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const project=resolve('.');
const crossBinaries={
  'darwin-arm64':'engine/target/release/shift-shift-worker',
  'linux-x64':'engine/target/x86_64-unknown-linux-musl/release/shift-shift-worker',
  'linux-arm64':'engine/target/aarch64-unknown-linux-musl/release/shift-shift-worker',
};
const args=process.argv.slice(2);
const preRelease=args.includes('--pre-release');
const targetArgs=args.filter(x=>x!=='--pre-release');
if(targetArgs.length && targetArgs[0]!=='--target')throw new Error('Usage: npm run package -- [--target platform ...] [--pre-release]');
const platforms=targetArgs.length ? targetArgs.slice(1) : [`${process.platform}-${process.arch}`];
if(!platforms.length || platforms.some(p=>!Object.hasOwn(crossBinaries,p)))throw new Error('Supported targets: darwin-arm64 linux-x64 linux-arm64');
const binaries=Object.fromEntries([...new Set(platforms)].map(p=>[p,p===`${process.platform}-${process.arch}` ? 'engine/target/release/shift-shift-worker' : crossBinaries[p]]));
const manifest=JSON.parse(await readFile('package.json','utf8'));
const checksums={};
for(const [platform,source] of Object.entries(binaries)){
  await mkdir(`bin/${platform}`,{recursive:true});
  await copyFile(source,`bin/${platform}/shift-shift-worker`);
  await chmod(`bin/${platform}/shift-shift-worker`,0o755);
  checksums[platform]=createHash('sha256').update(await readFile(source)).digest('hex');
}
await writeFile('bin/checksums.json',JSON.stringify(checksums,null,2)+'\n');
await mkdir('artifacts',{recursive:true});
for(const platform of Object.keys(binaries)){
  const stage=await mkdtemp(join(tmpdir(),'shift-package-'));
  try{
    for(const file of ['package.json','README.md','CHANGELOG.md','LICENSE','SECURITY.md','THIRD_PARTY_NOTICES.md'])await copyFile(file,join(stage,file));
    await cp('dist',join(stage,'dist'),{recursive:true,filter:p=>!p.endsWith('.map')&&!p.endsWith('client.mjs')});
    await cp(`bin/${platform}`,join(stage,'bin',platform),{recursive:true});
    await copyFile('bin/checksums.json',join(stage,'bin','checksums.json'));
    await writeFile(join(stage,'.vscodeignore'),'**/*.map\n');
    const result=spawnSync(process.execPath,[join(project,'node_modules/@vscode/vsce/vsce'),'package','--no-dependencies',...(preRelease?['--pre-release']:[]),'--target',platform,'--out',join(project,`artifacts/shift-shift-cc-${manifest.version}-${platform}.vsix`)],{cwd:stage,stdio:'inherit'});
    if(result.status)throw new Error(`Packaging ${platform} failed (${result.status})`);
  }finally{await rm(stage,{recursive:true,force:true});}
}
