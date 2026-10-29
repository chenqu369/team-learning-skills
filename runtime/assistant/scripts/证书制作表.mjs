import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';

const scalar=v=>Array.isArray(v)?v.length===1?scalar(v[0]):'':v==null?'':String(v);
const tasks=v=>scalar(v).split(/[、,，\s]+/u).filter(Boolean).map(t=>t.toLowerCase());
const groups=v=>scalar(v).split(/[;；\n]+/u).filter(Boolean).map(t=>t.split('|').map(s=>s.trim().toLowerCase()));
const completed=new Set(['已完成','已制作','制作完成']);
export const columns=['证书昵称','所学课程','群号','证书类型','微信昵称','证书编号','课程编号','营期编号','营期名','结营日期'];
export function validFilename(name){
 return typeof name==='string'&&!!name&&name===name.trim()&&!/[<>:"/\\|?*\x00-\x1f]/u.test(name)
  &&! /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name)&&!['无','？','?','.','..'].includes(name)&&Buffer.byteLength(name+'优秀学习者证书.png','utf8')<=180;
}
export function buildProduction({normal,awards,courses,config},contract){
 const people=[],pending=[],excluded=[],keys=new Map(),courseMap=new Map();
 const deferred=new Set(config.deferred_courses??[]);
 // 人工结营名单字段在表单迁移后改名过一次（旧名带"（不参与飞书打卡的课程填）"后缀）。
 // 按顺序尝试多个候选名并在全部缺失时返回空，避免再次因改名而静默漏采；可用配置的 manual_graduation_field 直接指定。
 const manualFields=[...(config.manual_graduation_field?[config.manual_graduation_field]:[]),'结营证书名单','结营证书名单（不参与飞书打卡的课程填）'];
 const manualValue=a=>{for(const f of manualFields){const v=scalar(a[f]);if(v!=='')return v;}return '';};
 const scope=(course,group)=>JSON.stringify([course,group]);
 const manualSources=(config.graduation_source_policy??'form_first')==='form_first'?awards.filter(a=>manualValue(a)!==''):[];
 const manualScopes=new Set(manualSources.map(a=>scope(scalar(a.课程名),scalar(a.群号))));
 const manualScopeCounts=new Map();
 for(const a of manualSources){const k=scope(scalar(a.课程名),scalar(a.群号));manualScopeCounts.set(k,(manualScopeCounts.get(k)??0)+1);}
 const manualApprovals=[];
 const formIdentity=(a,name)=>'FORM-'+crypto.createHash('sha256').update(JSON.stringify([config.base_token,config.period,scalar(a.课程名),a.record_id,name])).digest('hex').slice(0,20);
 for(const c of courses){const name=scalar(c.所学课程);courseMap.set(name,courseMap.has(name)?null:c);}
 const rules=[];
 for(const [name,c] of courseMap)if(c&&scalar(c.规则状态)==='已明确'){
  rules.push({course:name,role:config.normal_role,tasks:tasks(c.必需Task),any_groups:groups(c.任选Task组)});
 }
 const issue=(row,reason,role=scalar(row.角色),name=scalar(row.证书昵称))=>pending.push({来源记录ID:row.record_id,所学课程:scalar(row.所学课程)||scalar(row.课程名),群号:scalar(row.群号),角色:role,证书昵称:name,原因:reason});
 const add=(r,role,name,basis,awardId,manual=false)=>{
  const course=scalar(r.所学课程),c=courseMap.get(course),stable=scalar(r.系统学习者标识);
  const reasons=[];
  if(!stable)reasons.push('缺固定学习者身份');
  if(!validFilename(name))reasons.push('证书昵称缺失、占位或不能原样作为PNG文件名前缀');
  if(!config.role_codes?.[role])reasons.push('角色编码待确认');
  if(!c)reasons.push('课程参数缺失或不唯一');
  else for(const field of ['课程编号','营期编号','营期名','结营日期'])if(!scalar(c[field]))reasons.push('待补'+field);
  if(reasons.length){issue({...r,record_id:awardId||r.record_id},reasons.join('；'),role,name);return;}
  const ledgerKey=JSON.stringify([course,scalar(c.营期编号),role,stable]);
  const person={证书昵称:name,所学课程:course,群号:scalar(r.群号),证书类型:role,角色:role,微信昵称:scalar(r.微信昵称),稳定人员标识:stable,证书编号:config.certificate_ledger?.entries?.[ledgerKey]?.number??'',学习者编号:stable.startsWith('FORM-')?'':stable,
   营期:scalar(c.营期编号),名单核准状态:role===config.normal_role&&!manual?'自动通过':'已核准',制证依据:basis,
   来源记录ID:r.record_id,优秀申报记录ID:awardId||'',...Object.fromEntries(['课程编号','营期编号','营期名','结营日期'].map(f=>[f,scalar(c[f])]))};
  if(manual){
   person.资格核验={contract_version:contract.CONTRACT_VERSION,eligible:true,person_id:stable,course,source_kind:'manual_graduation',source_record_ids:[awardId],original_name:name};
  }else if(role===config.normal_role){
   const rule=rules.find(v=>v.course===course),ids=tasks(r.有效Task列表);
   try{
    if(!rule)throw Error('当前Task规则待确认');
    if(tasks(r.规则必需Task).join('|')!==rule.tasks.join('|')||JSON.stringify(groups(r.规则任选Task组))!==JSON.stringify(rule.any_groups))throw Error('名单采用规则与当前课程规则不一致');
    const missing=contract.missingTasks(ids,rule);if(missing.length)throw Error('缺有效Task：'+missing.join('、'));
    const sourceIds=[...new Set([scalar(r.来源记录ID),...(r.来源打卡??[]).map(v=>v.id)].filter(Boolean))];
    if(!sourceIds.length)throw Error('缺真实打卡来源');
    person.资格核验={contract_version:contract.CONTRACT_VERSION,eligible:true,person_id:stable,course,task_ids:ids,rule,source_record_ids:sourceIds};
   }catch(error){issue(r,error.message,role,name);return;}
  }
  const key=JSON.stringify([person.营期,course,stable,role]);
  if(keys.has(key)){
   const old=keys.get(key);if(old.证书昵称!==name){issue(r,'同固定身份同课程同角色昵称冲突',role,name);const idx=people.indexOf(old);if(idx>=0)people.splice(idx,1);old.conflict=true;}
   return;
  }
  keys.set(key,person);people.push(person);
 };
 for(const r of normal){
  if(deferred.has(scalar(r.所学课程))){excluded.push({record_id:r.record_id,所学课程:scalar(r.所学课程),原因:'用户明确暂缓发证'});continue;}
  if(scalar(r.角色)===config.normal_role&&scalar(r.群号).split('、').some(g=>manualScopes.has(scope(scalar(r.所学课程),g)))){excluded.push({record_id:r.record_id,原因:'该课程群号优先采用人工结营名单'});continue;}
  if(scalar(r.角色)!==config.normal_role){excluded.push({record_id:r.record_id,原因:'非普通角色，按优秀申报确认处理'});continue;}
  if(scalar(r.名单归并状态)!=='主记录'||scalar(r.结营判定)!=='符合结营要求'||completed.has(scalar(r.制作状态))){excluded.push({record_id:r.record_id,原因:completed.has(scalar(r.制作状态))?'已制作':scalar(r.名单归并状态)!=='主记录'?'非主记录':scalar(r.结营判定)});continue;}
  if(scalar(r.制作状态)&&scalar(r.制作状态)!=='待制作'){issue(r,'制作状态要求复核');continue;}
  if(scalar(r.角色)!==config.normal_role){issue(r,'普通证书角色与本批设置不一致');continue;}
  add(r,config.normal_role,scalar(r.证书昵称),'当前结营主记录自动通过');
 }
 for(const a of manualSources){
  const course=scalar(a.课程名),group=scalar(a.群号);
  if(deferred.has(course)||scalar(a.是否结营)==='否'){excluded.push({record_id:a.record_id,所学课程:course,原因:deferred.has(course)?'用户明确暂缓发证':'尚未结营'});continue;}
  if(!course||!group){issue(a,'人工结营申报缺课程或群号',config.normal_role);continue;}
  if(manualScopeCounts.get(scope(course,group))!==1){issue(a,'同课程群号存在多个人工结营申报，需确认当前有效名单',config.normal_role);continue;}
  const names=[...new Set(manualValue(a).split(/\r?\n/).filter(n=>n!==''&&n!=='无'))];
  const basis='当前人工结营申报名单优先于系统Task条件';
  manualApprovals.push({record_id:a.record_id,course,group,names,basis});
  for(const name of names){
   const candidates=normal.filter(r=>scalar(r.名单归并状态)==='主记录'&&scalar(r.角色)===config.normal_role&&scalar(r.所学课程)===course&&scalar(r.群号).split('、').includes(group)&&scalar(r.证书昵称)===name);
   if(candidates.length>1){issue(a,'人工结营姓名对应多个主记录，待核对',config.normal_role,name);continue;}
   const match=candidates[0];
   if(match&&completed.has(scalar(match.制作状态))){excluded.push({record_id:a.record_id,证书昵称:name,原因:'人工结营条目已制作'});continue;}
   if(match&&scalar(match.制作状态)&&scalar(match.制作状态)!=='待制作'){issue(a,'人工结营主记录制作状态要求复核',config.normal_role,name);continue;}
   const source=match?{...match,群号:group}:{record_id:a.record_id,所学课程:course,群号:group,系统学习者标识:formIdentity(a,name),微信昵称:''};
   add(source,config.normal_role,name,basis,a.record_id,true);
  }
 }
 for(const a of awards)for(const [field,role] of [['优秀学习者名单（没有可以填无）','优秀学习者证书'],['优秀队长名单（没有可以填无）','优秀队长证书']]){
  if(deferred.has(scalar(a.课程名))){if(scalar(a[field])&&scalar(a[field])!=='无')excluded.push({record_id:a.record_id,所学课程:scalar(a.课程名),角色:role,原因:'用户明确暂缓发证'});continue;}
  for(const name of scalar(a[field]).split(/\r?\n/).filter(v=>v!==''&&v!=='无')){
   if(scalar(a.是否结营)!=='是'){issue(a,'申报未确认结营',role,name);continue;}
   if(!validFilename(name)){issue(a,'申报名含占位或非法文件名',role,name);continue;}
   const basis='当前已结营人工优秀申报：'+a.record_id;
   const candidates=normal.filter(r=>scalar(r.名单归并状态)==='主记录'&&scalar(r.角色)===config.normal_role&&scalar(r.所学课程)===scalar(a.课程名)&&scalar(r.群号).split('、').includes(scalar(a.群号))
    &&[scalar(r.证书昵称),scalar(r.微信昵称)].includes(name));
   const ids=new Set(candidates.map(r=>scalar(r.系统学习者标识)).filter(Boolean));
   if(config.award_source_policy==='form_first'){
    // FORM IDs identify an approved submission entry; they do not claim a Base learner identity.
    const exact=candidates.filter(r=>scalar(r.证书昵称)===name||!scalar(r.证书昵称));
    const match=exact.length===1&&scalar(exact[0].系统学习者标识)?exact[0]:null;
    const stable=match?scalar(match.系统学习者标识):formIdentity(a,name);
    const source=match?{...match,群号:a.群号}:{record_id:a.record_id,所学课程:a.课程名,群号:a.群号,系统学习者标识:stable,微信昵称:''};
    const existing=normal.filter(r=>scalar(r.名单归并状态)==='主记录'&&scalar(r.所学课程)===scalar(a.课程名)&&scalar(r.系统学习者标识)===stable&&scalar(r.角色)===role);
    if(existing.some(r=>completed.has(scalar(r.制作状态)))){excluded.push({record_id:a.record_id,原因:'该身份同角色优秀证书已制作'});continue;}
    if(existing.length>1||existing.some(r=>scalar(r.制作状态)&&scalar(r.制作状态)!=='待制作')){issue(a,'已有优秀制作记录冲突或暂停',role,name);continue;}
    add(source,role,name,basis,a.record_id);
    continue;
   }
   if(ids.size!==1||candidates.length!==1){issue(a,'申报昵称未匹配唯一当前主记录身份',role,name);continue;}
   const candidate=candidates[0];
   if(scalar(candidate.证书昵称)&&scalar(candidate.证书昵称)!==name){issue(a,'申报姓名与当前主记录制证昵称不一致，待确认',role,name);continue;}
   const existing=normal.filter(r=>scalar(r.名单归并状态)==='主记录'&&scalar(r.所学课程)===scalar(a.课程名)&&scalar(r.系统学习者标识)===scalar(candidate.系统学习者标识)&&scalar(r.角色)===role);
   if(existing.length>1){issue(a,'同固定身份已有多个优秀主记录，待确认',role,name);continue;}
   if(existing.some(r=>completed.has(scalar(r.制作状态)))){excluded.push({record_id:a.record_id,原因:'该身份同角色优秀证书已制作'});continue;}
   if(existing.some(r=>scalar(r.证书昵称)!==name||(scalar(r.制作状态)&&scalar(r.制作状态)!=='待制作'))){issue(a,'已有优秀名单制证昵称或制作状态要求复核',role,name);continue;}
   add(candidates[0],role,name,basis,a.record_id);
  }
 }
 const issues=contract.validatePersonnel(people,config.normal_role,rules,manualApprovals);if(issues.length)throw Error(issues.join('；'));
 const renderConfig={...config,courses:{},rules,manual_graduation_approvals:manualApprovals,approved_statuses:['自动通过','已核准']};
 for(const [name,c] of courseMap)if(c)renderConfig.courses[name]=Object.fromEntries(['课程编号','营期编号','营期名','结营日期'].map(f=>[f,scalar(c[f])]));
 delete renderConfig.approved_awards;delete renderConfig.inputs;delete renderConfig.contract_path;delete renderConfig.certificate_sheet_token;delete renderConfig.certificate_ledger;
 return {people,pending,excluded,renderConfig};
}
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const csv=(headers,rows)=>'\uFEFF'+[headers,...rows.map(r=>headers.map(h=>r[h]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
function readSnapshot(file){
 const manifest=JSON.parse(fs.readFileSync(file.replace(/\.ndjson$/u,'.manifest.json'),'utf8'));
 const rows=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
 if(manifest.has_more!==false||manifest.records_count!==rows.length||manifest.query_context?.record_scope!=='all_records')throw Error('来源不是完整全表导出：'+file);
 return {rows,manifest,sha256:sha(file)};
}
export async function main(configFile,out){
 const root=path.dirname(path.resolve(configFile)),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 if(config.final_roster_source)throw Error('已迁入终版Base，请使用最终证书名单.mjs读取当前终版，不重新覆盖最终人工名单');
 if(config.certificate_ledger_path)config.certificate_ledger=JSON.parse(fs.readFileSync(path.resolve(root,config.certificate_ledger_path),'utf8'));
 const contract=await import(pathToFileURL(path.resolve(root,config.contract_path)).href);
 const snapshots=Object.fromEntries(Object.entries(config.inputs).map(([key,value])=>[key,readSnapshot(path.resolve(root,value))]));
 for(const [key,s] of Object.entries(snapshots))if(s.manifest.base_token!==config.base_token||s.manifest.table_id!==config.table_ids[key])throw Error('来源Base/表ID不匹配：'+key);
 const result=buildProduction({normal:snapshots.normal.rows,awards:snapshots.awards.rows,courses:snapshots.courses.rows,config},contract);
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('输出目录非空，请使用新目录');
 fs.mkdirSync(out,{recursive:true});
 const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n','utf8');
 write('制证人员.json',result.people);write('制证配置.json',result.renderConfig);write('待确认.json',result.pending);write('排除记录.json',result.excluded);
 fs.writeFileSync(path.join(out,'飞书终版证书制作单维表.csv'),csv(columns,result.people));
 fs.writeFileSync(path.join(out,'待确认.csv'),csv(['证书昵称','所学课程','群号','角色','来源记录ID','原因'],result.pending));
 write('导出验收.json',{at:new Date().toISOString(),people:result.people.length,normal:result.people.filter(p=>p.角色===config.normal_role).length,awards:result.people.filter(p=>p.角色!==config.normal_role).length,pending:result.pending.length,excluded:result.excluded.length,
  sources:Object.fromEntries(Object.entries(snapshots).map(([k,s])=>[k,{base_token:s.manifest.base_token,table_id:s.manifest.table_id,rev:s.manifest.rev,records_count:s.rows.length,has_more:s.manifest.has_more,sha256:s.sha256}])),files:Object.fromEntries(['制证人员.json','制证配置.json','飞书终版证书制作单维表.csv'].map(f=>[f,sha(path.join(out,f))]))});
 console.log(JSON.stringify({people:result.people.length,pending:result.pending.length,output:path.resolve(out)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==4)throw Error('node 证书制作表.mjs <配置.json> <新输出目录>');
 await main(process.argv[2],process.argv[3]);
}
