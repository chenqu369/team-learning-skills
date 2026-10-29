import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
let api={};try{api=await import('../runtime/learner/scripts/learning-cycle.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const requireApi=name=>{assert.equal(typeof api[name],'function',`${name} must be implemented`);return api[name];};
const info=()=>({schema_version:1,period:'2099-01',period_number:1,source:{document_id:'SAMPLE',revision_id:1},courses:[{course_key:'course-a',name:'课程A',checkin_name:'课程A',group_count:1,task_ids:['task1','task2'],course_code:'001',last_task_deadline:'2099-01-31',confirmation:{group_count:'已确认',tasks:'已确认'}}]});
const row=(task,changes={})=>({record_id:'rec-'+task,营期:'2099-01',所学课程:'课程A',群号:'1群',学习者编号:'L000001',微信昵称:'学习者甲',证书昵称:'',任务名称:task,学习心得:'实际内容',课程评价:0,请填写你对本次课程内容的反馈:'反馈',提交时间:'2099-01-20T10:00:00+08:00',自动编号:'NO.'+(task==='task1'?1:2),...changes});
const input=()=>({course_info:info(),records:[row('task1'),row('task2')]});
const graduated=()=>requireApi('graduate')(input());

test('明确证书日期优先于教学Task截止日期',()=>{
 const raw=input();raw.course_info.courses[0].certificate_date='2099-01-30';
 const graduates=requireApi('graduate')(raw);
 const out=requireApi('planFinalRoster')({graduates,course_info:raw.course_info,role_codes:{结课证书:'01'}});
 assert.equal(out.creates[0].结营日期,'2099年01月30日');
});

test('人工名单课程不会被导入飞书自动结营核验',()=>{
 const raw=input();raw.course_info.courses[0].graduation_mode='manual_roster';
 const out=requireApi('graduate')(raw);
 assert.equal(out.learners.length,0);
 assert.equal(out.skipped_courses[0].course,'课程A');
});

test('a submitted course absent from current rules must appear in pending',()=>{
 const out=requireApi('graduate')({...input(),records:[row('task1',{所学课程:'新增课程'})]});
 assert.ok(out.pending.some(x=>x.course==='新增课程'&&/规则|课程/.test(x.reason??(x.reasons??[]).join(''))));
});
test('changed course rules cannot reuse a previous graduation result',()=>{
 const g=graduated(),updated=info();updated.courses[0].task_ids.push('task3');
 assert.throws(()=>requireApi('planFinalRoster')({graduates:g,course_info:updated,normal_role:'结课证书',role_codes:{结课证书:'01'}}),/变更|重跑|版本/);
});
test('legacy graduation results without a course fingerprint require a refresh',()=>{
 const g=graduated();delete g.course_basis_sha256;
 assert.throws(()=>requireApi('planFinalRoster')({graduates:g,course_info:info(),normal_role:'结课证书',role_codes:{结课证书:'01'}}),/重跑|指纹|版本/);
});

test('graduation preserves sample-only markers from input or course source',()=>{
 const one=input();one.sample_only=true;assert.equal(requireApi('graduate')(one).sample_only,true);
 const two=input();two.course_info.source.sample_only=true;assert.equal(requireApi('graduate')(two).sample_only,true);
});

test('blank certificate nickname falls back to original WeChat nickname without mutating raw submissions',()=>{
 const raw=input(),original=structuredClone(raw);const out=requireApi('graduate')(raw);
 assert.equal(out.learners[0].certificate_name,'学习者甲');assert.equal(out.learners[0].name_source,'微信昵称');assert.equal(out.learners[0].qualified,true);assert.deepEqual(raw,original);
});
test('manual certificate nickname is preserved',()=>{
 const out=requireApi('graduate')({...input(),records:[row('task1',{证书昵称:'正式显示名'}),row('task2')]});assert.equal(out.learners[0].certificate_name,'正式显示名');
});
test('repeated task cannot replace a missing task, extra task does not count',()=>{
 const out=requireApi('graduate')({...input(),records:[row('task1'),row('task1',{record_id:'repeat',自动编号:'NO.3'}),row('task9')]});
 assert.equal(out.learners[0].qualified,false);assert.deepEqual(out.learners[0].missing_task_ids,['task2']);
});
test('graduation ignores note scores and old manual condition input',()=>{
 const out=requireApi('graduate')({...input(),manual_conditions:[{tasks:['task1']}],records:[row('task1',{笔记评分:0}),row('task2',{笔记评分:0})]});assert.equal(out.learners[0].qualified,true);
});
test('missing WeChat remains invalid even with learner ID',()=>{
 const out=requireApi('graduate')({...input(),records:[row('task1',{微信昵称:''}),row('task2',{微信昵称:''})]});assert.ok(out.learners.every(l=>!l.qualified));assert.ok(out.pending.length);
});
test('unknown course task list does not turn observed tasks into a rule',()=>{
 const raw=input();raw.course_info.courses[0].task_ids=['task1','task3'];const out=requireApi('graduate')(raw);assert.ok(out.learners.every(x=>!x.qualified));assert.ok(out.pending.length);
});
test('graduation refresh preserves direct manual excellence flags',()=>{
 const raw=input();raw.existing_roster=[{period:'2099-01',course:'课程A',person_id:'L000001',excellent_learner:true,excellent_captain:false,certificate_name:'人工昵称'}];
 const out=requireApi('graduate')(raw);assert.equal(out.learners[0].excellent_learner,true);assert.equal(out.learners[0].certificate_name,'人工昵称');
});
test('awards require an existing qualified learner and retain both roles',()=>{
 const out=requireApi('applyAwards')({graduates:graduated(),selections:[{course:'课程A',person_id:'L000001',excellent_learner:true,excellent_captain:true,reviewer:'评选助教',basis:'实际评选'}]});
 assert.equal(out.learners[0].excellent_learner,true);assert.equal(out.learners[0].excellent_captain,true);
 assert.throws(()=>api.applyAwards({graduates:graduated(),selections:[{course:'课程A',person_id:'missing',excellent_learner:true}]}),/唯一|未找到/);
});
test('awards cannot be assigned to an incomplete learner and omitted flags are not cleared',()=>{
 const g=requireApi('graduate')({...input(),records:[row('task1')]});assert.throws(()=>requireApi('applyAwards')({graduates:g,selections:[{course:'课程A',person_id:'L000001',excellent_learner:true}]}),/结营/);
 const old=graduated();old.learners[0].excellent_learner=true;const out=api.applyAwards({graduates:old,selections:[{course:'课程A',person_id:'L000001',excellent_captain:true,reviewer:'助教',basis:'依据'}]});assert.equal(out.learners[0].excellent_learner,true);
});
test('final plan emits one row per certificate and uses fallback nickname',()=>{
 const g=graduated();g.learners[0].excellent_learner=true;const out=requireApi('planFinalRoster')({graduates:g,course_info:info(),normal_role:'结课证书',role_codes:{结课证书:'01',优秀学习者证书:'02',优秀队长证书:'03'}});
 assert.equal(out.creates.length,2);assert.equal(out.creates[0].证书昵称,'学习者甲');assert.ok(out.creates.every(x=>x.资格核验.task_ids.length===2));assert.ok(out.creates.every(x=>x.证书编号===''));
});
test('existing final row is never replaced by an upstream name change',()=>{
 const g=graduated();const out=requireApi('planFinalRoster')({graduates:g,course_info:info(),normal_role:'结课证书',role_codes:{结课证书:'01'},existing_final:[{record_id:'final-1',稳定人员标识:'L000001',所学课程:'课程A',营期编号:'209901',证书类型:'结课证书',证书昵称:'人工改名',群号:'1群'}]});assert.equal(out.creates.length,0);assert.equal(out.updates.length,0);assert.ok(out.pending.length);
});
test('missing certificate date does not erase graduation but final creation is pending',()=>{
 const raw=info();raw.courses[0].last_task_deadline=null;const g=requireApi('graduate')({...input(),course_info:raw});assert.equal(g.learners[0].qualified,true);
 const out=requireApi('planFinalRoster')({graduates:g,course_info:raw,normal_role:'结课证书',role_codes:{结课证书:'01'}});assert.equal(out.creates.length,0);assert.ok(out.pending.length);
});
function receiptFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'team-learning-receipts-'));const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
 const image=path.join(root,'学习者甲结课证书.png');fs.writeFileSync(image,'synthetic-image');
 const people=[{最终名单记录ID:'final-1',稳定人员标识:'L000001',证书昵称:'学习者甲',所学课程:'课程A',群号:'1群',营期编号:'209901',角色:'结课证书',证书类型:'结课证书',证书编号:'SAMPLE-1',结营日期:'2099年01月31日'}];
 const manifest={status:'complete',test_mode:false,certificates:[{name:'学习者甲',course:'课程A',stable_id:'L000001',role:'结课证书',number:'SAMPLE-1',date:'2099年01月31日',group:'1群',path:image,relative_path:'学习者甲结课证书.png',sha256:digest('synthetic-image')} ]};
 return {root,people,manifest};
}
test('receipt uses one learner row and rerun updates zero rows',()=>{
 const f=receiptFixture();try{const out=requireApi('planReceipts')(f);assert.equal(out.receipts.length,1);assert.equal(out.creates.length,1);assert.equal(out.receipts[0].certificate_files.length,1);const rerun=api.planReceipts({...f,existing_receipts:out.receipts});assert.equal(rerun.creates.length,0);assert.equal(rerun.updates.length,0);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('receipt rejects test manifests and missing certificate types',()=>{
 const f=receiptFixture();try{assert.throws(()=>requireApi('planReceipts')({...f,manifest:{...f.manifest,test_mode:true}}),/正式/);f.people.push({...f.people[0],最终名单记录ID:'final-2',角色:'优秀学习者证书',证书类型:'优秀学习者证书',证书编号:'SAMPLE-2'});assert.throws(()=>api.planReceipts(f),/缺|完整/);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('receipt detects a changed image instead of offering stale files',()=>{
 const f=receiptFixture();try{fs.appendFileSync(f.manifest.certificates[0].path,'changed');assert.throws(()=>requireApi('planReceipts')(f),/哈希/);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
