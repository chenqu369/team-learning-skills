import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {formulas} from './checkin.mjs';
import {save} from './lark.mjs';
const reminder='笔记发布在飞书文档、CSDN、GitHub 等平台时，请将权限设为“公开可访问”（飞书：分享 → 互联网上获得链接的人可阅读；GitHub：仓库设为 Public）';
export function prepareTemplate(source,config){
 const optionFields={所学课程:config.courses,群号:config.groups,任务名称:config.tasks};
 for(const [field,options] of Object.entries(optionFields)){
   if(!Array.isArray(options)||!options.length||options.some(x=>typeof x!=='string'||!x.trim())||new Set(options).size!==options.length)throw Error(`${field}须提供当期非空且不重复的选项`);
 }
 if(!config.name||!config.table_name)throw Error('须提供新Base名称与表名');
 const excluded=new Set([...(config.exclude_fields||[]),'父记录','可在右上角查看每个task的提交记录','进度学习者数','归并状态','课程匹配值','群号匹配值']),pending=[];
 const fields=[];
 for(const f of source.fields){
   if(excluded.has(f.name))continue;
   if(['formula','lookup','link','not_support','button'].includes(f.type)){pending.push({field:f.name,reason:'依赖来源实体或特殊配置，不能直接跨Base复刻'});continue;}
   const copied=Object.fromEntries(['name','type','description','style','multiple','options','default_value'].filter(k=>f[k]!==undefined).map(k=>[k,structuredClone(f[k])]));
   if(optionFields[f.name]){copied.options=optionFields[f.name].map(name=>({name}));delete copied.default_value;}
   fields.push(copied);
 }
 fields.sort((a,b)=>a.name==='微信昵称'?-1:b.name==='微信昵称'?1:0);
 const names=new Set(fields.map(f=>f.name));
 for(const name of ['微信昵称','所学课程','群号','任务名称','自动编号','提交时间','学习心得','证书昵称'])if(!names.has(name))throw Error(`缺少必需字段 ${name}`);
 if(fields.find(f=>f.name==='自动编号').style?.rules?.some(r=>r.type==='text'&&r.text!=='NO.'))throw Error('当前去重公式仅支持现有NO.编号规则，禁止直接迁移不同规则');
 const questions=source.questions.filter(q=>names.has(q.title)).map(q=>({field_name:q.title,title:q.title,required:q.required,description:q.title==='笔记链接'?reminder:(q.description||''),...(q.option_display_mode!=null?{option_display_mode:q.option_display_mode}:{}),...(q.visible_rule?{visible_rule:q.visible_rule}:{})}));
 const idName=Object.fromEntries(source.fields.map(f=>[f.id,f.name]));
 const visible=(source.assistant_visible||[]).map(id=>idName[id]||id).filter(name=>names.has(name));
 const schema=formulas(config.table_name);
 return {kind:'base_build_plan',online_verified:false,create:{name:config.name,table_name:config.table_name,time_zone:'Asia/Shanghai',fields},
   add_fields_after_table_creation:schema,questions,
   assistant_view:{name:'分课程视图-助教评选使用',visible_fields:[...visible,'打卡次数','进度统计状态'],group_config:['所学课程','群号','任务名称'].map(field=>({field,desc:false})),sort_config:[{field:'微信昵称',desc:false},{field:'任务名称',desc:true}],filter:{logic:'or',conditions:[['进度统计状态','==','有效'],['进度统计状态','==','待核对']]}},
   source_dashboard_count:source.dashboard_count??null,copy_dashboard:false,copy_records:false,enable_automation:false,identity_contract_required:true,pending,
   execution_order:['只在独立测试Base创建首表与基础字段','读取目标字段ID并逐一映射；表单题目引用已有字段，不创建同名新字段','先部署并回读统一身份与最新有效统计合同，再增加打卡次数；不生成内容覆盖工作流','创建表单并按来源顺序配置；验证笔记链接描述和必填项','配置助教视图并保留评选字段；不复制来源收集视图的特定课程筛选','测试重复新增与修订，首次编号保留，Task变化实时计数；通过前不启用身份登记工作流','确认仪表盘是否真实存在；无来源仪表盘不构造复制结果']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [configFile,output]=process.argv.slice(2);if(!configFile||!output)throw Error('base-template.mjs config.json output.json（仅生成计划，不写飞书）');
 const read=p=>JSON.parse(readFileSync(p,'utf8')),c=read(configFile);
 const source={fields:read(c.source_fields).data.fields,questions:read(c.source_questions).data.questions,assistant_visible:read(c.source_assistant_visible).data.visible_fields,dashboard_count:read(c.source_dashboards).data.total};
 const plan=prepareTemplate(source,c);save(output,plan);console.log(JSON.stringify({output,fields:plan.create.fields.length,questions:plan.questions.length,pending:plan.pending.length,online_verified:false}));
}
