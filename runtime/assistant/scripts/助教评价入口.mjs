import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runBuild} from './招募草稿.mjs';
import {readConfig,python,makeLark,load,save,SKILL_ROOT} from './运行环境.mjs';
import {runRoster,prepareRosterSheet} from './飞书清单同步.mjs';
import {prepareBrowserScript} from './招募平台草稿.mjs';
import {evaluationPreview} from './单维表评价.mjs';
import {runPublication} from './核对后发布.mjs';
import {runAwards} from './等级发放.mjs';
import {collectPrevious} from './上期招募.mjs';
import {projectPayload,runProjectPreparation,prepareProjectBrowserScript} from './招募项目.mjs';
import {buildRecruitmentProgress,renderVacancies,prepareProgressBrowserScript} from './招募进度.mjs';
import {usageReport} from './成本记录.mjs';
import {recruitmentCourseInput} from '../../shared/course-info.mjs';
import {assertWorkflowAudit} from '../../shared/workflow-audit.mjs';
export function evaluationCommand(action,ctx){
  throw Error('旧评价接口已移除；改用 EvaluationPreview 读取共享单维表，不调用多维表构建器');
}
export function executionInputFiles(action,ctx){
 const paths={
  'recruit-project':['recruitment.project_file','recruitment.project_adapter_file'],
  'recruit-preview':['recruitment.courses_file','recruitment.overrides_file','recruitment.previous_snapshot'],
  'recruit-progress':['recruitment.courses_file','recruitment.progress_snapshot','recruitment.progress_receipt_file'],
  'recruit-publish':['recruitment.courses_file','publication.approval_file','publication.adapter_file'],
  'roster-sheet-prepare':['roster.courses_file'],
 };
 if(action.startsWith('evaluation-'))paths[action]=[ctx.config.evaluation?.people_file?'evaluation.people_file':'evaluation.source_snapshot','evaluation.decisions_file',...(action==='evaluation-awards'?['evaluation.adapter_file']:[])];
 if(['roster-preview','roster-read','roster-sync'].includes(action))paths[action]=['roster.courses_file','roster.export_file','roster.offline_workbook','roster.target_snapshot','roster.aliases_file'];
 return [ctx.location,...(paths[action]??[]).map(key=>key.split('.').reduce((v,k)=>v?.[k],ctx.config)).filter(Boolean).map(ctx.resolve)];
}
export async function main(argv=process.argv.slice(2)){
  const action=argv[0];
  if(!action||action==='help'||action==='--help'){
    console.log('组队学习助教：health | recruit-project [--apply] | recruit-source | usage-report | recruit-preview | recruit-progress | recruit-publish [--apply] | roster-preview | roster-sheet-prepare [--apply] | roster-read | roster-sync --apply | evaluation-preview | evaluation-awards [--apply]\n招募项目先查重，再创建草稿并回读；roster-sheet-prepare 默认只读预检，--apply 才新建当期月份子表。');return;
  }
  const allowed=new Set(['health','recruit-project','recruit-source','usage-report','recruit-preview','recruit-progress','recruit-publish','roster-preview','roster-sheet-prepare','roster-read','roster-sync','evaluation-preview','evaluation-awards']);
  if(!allowed.has(action))throw Error('旧评价接口或未知操作已移除；请查看 help');
  const pairs={},flags=new Set();
  for(let i=1;i<argv.length;i++){
    if(argv[i]==='--apply'){flags.add('apply');continue;}
    if(!['--config','--out','--audit'].includes(argv[i])||!argv[i+1])throw Error('未知参数或缺少值：'+argv[i]);
    pairs[argv[i].slice(2)]=argv[++i];
  }
  if(!pairs.config)throw Error('缺少 --config');
  const ctx=readConfig(pairs.config),{config,resolve}=ctx;
  if(action==='health'){
    console.log(JSON.stringify({node:process.version,python:python(config),evaluation:'single_sheet; opening_and_closing; centralized_awards',skill_root:SKILL_ROOT}));return;
  }
  const audit=pairs.audit?assertWorkflowAudit(pairs.audit,action.startsWith('evaluation-')?'evaluation':'recruitment',executionInputFiles(action,ctx)):null;
  if(flags.has('apply')&&!audit)throw Error('实际执行缺 --audit 全流程核对输入.json；先核对当前全量来源及范围');
  const out=pairs.out?path.resolve(pairs.out):resolve(config.output_dir||'');
  if(!config.output_dir&&!pairs.out)throw Error('缺少 output_dir 或 --out；每次使用独立运行目录');
  if(fs.existsSync(out))throw Error('输出目录已存在，保留旧结果；请更换运行目录');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  let result;
  if(action==='usage-report'){
    if(flags.has('apply'))throw Error('成本记录不接受--apply');result=usageReport(ctx,out);
  }else if(action==='recruit-project'){
    const settings=config.recruitment||{};
    if(!settings.project_file)throw Error('项目准备需要 recruitment.project_file');
    const input=load(resolve(settings.project_file));
    projectPayload(input,{apply:flags.has('apply')});
    if(flags.has('apply')&&!settings.project_adapter_file)throw Error('缺少通过验收的 project_adapter_file；不能用本地 --apply 冒充线上创建，请使用浏览器稿');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out,'浏览器项目准备稿.js'),prepareProjectBrowserScript(input));
    if(settings.project_adapter_file){
      const adapter=await import(pathToFileURL(resolve(settings.project_adapter_file)).href);
      if(typeof adapter.createTransport!=='function')throw Error('项目适配器缺少 createTransport');
      const transport=await adapter.createTransport(config);
      result=await runProjectPreparation(transport,input,{apply:flags.has('apply')});
    }else result={script_created:true,platform_read:false,project_created:false,apply:false};
    save(path.join(out,'项目准备结果.json'),result);
  }else if(action==='recruit-source'){
    if(flags.has('apply'))throw Error('上期来源只读，不接受--apply');
    const id=config.recruitment?.previous_project_id;
    if(!Number.isInteger(id)||id<=0)throw Error('需要recruitment.previous_project_id');
    fs.mkdirSync(out);
    const browser=`(async()=>{${collectPrevious.toString()}\nif(location.origin!=='https://contributor.datawhale.cn')throw Error('错误站点');const request=async(method,route)=>{const token=localStorage.getItem('access_token');if(!token)throw Error('未登录');const r=await fetch(route,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw Error('读取失败 '+r.status);return r.json()};return await collectPrevious(request,${id});})().catch(e=>({error:e.message}))`;
    fs.writeFileSync(path.join(out,'上期来源读取.js'),browser);result={previous_project_id:id,script_created:true,platform_read:false};
  }else if(['recruit-publish','evaluation-awards'].includes(action)){
    const settings=action==='recruit-publish'?config.publication:config.evaluation;
    if(!settings?.adapter_file)throw Error('尚未配置通过验收的平台适配器；不能宣称已发布或发放');
    const adapter=await import(pathToFileURL(resolve(settings.adapter_file)).href);
    const transport=await adapter.createTransport(config);
    fs.mkdirSync(out);
    for(const method of ['publishTask','publishProject','completeTask','setNoCertificate','setGradeAndIssueCertificate','grantCoins'])if(typeof transport[method]==='function'){
      const original=transport[method].bind(transport);
      transport[method]=async (...args)=>{
        const mark={method,id:typeof args[0]==='object'?args[0].assignment_id:args[0]};
        fs.appendFileSync(path.join(out,'执行台账.jsonl'),JSON.stringify({...mark,status:'attempt',at:new Date().toISOString()})+'\n');
        try{const result=await original(...args);fs.appendFileSync(path.join(out,'执行台账.jsonl'),JSON.stringify({...mark,status:'returned',at:new Date().toISOString()})+'\n');return result;}
        catch(e){fs.appendFileSync(path.join(out,'执行台账.jsonl'),JSON.stringify({...mark,status:'uncertain',at:new Date().toISOString()})+'\n');throw e;}
      };
    }
    if(action==='recruit-publish'){
      if(!settings.approval_file)throw Error('缺少具体批次的人工核对记录');
      if(!config.recruitment?.courses_file)throw Error('发布前缺少 recruitment.courses_file 课程信息 JSON');
      result=await runPublication(transport,load(resolve(settings.approval_file)),{apply:flags.has('apply'),courses:recruitmentCourseInput(load(resolve(config.recruitment.courses_file)))});
    }else{
      const preview=path.join(out,'preview');evaluationPreview(ctx,preview);
      result=await runAwards(transport,load(path.join(preview,'评价与发放预览.json')),{apply:flags.has('apply')});
    }
    if(!fs.existsSync(out))fs.mkdirSync(out);save(path.join(out,'执行核验结果.json'),result);
  }else if(action==='evaluation-preview'){
    if(flags.has('apply'))throw Error('评价预览不能带--apply');
    result=evaluationPreview(ctx,out);
  }else if(action==='recruit-progress'){
    if(flags.has('apply'))throw Error('本地进度读取不接受--apply；导出在已登录浏览器稿中执行');
    const settings=config.recruitment||{};
    if(!settings.courses_file||!settings.progress_snapshot)throw Error('进度读取需要courses_file和progress_snapshot');
    const snapshot=load(resolve(settings.progress_snapshot)),courses=recruitmentCourseInput(load(resolve(settings.courses_file)));
    if(config.sample_only)courses.sample_only=true;
    const report=buildRecruitmentProgress(snapshot,courses);fs.mkdirSync(out);
    save(path.join(out,'招募进度.json'),report);fs.writeFileSync(path.join(out,'未招满字段表.md'),renderVacancies(report));
    const receipt=settings.progress_receipt_file?load(resolve(settings.progress_receipt_file)):snapshot.export_receipt;
    fs.writeFileSync(path.join(out,'浏览器进度与满额导出.js'),prepareProgressBrowserScript(courses,snapshot.expected_project,snapshot.field_map,receipt));
    result={all_full:report.all_full,vacancy_rows:report.rows.length,platform_read:false,export_triggered:false};
  }else if(action==='recruit-preview'){
    if(flags.has('apply'))throw Error('招募预览不能带--apply');
    const settings=config.recruitment||{};
    if(!settings.courses_file||!settings.overrides_file)throw Error('招募缺少上一步的课程信息 JSON 或本期配置文件');
    result=runBuild({roles:path.join(SKILL_ROOT,'assets','岗位模板.json'),courses:resolve(settings.courses_file),overrides:resolve(settings.overrides_file),previous:settings.previous_snapshot?resolve(settings.previous_snapshot):undefined,out});
    const overrides=load(resolve(settings.overrides_file));
    prepareBrowserScript(out,overrides.target_project_id,config.period,load(path.join(out,'助教课程事实.json')),settings.progress_field_map);
  }else if(action==='roster-sheet-prepare'){
    result=prepareRosterSheet(ctx,out,makeLark(config),{apply:flags.has('apply')});
  }else{
    if(action==='roster-sync'&&!flags.has('apply'))throw Error('roster-sync 需要 --apply；未授权写入时使用 roster-read 预览');
    if(action!=='roster-sync'&&flags.has('apply'))throw Error('预览命令不能带 --apply');
    result=runRoster(ctx,out,makeLark(config),{apply:action==='roster-sync',online:action!=='roster-preview'});
  }
  console.log(JSON.stringify({...result,workflow_audit:audit??{ready:false,completion_verified:false,reminder:'仅本步骤结果，交接/写入前须运行全流程核对'}}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
