import test from 'node:test';
import assert from 'node:assert/strict';
import {planCalendar} from '../runtime/learner/scripts/course-calendar.mjs';
import {normalizeCourseInfo} from '../runtime/shared/course-info.mjs';
const input=()=>({period:'2099-01',source:{revision_id:1},courses:[{course_key:'a',name:'课程甲',start_date:'2099-01-01',calendar_nodes:[{node_id:'task1',kind:'task_deadline',title:'实验一',date:'2099-01-03',time:'03:00',status:'已确认',basis:'匿名排期表第1行'},{node_id:'task2',kind:'task_deadline',title:'实验二',date:'2099-01-04',time:'24:00',status:'已确认',basis:'匿名排期表第2行'}]}]});
test('03:00不前移；24:00保留原文标注日，实际为次日零点',()=>{
 const p=planCalendar(input());const [a,b]=p.records;
 assert.equal(a['日历标注日期'],'2099-01-03 00:00');assert.equal(a['实际截止时间'],'2099-01-03 03:00');
 assert.equal(b['日历标注日期'],'2099-01-04 00:00');assert.equal(b['实际截止时间'],'2099-01-05 00:00');
 assert.equal(p.records.at(-1)['实际截止时间'],null);
});
test('日期有冲突或缺来源时留空，不把相对天数换算成日期',()=>{
 const x=input();x.courses[0].calendar_nodes[0].status='有冲突';delete x.courses[0].calendar_nodes[1].basis;
 const p=planCalendar(x);assert.equal(p.records[0]['日历标注日期'],null);assert.equal(p.records[1]['日历标注日期'],null);assert.equal(p.pending.length,2);
});
test('缺Task日期只用有来源的起止日期，不使用制证日期',()=>{
 const x=input();delete x.courses[0].calendar_nodes;Object.assign(x.courses[0],{end_date:'2099-01-10',certificate_date:'2099-01-11'});
 const p=planCalendar(x);assert.equal(p.records.length,2);assert.equal(p.records[1]['日历标注日期'],'2099-01-10 00:00');assert.ok(p.pending.length);
});
test('同一快照重跑无写入；改日期只更新同一record，保留人工备注',()=>{
 const x=input(),p=planCalendar(x);const rows=p.records.map((r,i)=>({...r,record_id:`rec${i}`,人工备注:'保留'}));
 const same=planCalendar(x,rows);assert.equal(same.creates.length,0);assert.equal(same.updates.length,0);
 x.courses[0].calendar_nodes[0].date='2099-01-06';const changed=planCalendar(x,rows);
 assert.equal(changed.creates.length,0);assert.equal(changed.updates.length,1);assert.equal(changed.updates[0].record_id,'rec0');assert.equal(Object.hasOwn(changed.updates[0].fields,'人工备注'),false);
});
test('服务端ISO日期与本地日期等价；重复键和无键旧记录阻断',()=>{
 const p=planCalendar(input());const rows=p.records.map((r,i)=>({...r,record_id:`rec${i}`,日历标注日期:r['日历标注日期'].replace(' ','T')+':00+08:00',日历结束日期:r['日历结束日期'].replace(' ','T')+':00+08:00',实际截止时间:r['实际截止时间']?.replace(' ','T')+':00+08:00'}));rows.at(-1)['实际截止时间']=null;
 assert.equal(planCalendar(input(),rows).updates.length,0);
 assert.throws(()=>planCalendar(input(),[rows[0],rows[0]]),/重复/);
 assert.throws(()=>planCalendar(input(),[{record_id:'rec0'}]),/节点键/);
});
test('无效日期与24:30拒绝；跨年24:00正确换算',()=>{
 const x=input();x.courses[0].calendar_nodes[0].date='2099-02-30';assert.throws(()=>planCalendar(x),/日期/);
 const y=input();y.courses[0].calendar_nodes[0].time='24:30';assert.throws(()=>planCalendar(y),/时间/);
 const z=input();z.courses[0].calendar_nodes[1].date='2099-12-31';assert.equal(planCalendar(z).records[1]['实际截止时间'],'2100-01-01 00:00');
});
test('旧节点仅列retained，不删除；不同课程同编号不冲突',()=>{
 const x=input();x.courses.push({...structuredClone(x.courses[0]),course_key:'b',name:'课程乙'});const p=planCalendar(x);
 assert.equal(new Set(p.records.map(r=>r['节点键'])).size,p.records.length);
 const rows=p.records.map((r,i)=>({...r,record_id:`rec${i}`}));x.courses.pop();assert.equal(planCalendar(x,rows).retained.length,3);
});
test('课程归一化保留日历节点，不改变必需Task定义',()=>{
 const x=input();x.schema_version=1;x.period_number=1;x.source.document_id='SAMPLE-DOC';
 Object.assign(x.courses[0],{checkin_name:'课程甲',calendar_short_name:'甲',required_task_ids:['task1'],task_ids:['task1'],confirmation:{tasks:'已确认',group_count:'已确认'},group_count:1});
 const normalized=normalizeCourseInfo(x);
 assert.deepEqual(normalized.courses[0].calendar_nodes,x.courses[0].calendar_nodes);
 assert.equal(normalized.courses[0].calendar_short_name,'甲');assert.deepEqual(normalized.courses[0].required_task_ids,['task1']);
});
