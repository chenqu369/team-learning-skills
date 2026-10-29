// Whole-Base period rollover. Never changes source records or enables merge workflows.
import {existsSync} from 'node:fs';
import {call,load,save} from './lark.mjs';
const [mode,configPath]=process.argv.slice(2),config=load(configPath);
const statePath=config.state_path,out=config.output_prefix;
let state=existsSync(statePath)?load(statePath):{started_at:new Date().toISOString(),operations:[],checkpoints:{}};
function invoke(label,args){
 const started=Date.now();try{const r=call(args);save(`${out}-${label}.json`,r);state.operations.push({label,started_at:new Date(started).toISOString(),duration_ms:Date.now()-started,ok:true});save(statePath,state);return r;}
 catch(e){state.operations.push({label,duration_ms:Date.now()-started,ok:false,error:e.message});save(statePath,state);throw e;}
}
function once(label,args){if(state.checkpoints[label])return state.checkpoints[label];const r=invoke(label,args);state.checkpoints[label]=r;save(statePath,state);return r;}
const text=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
function parsePlan(snapshot){
 const xml=snapshot.data.document.content;
 const table=[...xml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map(m=>m[1]).find(t=>/名称/.test(t)&&/群数/.test(t));
 if(!table)throw Error('No explicit course catalogue');
 const rows=[...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c=>text(c[1])));
 const sections=xml.split(/<h4[^>]*>/).slice(1),pending=[],courses=[];
 for(const r of rows.filter(r=>/^\d+$/.test(r[0]||''))){
  const number=Number(r[0]),course=r[1],groups=Number((r[5]||'').match(/(\d+)\s*个/)?.[1]);
  if(!course||!Number.isInteger(groups)||groups<1)throw Error('Missing course or group count');
  const sec=sections.find(s=>Number(text(s.split('</h4>')[0]).match(/^([\d\s]+)[）)]/)?.[1]?.replace(/\s/g,''))===number)||'';
  const tasks=[...sec.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c=>text(c[1]))).filter(c=>/^(?:✅\s*)?Task\s*\d+/i.test(c[0]||''));
  const names=[...new Set(tasks.map(c=>'task'+Number(c[0].match(/Task\s*(\d+)/i)[1])))];
  if(!names.length)pending.push({course,reason:'No explicitly numbered Task in planning; no task count or certificate rule inferred'});
  if(tasks.some(c=>/0?9\s*月/.test(c[2]||'')))pending.push({course,reason:'September deadlines remain in October planning; do not infer corrected dates'});
  courses.push({number,course,groups,tasks:names,task_deadlines:tasks.map(c=>({task:'task'+Number(c[0].match(/Task\s*(\d+)/i)[1]),deadline:c[2]||''}))});
 }
 if(new Set(courses.map(c=>c.course)).size!==courses.length)throw Error('Duplicate course names');
 return {source_document:snapshot.data.document.document_id,source_revision:snapshot.data.document.revision_id,courses,task_options:[...new Set(courses.flatMap(c=>c.tasks))].sort((a,b)=>Number(a.slice(4))-Number(b.slice(4))),group_options:Array.from({length:Math.max(...courses.map(c=>c.groups))},(_,i)=>`${i+1}群`),pending};
}
if(mode==='copy'){
 if(state.base_token)throw Error('Target already exists; configure existing target instead');
 if(state.copy_attempted)throw Error('Copy outcome unknown; inspect receipt instead of retrying');
 state.copy_attempted=true;save(statePath,state);
 const r=invoke('copy',['base','+base-copy','--base-token',config.source_base,'--name',config.name,'--without-content','--as','user']);
 state.base_token=r.data.base.base_token;state.url=r.data.base.url;save(statePath,state);
}else if(mode==='configure'){
 if(!state.base_token||state.base_token===config.source_base)throw Error('Need distinct copied target');
 const plan=parsePlan(load(config.planning_snapshot));save(`${out}-period-plan.json`,plan);
 const tables=invoke('tables',['base','+table-list','--base-token',state.base_token,'--as','user']).data.tables;
 const target=tables.find(t=>t.name===config.table_name);if(!target)throw Error('Copied table missing');
 if(target.records_count!==0)throw Error('Target is not empty; do not replace options on live data');
 state.table_id=target.id;save(statePath,state);
 const common=['--base-token',state.base_token,'--table-id',target.id,'--as','user'];
 const fields=invoke('fields-before',['base','+field-list',...common]).data.fields;
 for(const [name,options] of [['所学课程',plan.courses.map(c=>c.course)],['任务名称',plan.task_options],['群号',plan.group_options]]){
  const f=fields.find(f=>f.name===name);if(f?.type!=='select')throw Error('Need existing select field '+name);
  const updated=Object.fromEntries(['name','type','description','style','multiple','options','default_value'].filter(k=>f[k]!==undefined).map(k=>[k,f[k]]));
  updated.options=options.map((name,i)=>({...(f.options.find(o=>o.name===name)||f.options[i%f.options.length]),name}));
  if(updated.default_value?.some(v=>!options.includes(v)))updated.default_value=null;
  const payload=`${out}-${name}-payload.json`;save(payload,updated);
  once(`update-${name}`,['base','+field-update',...common,'--field-id',f.id,'--json',`@${payload}`,'--i-have-read-guide','--yes']);
 }
 const views=invoke('views-before',['base','+view-list',...common]).data.views;
 const form=views.find(v=>v.type==='form'&&[config.source_form_name,config.form_name].includes(v.name));if(!form)throw Error('Copied form missing');
 state.form_id=form.id;save(statePath,state);
 once('form-update',['base','+form-update',...common,'--form-id',form.id,'--name',config.form_name,'--description',config.form_description]);
 // Only remove the obsolete period-specific filters, retaining all other view settings.
 const collection=views.find(v=>v.name==='收集结果-请不要动这张表');
 const filter=invoke('collection-filter-before',['base','+view-get-filter',...common,'--view-id',collection.id]).data.filter;
 if(filter?.conditions?.some(c=>c[0]==='所学课程'&&Array.isArray(c[2])&&(!c[2].length||c[2].some(v=>!plan.courses.some(x=>x.course===v))))){
  save(`${out}-empty-filter.json`,{conditions:[]});
  once('clear-obsolete-filter',['base','+view-set-filter',...common,'--view-id',collection.id,'--json',`@${out}-empty-filter.json`]);
 }
 for(const cmd of ['+base-block-list','+dashboard-list','+workflow-list'])invoke('readback'+cmd,['base',cmd,'--base-token',state.base_token,'--as','user']);
 invoke('fields-readback',['base','+field-list',...common]);invoke('views-readback',['base','+view-list',...common]);
 invoke('questions-readback',['base','+form-questions-list',...common,'--form-id',form.id]);
 invoke('share-readback',['base','+form-share-get',...common,'--form-id',form.id]);
 state.configured_at=new Date().toISOString();state.configuration=plan;save(statePath,state);
 console.log(JSON.stringify({base_token:state.base_token,url:state.url,table_id:state.table_id,course_count:plan.courses.length,tasks:plan.task_options,pending:plan.pending,operations:state.operations.length}));
}else throw Error('copy|configure config.json');
