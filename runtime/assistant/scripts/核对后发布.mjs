// 平台适配器提供独立read及publish方法；本模块不猜平台发布接口。
function compare(actual,expected){
 if(!actual||Object.keys(actual).filter(k=>k!=='status').sort().join('|')!==Object.keys(expected).filter(k=>k!=='status').sort().join('|'))throw Error('人工核对快照字段不完整或配置变化');
 for(const [key,value]of Object.entries(expected)){
  if(key==='status')continue;
  if(value&&typeof value==='object'&&!Array.isArray(value)){compare(actual?.[key],value);}
  else if(JSON.stringify(actual?.[key])!==JSON.stringify(value))throw Error('人工核对后配置变化：'+key);
 }
}
function validateCourses(courses,approval,tasks,now){
 if(!courses?.source?.period||!Array.isArray(courses.courses)||!courses.courses.length)throw Error('缺少本期课程事实 JSON');
 if(JSON.stringify(approval.course_source)!==JSON.stringify(courses.source))throw Error('人工确认的课程来源与课程 JSON 不一致');
 if(!Number.isFinite(Date.parse(now)))throw Error('当前时间无效');
 const expected=new Map();
 for(const course of courses.courses){
  if(!course.course_key||!course.name||!Number.isInteger(course.group_count)||course.group_count<=0)throw Error('课程键、名称或群数未确认');
  for(const [role,multiplier] of [['运营助教',1],['专业助教',2]]){
   const key=`${course.course_key}:${role}`;
   if(expected.has(key))throw Error('课程 JSON 存在重复课程键');
   expected.set(key,{title:`${course.name} - ${role}`,capacity:course.group_count*multiplier});
  }
 }
 const matched=new Set();
 for(const task of tasks){
  const candidates=[...expected].filter(([key,definition])=>
   (task.course_key&&task.role)?key===`${task.course_key}:${task.role}`:task.title===definition.title);
  if(candidates.length!==1)throw Error(`任务 ${task.id} 无法唯一对应课程岗位`);
  const [key,definition]=candidates[0];
  if(matched.has(key))throw Error(`课程岗位重复：${key}`);
  matched.add(key);
  if(task.title!==definition.title)throw Error(`任务 ${task.id} 课程岗位标题不一致`);
  if(task.capacity!==definition.capacity)throw Error(`任务 ${task.id} 名额不符：应为 ${definition.capacity}，当前 ${task.capacity}`);
  if(!Number.isInteger(task.claimed_count)||task.claimed_count<0||task.claimed_count>task.capacity)throw Error(`任务 ${task.id} 已领取数未完整回读`);
  if(!task.deadline||!Number.isFinite(Date.parse(task.deadline))||Date.parse(task.deadline)<=Date.parse(now))throw Error(`任务 ${task.id} 截止时间为空或已过期`);
  if(task.claimed_count===task.capacity&&approval.full_task_decisions?.[task.id]!=='keep_full')throw Error(`任务 ${task.id} 已满额，须确认扩容或明确保留满额`);
 }
 if(matched.size!==expected.size)throw Error(`缺少课程岗位任务：应有 ${expected.size} 项，实有 ${matched.size} 项`);
}
export async function runPublication(transport,approval,{apply=false,courses,now=new Date().toISOString()}={}){
 if(!approval?.confirmed||!approval.snapshot)throw Error('缺少人工对具体批次的核对记录');
 if(!courses)throw Error('缺少本期课程事实 JSON');
 if(apply&&!transport.fresh_readback)throw Error('平台适配器必须支持独立回读');
 if(typeof transport.readAllTasks!=='function')throw Error('平台适配器必须完整分页回读项目全部任务');
 const expected=approval.snapshot;
 if(!Number.isInteger(expected.project?.id)||expected.project.id<=0||!expected.tasks?.length)throw Error('发布批次不完整');
 const ids=expected.tasks.map(t=>t.id);if(ids.some(id=>!Number.isInteger(id)||id<=0)||new Set(ids).size!==ids.length)throw Error('发布任务标识无效');
 async function read(){
  const inventory=await transport.readAllTasks(expected.project.id);
  if(!Array.isArray(inventory)||inventory.length!==expected.tasks.length||new Set(inventory.map(task=>task.id)).size!==inventory.length||inventory.some(task=>!ids.includes(task.id)))throw Error('项目任务清单与人工核对批次不一致');
  const current=await transport.read(expected.project.id,ids);compare(current.project,expected.project);
  if(current.tasks.length!==expected.tasks.length)throw Error('人工核对后任务批次变化');
  if(!['draft','published'].includes(current.project.status))throw Error('项目状态不适合发布');
  for(const task of expected.tasks){
   const hits=current.tasks.filter(t=>t.id===task.id&&t.project_id===expected.project.id);
   if(hits.length!==1)throw Error('任务不在核对项目');compare(hits[0],task);
   if(!['draft','published'].includes(hits[0].status))throw Error('任务状态不适合发布');
  }
  validateCourses(courses,approval,current.tasks,now);
  return current;
 }
 let current=await read(),count=0;
 if(apply){
  for(const id of ids){current=await read();if(current.tasks.find(t=>t.id===id).status==='published')continue;
   await transport.publishTask(id);count++;current=await read();if(current.tasks.find(t=>t.id===id).status!=='published')throw Error('发布任务未回读通过；停止且不盲目重试');}
  current=await read();if(current.project.status!=='published'){await transport.publishProject(expected.project.id);count++;}
  current=await read();if(current.project.status!=='published'||current.tasks.some(t=>t.status!=='published'))throw Error('整批发布回读未通过');
 }
 const links=courses.courses.flatMap(course=>['运营助教','专业助教'].map(role=>{
  const task=expected.tasks.find(item=>item.course_key===course.course_key&&item.role===role||item.title===`${course.name} - ${role}`);
  return {course_key:course.course_key,role,task_id:task.id,url:`https://contributor.datawhale.cn/tasks/${task.id}`};
 }));
 return {project_id:expected.project.id,task_count:ids.length,apply,published_operations:count,readback:apply,links};
}
