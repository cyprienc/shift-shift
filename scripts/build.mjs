import { build } from 'esbuild';
await build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:'dist/extension.js',sourcemap:true});
await build({entryPoints:['src/client.ts'],bundle:true,platform:'node',format:'esm',target:'node20',outfile:'dist/client.mjs'});
