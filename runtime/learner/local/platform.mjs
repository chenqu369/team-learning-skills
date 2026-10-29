import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {equal} from './engine.mjs';
export const load=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
export function atomicSave(file,value){const temp=file+'.'+randomUUID()+'.tmp';save(temp,value);try{fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
export function acquireLock(file){
 fs.mkdirSync(path.dirname(file),{recursive:true});const token=randomUUID();
 function create(){const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,started_at:new Date().toISOString()}));fs.closeSync(fd);}
 try{create();}catch(e){
  if(e.code!=='EEXIST')throw e;
  const old=load(file);let alive=true;try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
  if(alive)throw Error('已有本地同步正在运行，请等待结束');
  fs.renameSync(file,file+'.abandoned-'+randomUUID()+'.json');create();
 }
 return ()=>{if(fs.existsSync(file)&&load(file).token===token)fs.unlinkSync(file);};
}
export function makeCaller(root,cli='lark-cli.exe',execute=spawnSync){
 return args=>{
  const readOnly=['+record-list','+field-list'].includes(args[1]);
  for(let attempt=0;;attempt++){
  const r=execute(cli,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,timeout:120000});
  if(r.error&&readOnly&&['ETIMEDOUT','ECONNRESET'].includes(r.error.code)&&attempt<2)continue;
  if(r.error)throw Error('飞书CLI调用失败：'+r.error.message);
  let out;try{out=JSON.parse(r.status===0?r.stdout:r.stderr);}catch{throw Error('飞书CLI未返回有效JSON；请检查登录状态和网络。'+(r.stderr||r.stdout).slice(0,500));}
  if(readOnly&&out.error?.type==='network'&&attempt<2)continue;
  if(r.status!==0||!(out.ok===true||out.manifest_version))throw Error(JSON.stringify(out.error??out));
  return out;
  }
 };
}
export function readTable({call,root,base,table,directory,label}){
 const rows=[],pages=[];let offset=0,rev,query;
 for(let i=0;;i++){
  const file=path.join(directory,`${label}-page-${i}.ndjson`),relative='./'+path.relative(root,file).replaceAll('\\','/');
  const response=call(['base','+record-list','--base-token',base,'--table-id',table,'--offset',String(offset),'--limit','2000','--format','ndjson','--output',relative,'--as','user']);
  const m=response.manifest_version?response:response.data;
  if(!m||m.base_token!==base||m.table_id!==table||m.query_context?.record_scope!=='all_records')throw Error('读取的Base/表或全量范围不符');
  const batch=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(s=>s.trim()).map(JSON.parse);
  if(batch.length!==m.records_count)throw Error('导出行数与manifest不符');
  if(i&&(m.rev!==rev||!equal(m.query_context,query)))throw Error('分页期间来源版本或范围变化，停止；重新运行获取完整快照');
  rev=m.rev;query=m.query_context;pages.push(m);rows.push(...batch);
  if(m.has_more===false)break;
  if(m.has_more!==true||!Number.isInteger(m.next_offset)||m.next_offset<=offset)throw Error('分页缺少有效next_offset');
  offset=m.next_offset;
 }
 if(rows.some(r=>!r.record_id)||new Set(rows.map(r=>r.record_id)).size!==rows.length)throw Error('分页记录ID缺失或重复，不能全量核验');
 const file=path.join(directory,label+'.ndjson');fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''));
 const manifest={...pages[0],records_count:rows.length,page_count:pages.length,has_more:false,record_file:file,query_context:query};delete manifest.next_offset;
 save(path.join(directory,label+'.manifest.json'),manifest);
 return {rows,manifest,file,captured_at:new Date().toISOString()};
}
