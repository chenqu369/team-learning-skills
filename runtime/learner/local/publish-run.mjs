import fs from 'node:fs';import path from 'node:path';import {randomUUID}from 'node:crypto';
import {load,save,atomicSave,acquireLock,makeCaller,readTable}from './platform.mjs';
import {finalPlan,receiptPlan}from './publication.mjs';import {equal}from './engine.mjs';
import {auditWorkflow}from '../../shared/workflow-audit.mjs';import {createHash}from 'node:crypto';
export function publishRun({config_file,apply=false,course,group,period}){
 const config=load(config_file),root=path.resolve(path.dirname(config_file),config.workspace_root),resolve=p=>path.resolve(root,p),info=load(resolve(config.course_info));
 if(period&&info.period!==period)throw Error('配置营期与请求月份不符，停止');
 if(!config.final_table||!config.receipt_table)throw Error('未配置终版与领取表ID');
 const run_started_at=new Date().toISOString();
 const directory=resolve(config.output_directory+'/publish-'+run_started_at.replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,5));fs.mkdirSync(directory,{recursive:true});
 const release=acquireLock(resolve(config.state_directory+'/run.lock')),call=makeCaller(root,config.cli);
 const read=(table,label)=>readTable({call,root,base:config.base_token,table,directory,label});
 const schemas={};
 function write(table,plan,prefix){
  if(!schemas[table])schemas[table]=call(['base','+field-list','--base-token',config.base_token,'--table-id',table,'--as','user']).data.fields;
  const payloads=[];for(let i=0;i<plan.creates.length;i+=100)payloads.push(['+record-batch-create',{create_records:plan.creates.slice(i,i+100)}]);
  for(let i=0;i<(plan.updates??[]).length;i+=100)payloads.push(['+record-batch-update',{update_records:Object.fromEntries(plan.updates.slice(i,i+100).map(u=>[u.record_id,u.fields]))}]);
  for(let i=0;i<payloads.length;i++){
   const [cmd,payload]=payloads[i];for(const fields of payload.create_records??Object.values(payload.update_records))for(const [key,value]of Object.entries(fields)){const f=schemas[table].find(f=>f.name===key);if(!f)throw Error('缺目标字段'+key);if(f.type==='select'&&value.some(v=>!f.options?.some(o=>o.name===v)))throw Error('选项不符'+key);}
   const file=path.join(directory,prefix+'-'+i+'.json');save(file,payload);const r=call(['base',cmd,'--base-token',config.base_token,'--table-id',table,'--json','@./'+path.relative(root,file).replaceAll('\\','/'),'--as','user']);save(file+'.receipt.json',r);if(r.data?.ignored_fields?.length)throw Error('写入存在忽略字段');
  }
 }
 try{
  const roster=read(config.roster_table,'roster'),final=read(config.final_table,'final'),receipt=read(config.receipt_table,'receipt');save(path.join(directory,'课程信息.json'),info);
  const fp=finalPlan({course_info:info,roster:roster.rows,existing:final.rows,course,group});save(path.join(directory,'终版计划.json'),fp);
  if(!apply){const result={preview:true,directory,final_creates:fp.creates.length,pending:fp.pending};save(path.join(directory,'结果.json'),result);return result;}
  const guard=read(config.roster_table,'roster-prewrite'),fg=read(config.final_table,'final-prewrite'),rg=read(config.receipt_table,'receipt-prewrite');
  if(!equal(guard.rows,roster.rows)||!equal(fg.rows,final.rows)||!equal(rg.rows,receipt.rows)||!equal(load(resolve(config.course_info)),info))throw Error('执行前输入已变化，请重新运行');
  if(!equal(load(config_file),config))throw Error('执行配置已变化，请重新运行');
  save(path.join(directory,'配置.json'),config);
  const selected=r=>r.营期编号===info.period.replace('-','')&&(!course||r.所学课程?.includes(course))&&(!group||r.群号?.includes(group))&&r.结营判定?.includes('符合结营要求');
  for(const status of ['planned','excluded'])save(path.join(directory,'coverage-'+status+'.json'),roster.rows.filter(r=>selected(r)===(status==='planned')));
  const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sources=[[roster,guard],[final,fg],[receipt,rg]].map(([used,current],i)=>({id:['结营与评优','终版','领取'][i],kind:'base',stage:'final-roster',used:{path:path.basename(used.file),manifest:path.basename(used.file).replace('.ndjson','.manifest.json'),sha256:sha(used.file)},current:{path:path.basename(current.file),manifest:path.basename(current.file).replace('.ndjson','.manifest.json'),captured_at:current.captured_at}}));
  for(const name of ['课程信息.json','配置.json'])sources.push({id:name,kind:'file',stage:'parameters',used:{path:name,sha256:sha(path.join(directory,name))},current:{path:name}});
  const spec={schema_version:1,workflow:'certificates',phase:'preflight',run_started_at,sources,coverage:{expected:{path:path.basename(guard.file),key_fields:['record_id']},actual:[{path:'coverage-planned.json',key_fields:['record_id'],status:'planned'},{path:'coverage-excluded.json',key_fields:['record_id'],status:'excluded',reason:'本任务只处理指定当期、课程和群中已符合结营条件者；其他记录保留，待满足要求或另行处理'}]}};
  save(path.join(directory,'全流程核对输入.json'),spec);const audit=auditWorkflow(spec,directory);save(path.join(directory,'全流程核对报告.json'),audit);if(!audit.ready)throw Error('全流程来源或覆盖检查未通过');
  write(config.final_table,{...fp,updates:[]},'final');const finalBack=read(config.final_table,'final-readback');
  for(const row of fp.creates){const hits=finalBack.rows.filter(r=>r.系统学习者标识===row.系统学习者标识&&equal(r.所学课程,row.所学课程)&&equal(r.证书类型,row.证书类型)&&r.营期编号===row.营期编号);if(hits.length!==1)throw Error('终版回读身份缺失或重复');for(const [k,v]of Object.entries(row))if(!equal(v,hits[0][k]))throw Error('终版回读不一致：'+k);}
  const rp=receiptPlan({course_info:info,finals:finalBack.rows,existing:receipt.rows,course,group});save(path.join(directory,'领取计划.json'),rp);
  const receiptGuard=read(config.receipt_table,'receipt-before-write');if(!equal(receiptGuard.rows,receipt.rows))throw Error('领取表人工内容已变化，请重跑');
  write(config.receipt_table,rp,'receipt');const back=read(config.receipt_table,'receipt-readback');
  for(const row of rp.creates){const hits=back.rows.filter(r=>r.归并标识===row.归并标识);if(hits.length!==1)throw Error('领取回读重复或缺失');for(const [k,v]of Object.entries(row))if(!equal(v,hits[0][k]))throw Error('领取回读不一致：'+k);}
  for(const u of rp.updates){const row=back.rows.find(r=>r.record_id===u.record_id);for(const[k,v]of Object.entries(u.fields))if(!equal(v,row?.[k]))throw Error('领取关联回读不一致');}
  for(const old of receipt.rows){const row=back.rows.find(r=>r.record_id===old.record_id);if(!row||!equal(row.证书附件,old.证书附件))throw Error('既有领取附件变化，需复核');}
  const result={verified:true,directory,period:info.period,final_created:fp.creates.length,receipt_created:rp.creates.length,receipt_updated:rp.updates.length,pending:[...fp.pending,...rp.pending],certificate_attachments_created:false,roster_source_count:roster.rows.length};save(path.join(directory,'结果.json'),result);atomicSave(resolve(config.state_directory+'/publication-latest.json'),result);return result;
 }catch(e){save(path.join(directory,'失败.json'),{error:e.message,recovery:'重跑会重新读取全表并去重，不重放旧载荷'});throw e;}finally{release();}
}
