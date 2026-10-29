// 平台适配器分别执行任务完成、证书办理和鲸币办理。
function identity(a,b){return ['course','role','name','wechat'].every(k=>a[k]===b[k]);}
export async function runAwards(transport,plan,{apply=false}={}){
 if(!Array.isArray(plan.people)||!plan.people.length)throw Error('缺少本期助教名单');
 if(apply&&plan.sample_only)throw Error('示例名单不能用于平台发放');
 if(apply&&!transport.fresh_readback)throw Error('平台办理必须支持独立回读');
 if(apply)for(const method of ['readSourceInventory','completeTask','setNoCertificate','setGradeAndIssueCertificate'])
  if(typeof transport[method]!=='function')throw Error('适配器缺少分步操作：'+method);
 const ids=plan.people.map(p=>p.business_key);
 if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw Error('助教身份键缺失或重复');
 let completed=0,issued=0,noCertificate=0,coins=0;
 const pendingCertificates=[],pendingRewards=[];
 let sourceInventoryVerified=false;
 async function read(){
  if(typeof transport.readSourceInventory==='function'){
   const inventory=await transport.readSourceInventory();
   if(!inventory||inventory.complete!==true||inventory.has_more!==false||inventory.truncated===true||!Array.isArray(inventory.people)||!Number.isSafeInteger(inventory.total)||inventory.total!==inventory.people.length)throw Error('共享助教清单全量读取不完整，重新读取后生成新预览');
   const source=inventory.people,sourceIds=source.map(p=>p.business_key);
   if(source.length!==ids.length||sourceIds.some(id=>!id||!ids.includes(id))||new Set(sourceIds).size!==sourceIds.length)throw Error('共享助教清单全集范围变化：存在新增、移除或重复人员，须重新完整预览');
   for(const target of plan.people){const hits=source.filter(r=>r.business_key===target.business_key);
    if(hits.length!==1||!identity(target,hits[0])||hits[0].grade!==target.grade||['eligible','s_bonus'].some(k=>hits[0][k]!==target[k]))throw Error('共享助教清单的身份、等次或奖励确认变化');}
   sourceInventoryVerified=true;
  }
  const records=await transport.read(ids);
  if(!Array.isArray(records)||records.length!==ids.length)throw Error('平台助教记录未完整读取');
  const assignmentIds=records.map(r=>r.assignment_id);
  if(assignmentIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(assignmentIds).size!==assignmentIds.length)throw Error('平台领取记录标识无效或重复');
  for(const target of plan.people){const hits=records.filter(r=>r.business_key===target.business_key);
   if(hits.length!==1||!identity(target,hits[0]))throw Error('平台人员身份或领取记录不唯一');
   if(hits[0].certificate_issued&&(!target.grade||['C','D'].includes(target.grade)))throw Error('已有证书与本期等次冲突，先人工核对');
   if(hits[0].certificate_issued&&(hits[0].grade!==target.grade||hits[0].certificate_name!==target.certificate))throw Error('平台已有证书或等级与计划冲突');}
  return records;
 }
 const get=(records,target)=>records.find(r=>r.business_key===target.business_key);
 let records=await read();
 // Finish phase 1 for the whole batch before starting certificates.
 if(apply)for(const target of plan.people){
  records=await read();const record=get(records,target);
  if(record.task_completed===true)continue;
  await transport.completeTask({...target,assignment_id:record.assignment_id});completed++;
  records=await read();if(get(records,target).task_completed!==true)throw Error('任务完成未回读通过，停止证书办理');
 }
 if(apply){records=await read();if(records.some(r=>r.task_completed!==true))throw Error('尚未统一任务完成');}
 for(const target of plan.people){
  if(!target.grade){pendingCertificates.push({business_key:target.business_key,reason:'待人工定级'});continue;}
  if(!['S','A','B','C','D'].includes(target.grade))throw Error('评价等次无效');
  if(!apply)continue;
  records=await read();const record=get(records,target);
  if(['C','D'].includes(target.grade)){
   if(record.certificate_choice==='不发证'&&record.certificate_issued===false)continue;
   await transport.setNoCertificate({...target,assignment_id:record.assignment_id});noCertificate++;
   records=await read();const actual=get(records,target);
   if(actual.certificate_choice!=='不发证'||actual.certificate_issued!==false)throw Error('不发证状态未回读通过');
  }else{
   if(record.certificate_issued===true)continue;
   if(!plan.certificate_deadline_date||plan.deadline_date!==plan.certificate_deadline_date){pendingCertificates.push({business_key:target.business_key,reason:'证书办理日期待确认'});continue;}
   await transport.setGradeAndIssueCertificate({...target,assignment_id:record.assignment_id,certificate:'优秀助教证书'});issued++;
   records=await read();const actual=get(records,target);
   if(actual.grade!==target.grade||actual.certificate_issued!==true||actual.certificate_name!=='优秀助教证书')throw Error('优秀助教证书或评价等次未回读通过，不自动重发');
  }
 }
 // Coin eligibility remains separate from task completion and certificates.
 for(const target of plan.people){
  if(!target.grade||!Number.isFinite(target.whalecoins)){pendingRewards.push({business_key:target.business_key,reason:'鲸币资格或金额待确认'});continue;}
  if(!apply)continue;
  records=await read();const record=get(records,target);
  if(record.whalecoins===target.whalecoins)continue;
  if(typeof transport.grantCoins!=='function'){pendingRewards.push({business_key:target.business_key,reason:'尚无已验收的鲸币操作'});continue;}
  if(record.whalecoins!==0&&record.whalecoins!=null)throw Error('平台既有鲸币与计划冲突');
  await transport.grantCoins({...target,assignment_id:record.assignment_id});coins++;
  records=await read();if(get(records,target).whalecoins!==target.whalecoins)throw Error('鲸币未回读通过，不自动重发');
 }
 return {apply,task_completed:completed,certificates_issued:issued,no_certificate:noCertificate,coin_operations:coins,
  pending_certificates:pendingCertificates,pending_rewards:pendingRewards,processed:issued+noCertificate,readback:apply,deadline_date:plan.deadline_date,
  source_inventory_verified:sourceInventoryVerified,source_people_count:sourceInventoryVerified?ids.length:null,
  scope_pending:sourceInventoryVerified?null:'缺少readSourceInventory全量源清单回读；不能据此验收本期全集覆盖'};
}
