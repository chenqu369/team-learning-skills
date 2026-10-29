import test from 'node:test';
import assert from 'node:assert/strict';
let api={};try{api=await import('../runtime/learner/local/engine.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const course_info={schema_version:1,period:'2099-01',period_number:1,source:{document_id:'SAMPLE',revision_id:1},courses:[{course_key:'a',name:'课程A',checkin_name:'课程A',group_count:1,task_ids:['task3'],required_task_ids:['task3'],confirmation:{group_count:'已确认',tasks:'已确认'},course_code:'001',certificate_date:'2099-01-30'}]};
const record={record_id:'rec-a',微信昵称:'甲',所学课程:['课程A'],群号:['1群'],任务名称:['task3'],学习心得:'学习记录',课程评价:5,请填写你对本次课程内容的反馈:'反馈',提交时间:'2099-01-20T10:00:00+08:00',自动编号:'NO.1'};
const input=()=>({course_info,records:[record],existing:[],base_token:'base',source_table:'source',identity_registry:undefined,approvals:[]});
test('明确task3单项合格且每个原始记录有唯一去向',()=>{
 const p=api.planSync(input());assert.equal(p.creates.length,1);assert.deepEqual(p.creates[0].结营判定,['符合结营要求']);assert.equal(p.coverage.length,1);assert.equal(p.coverage[0].record_id,'rec-a');
});
test('同数据重跑零变更，人工字段与备注不被覆盖',()=>{
 const one=api.planSync(input()),old={...one.creates[0],record_id:'existing',证书昵称:'人工昵称',优秀学习者:true,评阅人:'助教',备注:'人工备注'};
 const two=api.planSync({...input(),existing:[old],identity_registry:one.registry});assert.equal(two.creates.length,0);assert.equal(two.updates.length,0);assert.equal(old.证书昵称,'人工昵称');
});
test('Task变化只更新系统字段，不触碰人工优秀和昵称',()=>{
 const one=api.planSync(input()),old={...one.creates[0],record_id:'existing',证书昵称:'人工昵称',优秀学习者:true};
 const two=api.planSync({...input(),existing:[old],records:[{...record,任务名称:['task2']}],identity_registry:one.registry});
 assert.deepEqual(two.updates[0].fields.结营判定,['未完成要求']);assert.ok(!Object.hasOwn(two.updates[0].fields,'证书昵称'));assert.ok(!Object.hasOwn(two.updates[0].fields,'优秀学习者'));
});
test('人工课程全部归为明确排除并保留课程制证参数',()=>{
 const ci=structuredClone(course_info);ci.courses[0].graduation_mode='manual_roster';
 const p=api.planSync({...input(),course_info:ci});assert.equal(p.creates.length,0);assert.equal(p.coverage[0].status,'excluded');assert.equal(p.certificate_courses[0].course_code,'001');
});
test('重复主记录阻断，不静默任取一条',()=>{
 const p=api.planSync(input()),row={...p.creates[0],record_id:'a'};
 assert.throws(()=>api.planSync({...input(),identity_registry:p.registry,existing:[row,{...row,record_id:'b'}]}),/重复/);
});
test('缺必填项单列待确认，不能漏出范围',()=>{
 const p=api.planSync({...input(),records:[{...record,微信昵称:''}]});assert.equal(p.creates.length,0);assert.equal(p.coverage.length,1);assert.equal(p.coverage[0].status,'pending');
});
test('部分创建成功后重读，只计划尚未创建的对象',()=>{
 const raw={...input(),records:[record,{...record,record_id:'rec-b',微信昵称:'乙',自动编号:'NO.2'}]},p=api.planSync(raw);
 const rerun=api.planSync({...raw,identity_registry:p.registry,existing:[{...p.creates[0],record_id:'created'}]});assert.equal(rerun.creates.length,1);assert.equal(rerun.updates.length,0);
});
test('人工核准名单可优先，但身份歧义仍不得放行',()=>{
 const p=api.planSync({...input(),records:[{...record,任务名称:['task2']}],approvals:[{course:'课程A',group:'1群',name:'甲',excellent_learner:true,basis:'用户明确核准'}]});assert.deepEqual(p.creates[0].结营判定,['符合结营要求']);assert.equal(p.creates[0].优秀学习者,true);
});
test('多个空人员标识的待核对身份行不能被当成同一个人',()=>{
 const records=['甲','乙'].flatMap((name,i)=>['1群','2群'].map((g,j)=>({...record,record_id:`r-${i}-${j}`,微信昵称:name,群号:[g],自动编号:`NO.${i*2+j+1}`})));
 const p=api.planSync({...input(),records});assert.ok(p.creates.length>=2);
 const existing=p.creates.map((r,i)=>({...r,record_id:'existing-'+i}));
 const next=api.planSync({...input(),records,existing,identity_registry:p.registry});assert.equal(next.creates.length,0);assert.equal(next.updates.length,0);
});
