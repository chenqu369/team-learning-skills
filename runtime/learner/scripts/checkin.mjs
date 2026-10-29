import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyseIdentity,normaliseRule,missingSubmissionFormula,CONTRACT_VERSION} from './learning-record-contract.mjs';
export {normaliseRule} from './learning-record-contract.mjs';
export const submissionFields=['队名','群号','学习心得','课程评价','请填写你对本次课程内容的反馈','笔记链接','证书昵称'];
export const scalar=v=>Array.isArray(v)?v.length===1?scalar(v[0]):'':v==null?'':String(v);
export const taskId=v=>{const m=scalar(v).trim().match(/^task\s*(\d+)$/i);return m?`task${Number(m[1])}`:'';};
const submitter=r=>{const v=r['提交人'];const p=Array.isArray(v)&&v.length===1?v[0]:v;return p&&typeof p==='object'&&typeof (p.open_id||p.id)==='string'?(p.open_id||p.id):'';};
export const keyOf=r=>JSON.stringify([scalar(r['所学课程']),scalar(r['微信昵称'])||`提交人:${submitter(r)}`]);
const order=(a,b)=>Date.parse(a['提交时间'])-Date.parse(b['提交时间'])||Number(scalar(a['自动编号']).slice(3))-Number(scalar(b['自动编号']).slice(3))||a.record_id.localeCompare(b.record_id);
export function requiredTasks(rule){return normaliseRule(rule).tasks;}
export function analyse(rows,options={}){
 const result=analyseIdentity(rows,options.rules??[],options);
 const latest_records=result.latest.map(r=>({...r,task_id:r.task_id}));
 const anomalies=result.pending.map(p=>({record_id:p.record_id,course:p.course,reasons:p.reasons}));
 const updates={};let mergeGroups=0,duplicateRecords=0;
 const valid=rows.filter(r=>result.recordStates[r.record_id]?.valid);
 for(const learner of result.learners.filter(l=>!l.has_pending)){
  const list=valid.filter(r=>learner.record_ids.includes(r.record_id)),byTask=new Map();
  for(const r of list){const t=taskId(r.任务名称);if(!byTask.has(t))byTask.set(t,[]);byTask.get(t).push(r);}
  for(const [task,records] of byTask){
   if(records.length<2)continue;mergeGroups++;duplicateRecords+=records.length-1;
   const master=[...records].sort((a,b)=>Number(scalar(a.自动编号).slice(3))-Number(scalar(b.自动编号).slice(3))||a.record_id.localeCompare(b.record_id))[0];
   const latest=[...records].sort(order).at(-1),diff={};
   for(const field of submissionFields)if(JSON.stringify(master[field]??null)!==JSON.stringify(latest[field]??null))diff[field]=latest[field]??null;
   if(Object.keys(diff).length)updates[master.record_id]=diff;
   const assessed=records.filter(r=>r.笔记评分!=null||r.笔记评审人||r.备注);
   if(assessed.length)anomalies.push({record_ids:assessed.map(r=>r.record_id),course:learner.course,task,reasons:['重复记录已有助教评审；保留评审，内容更新后需复核']});
  }
 }
 result.registry.legacy_identities??={};
 const learners=result.learners.filter(l=>!l.has_pending&&l.task_ids.length).map(l=>{
  const list=valid.filter(r=>l.record_ids.includes(r.record_id)),last=[...list].sort(order).at(-1);
  const name=scalar(last.证书昵称)||scalar(last.微信昵称);
  const compatibilityKey=JSON.stringify([options.base_token??'',options.table_id??'',l.period,l.course,l.identity]);
  const legacy_identities=[...new Set([...(result.registry.legacy_identities[compatibilityKey]??[]),...list.map(keyOf)])];
  result.registry.legacy_identities[compatibilityKey]=legacy_identities;
  return {...l,微信昵称:scalar(last.微信昵称),证书昵称:name,所学课程:l.course,群号:l.group,打卡次数:l.task_ids.length,latest_record_id:last.record_id,name_bad:!name.trim()||/^(?:[-/\\.0-9]+|null|none|无|暂无|微信昵称|证书昵称)$/i.test(name)||name.length>40,legacy_identities};
 });
 latest_records.sort((a,b)=>a.identity.localeCompare(b.identity)||Number(a.task_id.slice(4))-Number(b.task_id.slice(4)));
 return {contract_version:CONTRACT_VERSION,registry:result.registry,recordStates:result.recordStates,latest_records,summary:{effective_records:latest_records.length,records:rows.length,learners:learners.length,merge_groups:mergeGroups,duplicate_records:duplicateRecords,primary_content_updates:Object.keys(updates).length,blocked_records:result.pending.length,anomaly_items:anomalies.length},updates,anomalies,learners};
}
export function analysePersisted(rows,options){
 if(!options.period||!options.base_token||!options.table_id)throw Error('持久身份登记缺营期、Base或来源表');
 const file=resolve(options.identity_registry_path??('workflow/state/learner-identities-'+options.period+'.json'));
 const analysis=analyse(rows,{...options,registry:existsSync(file)?JSON.parse(readFileSync(file,'utf8')):options.registry});
 mkdirSync(dirname(file),{recursive:true});const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(analysis.registry,null,2));renameSync(temporary,file);
 return {...analysis,identity_registry_path:file};
}
export function formulas(table='打卡记录'){
  return [{name:'打卡次数',type:'formula',expression:`[${table}].FILTER(CurrentValue.[系统学习者标识]=[系统学习者标识]&&CurrentValue.[所学课程]=[所学课程]&&CurrentValue.[进度最新有效]=1).[进度Task编号].UNIQUE().COUNTA()`,description:'同课程同固定学习者编号的最新有效不同Task数量；次数不代替结营任务覆盖。'}];
}
export function mergeWorkflow(){
  throw Error('旧内容归并工作流入口已停用。原打卡保留，按进度最新有效统计；使用已验证的身份登记与待核对工作流，不覆盖首次打卡内容。');
}
export function readRows(files){return files.flatMap(file=>readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [mode,out,...files]=process.argv.slice(2);let result;
  if(mode==='analyse'){
   if(files[0]==='--config'){const options=JSON.parse(readFileSync(files[1],'utf8'));result=analysePersisted(readRows(files.slice(2)),options);}
   else result={...analyse(readRows(files)),identity_registry_persisted:false};
  }
  else if(mode==='formulas')result=formulas();
  else if(mode==='workflow')result=mergeWorkflow(JSON.parse(readFileSync(files[0],'utf8')).data.fields);
  else throw Error('Usage: checkin.mjs analyse|formulas|workflow output.json input...');
  mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result.summary||{file:out}));
}
