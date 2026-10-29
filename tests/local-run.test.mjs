import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {run} from '../runtime/learner/local/run.mjs';import {save,load} from '../runtime/learner/local/platform.mjs';import {systemFields,protectedFields} from '../runtime/learner/local/engine.mjs';
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-local-run-'));
 const c={workspace_root:'.',base_token:'base',source_table:'source',roster_table:'roster',course_info:'course.json',confirmations:'confirmations.json',identity_registry:'registry.json',course_codes:'codes.json',course_aliases:'aliases.json',output_directory:'output',state_directory:'state'};
 save(path.join(root,'config.json'),c);save(path.join(root,'codes.json'),{'课程A':'001'});save(path.join(root,'aliases.json'),{aliases:{'课程A':'课程A'}});save(path.join(root,'confirmations.json'),{});
 save(path.join(root,'course.json'),{schema_version:1,period:'2099-01',period_number:1,source:{document_id:'sample',revision_id:1},courses:[{course_key:'a',name:'课程A',checkin_name:'课程A',course_code:'001',task_ids:['task1'],required_task_ids:['task1'],confirmation:{tasks:'已确认',group_count:'已确认'},group_count:1,certificate_date:'2099-01-30'}]});
 const raw=[{record_id:'raw1',微信昵称:'甲',所学课程:['课程A'],群号:['1群'],任务名称:['task1'],学习心得:'内容',课程评价:5,请填写你对本次课程内容的反馈:'反馈',提交时间:'2099-01-20T10:00:00+08:00',自动编号:'NO.1'}],roster=[];
 let revision=1,writes=0,failAfterCreate=false;
 const fields=[...systemFields,...protectedFields].map(name=>({name,type:'text'}));
 const caller=args=>{
  const table=args[args.indexOf('--table-id')+1];
  if(args[1]==='+field-list')return {ok:true,data:{fields}};
  if(args[1]==='+record-list'){
   const rows=table==='source'?raw:roster,file=path.resolve(root,args[args.indexOf('--output')+1]);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n'));
   return {manifest_version:'v1',base_token:'base',table_id:table,rev:table==='source'?1:revision,records_count:rows.length,has_more:false,query_context:{record_scope:'all_records'}};
  }
  const file=args[args.indexOf('--json')+1].slice(1),payload=load(path.resolve(root,file));writes++;
  if(args[1]==='+record-batch-create'){for(const r of payload.create_records)roster.push({...r,record_id:'created-'+roster.length});revision++;if(failAfterCreate){failAfterCreate=false;throw Error('network outcome unknown');}}
  else if(args[1]==='+record-batch-update'){for(const [id,fields]of Object.entries(payload.update_records))Object.assign(roster.find(r=>r.record_id===id),fields);revision++;}
  else throw Error('unexpected '+args[1]);
  return {ok:true,data:{}};
 };
 return {root,roster,caller,config_file:path.join(root,'config.json'),get writes(){return writes;},failNextCreate(){failAfterCreate=true;}};
}
test('全入口：预览不写入，同步可回读，重复同步不新增',()=>{
 const f=fixture();try{
  const preview=run(f);assert.equal(f.writes,0);assert.equal(preview.summary.creates,1);
  const synced=run({...f,apply:true});assert.equal(synced.verified,true);assert.equal(f.writes,1);
  f.roster[0].证书昵称='人工名';f.roster[0].优秀学习者=true;
  const second=run({...f,apply:true});assert.equal(second.created,0);assert.equal(second.updated,0);assert.equal(f.roster.length,1);assert.equal(f.roster[0].优秀学习者,true);assert.equal(f.writes,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('全入口：创建已落库但响应失败，下一次运行不会重复创建',()=>{
 const f=fixture();try{
  f.failNextCreate();assert.throws(()=>run({...f,apply:true}),/outcome unknown/);assert.equal(f.roster.length,1);assert.equal(f.writes,1);
  const recovered=run({...f,apply:true});assert.equal(recovered.created,0);assert.equal(recovered.verified,true);assert.equal(f.writes,1);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
