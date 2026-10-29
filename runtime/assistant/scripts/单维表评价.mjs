import fs from 'node:fs';
import path from 'node:path';
import {load,save,SKILL_ROOT} from './运行环境.mjs';
export function previousDate(value){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))throw Error('必须确认实际招募日期YYYY-MM-DD');
 const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)throw Error('日期无效');
 d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);
}
export function firstWeekFriday(period){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period||''))throw Error('营期无效');
 const d=new Date(period+'-01T00:00:00Z');d.setUTCDate(1+(8-d.getUTCDay())%7+4);
 return d.toISOString().slice(0,10)+'T16:00:00+08:00';
}
export function certificateDeadline(value){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))throw Error('必须明确当月学习者招募开始日期YYYY-MM-DD');
 const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)throw Error('学习者招募节点日期无效');
 d.setUTCDate(d.getUTCDate()+30);return d.toISOString().slice(0,10);
}
export function reward(role,grade,bonus){
 const bases={'运营助教':{S:7,A:5,B:2.5,C:0,D:0},'专业助教':{S:5,A:3,B:1.5,C:0,D:0}};
 if(!bases[role]||!Object.hasOwn(bases[role],grade))throw Error('岗位或人工等级无效');
 if(grade==='S'&&(!Number.isFinite(bonus)||bonus<0.5||bonus>1.5))throw Error('S额外鲸币必须人工确定为0.5—1.5');
 if(grade!=='S'&&bonus!==undefined&&bonus!==null&&bonus!==0)throw Error('非S等级不能加S额外奖励');
 return bases[role][grade]+(grade==='S'?bonus:0);
}
export function buildEvaluation(rows,config){
 const standards=load(path.join(SKILL_ROOT,'assets','岗位适用项.json'));
 const people=[],seen=new Set();let vacancies=0;
 for(const row of rows){
  if(!row.name&&!row.wechat){if(row.grade)throw Error('空岗位有评分，先核对身份');vacancies++;continue;}
  if(!row.course||!['运营助教','专业助教'].includes(row.role)||!row.name||!row.wechat)throw Error('评价身份信息不完整');
  const key=JSON.stringify([row.course,row.role,row.wechat]);if(seen.has(key))throw Error('重复人员标识');seen.add(key);
  const grade=String(row.grade??'').trim().toUpperCase()||null;
  if(grade&&!/^[SABCD]$/.test(grade))throw Error('最终人工等级须为S/A/B/C/D');
  const holds=[];let amount=null;
  if(!grade)holds.push('待人工定级');
  else if(['C','D'].includes(grade)||row.eligible===false)amount=0;
  else{
   try{amount=reward(row.role,grade,row.s_bonus);}catch(e){holds.push(e.message);}
   if(row.eligible!==true){amount=null;holds.push('鲸币资格待人工核对');}
  }
  const states=row.states||{};
  const checks=standards.items.filter(s=>s.role==='共用'||s.role===row.role).map(s=>{
   const reused=standards.items.filter(x=>x.column===s.column&&x.role===s.role).length>1;
   const value=states[s.code]??(reused?null:states[s.column]);
   const status=['已核实完成','存在问题','不适用'].includes(value)?value:'待核对';
   return {...s,color:standards.colors[s.role],status,raw_state:value??null};
  });
  people.push({...row,business_key:key,grade,checks,holds,certificate_holds:grade?[]:['待人工定级'],reward_holds:holds.filter(h=>h!=='待人工定级'),whalecoins:amount,
   certificate:grade&&['S','A','B'].includes(grade)?'优秀助教证书':null,
   counts_for_elite:['S','A'].includes(grade),discipline:grade==='C'?'一次C禁下一期；两次C清退，需核历史':grade==='D'?'清退，需人工办理':null});
 }
 if(config.next_recruitment_start_date)throw Error('旧助教招募截止配置已停用；证书截止改用learner_recruitment_date加30天');
 if(config.learner_recruitment_node&&config.learner_recruitment_node!=='start')throw Error('证书期限只按学习者招募开始日计算');
 const deadline=config.learner_recruitment_date?certificateDeadline(config.learner_recruitment_date):null;
 return {period:config.period,reminder:firstWeekFriday(config.period),deadline_date:deadline,certificate_deadline_date:deadline,deadline_basis:'当月学习者招募开始日加30个自然日',
  deadline_pending:!deadline,sample_only:!!config.sample_only,observers:'观察员共同维护',checkpoints:['开营','结营'],processing:'先统一任务完成，再按等级办理证书',vacancies,people,
  summary:{people:people.length,graded:people.filter(p=>p.grade).length,holds:people.filter(p=>p.holds.length).length,vacancies}};
}
function csvParse(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(c===','&&!quoted){row.push(cell);cell='';}
  else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 if(quoted)throw Error('CSV引号未闭合');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
export function readPeople(snapshot){
 if(snapshot.ok===false)throw Error('源表读取失败');const d=snapshot.data||snapshot;
 if(d.has_more||d.truncated)throw Error('源表截断');
 let headers=d.headers,rows=d.rows;
 if(!headers){const parsed=csvParse((d.annotated_csv||'').replace(/^\[row=\d+\] /gm,''));headers=parsed.shift();rows=parsed;}
 if(!Array.isArray(headers)||!Array.isArray(rows))throw Error('源表结构无效');
 for(const name of ['课程名','职责','姓名','微信号','评价打分'])if(headers.filter(h=>h===name).length!==1)throw Error('表头缺失或重复：'+name);
 let course='',group='';
 return rows.map(values=>{
  const o=Object.fromEntries(headers.map((h,i)=>[h,values[i]??'']));course=o['课程名']||course;group=o['群号']||group;
  const role={'运营':'运营助教','专业':'专业助教','运营助教':'运营助教','专业助教':'专业助教'}[o['职责']]||o['职责'];
  return {course,group,role,name:o['姓名'],wechat:o['微信号'],observer:o['观察员'],grade:o['评价打分'],states:o};
 }).filter(r=>r.role||r.name||r.wechat||r.grade);
}
export function evaluationPreview(ctx,out){
 const settings=ctx.config.evaluation||{};
 if(!settings.people_file&&!settings.source_snapshot)throw Error('评价需要共享单维表快照source_snapshot；people_file仅作本地演示');
 const rows=settings.people_file?load(ctx.resolve(settings.people_file)):readPeople(load(ctx.resolve(settings.source_snapshot)));
 const decisions=settings.decisions_file?load(ctx.resolve(settings.decisions_file)):{};
 if(!decisions||typeof decisions!=='object'||Array.isArray(decisions))throw Error('补充确认文件必须是业务身份键到决策的对象');
 const sourceKeys=new Set(rows.map(r=>JSON.stringify([r.course,r.role,r.wechat])));
 const unmatched=Object.keys(decisions).filter(key=>!sourceKeys.has(key));
 if(unmatched.length)throw Error('补充确认存在未匹配的身份键，源快照可能遗漏人员；重新完整读取后预览：'+unmatched.join('、'));
 const merged=rows.map(r=>{
  const extra=decisions[JSON.stringify([r.course,r.role,r.wechat])]||{};
  for(const key of Object.keys(extra))if(!['eligible','s_bonus','b_certificate_confirmed','states'].includes(key))throw Error('补充确认文件不能覆盖身份或最终人工等级：'+key);
  return {...r,...extra};
 });
 const plan=buildEvaluation(merged,{period:ctx.config.period,sample_only:!!ctx.config.sample_only,learner_recruitment_date:settings.learner_recruitment_date,learner_recruitment_node:settings.learner_recruitment_node,next_recruitment_start_date:settings.next_recruitment_start_date});
 fs.mkdirSync(out);save(path.join(out,'评价与发放预览.json'),plan);
 const html='<html><meta charset="utf-8"><title>岗位适用项与评价预览</title><body><h1>观察员共同维护：开营、结营</h1><p>蓝色=运营；绿色=专业；灰色=共用。空白或旧勾选均待核；不自动定级。</p><table border="1"><tr><th>岗位</th><th>集中检查</th><th>要点</th><th>标准</th></tr>'+load(path.join(SKILL_ROOT,'assets','岗位适用项.json')).items.map(s=>'<tr style="background:'+({'运营助教':'#dbeafe','专业助教':'#dcfce7','共用':'#f1f5f9'}[s.role])+'"><td>'+s.role+'</td><td>'+s.phase+'</td><td>'+s.action+'</td><td>'+s.standard+'</td></tr>').join('')+'</table></body></html>';
 fs.writeFileSync(path.join(out,'岗位适用项.html'),html);
 save(path.join(out,'运行摘要.json'),{...plan.summary,deadline_date:plan.deadline_date,deadline_pending:plan.deadline_pending});
 return {...plan.summary,deadline_date:plan.deadline_date,deadline_pending:plan.deadline_pending,applied:false};
}
