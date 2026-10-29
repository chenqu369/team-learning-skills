const PROJECT_FIELDS=['name','project_type','assistant_category','assistant_period','description','content_markdown','cover_image','contact_qr_image_url','tags','access_scope'];
const identityKeys=['name','project_type','assistant_category','assistant_period'];

export function projectPayload(input,{apply=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('缺少本期项目输入');
  if(apply&&input.sample_only)throw Error('Sample／模拟输入不得创建线上项目');
  const source=input.project;
  if(!source||typeof source!=='object'||Array.isArray(source))throw Error('缺少 project 对象');
  const unknown=Object.keys(source).filter(key=>!PROJECT_FIELDS.includes(key)&&key!=='status');
  if(unknown.length)throw Error('项目创建字段未核实，停止：'+unknown.join(', '));
  const payload={};
  for(const key of PROJECT_FIELDS)if(source[key]!==null&&source[key]!==undefined)payload[key]=source[key];
  if(typeof payload.name!=='string'||!payload.name.trim()||payload.name!==payload.name.trim())throw Error('项目名称待确认');
  if(payload.project_type!=='assistant'||payload.assistant_category!=='team_learning')throw Error('项目类型或类别不是组队学习助教招募');
  if(typeof payload.assistant_period==='number')payload.assistant_period=String(payload.assistant_period);
  if(typeof payload.assistant_period!=='string'||!/^[1-9]\d*$/.test(payload.assistant_period))throw Error('assistant_period 须为已确认的数字期数');
  if(input.period_number!==undefined&&String(input.period_number)!==payload.assistant_period)throw Error('项目期数与当期来源不一致');
  if(input.test_only===true&&!payload.name.includes('测试'))throw Error('测试项目名称须明确标记测试');
  if(Object.hasOwn(source,'status'))throw Error('创建输入不得提供 status；只允许创建草稿');
  return payload;
}

async function listAllProjects(transport){
  const all=[],seen=new Set();let total=null;
  for(let page=1;page<=1000;page++){
    const data=await transport.listProjects(page,100);
    if(!data||!Array.isArray(data.items))throw Error('项目列表接口结构变化');
    if(Number.isSafeInteger(data.total)){
      if(data.total<0||(total!==null&&data.total!==total))throw Error('项目列表总数变化，分页不完整');
      total=data.total;
    }else if(typeof data.has_more!=='boolean')throw Error('项目列表缺少分页完整性信息');
    for(const item of data.items){
      if(!Number.isSafeInteger(item?.id)||item.id<=0||seen.has(item.id))throw Error('项目 ID 缺失或分页重复');
      seen.add(item.id);all.push(item);
    }
    if(total!==null){
      if(all.length>total)throw Error('项目列表分页总数不符');
      if(all.length===total)return all;
    }else if(data.has_more===false)return all;
    if(!data.items.length||page===1000)throw Error('项目列表分页不完整');
  }
  throw Error('项目列表分页不完整');
}

function matchingProject(projects,payload){
  const named=projects.filter(p=>p.name===payload.name);
  if(named.length>1)throw Error('同名项目不唯一，停止创建');
  if(named.length===1&&identityKeys.some(key=>String(named[0][key]??'')!==String(payload[key])))throw Error('同名项目身份不一致，停止创建');
  return named[0]??null;
}

function verifyReadback(project,payload,id){
  if(!project||project.id!==id||project.status!=='draft')throw Error('项目定向回读不是指定草稿');
  for(const key of identityKeys)if(String(project[key]??'')!==String(payload[key]))throw Error('项目回读身份字段不一致：'+key);
  return project;
}

export async function runProjectPreparation(transport,input,{apply=false}={}){
  const payload=projectPayload(input,{apply});
  const projects=await listAllProjects(transport);
  const existing=matchingProject(projects,payload);
  if(existing){
    const readback=verifyReadback(await transport.getProject(existing.id),payload,existing.id);
    return {action:'reuse_draft',apply,project_id:existing.id,readback,payload};
  }
  if(!apply)return {action:'create_draft',apply:false,project_id:null,payload};
  let created;
  try{created=await transport.createProject(payload)}catch(error){
    const current=await listAllProjects(transport);
    const found=matchingProject(current,payload);
    throw Error(`创建结果不明；已重新查找${found?`，发现候选项目 ID ${found.id}`:'但未发现匹配项目'}；先回读，不自动重发：${error.message}`);
  }
  if(!Number.isSafeInteger(created?.id)||created.id<=0)throw Error('创建返回缺少真实项目 ID；先查列表并回读，不自动重发');
  const readback=verifyReadback(await transport.getProject(created.id),payload,created.id);
  return {action:'created_draft',apply:true,project_id:created.id,readback,payload};
}

export function prepareProjectBrowserScript(input){
  const safe=JSON.stringify(input).replace(/</g,'\\u003c');
  return `// 在已登录贡献者平台运行：默认只读查重；仅本轮确认后调用 window.assistantProjectRun(true)。\n(async()=>{\n`+
    `const PROJECT_FIELDS=${JSON.stringify(PROJECT_FIELDS)};const identityKeys=${JSON.stringify(identityKeys)};\n`+
    `${projectPayload.toString()}\n${listAllProjects.toString()}\n${matchingProject.toString()}\n${verifyReadback.toString()}\n${runProjectPreparation.toString()}\n`+
    `const input=${safe};if(location.origin!=='https://contributor.datawhale.cn')throw Error('请打开贡献者平台');\n`+
    `const request=async(method,route,body)=>{const token=localStorage.getItem('access_token');if(!token)throw Error('请先登录');const response=await fetch(route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('平台请求失败 '+response.status+'；先回读，不重发');return response.json()};\n`+
    `const transport={listProjects:(page,size)=>request('GET','/api/v1/admin/projects?page='+page+'&page_size='+size),getProject:id=>request('GET','/api/v1/admin/projects/'+id),createProject:body=>request('POST','/api/v1/admin/projects',body)};\n`+
    `window.assistantProjectRun=async(apply=false)=>{const result=await runProjectPreparation(transport,input,{apply});window.assistantProjectResult=result;return result};return window.assistantProjectRun(false);\n})();\n`;
}
