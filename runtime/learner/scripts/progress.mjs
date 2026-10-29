import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analysePersisted,readRows} from './checkin.mjs';
import {normaliseRule,missingTasks} from './learning-record-contract.mjs';

// Same latest-record dataset as certificate eligibility; Task0 displayed separately.
export function buildProgress(analysis,rules){
 const seen=new Set();
 const courses=rules.map(rule=>{
  if(!rule.course||seen.has(rule.course))throw Error('课程规则缺失或重复');seen.add(rule.course);
  const normalized=normaliseRule(rule),required=normalized.tasks;
  const learners=analysis.learners.filter(l=>l.所学课程===rule.course).map(l=>{
   const completed=required.filter(t=>l.task_ids.includes(t));
   const missing=missingTasks(l.task_ids,rule);
   return {identity:l.identity,微信昵称:l.微信昵称,所学课程:l.所学课程,群号:l.群号,
    completed_tasks:completed,missing_tasks:missing,required_count:required.length,
    completed_count:completed.length,progress:required.length?completed.length/required.length:null,
    task0_submitted:l.task_ids.includes('task0'),eligible:missing.length===0,
    extra_tasks:l.task_ids.filter(t=>t!=='task0'&&!required.includes(t))};
  });
  return {course:rule.course,required_tasks:required,learners,observed_learners:learners.length,
   completed_learners:learners.filter(l=>l.eligible).length,
   effective_required_submissions:learners.reduce((n,l)=>n+l.completed_count,0)};
 });
 return {summary:analysis.summary,courses,latest_records:analysis.latest_records,anomalies:analysis.anomalies,
  population_note:'学习者数仅代表完整来源中可确认身份的已提交者；无报名名单时不推算未打卡人数或全体完成率'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [config,out,...files]=process.argv.slice(2);
 if(!config||!out||!files.length)throw Error('progress.mjs config.json output.json records.ndjson...');
 const options=JSON.parse(readFileSync(config,'utf8'));
 const result=buildProgress(analysePersisted(readRows(files),options),options.rules);
 mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
 console.log(JSON.stringify({courses:result.courses.length,...result.summary,output:out}));
}
