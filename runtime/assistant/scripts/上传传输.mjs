// Serial transfer with per-file timing; unknown writes are reconciled, never replayed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

export function transferFile({record_id,file,read,upload,verify,record=()=>{},now=Date.now}){
 const started=now();
 const event=(phase,status,at,extra={})=>record({record_id,name:path.basename(file.file),bytes:file.size,phase,status,elapsed_ms:Math.max(0,now()-at),...extra});
 const phase=(name,operation)=>{const at=now();try{const result=operation();event(name,'ok',at);return result;}catch(e){event(name,name==='upload'?'outcome_unknown':'failed',at);throw e;}};
 const validate=a=>{if(!a?.file_token||a.name!==path.basename(file.file)||a.size!==file.size)throw Error('线上附件名称、大小或token不一致，停止避免重复上传');return a;};
 const reuse=(attachment,status)=>{validate(attachment);const proof=phase('verify_download',()=>verify(attachment));if(proof?.sha256!==file.expected_sha256)throw Error('线上附件哈希不符，保留原附件并停止');const result={status,file_token:attachment.file_token,sha256:proof.sha256,verification:'download_sha256',elapsed_ms:Math.max(0,now()-started)};event('file',status,started);return result;};
 try{
  const existing=phase('read_target',read);if(existing)return reuse(existing,'reused');
  try{phase('upload',upload);}catch{
   // The server may have committed before the CLI lost its response.
   const actual=phase('reconcile_target',read);
   if(actual)return reuse(actual,'recovered');
   throw Error('上传结果未确认且线上未找到附件；本轮停止，重新读取后再继续，禁止直接重传');
  }
  // A final full readback belongs to the caller; do not add a full-table read here.
  const result={status:'uploaded',sha256:file.expected_sha256,verification:'awaiting_final_readback',elapsed_ms:Math.max(0,now()-started)};
  event('file','uploaded',started);return result;
 }catch(e){event('file','pending',started);throw e;}
}

export function downloadVerified({attachment,expected_sha256,directory,cli='lark-cli',execute=execFileSync}){
 if(!attachment?.file_token||!/^[a-f\d]{64}$/i.test(expected_sha256??''))throw Error('下载验收缺附件token或SHA256');
 fs.mkdirSync(directory,{recursive:true});const temporary=path.join(directory,crypto.randomUUID()+'.download'),started=Date.now();
 try{
  const raw=execute(cli,['api','GET','/open-apis/drive/v1/medias/batch_get_tmp_download_url','--params',JSON.stringify({file_tokens:[attachment.file_token]}),'--as','user'],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  const response=JSON.parse(raw),url=response.ok===true?response.data?.tmp_download_urls?.[0]?.tmp_download_url:null;
  if(!url||new URL(url).protocol!=='https:')throw Error('authorization failed');
  execute('curl.exe',['--silent','--show-error','--fail','--location','--connect-timeout','10','--max-time','45','--output',temporary,url],{windowsHide:true,timeout:50000,stdio:['ignore','pipe','pipe']});
  const bytes=fs.readFileSync(temporary),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(sha256!==expected_sha256.toLowerCase())throw Error('digest mismatch');
  return {sha256,bytes:bytes.length,elapsed_ms:Date.now()-started};
 }catch{throw Error('授权下载或SHA256校验失败；保留线上附件并停止，不记录临时下载地址');}
 finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
