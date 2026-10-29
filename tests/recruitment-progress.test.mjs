import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as module from '../runtime/assistant/scripts/招募进度.mjs';

const courses = {source:{period:'85',document_id:'sample-doc',revision_id:1},courses:[{course_key:'c1',name:'示例课程',group_count:2}]};
function snapshot(full=false) {
 return {sample_only:false,capture_kind:'project_tasks',captured_at:'2099-01-01T09:00:00+08:00',complete:true,total:2,
  expected_project:{id:900001,name:'示例招募',assistant_period:'85',assistant_category:'组队学习'},
  project:{id:900001,name:'示例招募',assistant_period:'85',assistant_category:'组队学习'},
  tasks:[{id:11,title:'示例课程 - 运营助教',capacity:2,claimed_count:full?2:1,status:'published',deadline:null},
   {id:12,title:'示例课程 - 专业助教',capacity:4,claimed_count:4,status:'published',deadline:null}]};
}
function applicants(data=snapshot(true)){
 data.applicant_inventory={project_id:data.project.id,captured_at:data.captured_at,complete:true,has_more:false,total:6,records:Array.from({length:6},(_,i)=>({id:i+1,task_id:i<2?11:12,name:`人员${i}`,status:'已领取'}))};
 return data;
}
test('progress reports a fixed vacancy table with actual and planned capacities',()=>{
 const report=module.buildRecruitmentProgress(snapshot(),courses);
 assert.equal(report.all_full,false);assert.equal(report.rows.length,1);assert.equal(report.rows[0]['缺口'],1);
 assert.equal(report.rows[0]['应招人数'],2);assert.equal(report.rows[0]['已招人数'],1);
 assert.deepEqual(report.columns,['课程','岗位','招募进度（已招/应招）']);
 assert.match(module.renderVacancies(report),/\| 示例课程 \| 运营助教 \| 1\/2 \|/);
 assert.doesNotMatch(module.renderVacancies(report),/\|[^\n]*(任务ID|任务链接|当前名额|缺口|截止时间|核验状态)/);
});
test('a missing course role is reported instead of declaring full',()=>{
 const data=snapshot(true);data.tasks.pop();data.total=1;
 const r=module.buildRecruitmentProgress(data,courses);assert.equal(r.all_full,false);
 assert.equal(r.rows[0]['岗位'],'专业助教');assert.equal(r.rows[0]['已招人数'],null);
});
test('partial inventories and unknown counts cannot trigger export',()=>{
 for(const mutate of [d=>d.complete=false,d=>d.total=3,d=>delete d.tasks[0].claimed_count,d=>d.tasks[0].claimed_count=3]){
  const data=snapshot(true);mutate(data);assert.equal(module.buildRecruitmentProgress(data,courses).all_full,false);
 }
});
test('duplicate roles, unexpected tasks and wrong quotas cannot count as full',()=>{
 for(const mutate of [d=>{d.tasks.push({...d.tasks[0],id:13});d.total=3;},d=>d.tasks[0].title='其他课程 - 运营助教',d=>d.tasks[0].capacity=3]){
  const data=snapshot(true);mutate(data);assert.equal(module.buildRecruitmentProgress(data,courses).all_full,false);
 }
});
test('unknown status cannot trigger export',()=>{
 const data=snapshot(true);data.tasks[0].status='unknown';assert.equal(module.buildRecruitmentProgress(data,courses).all_full,false);
});
test('wrong project or period is rejected',()=>{
 const data=snapshot(true);data.project.id=123;assert.throws(()=>module.buildRecruitmentProgress(data,courses),/项目/);
 const other=snapshot(true);other.project.assistant_period='84';assert.throws(()=>module.buildRecruitmentProgress(other,courses),/期数|项目/);
});
test('only project task JSON is accepted for progress',()=>{
 const data=snapshot();data.capture_kind='publication_ui';
 assert.throws(()=>module.buildRecruitmentProgress(data,courses),/项目任务 JSON/);
});
test('project task JSON uses explicit field mapping, not inferred counts',()=>{
 const data=snapshot();
 data.tasks=data.tasks.map(t=>({task_id:t.id,task_name:t.title,slots:t.capacity,occupied:t.claimed_count,state:t.status}));
 data.field_map={id:'task_id',title:'task_name',capacity:'slots',claimed_count:'occupied',status:'state'};
 assert.equal(module.buildRecruitmentProgress(data,courses).rows[0]['缺口'],1);
});
test('all full still emits the same header and an explicit empty table',()=>{
 const r=module.buildRecruitmentProgress(snapshot(true),courses);assert.equal(r.all_full,true);assert.equal(r.rows.length,0);
 assert.match(module.renderVacancies(r),/全部课程招满/);assert.match(module.renderVacancies(r),/招募进度（已招\/应招）/);
});
test('the table only contains known vacancies; unknown or full roles are not shown as vacancies',()=>{
 const unknown=snapshot(true);delete unknown.tasks[0].claimed_count;
 const report=module.buildRecruitmentProgress(unknown,courses),text=module.renderVacancies(report);
 assert.equal(report.all_full,false);
 assert.equal(text.split('\n').filter(line=>line.startsWith('| 示例课程')).length,0);
 assert.match(text,/待确认/);assert.doesNotMatch(text,/全部课程招满。/);
 const abnormal=snapshot(true);abnormal.tasks[0].status='unknown';
 assert.equal(module.renderVacancies(module.buildRecruitmentProgress(abnormal,courses)).split('\n').filter(line=>line.startsWith('| 示例课程')).length,0);
});
test('partial progress never invokes export',async()=>{
 let exports=0;const r=await module.runRecruitmentProgress({readSnapshot:async()=>snapshot(),exportAll:async()=>{exports++;}},courses);
 assert.equal(exports,0);assert.equal(r.export_triggered,false);
});
test('full progress refreshes and only reuses a receipt bound to complete applicant content',async()=>{
 let reads=0,exports=0;
 const transport={readSnapshot:async()=>{reads++;return applicants();},exportAll:async()=>{exports++;return {download_started:true,filename:'sample.xlsx'};}};
 const r=await module.runRecruitmentProgress(transport,courses);
 assert.equal(reads,2);assert.equal(exports,1);assert.equal(r.export_triggered,true);assert.equal(r.local_file_verified,false);
 assert.equal(r.roster_source_file,null);
 const repeat=await module.runRecruitmentProgress(transport,courses,{receipt:r.export_receipt});
 assert.equal(exports,1);assert.equal(repeat.export_triggered,false);assert.equal(repeat.export_skipped,true);
});
test('same-count identity or submission changes invalidate the saved export receipt',async()=>{
 for(const mutate of [d=>d.applicant_inventory.records[0].name='替换人员',d=>d.applicant_inventory.records[0].status='已提交']){
  let live=applicants(),exports=0;
  const transport={readSnapshot:async()=>structuredClone(live),exportAll:async()=>{exports++;return {download_started:true};}};
  const first=await module.runRecruitmentProgress(transport,courses);
  mutate(live);
  const next=await module.runRecruitmentProgress(transport,courses,{receipt:first.export_receipt});
  assert.equal(exports,2);assert.equal(next.export_triggered,true);assert.equal(next.export_skipped,false);
  assert.equal(next.roster_coverage_verified,false);
 }
});
test('counts alone permit a first export but never certify reuse of a current roster',async()=>{
 let exports=0;const transport={readSnapshot:async()=>snapshot(true),exportAll:async()=>{exports++;return {download_started:true};}};
 const first=await module.runRecruitmentProgress(transport,courses);
 assert.equal(first.export_triggered,true);assert.equal(first.roster_coverage_verified,false);
 const next=await module.runRecruitmentProgress(transport,courses,{receipt:first.export_receipt});
 assert.equal(exports,1);assert.equal(next.export_skipped,false);assert.match(next.export_pending,/报名|名单|完整/);
 assert.equal(next.roster_coverage_verified,false);
});
test('incomplete applicant inventories cannot authorize receipt reuse',async()=>{
 const data=applicants();data.applicant_inventory.has_more=true;
 const report=module.buildRecruitmentProgress(data,courses);
 assert.equal(report.applicant_inventory_verified,false);
});
test('uncertain exports remain pending until the actual download is checked',async()=>{
 const data=applicants(),report=module.buildRecruitmentProgress(data,courses);let exports=0;
 const result=await module.runRecruitmentProgress({readSnapshot:async()=>data,exportAll:async()=>{exports++;}},courses,{receipt:{project_id:report.project_id,fingerprint:report.fingerprint,status:'uncertain'}});
 assert.equal(exports,0);assert.equal(result.export_skipped,false);assert.match(result.export_pending,/不明|下载|核对/);
});
test('changed live counts stop export even when the old snapshot is full',async()=>{
 let reads=0,exports=0;
 const r=await module.runRecruitmentProgress({readSnapshot:async()=>snapshot(++reads===1),exportAll:async()=>{exports++;}},courses);
 assert.equal(exports,0);assert.equal(r.all_full,false);
});
test('sample input never triggers a platform export',async()=>{
 let exports=0;const data=snapshot(true);data.sample_only=true;
 const r=await module.runRecruitmentProgress({readSnapshot:async()=>data,exportAll:async()=>{exports++;}},courses);
 assert.equal(exports,0);assert.equal(r.export_triggered,false);
});

function browser(full=true,extraButtons=0){
 const source=snapshot(full),clicks=[],buttons=Array.from({length:1+extraButtons},()=>({textContent:'导出全部',getClientRects:()=>[{}],disabled:false,getAttribute:()=>null,click:()=>clicks.push('clicked')}));
 const context={window:{},location:{origin:'https://contributor.datawhale.cn',pathname:'/admin/projects/900001/tasks'},localStorage:{getItem:()=> 'sample-not-a-real-token'},
  document:{querySelectorAll:()=>buttons},fetch:async route=>({ok:true,json:async()=>route.includes('?')?{items:source.tasks,total:source.total}:source.project})};
 return {source,clicks,context};
}
test('generated browser code reads all tasks and clicks the actual export-all button',async()=>{
 const b=browser();const script=module.prepareProgressBrowserScript(courses,b.source.expected_project);
 const result=await vm.runInNewContext(script,b.context);assert.equal(result.all_full,true);assert.equal(b.clicks.length,1);
 await b.context.window.assistantRecruitProgress();assert.equal(b.clicks.length,1);
});
test('generated browser code does not click when a role remains vacant',async()=>{
 const b=browser(false);const result=await vm.runInNewContext(module.prepareProgressBrowserScript(courses,b.source.expected_project),b.context);
 assert.equal(result.all_full,false);assert.equal(b.clicks.length,0);
});
test('an ambiguous export button returns a pending result without retrying',async()=>{
 const b=browser(true,1);const result=await vm.runInNewContext(module.prepareProgressBrowserScript(courses,b.source.expected_project),b.context);
 assert.match(result.export_pending,/唯一/);assert.equal(b.clicks.length,0);assert.equal(result.export_receipt.status,'uncertain');
});
test('a saved export receipt prevents clicking again in a new browser context',async()=>{
 const first=browser();const result=await vm.runInNewContext(module.prepareProgressBrowserScript(courses,first.source.expected_project),first.context);
 const second=browser();await vm.runInNewContext(module.prepareProgressBrowserScript(courses,second.source.expected_project,{},result.export_receipt),second.context);
 assert.equal(second.clicks.length,0);
});
