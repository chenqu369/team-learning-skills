import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {planSync,equal,hash,protectedFields} from './engine.mjs';
import {load,save,atomicSave,acquireLock,makeCaller,readTable} from './platform.mjs';
import {auditWorkflow} from '../../shared/workflow-audit.mjs';

export function run({config_file,apply=false,caller}={}){
 const configPath=path.resolve(config_file),config=load(configPath),root=path.resolve(path.dirname(configPath),config.workspace_root);
 const resolve=p=>path.resolve(root,p),read=p=>load(resolve(p));
 if(Number(process.versions.node.split('.')[0])<20)throw Error('需要Node.js >=20');
 const run_started_at=new Date().toISOString(),runId=run_started_at.replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,6);
 const directory=resolve(config.output_directory+'/'+runId),state=resolve(config.state_directory);
 fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(state,{recursive:true});
 const release=acquireLock(path.join(state,'run.lock')),call=caller??makeCaller(root,config.cli??'lark-cli.exe');
 const log=(event,data={})=>{fs.appendFileSync(path.join(directory,'events.ndjson'),JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');console.log(JSON.stringify({event,...data}));};
 let writesStarted=false;
 try{
  log('读取本期规则与线上全量记录',{mode:apply?'sync':'preview',directory});
  const info=read(config.course_info),confirmation=read(config.confirmations),registryFile=resolve(config.identity_registry);
  const identities=fs.existsSync(registryFile)?load(registryFile):undefined;
  const courseCodes=read(config.course_codes),aliases=read(config.course_aliases).aliases;
  if(new Set(Object.values(courseCodes)).size!==Object.keys(courseCodes).length)throw Error('课程编号登记重复');
  for(const c of info.courses)if(!c.course_code||courseCodes[aliases[c.checkin_name]??c.checkin_name]!==c.course_code)throw Error('课程JSON编号与统一登记不一致：'+c.name);
  if(config.certificate_ledger)for(const [key,value]of Object.entries(read(config.certificate_ledger).entries)){const name=JSON.parse(key)[0];if(courseCodes[aliases[name]??name]!==value.prefix.slice(2,5))throw Error('历史正式账本与课程编号登记冲突：'+name);}
  const dependencies=[configPath,config.course_info,config.confirmations,config.course_codes,config.course_aliases,config.identity_registry,...(config.certificate_ledger?[config.certificate_ledger]:[])].map(p=>({path:resolve(p),sha256:fs.existsSync(resolve(p))?hash(fs.readFileSync(resolve(p),'utf8')):null}));
  save(path.join(directory,'课程信息.json'),info);save(path.join(directory,'人工确认.json'),confirmation);save(path.join(directory,'身份登记-before.json'),identities??null);save(path.join(directory,'配置.json'),config);
  const readSource=label=>readTable({call,root,base:config.base_token,table:config.source_table,directory,label});
  const readTarget=label=>readTable({call,root,base:config.base_token,table:config.roster_table,directory,label});
  const source=readSource('source'),target=readTarget('roster');
  const schema=call(['base','+field-list','--base-token',config.base_token,'--table-id',config.roster_table,'--as','user']).data.fields;
  save(path.join(directory,'roster-fields.json'),schema);
  const plan=planSync({course_info:info,records:source.rows,existing:target.rows,base_token:config.base_token,source_table:config.source_table,identity_registry:identities,...confirmation});
  for(const fields of [...plan.creates,...plan.updates.map(u=>u.fields)])for(const [name,value] of Object.entries(fields)){
   const f=schema.find(f=>f.name===name);if(!f||['formula','lookup','auto_number'].includes(f.type))throw Error('目标字段不存在或不可写：'+name);
   if(f.type==='select'&&(!Array.isArray(value)||value.some(v=>!f.options?.some(o=>o.name===v))))throw Error('目标选项不匹配：'+name);
  }
  save(path.join(directory,'写入计划.json'),plan);save(path.join(directory,'课程制证准备信息.json'),plan.certificate_courses);save(path.join(directory,'待处理.json'),plan.pending);
  const classified=['planned','pending','excluded'].map(status=>{
   const name='coverage-'+status+'.json';save(path.join(directory,name),plan.coverage.filter(r=>r.status===status));
   return {path:name,key_fields:['record_id'],status,...(status==='excluded'?{reason:'课程JSON明确人工名单制证，不参与飞书打卡判定'}:{})};
  });
  const sourceSpec=(name,snapshot,stage)=>({id:name,kind:'base',stage,used:{path:path.basename(snapshot.file),manifest:path.basename(snapshot.file).replace('.ndjson','.manifest.json'),sha256:hash(fs.readFileSync(snapshot.file,'utf8'))},current:{path:path.basename(snapshot.file),manifest:path.basename(snapshot.file).replace('.ndjson','.manifest.json'),captured_at:snapshot.captured_at}});
  const auditSpec={schema_version:1,workflow:'checkin',phase:'preflight',run_started_at,sources:[sourceSpec('原始打卡',source,'records'),sourceSpec('结营与评优',target,'graduation'),...['课程信息.json','人工确认.json','配置.json','roster-fields.json'].map(name=>({id:name,kind:'file',stage:'courses',used:{path:name,sha256:hash(fs.readFileSync(path.join(directory,name),'utf8'))},current:{path:name}}))],coverage:{expected:{path:'source.ndjson',key_fields:['record_id']},actual:classified}};
  save(path.join(directory,'全流程核对输入.json'),auditSpec);
  const audit=auditWorkflow(auditSpec,directory);save(path.join(directory,'全流程核对报告.json'),audit);
  if(audit.errors.some(e=>e!=='仍有待确认对象，不能宣告范围全部完成'))throw Error('来源范围核对失败：'+audit.errors.join('；'));
  log('差异计划已生成',plan.summary);
  let verification={mode:apply?'sync':'preview',run_id:runId,directory,summary:plan.summary,source_revision:source.manifest.rev,source_records:source.rows.length,all_records_classified:audit.missing.length===0&&audit.unknown.length===0,scope_fully_resolved:audit.ready,online_write:false,scheduled:false};
  const report=()=>{
   save(path.join(directory,'结果.json'),verification);atomicSave(path.join(state,'latest.json'),verification);
   const content=[`# ${apply?'同步':'预览'}结果`,`原始打卡${source.rows.length}条；${apply?'本次':'预计'}新增${plan.summary.creates}条、更新${plan.summary.updates}条、不变${plan.summary.unchanged}条。`,`待确认原始记录${plan.summary.pending_records}条；明确排除${plan.summary.excluded_records}条；未匹配旧名单${plan.summary.unmatched_existing}条。人工名单课程${plan.skipped_courses.length}门，保留制证参数，等待核准人员。`,apply?(verification.online_write?'已按最小差异写入并全量回读核验。':'与线上一致，无需写入，已全量回读核验。'):'本轮未写入线上，仅生成预览。',verification.source_changed_during_write?'执行期间原始打卡已变化，需重新运行。':'',`完整范围${audit.ready?'检查通过':'仍有待确认项，不能称全部人员结营处理完成'}。原始打卡和人工评优字段不在更新范围。未生成证书，未启用定时任务。`,`完整批次目录：${directory}`].filter(Boolean).join('\n\n')+'\n';
   fs.writeFileSync(path.join(directory,'运行结果.md'),content);fs.writeFileSync(path.join(path.dirname(configPath),'最近运行.md'),content);
  };
  if(!apply){report();return verification;}
  // Each execution uses new snapshots. Old plans are never blindly replayed.
  const freshSource=readSource('source-prewrite'),freshTarget=readTarget('roster-prewrite');
  if(freshSource.manifest.rev!==source.manifest.rev||!equal(freshSource.rows,source.rows)||freshTarget.manifest.rev!==target.manifest.rev||!equal(freshTarget.rows,target.rows))throw Error('计算后源数据或人工名单已变化，本轮停止；重新运行会重算最新差异');
  const freshSchema=call(['base','+field-list','--base-token',config.base_token,'--table-id',config.roster_table,'--as','user']).data.fields;
  if(!equal(schema,freshSchema))throw Error('执行前目标表结构已变化，请重新运行');
  for(const d of dependencies)if((fs.existsSync(d.path)?hash(fs.readFileSync(d.path,'utf8')):null)!==d.sha256)throw Error('执行前本地课程规则、人工确认或身份登记变化，请重跑');
  // Persist allocated identities before the first request so ambiguous/partial outcomes keep their IDs.
  atomicSave(registryFile,plan.registry);
  const batches=[...Array.from({length:Math.ceil(plan.creates.length/100)},(_,i)=>({kind:'create',rows:plan.creates.slice(i*100,i*100+100)})),...Array.from({length:Math.ceil(plan.updates.length/100)},(_,i)=>({kind:'update',rows:plan.updates.slice(i*100,i*100+100)}))];
  for(let i=0;i<batches.length;i++){
   const b=batches[i],payload=b.kind==='create'?{create_records:b.rows}:{update_records:Object.fromEntries(b.rows.map(u=>[u.record_id,u.fields]))};
   const file=path.join(directory,`batch-${i}-payload.json`);save(file,payload);writesStarted=true;log('写入批次',{index:i,kind:b.kind,count:b.rows.length});
   const receipt=call(['base',b.kind==='create'?'+record-batch-create':'+record-batch-update','--base-token',config.base_token,'--table-id',config.roster_table,'--json','@./'+path.relative(root,file).replaceAll('\\','/'),'--as','user']);save(path.join(directory,`batch-${i}-receipt.json`),receipt);
   if(receipt.data?.ignored_fields?.length)throw Error('飞书忽略部分字段；停止，重新读取后恢复');
  }
  const back=readTarget('roster-readback'),after=readSource('source-readback');
  for(const e of plan.expected){
   const hits=back.rows.filter(r=>r.名单标识===e.fields.名单标识);if(hits.length!==1)throw Error('回读主记录缺失或重复：'+e.fields.名单标识);
   for(const [k,v]of Object.entries(e.fields))if(!equal(v,hits[0][k]))throw Error('写后回读不一致：'+k);
  }
  const protectedChanges=[];
  for(const old of target.rows){const now=back.rows.find(r=>r.record_id===old.record_id);if(!now)throw Error('既有行在同步期间消失，需人工复核');for(const k of protectedFields)if(!equal(old[k],now[k]))protectedChanges.push({record_id:old.record_id,field:k});}
  for(const fields of plan.creates){const row=back.rows.find(r=>r.名单标识===fields.名单标识);for(const [k,v]of Object.entries(fields))if(!equal(v,row[k]))throw Error('新增行回读不一致：'+k);}
  verification={...verification,online_write:batches.length>0,verified:true,created:plan.creates.length,updated:plan.updates.length,target_revision:back.manifest.rev,source_changed_during_write:after.manifest.rev!==source.manifest.rev||!equal(after.rows,source.rows),manual_fields_changed_concurrently:protectedChanges};
  save(path.join(directory,'回读核验.json'),verification);
  const completeSpec=structuredClone(auditSpec);completeSpec.phase='complete';
  completeSpec.sources=completeSpec.sources.filter(s=>s.id!=='结营与评优');
  completeSpec.sources[0].current={path:'source-readback.ndjson',manifest:'source-readback.manifest.json',captured_at:after.captured_at};
  completeSpec.coverage.expected.path='source-readback.ndjson';
  completeSpec.coverage.actual=classified.map(c=>c.status==='planned'?{...c,status:'completed',evidence_file:'回读核验.json'}:c);
  save(path.join(directory,'写后全流程核对输入.json'),completeSpec);save(path.join(directory,'写后全流程核对报告.json'),auditWorkflow(completeSpec,directory));
  report();log('回读核验完成',{created:verification.created,updated:verification.updated,source_changed:verification.source_changed_during_write});
  return verification;
 }catch(error){
  const failure={failed:true,run_id:runId,directory,error:error.message,online_write_may_have_occurred:writesStarted,recovery:'重新运行会读取线上当前状态并重算差异；不要手工重放旧批次。'};
  save(path.join(directory,'失败.json'),failure);atomicSave(path.join(state,'latest.json'),failure);log('运行停止',failure);throw error;
 }finally{release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2),index=args.indexOf('--config');
 if(index<0||!args[index+1]||args.some((a,i)=>i!==index&&i!==index+1&&!['--apply','--preview'].includes(a))||args.includes('--apply')&&args.includes('--preview')){console.error('用法：node run.mjs --config <本地配置.json> [--preview|--apply]');process.exitCode=1;}
 else try{const result=run({config_file:args[index+1],apply:args.includes('--apply')});console.log(JSON.stringify(result));if(result.source_changed_during_write)process.exitCode=2;}catch(error){console.error(error.message);process.exitCode=1;}
}
