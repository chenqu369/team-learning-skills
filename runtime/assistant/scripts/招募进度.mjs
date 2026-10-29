import fs from 'node:fs';
import {recruitmentCourseInput} from '../../shared/course-info.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectPrevious} from './上期招募.mjs';
export const VACANCY_COLUMNS=['课程','岗位','招募进度（已招/应招）'];

export function buildRecruitmentProgress(snapshot,courses){
 if(!courses?.source?.period||!Array.isArray(courses.courses)||!courses.courses.length)throw Error('缺少本期完整课程事实');
 const target=snapshot.expected_project,project=snapshot.project;
 if(!target||!Number.isSafeInteger(target.id)||target.id<=0||!project)throw Error('缺少已核实的项目身份');
 for(const key of ['id','name','assistant_period','assistant_category'])
  if(target[key]==null||String(target[key])!==String(project[key]))throw Error('项目身份或期数不符：'+key);
 if(String(target.assistant_period)!==String(courses.source.period))throw Error('项目期数与课程事实不符');
 if(snapshot.capture_kind!=='project_tasks')throw Error('招募进度使用项目任务 JSON');
 if(!Number.isFinite(Date.parse(snapshot.captured_at)))throw Error('缺少有效读取时间');
 if(!Array.isArray(snapshot.tasks))throw Error('任务JSON不是数组');
 const problems=[],expected=[],seen=new Set();
 for(const c of courses.courses){
  if(!c.course_key||!c.name||!Number.isSafeInteger(c.group_count)||c.group_count<=0||seen.has(c.course_key))throw Error('课程键、名称或群数未确认');
  seen.add(c.course_key);
  for(const [role,m] of [['运营助教',1],['专业助教',2]])expected.push({course_key:c.course_key,name:c.name,role,title:`${c.name} - ${role}`,capacity:c.group_count*m});
 }
 const map={id:'id',title:'title',capacity:'capacity',claimed_count:'claimed_count',status:'status',deadline:'deadline',course_key:'course_key',role:'role',url:'url',...snapshot.field_map};
 const get=(t,k)=>String(map[k]).split('.').reduce((v,p)=>v?.[p],t);
 const tasks=snapshot.tasks.map(t=>Object.fromEntries(Object.keys(map).map(k=>[k,get(t,k)])));
 if(snapshot.complete!==true||snapshot.has_more===true||snapshot.truncated===true||!Number.isSafeInteger(snapshot.total)||snapshot.total!==tasks.length)problems.push('项目任务未完整读取');
 const ids=tasks.map(t=>t.id);
 if(ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length)problems.push('任务ID缺失或重复');
 const matched=new Set(),allRows=[];
 for(const e of expected){
  const hits=tasks.filter(t=>t.course_key&&t.role?t.course_key===e.course_key&&t.role===e.role:t.title===e.title);
  const t=hits.length===1?hits[0]:null,issues=[];hits.forEach(hit=>matched.add(hit));
  if(!t)issues.push(hits.length?'课程岗位重复':'缺少课程岗位任务');
  if(t&&t.title!==e.title)issues.push('任务标题不符');
  if(t&&t.capacity!==e.capacity)issues.push('名额与规划不符');
  const valid=t&&Number.isSafeInteger(t.claimed_count)&&t.claimed_count>=0&&Number.isSafeInteger(t.capacity)&&t.claimed_count<=t.capacity;
  if(t&&!valid)issues.push('已招人数未知或异常');
  if(t&&!['published','已发布'].includes(t.status))issues.push('任务未发布或状态未知');
  const count=valid?t.claimed_count:null;
  allRows.push({'课程':e.name,'岗位':e.role,'任务ID':t?.id??null,'任务链接':t?.url??null,'应招人数':e.capacity,'当前名额':t?.capacity??null,'已招人数':count,
   '缺口':count===null?null:Math.max(0,e.capacity-count),'任务状态':t?.status??null,'截止时间':t?.deadline??null,'核验状态':issues.length?issues.join('；'):'已核实'});
 }
 if(matched.size!==tasks.length)problems.push('项目存在未匹配的任务');
 const rows=allRows.filter(r=>r['缺口']!==0||r['核验状态']!=='已核实');
 // Counts cannot attest that the people or submitted form content are unchanged.
 const inventory=snapshot.applicant_inventory,applicantProblems=[];
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 if(!inventory||inventory.project_id!==target.id||!Number.isFinite(Date.parse(inventory.captured_at))||inventory.complete!==true||inventory.has_more!==false||inventory.truncated===true||!Array.isArray(inventory.records)||!Number.isSafeInteger(inventory.total)||inventory.total!==inventory.records.length){
  applicantProblems.push('缺少当前项目完整报名内容快照，人数不能证明名单未变');
 }else{
  const applicantIds=inventory.records.map(r=>r.id);
  if(applicantIds.some(id=>!(typeof id==='string'&&id.trim()||Number.isSafeInteger(id)&&id>0))||new Set(applicantIds.map(String)).size!==applicantIds.length)applicantProblems.push('报名稳定标识缺失或重复');
  if(inventory.records.some(r=>!tasks.some(t=>t.id===r.task_id)||typeof r.status!=='string'||!r.status.trim()))applicantProblems.push('报名任务或提交状态缺失');
  for(const task of tasks)if(inventory.records.filter(r=>r.task_id===task.id).length!==task.claimed_count)applicantProblems.push('报名明细与当前任务占用人数不一致');
 }
 const applicantVerified=applicantProblems.length===0;
 const applicantFingerprint=applicantVerified?JSON.stringify(inventory.records.map(canonical).sort((a,b)=>String(a.id).localeCompare(String(b.id)))):null;
 return {project_id:target.id,captured_at:snapshot.captured_at,capture_kind:snapshot.capture_kind,
  sample_only:!!(snapshot.sample_only||courses.sample_only||courses.source.sample_only),columns:[...VACANCY_COLUMNS],all_full:problems.length===0&&rows.length===0,
  rows,all_rows:allRows,problems,fingerprint:JSON.stringify({project:target,source:courses.source,problems,rows:allRows,applicants:applicantFingerprint}),
  applicant_inventory_verified:applicantVerified,applicant_fingerprint:applicantFingerprint,applicant_inventory_problems:applicantProblems,
  summary:{courses:courses.courses.length,roles:expected.length,vacancy_rows:rows.length,expected_slots:allRows.reduce((n,r)=>n+r['应招人数'],0),
   filled_slots:allRows.every(r=>r['已招人数']!==null)?allRows.reduce((n,r)=>n+r['已招人数'],0):null}};
}
export function renderVacancies(report){
 const cell=v=>v==null?'待确认':String(v).replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
 const vacancies=report.rows.filter(r=>Number.isSafeInteger(r['已招人数'])&&r['已招人数']<r['应招人数'])
  .map(r=>({'课程':r['课程'],'岗位':r['岗位'],'招募进度（已招/应招）':`${r['已招人数']}/${r['应招人数']}`}));
 const pending=report.rows.filter(r=>r['核验状态']!=='已核实').map(r=>`待确认：${cell(r['课程'])}，${cell(r['岗位'])}，${cell(r['核验状态'])}。`);
 return ['# 未招满字段表',`读取时间：${report.captured_at}。项目ID：${report.project_id}。`,'',`| ${report.columns.join(' | ')} |`,
  `| ${report.columns.map(()=>'---').join(' | ')} |`,...vacancies.map(r=>`| ${report.columns.map(k=>cell(r[k])).join(' | ')} |`),'',
  report.all_full?'全部课程招满。未招满表为空。':'尚未全部招满，或存在待核实项。',...pending,...report.problems.map(p=>`待确认：${p}。`),'',
  '已招人数使用平台当前有效占用名额数。已领取未提交不等于名单已完整。',''].join('\n');
}
export async function runRecruitmentProgress(transport,courses,{exportWhenFull=true,receipt=null}={}){
 let report=buildRecruitmentProgress(await transport.readSnapshot(),courses);
 const result=()=>({...report,export_triggered:false,export_skipped:false,local_file_verified:false,roster_coverage_verified:false,roster_source_file:null,export_receipt:receipt});
 const receiptResult=()=>{
  if(receipt?.project_id!==report.project_id)return null;
  if(receipt.status!=='triggered')return {...result(),export_pending:'上次导出结果不明；先核对实际下载文件和回执，不自动重试'};
  if(!report.applicant_inventory_verified||!receipt.applicant_fingerprint)return {...result(),export_pending:'旧导出只有人数证据，无法核实当前报名名单与提交内容；重新读取报名全集并核对或重新导出Excel'};
  if(receipt.fingerprint===report.fingerprint&&receipt.applicant_fingerprint===report.applicant_fingerprint)return {...result(),export_skipped:true};
  return null;
 };
 if(!report.all_full||!exportWhenFull||report.sample_only)return result();
 const prior=receiptResult();if(prior)return prior;
 report=buildRecruitmentProgress(await transport.readSnapshot(),courses);
 if(!report.all_full||report.sample_only)return result();
 const latest=receiptResult();if(latest)return latest;
 if(typeof transport.exportAll!=='function')return {...result(),export_pending:'缺少导出全部操作'};
 receipt={project_id:report.project_id,fingerprint:report.fingerprint,applicant_fingerprint:report.applicant_fingerprint,status:'attempted',at:new Date().toISOString()};
 try{const exported=await transport.exportAll(report.project_id);receipt={...receipt,status:'triggered',filename:exported?.filename??null};
  return {...result(),export_triggered:true,export_receipt:receipt,export_result:exported??null};
 }catch(error){receipt={...receipt,status:'uncertain'};return {...result(),export_receipt:receipt,export_pending:error.message};}
}
export function prepareProgressBrowserScript(courses,target,fieldMap={},initialReceipt=null){
 if(!Number.isSafeInteger(target?.id)||target.id<=0)throw Error('进度读取需要目标项目ID');
 return `// 已登录贡献者平台：读取进度，全部招满时点击导出全部。\n(async()=>{\nconst VACANCY_COLUMNS=${JSON.stringify(VACANCY_COLUMNS)};\n${collectPrevious.toString()}\n${buildRecruitmentProgress.toString()}\n${renderVacancies.toString()}\n${runRecruitmentProgress.toString()}\n`+
 `const courses=${JSON.stringify(courses).replace(/</g,'\\u003c')};const target=${JSON.stringify(target).replace(/</g,'\\u003c')};const fieldMap=${JSON.stringify(fieldMap)};\n`+
 `if(location.origin!=='https://contributor.datawhale.cn')throw Error('请打开贡献者平台');\nconst request=async(method,route)=>{const token=localStorage.getItem('access_token');if(!token)throw Error('请先登录');const r=await fetch(route,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('读取失败 '+r.status);return r.json()};\n`+
 `const transport={readSnapshot:async()=>{const raw=await collectPrevious(request,target.id);return {...raw,expected_project:target,capture_kind:'project_tasks',complete:true,total:raw.tasks.length,field_map:fieldMap}},\n`+
 `exportAll:async()=>{const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(b=>b.textContent.trim()==='导出全部'&&b.getClientRects().length);if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true')throw Error('未找到唯一可用的导出全部按钮');if(!location.pathname.split('/').includes(String(target.id)))throw Error('请打开目标项目的任务发布界面');buttons[0].click();return {button_clicked:true,download_started:null,local_file_verified:false}}};\n`+
 `window.assistantRecruitProgressReceipts??={};const initialReceipt=${JSON.stringify(initialReceipt).replace(/</g,'\\u003c')};if(initialReceipt?.project_id===target.id&&!window.assistantRecruitProgressReceipts[target.id])window.assistantRecruitProgressReceipts[target.id]=initialReceipt;\n`+
 `window.assistantRecruitProgress=async()=>{const r=await runRecruitmentProgress(transport,courses,{receipt:window.assistantRecruitProgressReceipts?.[target.id]});if(r.export_receipt)window.assistantRecruitProgressReceipts[target.id]=r.export_receipt;window.assistantRecruitProgressResult=r;return {...r,table_markdown:renderVacancies(r)}};return window.assistantRecruitProgress();\n})();\n`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const [input,courseFile,out]=process.argv.slice(2);if(!input||!courseFile||!out)throw Error('用法：node 招募进度.mjs <任务JSON> <课程信息JSON> <新输出目录>');
  if(fs.existsSync(out))throw Error('输出目录已存在');const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
  const snapshot=read(input),courses=recruitmentCourseInput(read(courseFile)),report=buildRecruitmentProgress(snapshot,courses);fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'招募进度.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(out,'未招满字段表.md'),renderVacancies(report));
  fs.writeFileSync(path.join(out,'浏览器进度与满额导出.js'),prepareProgressBrowserScript(courses,snapshot.expected_project,snapshot.field_map,snapshot.export_receipt));
  console.log(JSON.stringify({all_full:report.all_full,vacancy_rows:report.rows.length,platform_read:false,export_triggered:false}));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
