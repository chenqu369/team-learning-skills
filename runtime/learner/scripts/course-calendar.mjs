import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

const textFields=['节点标题','节点键','课程','课程键','节点','任务内容','日期状态','原文日期','日期说明','来源'];
const dateFields=['日历标注日期','日历结束日期','实际截止时间'];
export const fields=[...textFields.map(name=>({name,type:'text'})),...dateFields.map(name=>({name,type:'datetime',style:{format:name==='实际截止时间'?'yyyy-MM-dd HH:mm':'yyyy-MM-dd'}}))];
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
const stable=(period,course,node)=>JSON.stringify([period,course,node]);
const millis=x=>Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x)?x.replace(' ','T')+':00+08:00':x);
const equal=(field,a,b)=>dateFields.includes(field)?(!a&&!b)||millis(a)===millis(b):(a??'')===(b??'');

/** Local planner only. No network, writes, deletion, or qualification mutation. */
export function planCalendar(input,existing=[]){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(input?.period)||!Array.isArray(input.courses)||!input.courses.length)throw Error('需要当期period及非空courses');
 if(!Array.isArray(existing))throw Error('existing必须为完整记录数组');
 const records=[],pending=[],courses=new Set(),keys=new Set(),old=new Map(),recordIds=new Set();
 for(const r of existing){
  if(!nonempty(r['节点键'])||!nonempty(r.record_id))throw Error('旧记录缺节点键或record_id；先核准迁移映射');
  if(old.has(r['节点键'])||recordIds.has(r.record_id))throw Error('现有日历节点键或record_id重复');
  old.set(r['节点键'],r);recordIds.add(r.record_id);
 }
 for(const course of input.courses){
  if(!nonempty(course.course_key)||!nonempty(course.name)||courses.has(course.course_key))throw Error('课程键／名称缺失或课程键重复');
  courses.add(course.course_key);
  if(course.calendar_nodes!=null&&!Array.isArray(course.calendar_nodes))throw Error('calendar_nodes必须为数组');
  const nodes=structuredClone(course.calendar_nodes??[]);
  const wait=reason=>pending.push({course_key:course.course_key,reason});
  if(!nodes.length)wait('未提供具体Task排期；仅展示已知起止日期');
  for(const [kind,field]of [['start','start_date'],['end','end_date']]){
   if(course[field]&&!nodes.some(n=>n.kind===kind))nodes.push({node_id:kind,kind,title:kind==='start'?'正式开始':'结营日期',date:course[field],time:null,status:'已确认',basis:`当期课程JSON ${field}；来源版本${input.source?.revision_id??'见当期确认记录'}`});
  }
  if(!nodes.length)nodes.push({node_id:'schedule-pending',kind:'other',title:'课程排期待确认',status:'待确认',date:null,basis:'当期课程JSON缺排期及起止日期'});
  for(const node of nodes){
   if(!nonempty(node.node_id)||!nonempty(node.title)||!['task_deadline','start','end','other'].includes(node.kind))throw Error('节点必须有node_id、title及有效kind');
   if(!['已确认','待确认','有冲突'].includes(node.status))throw Error('节点status必须明确');
   const key=stable(input.period,course.course_key,node.node_id);if(keys.has(key))throw Error('输入节点键重复');keys.add(key);
   if(node.date!=null&&!validDate(node.date))throw Error(`节点日期无效：${key}`);
   const time=node.time??null;
   if(time!==null&&(typeof time!=='string'||!(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)||time==='24:00')))throw Error(`节点时间无效：${key}`);
   if(time&&!node.date)throw Error('没有具体日期时不能填写time');
   const scheduled=node.status==='已确认'&&!!node.date&&nonempty(node.basis);
   const reason=node.status!=='已确认'?`日期${node.status}`:!node.date?'缺具体日期':!nonempty(node.basis)?'缺日期依据':'';
   if(!scheduled)pending.push({course_key:course.course_key,node_id:node.node_id,reason,source_label:node.source_label??''});
   let deadline=null;
   if(scheduled&&time&&node.kind!=='start'){
    const day=time==='24:00'?new Date(Date.parse(node.date+'T00:00:00Z')+86400000).toISOString().slice(0,10):node.date;
    deadline=day+' '+(time==='24:00'?'00:00':time);
   }
   const short=course.calendar_short_name||course.name;
   const label=node.node_id.replace(/^task/i,'T');
   records.push({'节点标题':`${short} ${label} ${scheduled?(time||(node.kind==='start'?'开始':node.kind==='end'?'结营':'日期已定')):'日期待确认'}`,'节点键':key,'课程':course.name,'课程键':course.course_key,'节点':node.node_id,'任务内容':node.title,'日期状态':scheduled?'已确认':reason,'原文日期':node.source_label??[node.date,time].filter(Boolean).join(' '),'日期说明':time==='24:00'?'按原文标注日显示；实际截止为次日00:00':node.kind==='start'?'开始日期；未提供时刻时不补造':scheduled?'按原文截止／结营日期显示':'保留原文；不推算日历日期','来源':node.basis??'','日历标注日期':scheduled?node.date+' 00:00':null,'日历结束日期':scheduled?node.date+' 00:00':null,'实际截止时间':deadline});
  }
 }
 const creates=[],updates=[];let unchanged=0;
 for(const r of records){const previous=old.get(r['节点键']);if(!previous){creates.push(r);continue;}const delta=Object.fromEntries(Object.entries(r).filter(([k,v])=>!equal(k,v,previous[k])));if(Object.keys(delta).length)updates.push({record_id:previous.record_id,fields:delta});else unchanged++;}
 const retained=[...old.values()].filter(r=>!keys.has(r['节点键'])).map(r=>({record_id:r.record_id,node_key:r['节点键'],reason:'新输入未包含，保留待核对'}));
 return {records,pending,creates,updates,retained,summary:{courses:courses.size,total:records.length,dated:records.filter(r=>r['日历标注日期']).length,pending:pending.length,creates:creates.length,updates:updates.length,unchanged,retained:retained.length}};
}

function readExisting(file){
 if(!file)return [];
 const raw=fs.readFileSync(file,'utf8').trim();
 if(!raw)return [];
 if(file.endsWith('.ndjson')){
  const manifestFile=file.replace(/\.ndjson$/,'.manifest.json');
  if(!fs.existsSync(manifestFile))throw Error('全量回读缺manifest');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const rows=raw.split(/\r?\n/).map(JSON.parse);
  if(manifest.has_more!==false||manifest.records_count!==rows.length||manifest.query_context?.record_scope!=='all_records')throw Error('manifest不能证明全量回读');
  return rows;
 }
 const value=JSON.parse(raw);if(!Array.isArray(value))throw Error('现有记录JSON须为数组；生产优先用带manifest的ndjson');return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const [inputFile,outputDir,...args]=process.argv.slice(2);
  if(!inputFile||!outputDir||(args.length&&!(args.length===2&&args[0]==='--existing')))throw Error('用法：course-calendar.mjs <课程信息.json> <新计划目录> [--existing <全量回读.ndjson>]');
  if(fs.existsSync(outputDir))throw Error('输出目录已存在，请使用新目录保留前次计划');
  const input=JSON.parse(fs.readFileSync(inputFile,'utf8')),existing=readExisting(args[1]),plan=planCalendar(input,existing);
  fs.mkdirSync(outputDir,{recursive:true});
  const write=(name,data)=>fs.writeFileSync(path.join(outputDir,name),JSON.stringify(data,null,2)+'\n');
  for(const name of ['records','pending','retained'])write(name+'.json',plan[name]);
  write('fields.json',fields);write('view.json',{name:'课程 Task 截止日历',type:'calendar'});
  write('timebar.json',{start_time:'日历标注日期',end_time:'日历结束日期',title:'节点标题'});
  write('visible-fields.json',{visible_fields:['节点标题','课程','节点','任务内容','日历标注日期','实际截止时间','日期状态','原文日期','日期说明','来源','节点键']});
  for(let i=0;i<plan.creates.length;i+=200)write(`create-${String(i/200+1).padStart(3,'0')}.json`,{create_records:plan.creates.slice(i,i+200)});
  for(let i=0;i<plan.updates.length;i+=200)write(`update-${String(i/200+1).padStart(3,'0')}.json`,{update_records:Object.fromEntries(plan.updates.slice(i,i+200).map(r=>[r.record_id,r.fields]))});
  const summary={...plan.summary,input_sha256:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),existing_sha256:crypto.createHash('sha256').update(JSON.stringify(existing)).digest('hex'),local_plan_only:true};
  write('summary.json',summary);console.log(JSON.stringify(summary));
 }catch(error){console.error(error.message);process.exitCode=2;}
}
