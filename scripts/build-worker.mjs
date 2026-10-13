import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root=resolve('.');
const cargoHome=process.env.CARGO_HOME ?? join(homedir(),'.cargo');
const flags=process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.split(/\s+/).filter(Boolean) ?? [];
// Remove machine-specific paths from panic locations and compiled dependency strings.
for(const registry of await readdir(join(cargoHome,'registry','src')).catch(()=>[]))flags.push(`--remap-path-prefix=${join(cargoHome,'registry','src',registry)}=/cargo/registry/src`);
flags.push(`--remap-path-prefix=${root}=/source/shift-shift`);
flags.push(`--remap-path-prefix=${process.env.RUSTUP_HOME ?? join(homedir(),'.rustup')}=/rustup`);
const args=process.argv.slice(2);
const cross=args.includes('--cross');
const result=spawnSync('cargo',['+1.97.0',cross?'zigbuild':'build','--release','--locked','--manifest-path','engine/Cargo.toml',...args.filter(x=>x!=='--cross')],{stdio:'inherit',env:{...process.env,RUSTFLAGS:'',CARGO_ENCODED_RUSTFLAGS:flags.join('\x1f')}});
if(result.error)throw result.error;
process.exit(result.status ?? 1);
