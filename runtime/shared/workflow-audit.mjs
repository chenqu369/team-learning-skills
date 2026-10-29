// Shared local coverage/freshness gate. It never fetches data or mutates a platform.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const stages={
 recruitment:['courses','drafts','publication','progress','export','roster'],
 evaluation:['roster','decisions','tasks','certificates','coins','readback'],
 checkin:['courses','forms','records','identity','graduation','awards','readback'],
 certificates:['final-roster','parameters','production','upload','receipt','readback'],
};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const at=(obj,key)=>!key?obj:key.split('.').reduce((v,k)=>v?.[k],obj);
function readRows(file,field){
 const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
 const value=file.endsWith('.ndjson')?text.split(/\r?\n/).filter(x=>x.trim()).map(JSON.parse):JSON.parse(text);
 const rows=at(value,field);if(!Array.isArray(rows))throw Error('对象范围必须是数组：'+file+(field?'#'+field:''));return rows;
}
function keys(row,fields){
 if(!Array.isArray(fields)||!fields.length)throw Error('缺 key_fields，不能只按数量核对');
 let result=[[]];
 for(const field of fields){
  const value=at(row,field),values=Array.isArray(value)?value:[value];
  if(!values.length||values.some(v=>v==null||typeof v==='object'||String(v).trim()===''))throw Error('对象缺稳定键：'+field);
  result=result.flatMap(prefix=>values.map(v=>[...prefix,String(v)]));
 }
 return result.map(v=>JSON.stringify(v));
}
export function auditWorkflow(spec,root='.'){
 const errors=[],changed=[],invalid=new Set(),files=new Set(),auditedInputs=new Set(),coveredInputs=new Set(),sourceSnapshots=[],missing=[],unknown=[],duplicates=[];
 const order=stages[spec.workflow];
 const fail=message=>errors.push(message);
 const invalidate=stage=>{const index=order?.indexOf(stage)??-1;for(const s of (order??[]).slice(index<0?0:index))invalid.add(s);};
 const resolve=file=>path.resolve(root,file);
 const track=file=>{const p=resolve(file);files.add(p);return p;};
 if(!order)fail('未知workflow流程');
 if(!['preflight','complete'].includes(spec.phase))fail('phase须为preflight或complete');
 const started=Date.parse(spec.run_started_at);if(!Number.isFinite(started))fail('缺本轮run_started_at；续跑须重新读取线上状态');
 const maxAge=spec.max_snapshot_age_seconds??900;
 if(!Number.isFinite(maxAge)||maxAge<=0)fail('max_snapshot_age_seconds须为正数');
 if(!Array.isArray(spec.sources)||!spec.sources.length)fail('缺独立来源sources，不能用计划自身证明覆盖完整');
 const ids=new Set(),currentFiles=new Set();
 for(const source of spec.sources??[]){
  try{
   if(!source.id||ids.has(source.id))throw Error('来源id缺失或重复');ids.add(source.id);
   if(!['base','platform','manual','file'].includes(source.kind))throw Error('来源kind须为base/platform/manual/file');
   const used=source.used,current=source.current;
   if(!used?.sha256||!used.path||!current?.path)throw Error('缺使用时文件及固定sha256或当前来源');
   const usedFile=track(used.path),currentFile=track(current.path);currentFiles.add(currentFile);
   auditedInputs.add(usedFile);auditedInputs.add(currentFile);
   if(sha(usedFile)!==used.sha256)throw Error('使用时快照已修改，不能刷新旧指纹掩盖变更');
   let different=sha(currentFile)!==used.sha256,baseMetadata={};
   if(source.kind!=='file'){
    const captured=Date.parse(current.captured_at);
    if(!Number.isFinite(captured)||captured<started)throw Error('当前读取/人工确认早于本轮开始，须刷新来源');
    if(captured>Date.now()+60000||Date.now()-captured>maxAge*1000)throw Error('当前快照时间无效或已过本批新鲜度窗口，须重新读取');
   }
   if(source.kind==='base'){
    const validate=descriptor=>{
     if(!descriptor.manifest)throw Error('Base来源缺导出manifest');
     const m=json(track(descriptor.manifest)),rows=readRows(resolve(descriptor.path));
     if(!m.base_token||!m.table_id||m.rev==null||m.has_more!==false||m.query_context?.record_scope!=='all_records'||m.records_count!==rows.length)throw Error('Base来源非完整全表导出或数量不一致');
     return m;
    };
    const a=validate(used),b=validate(current);
    baseMetadata={base_token:b.base_token,table_id:b.table_id,rev:b.rev};
    if(a.base_token!==b.base_token||a.table_id!==b.table_id)throw Error('来源Base/table身份不同');
    different ||= a.rev!==b.rev;
   }
   sourceSnapshots.push({id:source.id,kind:source.kind,path:currentFile,sha256:sha(currentFile),...baseMetadata});
   if(different){changed.push(source.id);fail(source.id+'输入/规则/范围变化：从受影响步骤重算并全量对账');invalidate(source.stage);}
  }catch(error){fail((source.id??'source')+'：'+error.message);invalidate(source.stage);}
 }
 const expected=new Set(),assigned=new Map();
 try{
  const descriptor=spec.coverage?.expected;
  if(!descriptor?.path||!currentFiles.has(resolve(descriptor.path)))throw Error('coverage.expected须直接引用当前来源文件，不能引用筛选后的旧计划');
  for(const row of readRows(track(descriptor.path),descriptor.array_path))for(const key of keys(row,descriptor.key_fields)){
   if(expected.has(key))throw Error('来源稳定键重复，先确认身份：'+key);expected.add(key);
  }
  if(!Array.isArray(spec.coverage.actual))throw Error('缺coverage.actual对象去向');
  for(const part of spec.coverage.actual){
   if(!['planned','completed','reused','excluded','pending'].includes(part.status))throw Error('未知去向status');
   const rows=readRows(track(part.path),part.array_path);
   if(['planned','completed','reused'].includes(part.status)){auditedInputs.add(resolve(part.path));coveredInputs.add(resolve(part.path));}
   if(!rows.length)continue;
   if(part.status==='excluded'&&!part.reason)fail('明确排除项须有负责人依据reason');
   if(part.status==='pending')fail('仍有待确认对象，不能宣告范围全部完成');
   if(spec.phase==='complete'&&part.status==='planned')fail('仍为计划，不能宣告完成');
   if(['completed','reused'].includes(part.status)){
    if(!part.evidence_file)fail('已完成/复用项缺实际验收回执evidence_file');
    else if(!fs.statSync(track(part.evidence_file)).isFile())fail('验收回执不是文件');
   }
   for(const row of rows)for(const key of keys(row,part.key_fields)){
    if(assigned.has(key))duplicates.push(key);else assigned.set(key,part.status);
   }
  }
  for(const key of expected)if(!assigned.has(key))missing.push(key);
  for(const key of assigned.keys())if(!expected.has(key))unknown.push(key);
  if(missing.length)fail('存在未归类对象：'+missing.length);
  if(unknown.length)fail('计划含范围外对象：'+unknown.length);
  if(duplicates.length)fail('同一对象多种/重复去向：'+duplicates.length);
 }catch(error){fail(error.message);}
 if(errors.length&&!invalid.size)invalidate(order?.[0]);
 return {schema_version:1,workflow:spec.workflow,phase:spec.phase,checked_at:new Date().toISOString(),ready:errors.length===0,
  completion_verified:spec.phase==='complete'&&errors.length===0,expected_count:expected.size,classified_count:assigned.size,
  missing,unknown,duplicates,changed_sources:changed,invalidated_stages:[...invalid],errors,
  reminder:errors.length?'先刷新受影响输入并运行完整检查；仅执行确认缺项，保留已完成结果。':'本轮范围覆盖检查通过；具体字段、下载和角色验收仍按模块规则执行。',
  audited_input_files:[...auditedInputs],covered_input_files:[...coveredInputs],
  source_snapshots:sourceSnapshots,
  evidence_files:[...files].map(file=>({path:file,sha256:fs.existsSync(file)&&fs.statSync(file).isFile()?sha(file):null}))};
}
export function assertWorkflowAudit(file,workflow,boundFiles=[],coverageFiles=[]){
 if(!file)throw Error('缺 --audit 全流程核对输入.json；先读取当前来源并核对范围');
 const spec=json(path.resolve(file));if(spec.workflow!==workflow)throw Error('核对workflow与执行流程不一致');
 const report=auditWorkflow(spec,path.dirname(path.resolve(file)));
 if(!report.ready)throw Error('全流程核对未通过：'+report.errors.join('；'));
 for(const bound of boundFiles)if(!report.audited_input_files.includes(path.resolve(bound)))throw Error('执行输入文件未纳入本轮核对：'+bound);
 for(const bound of coverageFiles)if(!report.covered_input_files.includes(path.resolve(bound)))throw Error('执行人员范围文件未纳入对象覆盖：'+bound);
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [action,input,out,...rest]=process.argv.slice(2);
 if(!['check','assert'].includes(action)||!input||(action==='check'&&rest.length))throw Error('workflow-audit.mjs check <核对输入.json> <新报告.json> | assert <核对输入.json> <workflow> [执行输入文件...]');
 if(action==='assert'){
  const bound=[],coverage=[];
  for(let i=0;i<rest.length;i++){if(rest[i]==='--coverage'){if(!rest[i+1])throw Error('--coverage缺文件');coverage.push(rest[++i]);}else bound.push(rest[i]);}
  const result=assertWorkflowAudit(input,out,bound,coverage);console.log(JSON.stringify(result));
 }else{
 const spec=json(path.resolve(input)),result=auditWorkflow(spec,path.dirname(path.resolve(input)));
 if(action==='check'){
  if(!out||fs.existsSync(out))throw Error('报告须使用新文件名');
  fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 }
 console.log(JSON.stringify(result));if(!result.ready)process.exitCode=2;
 }
}
