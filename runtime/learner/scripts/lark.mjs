import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
export const cli=process.env.LARK_CLI_PATH||process.env.LARK_CLI||'lark-cli';
export function call(args){
 const p=spawnSync(cli,args,{encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
 if(p.error)throw p.error;
 let result;try{result=JSON.parse(p.status===0?p.stdout:p.stderr);}catch{throw Error(p.stderr||p.stdout);}
 if(p.status!==0||(result.ok!==true&&!(args.includes('+record-list')&&result.manifest_version)))throw Error(JSON.stringify(result.error||result));
 return result;
}
export function save(path,value){mkdirSync(dirname(resolve(path)),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2),'utf8');}
export const load=path=>JSON.parse(readFileSync(path,'utf8'));
