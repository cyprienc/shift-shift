import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function activate():Promise<void>{
 const output=process.env.SHIFT_SMOKE_OUTPUT!;const checks:any={};
 let workerPath='';
 const workers=()=>execFileSync('ps',['-axo','pid,command'],{encoding:'utf8'}).split('\n').filter(l=>workerPath&&l.includes(workerPath));
 try{
  const ext=vscode.extensions.getExtension('CyprienCourtot.shift-shift');if(!ext)throw new Error('Packaged extension unavailable');
  workerPath=`${ext.extensionPath}/bin/${process.platform}-${process.arch}/shift-shift-worker`;
  await ext.activate();checks.activation=ext.isActive;checks.shortcut=ext.packageJSON.contributes.keybindings[0].key;
  await vscode.commands.executeCommand('shiftShift.open');await delay(500);checks.workerCount=workers().length;
  // VS Code's native command accepts the selected picker item, exercising navigation.
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');await delay(300);checks.openedFile=vscode.window.activeTextEditor?.document.uri.fsPath;
  await vscode.commands.executeCommand('shiftShift.reindex');await delay(300);checks.workerCountAfterReindex=workers().length;
  await vscode.commands.executeCommand('shiftShift.status');await delay(100);
  if(!checks.activation||checks.shortcut!=='shift shift'||checks.workerCount!==1||checks.workerCountAfterReindex!==1||!checks.openedFile?.endsWith('/sample.py'))throw new Error('Smoke assertions failed');
  await writeFile(output,JSON.stringify({ok:true,checks,vscode:vscode.version},null,2));
 }catch(e){await writeFile(output,JSON.stringify({ok:false,error:String(e),checks},null,2));}
 await vscode.commands.executeCommand('workbench.action.closeWindow');
}
