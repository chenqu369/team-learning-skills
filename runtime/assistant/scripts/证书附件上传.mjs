// Upload only completed formal files to their unchanged current final-roster rows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {columns} from './证书制作表.mjs';
import {assertWorkflowAudit} from '../../shared/workflow-audit.mjs';
import {transferFile,downloadVerified} from './上传传输.mjs';
const scalar=v=>Array.isArray(v)?v.length===1?scalar(v[0]):'':v==null?'':String(v);
const key=p=>JSON.stringify([p.所学课程,p.稳定人员标识,p.角色]);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const signature=value=>JSON.stringify(canonical(value));
export function cliFile(file,cwd=process.cwd()){
 const rel=path.relative(cwd,path.resolve(file));
 if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('上传文件必须在当前项目内');
 return './'+rel.replaceAll('\\','/');
}
export function planUploads(people,manifest,current,config,{resume=false}={}){
 if(manifest.status!=='complete'||manifest.test_mode!==false)throw Error('只接受已完成的正式制证manifest');
 if(!config.final_roster_source?.table_id||!config.attachment_fields?.certificate)throw Error('缺终版目标或证书附件字段配置');
 if(!Array.isArray(people)||!people.length||!Array.isArray(manifest.certificates)||manifest.certificates.length!==people.length)throw Error('本批全部人员与manifest证书范围未一一对应，存在缺项或范围外证书');
 if(new Set(people.map(key)).size!==people.length||people.some(p=>!p.最终名单记录ID||!p.稳定人员标识)||new Set(people.map(p=>p.最终名单记录ID)).size!==people.length)throw Error('本批终版来源ID或证书身份重复/缺失，无法唯一对应');
 const result=[],seen=new Set();
 for(const cert of manifest.certificates??[]){
  const candidates=people.filter(p=>key(p)===JSON.stringify([cert.course,cert.stable_id,cert.role]));
  if(candidates.length!==1)throw Error('证书没有唯一终版输入对应');
  const p=candidates[0],rows=current.filter(r=>r.record_id===p.最终名单记录ID);
  if(rows.length!==1)throw Error('当前终版行不唯一或不存在');
  const row=rows[0];
  for(const f of columns)if(f!=='证书编号'&&(f==='证书昵称'?(scalar(row[f])||scalar(row.微信昵称)):scalar(row[f]))!==scalar(p[f]))throw Error('终版已变化：'+row.record_id+' '+f);
  if(cert.name!==p.证书昵称||cert.date!==p.结营日期||cert.group!==p.群号||!cert.number||(scalar(row.证书编号)&&scalar(row.证书编号)!==cert.number)||(p.证书编号&&p.证书编号!==cert.number))throw Error('证书内容或编号与终版不符');
  if(seen.has(key(p)))throw Error('重复证书');seen.add(key(p));
  if(typeof cert.sha256!=='string'||!/^[a-f\d]{64}$/i.test(cert.sha256))throw Error('正式manifest缺有效证书SHA256哈希：'+row.record_id);
  const files=[{field_id:config.attachment_fields.certificate,field_name:config.attachment_fields.certificate_name??'证书附件',file:cert.path,expected_sha256:cert.sha256.toLowerCase()}];
  for(const f of files){const existing=row[f.field_name]??[];if(!Array.isArray(existing))throw Error('附件字段不是数组');if(existing.length){if(!resume)throw Error('已有附件，先核对上传回执，禁止重复追加：'+row.record_id);if(existing.length!==1||!existing[0].file_token||existing[0].name!==path.basename(f.file))throw Error('已有附件冲突，保留并停止：'+row.record_id);}}
  result.push({record_id:row.record_id,number:cert.number,files});
 }
 if(!result.length)throw Error('无正式证书可上传');
 if(seen.size!==people.length)throw Error('manifest缺少本批人员证书，不能以部分上传验收全部范围');
 return result;
}
export function verifySourceSnapshot(before,after,plan){
 if(!Array.isArray(before)||!Array.isArray(after))throw Error('源表全集不是数组');
 const original=new Map(before.map(row=>[row.record_id,row])),current=new Map(after.map(row=>[row.record_id,row]));
 if(original.size!==before.length||current.size!==after.length||before.some(row=>!row.record_id)||after.some(row=>!row.record_id)||original.size!==current.size||[...original.keys()].some(id=>!current.has(id)))throw Error('源表ID全集变化：新增、移除或重复记录，先重新全量对账');
 const allowed=new Map(plan.map(item=>[item.record_id,item.files]));
 for(const [id,old]of original){
  const row=current.get(id),files=allowed.get(id)??[],fields=new Set(files.map(f=>f.field_name));
  const immutable=value=>Object.fromEntries(Object.entries(value).filter(([field])=>!fields.has(field)));
  if(signature(immutable(old))!==signature(immutable(row)))throw Error('源表非允许修改字段发生变化：'+id);
  for(const field of fields){
   const previous=old[field]??[],actual=row[field]??[];
   if(!Array.isArray(previous)||!Array.isArray(actual)||actual.length<previous.length||signature(actual.slice(0,previous.length))!==signature(previous))throw Error('源表原有附件被修改或移除：'+id);
   const extra=actual.slice(previous.length),expected=files.filter(f=>f.field_name===field),names=new Set();
   if(extra.length>expected.length)throw Error('源表出现非本批或重复追加的附件：'+id);
   for(const attachment of extra){
    const name=attachment?.name,match=expected.find(file=>path.basename(file.file)===name);
    if(!match||!attachment.file_token||names.has(name)||(match.size!==undefined&&attachment.size!==match.size))throw Error('源表追加附件与本批成品不一致：'+id);
    names.add(name);
   }
  }
 }
 return true;
}
export function verifyManifestFile(file){
 if(typeof file.expected_sha256!=='string'||!/^[a-f\d]{64}$/i.test(file.expected_sha256))throw Error('缺正式manifest文件SHA256哈希');
 const data=fs.readFileSync(file.file),digest=crypto.createHash('sha256').update(data).digest('hex');
 if(digest!==file.expected_sha256.toLowerCase())throw Error('实际证书文件与正式manifest哈希不符');
 return {sha256:digest,size:data.length};
}
export function verifyAuditedSource(audit,source,current,revision,{required=false}={}){
 const snapshots=(audit?.source_snapshots??[]).filter(item=>item.kind==='base'&&item.base_token===source.base_token&&item.table_id===source.table_id);
 if(!snapshots.length){if(required)throw Error('实际上传缺对应Base/table的已审计全量来源，文件依赖不能代替现场来源');return false;}
 for(const snapshot of snapshots){
  if(snapshot.rev!==revision)throw Error('审计后源表版本rev变化，重新完整读取并对账');
  const data=fs.readFileSync(snapshot.path),digest=crypto.createHash('sha256').update(data).digest('hex');
  if(digest!==snapshot.sha256)throw Error('已审计源表文件发生变化，须重新核对');
  const text=data.toString('utf8').replace(/^\uFEFF/,''),rows=snapshot.path.endsWith('.ndjson')?text.split(/\r?\n/).filter(Boolean).map(JSON.parse):JSON.parse(text);
  verifySourceSnapshot(rows,current,[]);
 }
 return true;
}
export function main(configFile,peopleFile,manifestFile,out,apply=false,auditFile){
 const audit=apply||auditFile?assertWorkflowAudit(auditFile,'certificates',[configFile,peopleFile,manifestFile],[peopleFile]):null;
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),people=JSON.parse(fs.readFileSync(peopleFile,'utf8')),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 const source=config.final_roster_source,cli=config.lark_cli??'lark-cli',common=['--base-token',source.base_token,'--table-id',source.table_id,'--as','user'];
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('输出目录非空，使用新目录');fs.mkdirSync(out,{recursive:true});
 const save=(file,data)=>fs.writeFileSync(path.join(out,file),JSON.stringify(data,null,2)+'\n');
 const started=Date.now(),timings=[],results=[];
 const record=event=>{timings.push(event);fs.appendFileSync(path.join(out,'传输耗时.ndjson'),JSON.stringify({...event,at:new Date().toISOString()})+'\n');};
 const summary=(verified=false)=>save('传输汇总.json',{verified,elapsed_ms:Date.now()-started,uploaded:results.filter(x=>x.status==='uploaded').length,reused:results.filter(x=>x.status==='reused').length,recovered:results.filter(x=>x.status==='recovered').length,cli_calls:timings.filter(x=>x.phase==='cli').length,pending:timings.some(x=>x.status==='pending'),results});
 const call=args=>{const at=Date.now();try{const r=JSON.parse(execFileSync(cli,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024}));if(r.ok===false)throw Error('飞书CLI返回失败');record({phase:'cli',operation:args[1],status:'ok',elapsed_ms:Date.now()-at});return r;}catch(e){record({phase:'cli',operation:args[1],status:'failed',elapsed_ms:Date.now()-at});throw e;}};
 let readCount=0,sourceBaseline=null,sourcePlan=[],lastReadRevision;
 const read=()=>{const rows=[];let offset=0,rev;for(;;){const file=path.resolve(out,`读回-${++readCount}.ndjson`),rel=path.relative(process.cwd(),file);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('输出目录必须在当前项目内');const m=call(['base','+record-list',...common,'--format','ndjson','--output','./'+rel.replaceAll('\\','/'),'--offset',String(offset)]);const part=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);if(m.base_token!==source.base_token||m.table_id!==source.table_id||m.rev==null||m.query_context?.record_scope!=='all_records'||m.records_count!==part.length||typeof m.has_more!=='boolean'||(rev!==undefined&&rev!==m.rev))throw Error('全量分页验收失败');rev=m.rev;rows.push(...part);if(!m.has_more){lastReadRevision=rev;if(sourceBaseline)verifySourceSnapshot(sourceBaseline,rows,sourcePlan);return rows;}if(!Number.isInteger(m.next_offset)||m.next_offset<=offset)throw Error('分页未前进');offset=m.next_offset;}};
 const initial=read();verifyAuditedSource(audit,source,initial,lastReadRevision,{required:apply});
 const plan=planUploads(people,manifest,initial,config,{resume:true}),ledger=JSON.parse(fs.readFileSync(config.certificate_ledger_path,'utf8'));
 sourceBaseline=structuredClone(initial);sourcePlan=plan;
 save('源表不变量基准.json',{base_token:source.base_token,table_id:source.table_id,rev:lastReadRevision,rows:sourceBaseline});
 if(ledger.test_mode!==false)throw Error('不是正式编号账本');
 const root=path.dirname(path.resolve(manifestFile));
 for(const item of plan){const p=people.find(p=>p.最终名单记录ID===item.record_id);const ledgerKey=JSON.stringify([p.所学课程,p.营期编号,p.角色,p.稳定人员标识]);if(ledger.entries?.[ledgerKey]?.number!==item.number)throw Error('编号与正式账本不一致');for(const file of item.files){file.file=path.resolve(file.file);const rel=path.relative(root,file.file);if(rel.startsWith('..')||path.isAbsolute(rel)||!fs.statSync(file.file).isFile())throw Error('文件不在manifest交付目录');Object.assign(file,verifyManifestFile(file));}}
 save('上传计划.json',plan);if(!apply){console.log(JSON.stringify({ok:true,phase:'preview',rows:plan.length,files:plan.flatMap(p=>p.files).length}));return;}
 const receipts=[];
 try{
 for(const item of plan){
  // Refresh the target before each row; previous rows have changed only their attachments.
  const p=people.find(p=>p.最终名单记录ID===item.record_id),cert=manifest.certificates.find(c=>key(p)===JSON.stringify([c.course,c.stable_id,c.role]));
  const local={...manifest,certificates:[cert]};
  for(const file of item.files){
   const result=transferFile({record_id:item.record_id,file,record,
    read:()=>{const rows=read();planUploads([p],local,rows,config,{resume:true});return rows.find(row=>row.record_id===item.record_id)[file.field_name]?.[0]??null;},
    verify:attachment=>downloadVerified({attachment,expected_sha256:file.expected_sha256,directory:path.join(out,'下载临时文件'),cli}),
    upload:()=>{if(crypto.createHash('sha256').update(fs.readFileSync(file.file)).digest('hex')!==file.sha256)throw Error('上传前文件发生变化');const response=call(['base','+record-upload-attachment',...common,'--record-id',item.record_id,'--field-id',file.field_id,'--file',cliFile(file.file)]);receipts.push({record_id:item.record_id,field:file.field_name,file:file.file,sha256:file.sha256,response});save('上传回执.json',receipts);}});
   results.push({record_id:item.record_id,name:path.basename(file.file),...result});summary();
  }
 }
 const after=read();for(const item of plan){const row=after.find(r=>r.record_id===item.record_id);for(const f of item.files){const attachment=(row?.[f.field_name]??[]).find(a=>a.file_token&&a.name===path.basename(f.file)&&a.size===f.size);if(!attachment)throw Error('附件回读不符');const result=results.find(r=>r.record_id===item.record_id&&r.name===path.basename(f.file));if(result?.status==='uploaded'){result.file_token=attachment.file_token;result.verification='upload_ack_and_final_readback';}}}
 const verification={ok:true,rows:plan.length,files:results.length,uploaded:receipts.length,reused:results.filter(x=>x.status==='reused').length,recovered:results.filter(x=>x.status==='recovered').length,full_readback:true,source_inventory_unchanged:true,source_records:sourceBaseline.length,distribution_changed:false,workflow_audit:audit};save('上传验收.json',verification);summary(true);console.log(JSON.stringify(verification));
 }catch(e){record({phase:'batch',status:'pending',elapsed_ms:Date.now()-started});summary(false);throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2),index=args.indexOf('--audit');
 if(index>=0&&!args[index+1])throw Error('--audit缺核对输入文件');
 main(...args.slice(0,4),args.includes('--apply'),index>=0?args[index+1]:undefined);
}
