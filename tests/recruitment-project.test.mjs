import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {runProjectPreparation,prepareProjectBrowserScript} from '../runtime/assistant/scripts/招募项目.mjs';

const project={name:'第86期组队学习助教招募（测试草稿）',project_type:'assistant',assistant_category:'team_learning',assistant_period:'86'};
const input={test_only:true,source_note:'用户明确确认第86期测试草稿及数字期数',project};
function auditFixture(dir,config){
 const universe=path.join(dir,'scope.json');fs.writeFileSync(universe,JSON.stringify([{id:'current-project'}]));
 const adapter=path.join(dir,'adapter.mjs');
 const sources=[universe,config,path.join(dir,'project.json'),...(fs.existsSync(adapter)?[adapter]:[])].map((file,i)=>({id:'input-'+i,kind:i===0?'manual':'file',used:{path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')},current:{path:file,captured_at:new Date().toISOString()}}));
 const audit=path.join(dir,'audit.json');fs.writeFileSync(audit,JSON.stringify({schema_version:1,workflow:'recruitment',phase:'preflight',run_started_at:new Date(Date.now()-60000).toISOString(),sources,coverage:{expected:{path:universe,key_fields:['id']},actual:[{path:universe,key_fields:['id'],status:'planned'}]}}));return audit;
}

function platform(items=[]){
  const calls=[];
  return {calls,
    listProjects:async(page,pageSize)=>{calls.push(['list',page,pageSize]);return {items,total:items.length}},
    getProject:async id=>{calls.push(['get',id]);return items.find(x=>x.id===id)},
    createProject:async body=>{calls.push(['create',body]);const created={id:1001,status:'draft',...body};items.push(created);return created}};
}

test('只读预检查完项目列表而不创建',async()=>{
  const api=platform();
  const result=await runProjectPreparation(api,input);
  assert.equal(result.action,'create_draft');
  assert.equal(result.apply,false);
  assert.equal(api.calls.some(x=>x[0]==='create'),false);
});

test('已有同身份草稿按 ID 回读并复用，不重复创建',async()=>{
  const api=platform([{id:42,status:'draft',...project}]);
  const result=await runProjectPreparation(api,input,{apply:true});
  assert.equal(result.action,'reuse_draft');
  assert.equal(result.project_id,42);
  assert.equal(api.calls.some(x=>x[0]==='create'),false);
});

test('无匹配时仅创建一次并定向回读草稿，创建载荷不含 status',async()=>{
  const api=platform();
  const result=await runProjectPreparation(api,input,{apply:true});
  assert.equal(result.action,'created_draft');
  assert.equal(result.project_id,1001);
  assert.equal(result.readback.status,'draft');
  assert.equal(api.calls.filter(x=>x[0]==='create').length,1);
  assert.equal(Object.hasOwn(api.calls.find(x=>x[0]==='create')[1],'status'),false);
});

test('同名不同身份、分页不完整、模拟输入均停止创建',async()=>{
  const sameName=platform([{id:43,status:'draft',...project,assistant_period:'85'}]);
  await assert.rejects(runProjectPreparation(sameName,input,{apply:true}),/同名|身份/);
  assert.equal(sameName.calls.some(x=>x[0]==='create'),false);
  const incomplete=platform();incomplete.listProjects=async()=>({items:[],total:1});
  await assert.rejects(runProjectPreparation(incomplete,input,{apply:true}),/分页|完整/);
  const sample=platform();
  await assert.rejects(runProjectPreparation(sample,{...input,sample_only:true},{apply:true}),/Sample|模拟/);
  assert.equal(sample.calls.some(x=>x[0]==='create'),false);
  await assert.rejects(runProjectPreparation(platform(),{...input,project:{...project,certificate_scene:'unknown'}},{apply:true}),/字段未核实/);
});

test('写入返回不明时先查列表，不自动重发',async()=>{
  const api=platform();
  api.createProject=async()=>{api.calls.push(['create']);throw Error('网络中断')};
  await assert.rejects(runProjectPreparation(api,input,{apply:true}),/结果不明|回读/);
  assert.equal(api.calls.filter(x=>x[0]==='create').length,1);
});

test('浏览器稿先只读预检，明确调用 true 后才创建并回读',async()=>{
  let created=null;
  const fetch=async(route,options={})=>{
    if(route.includes('?'))return {ok:true,json:async()=>({items:created?[created]:[],total:created?1:0})};
    if(options.method==='POST'){
      created={id:1001,status:'draft',...JSON.parse(options.body)};
      return {ok:true,json:async()=>created};
    }
    return {ok:true,json:async()=>created};
  };
  const context={location:{origin:'https://contributor.datawhale.cn'},localStorage:{getItem:()=> 'test-token'},fetch,window:{}};
  const preview=await vm.runInNewContext(prepareProjectBrowserScript(input),context);
  assert.equal(preview.action,'create_draft');
  assert.equal(created,null);
  const applied=await context.window.assistantProjectRun(true);
  assert.equal(applied.action,'created_draft');
  assert.equal(applied.project_id,1001);
  assert.equal(created.status,'draft');
});

test('recruit-project 命令生成浏览器稿；无适配器时 --apply 不冒充已创建',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recruit-project-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const projectFile=path.join(dir,'project.json');fs.writeFileSync(projectFile,JSON.stringify(input));
  const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify({period:'2026-10',recruitment:{project_file:'project.json'}}));
  const entry=fileURLToPath(new URL('../runtime/assistant/scripts/助教评价入口.mjs',import.meta.url));
  const preview=spawnSync(process.execPath,[entry,'recruit-project','--config',configFile,'--out',path.join(dir,'preview')],{encoding:'utf8'});
  assert.equal(preview.status,0,preview.stderr);
  assert.equal(JSON.parse(preview.stdout).platform_read,false);
  assert.equal(fs.existsSync(path.join(dir,'preview','浏览器项目准备稿.js')),true);
  const noAudit=spawnSync(process.execPath,[entry,'recruit-project','--config',configFile,'--out',path.join(dir,'no-audit'),'--apply'],{encoding:'utf8'});
  assert.notEqual(noAudit.status,0);assert.match(noAudit.stderr,/--audit/);assert.equal(fs.existsSync(path.join(dir,'no-audit')),false);
  const apply=spawnSync(process.execPath,[entry,'recruit-project','--config',configFile,'--out',path.join(dir,'apply'),'--apply','--audit',auditFixture(dir,configFile)],{encoding:'utf8'});
  assert.notEqual(apply.status,0);
  assert.match(apply.stderr,/project_adapter_file/);
});

test('recruit-project --apply 通过适配器写入后保存真实 ID 与回读',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recruit-project-adapter-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify(input));
  fs.writeFileSync(path.join(dir,'adapter.mjs'),`let created=null;
export async function createTransport(){return {
  listProjects:async()=>({items:created?[created]:[],total:created?1:0}),
  getProject:async()=>created,
  createProject:async body=>(created={id:1001,status:'draft',...body})
}};`);
  const config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({period:'2026-10',recruitment:{project_file:'project.json',project_adapter_file:'adapter.mjs'}}));
  const entry=fileURLToPath(new URL('../runtime/assistant/scripts/助教评价入口.mjs',import.meta.url));
  const out=path.join(dir,'apply');
  const processResult=spawnSync(process.execPath,[entry,'recruit-project','--config',config,'--out',out,'--apply','--audit',auditFixture(dir,config)],{encoding:'utf8'});
  assert.equal(processResult.status,0,processResult.stderr);
  const result=JSON.parse(fs.readFileSync(path.join(out,'项目准备结果.json'),'utf8'));
  assert.equal(result.project_id,1001);
  assert.equal(result.readback.status,'draft');
});
