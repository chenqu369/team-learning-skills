import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {buildCourseOutputs} from '../../shared/course-info.mjs';
import {analyseIdentity,scalar,nameBad,missingTasks,CONTRACT_VERSION} from './learning-record-contract.mjs';
import {assertWorkflowAudit} from '../../shared/workflow-audit.mjs';

const key=(period,course,id)=>JSON.stringify([period,course,id]);
const normalPeriod=value=>/^\d{6}$/.test(value)?`${value.slice(0,4)}-${value.slice(4)}`:value;
const validName=name=>!nameBad(name)&&name===name.trim()&&!/[<>:"/\\|?*\x00-\x1f]/u.test(name)&&!/[. ]$/.test(name)&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
const role=p=>scalar(p.证书类型)||scalar(p.角色);
const identity=p=>scalar(p.稳定人员标识)||scalar(p.person_id);
const certName=p=>scalar(p.证书昵称)||scalar(p.微信昵称);
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function graduate(input){
 const {course_info:info,learner}=buildCourseOutputs(input.course_info);
 const skipped_courses=info.courses.filter(c=>c.graduation_mode==='manual_roster').map(c=>({course:c.checkin_name,reason:'不参加飞书打卡；等待人工核准名单补入制证表'}));
 const analysis=analyseIdentity(input.records.filter(r=>!skipped_courses.some(c=>c.course===scalar(r.所学课程))),learner.rules,{period:info.period,base_token:input.base_token??'',table_id:input.table_id??'',registry:input.identity_registry,confirmed_aliases:input.confirmed_aliases,confirmed_cross_groups:input.confirmed_cross_groups});
 const previous=input.existing_roster??[],pending=[...info.pending,...analysis.pending];
 for(const l of analysis.learners)if(!learner.rules.some(r=>r.course===l.course))pending.push({course:l.course,person_id:l.identity,source_record_ids:l.record_ids,reason:'当前课程无已确认Task规则；刷新课程信息后重跑结营核验'});
 const learners=analysis.learners.map(l=>{
  const matches=previous.filter(p=>key(p.period,p.course,p.person_id)===key(l.period,l.course,l.identity));
  if(matches.length>1)throw Error('结营名单同固定身份有多条主记录');
  const old=matches[0],name=old?.certificate_name||l.certificate_name||l.wechat;
  const rule=learner.rules.find(r=>r.course===l.course);
  return {period:l.period,course:l.course,person_id:l.identity,certificate_name:name,wechat:l.wechat,group:l.group,
   source_record_ids:l.record_ids,valid_task_ids:l.task_ids,required_task_ids:rule?.task_ids??[],missing_task_ids:l.missing,
   qualified:l.qualified,status:l.has_pending?'待核对身份':!rule?'课程Task待确认':l.qualified?'已结营':'未完成全部Task',
   certificate_ready:validName(name),name_source:old?.certificate_name?'结营名单人工值':l.certificate_name?'证书昵称':'微信昵称',
   excellent_learner:old?.excellent_learner??false,excellent_captain:old?.excellent_captain??false,
   ...(old?.award_source?{award_source:old.award_source}:{})};
 });
 return {schema_version:1,period:info.period,course_basis_sha256:fingerprint(info),records_sha256:fingerprint(input.records),sample_only:!!(input.sample_only||info.sample_only||info.source?.sample_only),learners,pending,registry:analysis.registry,
  skipped_courses,summary:{learners:learners.length,graduated:learners.filter(l=>l.qualified).length,pending:pending.length}};
}

export function applyAwards(input){
 const graduates=structuredClone(input.graduates),updates=[],seen=new Set();
 for(const s of input.selections??[]){
  const k=key(graduates.period,s.course,s.person_id);if(seen.has(k))throw Error('同一学习者重复优秀指令');seen.add(k);
  const hits=graduates.learners.filter(l=>key(l.period,l.course,l.person_id)===k);
  if(hits.length!==1)throw Error('未找到唯一结营学习者');const l=hits[0];
  if(!l.qualified)throw Error('优秀人选尚未结营');
  const before={excellent_learner:l.excellent_learner,excellent_captain:l.excellent_captain};
  for(const f of ['excellent_learner','excellent_captain'])if(Object.hasOwn(s,f)){if(typeof s[f]!=='boolean')throw Error('优秀标注须为明确true/false');l[f]=s[f];}
  l.award_source={kind:'direct_graduation_fields',reviewer:s.reviewer??'',basis:s.basis??'',source_record_id:s.source_record_id??''};
  if(before.excellent_learner!==l.excellent_learner||before.excellent_captain!==l.excellent_captain)updates.push({period:l.period,course:l.course,person_id:l.person_id,before,after:{excellent_learner:l.excellent_learner,excellent_captain:l.excellent_captain},source:l.award_source});
 }
 return {...graduates,updates};
}

export function planFinalRoster(input){
 const {course_info:info,learner}=buildCourseOutputs(input.course_info);
 if(input.graduates.period!==info.period)throw Error('结营名单与课程信息营期不同');
 if(input.graduates.course_basis_sha256!==fingerprint(info))throw Error('课程版本/规则变更或结营结果缺指纹，请刷新完整输入并重跑graduate');
 const creates=[],pending=[],existing=input.existing_final??[],seen=new Set(),normal=input.normal_role??'结课证书';
 if(!['结课证书','结营证书'].includes(normal))throw Error('普通证书角色无效');
 for(const l of input.graduates.learners){
  if(!l.qualified)continue;const course=info.courses.find(c=>c.checkin_name===l.course),rule=learner.rules.find(r=>r.course===l.course);
  const reasons=[];if(!l.person_id||!l.source_record_ids?.length)reasons.push('缺固定学习者身份或真实打卡来源');
  if(!rule||missingTasks(l.valid_task_ids??[],rule).length)reasons.push('当前完整Task未覆盖');
  const name=l.certificate_name||l.wechat;if(!validName(name))reasons.push('制证昵称无效');
  if(!course?.course_code)reasons.push('课程编号待补');if(!(course?.certificate_date||course?.last_task_deadline))reasons.push('证书日期待补');
  const roles=[normal,...(l.excellent_learner?['优秀学习者证书']:[]),...(l.excellent_captain?['优秀队长证书']:[])];
  for(const certificateRole of roles){
   const k=JSON.stringify([info.period,l.course,l.person_id,certificateRole]);if(seen.has(k))throw Error('同身份同课程同证书类型重复');seen.add(k);
   const current=existing.filter(p=>normalPeriod(scalar(p.营期编号)||scalar(p.营期))===info.period&&scalar(p.所学课程)===l.course&&identity(p)===l.person_id&&role(p)===certificateRole);
   const anonymous=existing.filter(p=>!identity(p)&&normalPeriod(scalar(p.营期编号)||scalar(p.营期))===info.period&&scalar(p.所学课程)===l.course&&certName(p)===name&&role(p)===certificateRole);
   if(anonymous.length){pending.push({course:l.course,person_id:l.person_id,role:certificateRole,reason:'已有同名终版缺固定身份映射，先核对，不重复新增'});continue;}
   if(current.length){if(current.length!==1||certName(current[0])!==name||scalar(current[0].群号)!==l.group)pending.push({course:l.course,person_id:l.person_id,role:certificateRole,reason:'已有终版人工值与上游不同，保留终版并核对'});continue;}
   const errors=[...reasons,...(!input.role_codes?.[certificateRole]?['角色编码待补']:[])];
   if(errors.length){pending.push({course:l.course,person_id:l.person_id,role:certificateRole,reason:errors.join('；')});continue;}
   const evidence={contract_version:CONTRACT_VERSION,eligible:true,person_id:l.person_id,course:l.course,task_ids:l.valid_task_ids,rule,source_record_ids:l.source_record_ids,course_source:info.source};
   creates.push({证书昵称:name,微信昵称:l.wechat,所学课程:l.course,群号:l.group,证书类型:certificateRole,角色:certificateRole,证书编号:'',稳定人员标识:l.person_id,营期:info.period,
    课程编号:String(course.course_code),营期编号:info.period.replace('-',''),营期名:`第${info.period_number}期组队学习`,结营日期:(course.certificate_date||course.last_task_deadline).replace(/^(\d{4})-(\d{2})-(\d{2})$/,'$1年$2月$3日'),
    名单核准状态:certificateRole===normal?'自动通过':'已核准',制作状态:'待制作',分发方式:'助教手动分发',分发状态:'待手动分发',
    制证依据:certificateRole===normal?'当前结营主记录自动通过':'结营名单人工优秀标注',优秀申报记录ID:certificateRole===normal?'':l.award_source?.source_record_id||l.source_record_ids[0],资格核验:evidence});
  }
 }
 return {schema_version:1,period:info.period,sample_only:info.sample_only??false,creates,updates:[],pending,summary:{creates:creates.length,pending:pending.length}};
}

export function planReceipts(input){
 const manifest=input.manifest;if(manifest?.status!=='complete'||manifest.test_mode!==false)throw Error('领取汇总只接受已完成正式manifest');
 const people=input.people??[],certificates=manifest.certificates??[],groups=new Map(),seen=new Set();
 for(const p of people){const id=identity(p),period=normalPeriod(scalar(p.营期编号)||scalar(p.营期)),course=scalar(p.所学课程),name=certName(p),type=role(p),k=key(period,course,id);
  if(!id||!period||!course||!p.最终名单记录ID)throw Error('领取来源缺身份、营期、课程或终版记录ID');
  const certificateKey=JSON.stringify([k,type]);if(seen.has(certificateKey))throw Error('领取来源同证书类型重复');seen.add(certificateKey);
  const hits=certificates.filter(c=>c.course===course&&c.stable_id===id&&c.role===type);
  if(hits.length!==1)throw Error('缺完整终版证书，不能以部分批次生成全部领取包');const cert=hits[0];
  if(cert.name!==name||cert.number!==p.证书编号||cert.date!==p.结营日期||cert.group!==p.群号)throw Error('领取证书与当前终版内容不一致');
  if(!groups.has(k))groups.set(k,{receipt_key:k,period,course,person_id:id,certificate_name:name,group:p.群号,certificate_types:[],certificate_numbers:[],certificate_files:[],source_final_record_ids:[]});
  const r=groups.get(k);if(r.certificate_name!==name)throw Error('同一学习者制证昵称冲突');
  if(!fs.existsSync(cert.path))throw Error('证书文件缺失');const digest=crypto.createHash('sha256').update(fs.readFileSync(cert.path)).digest('hex');if(!cert.sha256||digest!==cert.sha256)throw Error('证书图片哈希不符');
  r.certificate_types.push(type);r.certificate_numbers.push(cert.number);r.certificate_files.push({type,number:cert.number,path:cert.path,sha256:digest});r.source_final_record_ids.push(p.最终名单记录ID);
 }
 const receipts=[...groups.values()];for(const r of receipts){
  const sort=(a,b)=>a.type.localeCompare(b.type);r.certificate_files.sort(sort);r.certificate_types.sort();r.certificate_numbers.sort();r.source_final_record_ids.sort();
 }
 const creates=[],updates=[],existing=input.existing_receipts??[];
 const content=r=>JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>!['record_id','领取状态','分发状态','领取时间','备注'].includes(k))));
 for(const r of receipts){const matches=existing.filter(e=>e.receipt_key===r.receipt_key);if(matches.length>1)throw Error('已有领取主记录重复');if(!matches.length)creates.push(r);else if(content(matches[0])!==content(r))updates.push({record_id:matches[0].record_id,receipt_key:r.receipt_key,after:r});}
 return {schema_version:1,receipts,creates,updates,pending:[]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [action,inputFile,outputFile,...flags]=process.argv.slice(2),actions={graduate,awards:applyAwards,'final-plan':planFinalRoster,'receipt-plan':planReceipts};
 if(!actions[action]||!inputFile||!outputFile)throw Error('graduate|awards|final-plan|receipt-plan <input.json> <新output.json>');
 if(fs.existsSync(outputFile))throw Error('输出已存在，换新路径以保留来源');
 if(flags.length&&!(flags.length===2&&flags[0]==='--audit'))throw Error('可选参数为 --audit <全流程核对输入.json>');
 const audit=flags.length?assertWorkflowAudit(flags[1],action==='receipt-plan'||action==='final-plan'?'certificates':'checkin',[inputFile]):null;
 const input=JSON.parse(fs.readFileSync(inputFile,'utf8').replace(/^\uFEFF/,'')),result=actions[action](input);
 result.workflow_audit=audit??{ready:false,completion_verified:false,reminder:'仅完成本地计算；交接/写回前须完整读取当前来源并运行workflow-audit'};
 fs.mkdirSync(path.dirname(path.resolve(outputFile)),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({ok:true,action,output:path.resolve(outputFile),summary:result.summary??{creates:result.creates?.length??0,updates:result.updates?.length??0},online_write:false}));
}
