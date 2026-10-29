import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildEvaluation,evaluationPreview} from '../runtime/assistant/scripts/单维表评价.mjs';
import {runAwards} from '../runtime/assistant/scripts/等级发放.mjs';

function plan(grades=['S','A','B','C','D']) {
 return buildEvaluation(grades.map((grade,i)=>({course:'示例课程',role:'专业助教',name:`匿名${i}`,wechat:`sample-${i}`,grade,eligible:false})),{period:'2099-01',learner_recruitment_date:'2099-01-01'});
}
function platform(p) {
 const events=[],records=p.people.map((t,i)=>({...t,assignment_id:i+1,task_completed:false,certificate_issued:false,certificate_choice:null,certificate_name:null,grade:null,whalecoins:0}));
 const transport={fresh_readback:true,readSource:async()=>p.people,readSourceInventory:async()=>({complete:true,has_more:false,total:p.people.length,people:structuredClone(p.people)}),read:async()=>structuredClone(records),
  completeTask:async t=>{events.push(['complete',t.assignment_id]);records.find(r=>r.assignment_id===t.assignment_id).task_completed=true;},
  setNoCertificate:async t=>{events.push(['no-certificate',t.assignment_id]);records.find(r=>r.assignment_id===t.assignment_id).certificate_choice='不发证';},
  setGradeAndIssueCertificate:async t=>{events.push(['issue',t.assignment_id]);Object.assign(records.find(r=>r.assignment_id===t.assignment_id),{grade:t.grade,certificate_name:t.certificate,certificate_issued:true});},
 };
 return {transport,events,records};
}
test('B certificate is fixed by the current rule without a provisional confirmation',()=>{
 const p=plan(['B']);assert.equal(p.people[0].certificate,'优秀助教证书');assert.equal(p.people[0].certificate_holds.length,0);
 assert.ok(!p.people[0].holds.some(x=>/暂定|B级/.test(x)));
});
test('all tasks are completed before any grade or certificate action',async()=>{
 const p=plan(),s=platform(p);await runAwards(s.transport,p,{apply:true});
 assert.deepEqual(s.events.slice(0,5).map(e=>e[0]),Array(5).fill('complete'));
 assert.equal(s.events.filter(e=>e[0]==='issue').length,3);assert.equal(s.events.filter(e=>e[0]==='no-certificate').length,2);
 assert.deepEqual(s.records.slice(0,3).map(r=>r.grade),['S','A','B']);
 assert.ok(s.records.slice(3).every(r=>r.certificate_choice==='不发证'&&!r.certificate_issued&&r.grade===null));
});
test('unknown coin qualification does not block the confirmed certificate',async()=>{
 const p=plan(['A']);p.people[0].eligible=null;p.people[0].whalecoins=null;p.people[0].holds=['鲸币资格待人工核对'];
 const s=platform(p);const r=await runAwards(s.transport,p,{apply:true});assert.equal(s.records[0].certificate_issued,true);assert.equal(r.pending_rewards.length,1);
});
test('missing grade completes the task but does not choose an award',async()=>{
 const p=plan(['']);const s=platform(p);const r=await runAwards(s.transport,p,{apply:true});
 assert.equal(s.records[0].task_completed,true);assert.equal(s.events.length,1);assert.equal(r.pending_certificates.length,1);
});
test('completion readback failure prevents every certificate action',async()=>{
 const p=plan(['A','B']);const s=platform(p);s.transport.completeTask=async()=>s.events.push(['failed-completion']);
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/任务完成/);assert.equal(s.events.length,1);
});
test('repeat processing preserves completed awards',async()=>{
 const p=plan(),s=platform(p);await runAwards(s.transport,p,{apply:true});const count=s.events.length;
 await runAwards(s.transport,p,{apply:true});assert.equal(s.events.length,count);
});
test('preview performs no platform mutations',async()=>{
 const p=plan(),s=platform(p);await runAwards(s.transport,p);assert.equal(s.events.length,0);
});
test('an old mixed process adapter cannot bypass the completion stage',async()=>{
 const p=plan(['A']),s=platform(p);delete s.transport.completeTask;s.transport.process=async()=>{throw Error('must not run');};
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/completeTask/);
});
test('existing C/D certificate is a conflict, not automatically revoked',async()=>{
 const p=plan(['C']),s=platform(p);s.records[0].certificate_issued=true;
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/已有证书/);assert.equal(s.events.length,0);
});
test('late source additions cannot hide outside the planned identity list',async()=>{
 const p=plan(['C']),s=platform(p),late={...p.people[0],business_key:'late',name:'后来者',wechat:'late'};
 s.transport.readSourceInventory=async()=>({complete:true,has_more:false,total:2,people:[...p.people,late]});
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/全集|范围|新增/);assert.equal(s.events.length,0);
});
test('partial or unsupported source inventories prevent every platform mutation',async()=>{
 for(const inventory of [null,{complete:true,has_more:true,total:1,people:plan(['C']).people}]){
  const p=plan(['C']),s=platform(p);
  if(inventory)s.transport.readSourceInventory=async()=>inventory;else delete s.transport.readSourceInventory;
  await assert.rejects(runAwards(s.transport,p,{apply:true}),/全量|完整|全集|readSourceInventory/);assert.equal(s.events.length,0);
 }
});
test('a same-count identity replacement invalidates the evaluation batch',async()=>{
 const p=plan(['C']),s=platform(p);
 s.transport.readSourceInventory=async()=>({complete:true,has_more:false,total:1,people:[{...p.people[0],business_key:'replacement',name:'更换后',wechat:'replacement'}]});
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/全集|范围|变化/);assert.equal(s.events.length,0);
});
test('a source addition during processing stops before certificate decisions',async()=>{
 const p=plan(['A']),s=platform(p);let reads=0;
 s.transport.readSourceInventory=async()=>{const people=reads++<2?p.people:[...p.people,{...p.people[0],business_key:'late'}];return {complete:true,has_more:false,total:people.length,people};};
 await assert.rejects(runAwards(s.transport,p,{apply:true}),/全集|范围|新增/);
 assert.deepEqual(s.events.map(e=>e[0]),['complete']);
});
test('an unmatched decision key is reported instead of silently discarded',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-scope-'));
 try{
  fs.writeFileSync(path.join(root,'people.json'),JSON.stringify([{course:'示例课程',role:'专业助教',name:'甲',wechat:'a',grade:'A'}]));
  fs.writeFileSync(path.join(root,'decisions.json'),JSON.stringify({late:{eligible:true}}));
  const ctx={config:{period:'2099-01',sample_only:true,evaluation:{people_file:'people.json',decisions_file:'decisions.json'}},resolve:f=>path.join(root,f)};
  assert.throws(()=>evaluationPreview(ctx,path.join(root,'out')),/未匹配|决策.*范围|确认.*范围/);
  assert.equal(fs.existsSync(path.join(root,'out')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
