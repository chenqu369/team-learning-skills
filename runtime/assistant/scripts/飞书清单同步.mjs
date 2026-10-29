import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {load,save,run,python,SKILL_ROOT} from './运行环境.mjs';
import {recruitmentCourseInput} from '../../shared/course-info.mjs';
const signature=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rosterLayout=load(path.join(SKILL_ROOT,'assets','单维表列序.json'));
const applicable=load(path.join(SKILL_ROOT,'assets','岗位适用项.json')).initial_check_roles;
const checkStatuses=['待核对','已核实完成','存在问题','不适用'];
const monthName=period=>{
  const match=/^\d{4}-(0[1-9]|1[0-2])$/.exec(period||'');
  if(!match)throw Error('营期必须为 YYYY-MM，不能推测子表名称');
  return `${Number(match[1])}月`;
};
const sheetList=reply=>reply.data?.sheets||reply.data?.spreadsheet?.sheets||[];
const sheetTitle=sheet=>sheet.title||sheet.sheet_name;
export function prepareRosterSheet(ctx,out,lark,{apply=false,courses}={}){
  const {config,resolve}=ctx,settings=config.roster||{};
  const token=settings.spreadsheet_token;
  if(!token)throw Error('准备清单子表需要 roster.spreadsheet_token');
  const name=monthName(config.period);
  const facts=courses||recruitmentCourseInput(load(resolve(settings.courses_file)));
  const slots=facts.courses.reduce((sum,course)=>sum+course.group_count*3,0);
  const rowCount=Math.max(200,slots+1);
  if(rowCount>50000)throw Error('当期岗位数超过可新建子表行数上限');
  fs.mkdirSync(out,{recursive:false});
  const before=lark('sheets','+workbook-info',['--spreadsheet-token',token]);
  save(path.join(out,'建表前工作簿.json'),before);
  const matches=sheetList(before).filter(s=>sheetTitle(s)===name);
  if(matches.length>1)throw Error('当期月份有多个同名子表，停止并核对');
  const existing=matches[0];
  if(existing){
    if(!apply&&settings.sheet_id!==existing.sheet_id){
      const result={sheet_name:name,candidate_sheet_id:existing.sheet_id,created:false,
        pending_confirmation:true};
      save(path.join(out,'目标子表.json'),result);return result;
    }
    if(settings.sheet_id!==existing.sheet_id)throw Error('已有同名子表；先核对并在配置中填写其 sheet_id，不能仅凭月份复用');
    if(existing.resource_type&&existing.resource_type!=='sheet')throw Error('同名子表不是电子表格网格');
    const result={sheet_name:name,sheet_id:existing.sheet_id,created:false,reused:true,configured:false,readback:false};
    if(apply){
      const last=existing.grid_properties?.row_count||existing.row_count;
      const columns=existing.grid_properties?.column_count||existing.column_count;
      if(last<slots+1||columns<rosterLayout.headers.length)throw Error('同名子表行列不足，不能复用');
      const scoped=['--spreadsheet-token',token,'--sheet-id',existing.sheet_id];
      const head=lark('sheets','+cells-get',[...scoped,'--range','A1:V1','--include','value']);
      save(path.join(out,'表头回读.json'),head);
      const actual=head.data?.ranges?.[0]?.cells?.[0]?.map(c=>String(c.value??''));
      if(JSON.stringify(actual)!==JSON.stringify(rosterLayout.headers))throw Error('同名子表表头不同，不能自动配置单选');
      const values=lark('sheets','+cells-get',[...scoped,'--range',`I2:R${last}`,'--include','value','--max-chars','1000000']);
      save(path.join(out,'检查项写前回读.json'),values);
      if(values.data?.has_more||values.data?.truncated||values.data?.ranges?.some(r=>r.truncated)
        ||values.data?.ranges?.length!==1||values.data.ranges[0].actual_range!==`I2:R${last}`)
        throw Error('检查项未读完整，不配置单选');
      const cells=values.data?.ranges?.flatMap(r=>r.cells?.flat()||[])||[];
      if(cells.some(c=>c.value!=null&&c.value!==''&&!checkStatuses.includes(String(c.value))))
        throw Error('已有检查项包含四状态以外的人工值，先核对；没有修改源表');
      const ranges=Object.keys(applicable).map(header=>{
        const col=String.fromCharCode(65+rosterLayout.headers.indexOf(header));
        return `${name}!${col}2:${col}${last}`;
      });
      lark('sheets','+dropdown-update',['--spreadsheet-token',token,'--ranges',JSON.stringify(ranges),
        '--options',JSON.stringify(checkStatuses),'--multiple=false','--highlight=false']);
      result.configured=true;
      save(path.join(out,'目标子表.json'),result);
      const validation=lark('sheets','+cells-get',[...scoped,'--range','I2:R2','--include','data_validation']);
      save(path.join(out,'单选回读.json'),validation);
      const rules=validation.data?.ranges?.[0]?.cells?.[0]||[];
      if(rules.length!==Object.keys(applicable).length||rules.some(c=>{
        const rule=c.data_validation;
        return rule?.type!=='list'||JSON.stringify(rule.items)!==JSON.stringify(checkStatuses)
          ||rule.enable_highlight!==false;
      }))throw Error('同名子表单选规则回读不一致');
      result.readback=true;
    }
    save(path.join(out,'目标子表.json'),result);return result;
  }
  if(settings.sheet_id)throw Error('配置的 sheet_id 未对应当期月份子表；先核对，不新建');
  if(!apply){
    const result={sheet_name:name,created:false,reused:false,planned_rows:rowCount,planned_columns:rosterLayout.headers.length};
    save(path.join(out,'目标子表.json'),result);return result;
  }
  lark('sheets','+sheet-create',['--spreadsheet-token',token,'--title',name,
    '--row-count',String(rowCount),'--col-count',String(rosterLayout.headers.length)]);
  const after=lark('sheets','+workbook-info',['--spreadsheet-token',token]);
  save(path.join(out,'建表后工作簿.json'),after);
  const created=sheetList(after).filter(s=>sheetTitle(s)===name);
  if(created.length!==1||!created[0].sheet_id)throw Error('创建请求后未能唯一回读当期子表；先查表，不重复创建');
  const sheetId=created[0].sheet_id;
  const receipt={sheet_name:name,sheet_id:sheetId,created:true,reused:false,configured:false,readback:false};
  save(path.join(out,'目标子表.json'),receipt);
  const endColumn=String.fromCharCode(64+rosterLayout.headers.length);
  lark('sheets','+cells-set',['--spreadsheet-token',token,'--sheet-id',sheetId,
    '--range',`A1:${endColumn}1`,'--cells','-'],JSON.stringify([rosterLayout.headers.map(value=>({value}))]));
  lark('sheets','+styles-put',['--spreadsheet-token',token,'--styles','-'],JSON.stringify({styles:[{
    name,
    cell_styles:[{range:`A1:${endColumn}1`,background_color:'#E5E7EB',font_weight:'bold',
      font_size:12,horizontal_alignment:'center',vertical_alignment:'middle',word_wrap:'auto-wrap'},
      {range:`A2:${endColumn}${rowCount}`,font_size:12,word_wrap:'auto-wrap'}],
    col_sizes:[{range:'A:A',type:'pixel',size:180},{range:'B:D',type:'pixel',size:130},
      {range:'E:E',type:'pixel',size:180},{range:'F:V',type:'pixel',size:130}],
    row_sizes:[{range:'1:1',type:'pixel',size:30}],freeze:{rows:1,cols:5}
  }]}));
  const cols=Object.keys(applicable).map(header=>{
    const index=rosterLayout.headers.indexOf(header);
    if(index<0)throw Error('检查项未出现在清单表头：'+header);
    return String.fromCharCode(65+index);
  });
  const ranges=cols.map(col=>`${name}!${col}2:${col}${rowCount}`);
  lark('sheets','+dropdown-update',['--spreadsheet-token',token,'--ranges',JSON.stringify(ranges),
    '--options',JSON.stringify(checkStatuses),'--multiple=false','--highlight=false']);
  receipt.configured=true;
  save(path.join(out,'目标子表.json'),receipt);
  const head=lark('sheets','+cells-get',['--spreadsheet-token',token,'--sheet-id',sheetId,
    '--range',`A1:${endColumn}1`,'--include','value']);
  const choices=lark('sheets','+cells-get',['--spreadsheet-token',token,'--sheet-id',sheetId,
    '--range','I2:R2','--include','data_validation']);
  save(path.join(out,'表头回读.json'),head);
  save(path.join(out,'单选回读.json'),choices);
  const actualHeaders=head.data?.ranges?.[0]?.cells?.[0]?.map(c=>String(c.value??''));
  if(JSON.stringify(actualHeaders)!==JSON.stringify(rosterLayout.headers))throw Error('新子表表头回读不一致');
  const validations=choices.data?.ranges?.[0]?.cells?.[0]||[];
  if(validations.length!==cols.length||validations.some(c=>{
    const rule=c.data_validation;
    return rule?.type!=='list'||JSON.stringify(rule.items)!==JSON.stringify(checkStatuses)
      ||rule.enable_highlight!==false;
  }))throw Error('新子表单选规则回读不一致');
  receipt.readback=true;
  save(path.join(out,'目标子表.json'),receipt);
  return receipt;
}
export function mergeDelta(existing,desired){
  const parse=r=>{const m=r.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);if(!m)throw Error('合并范围不是矩形 A1 表达式：'+r);
    const col=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);return [col(m[1]),+m[2],col(m[3]),+m[4]];};
  const additions=desired.filter(r=>!existing.includes(r));
  for(const r of additions){const [a,b,c,d]=parse(r);for(const old of existing){const [e,f,g,h]=parse(old);
    if(a<=g&&e<=c&&b<=h&&f<=d)throw Error(`已有合并范围 ${old} 与计划 ${r} 冲突；不会自动拆开人工合并`);}}
  return additions;
}
export function buildWrites(plan,sheetId){
  if(!plan.write_ready)throw Error('名单存在冲突或未分配报名，先查看名单写入计划');
  return plan.diff.map(d=>{
    const cell={value:d.after};
    const match=/^([A-Z]+)(\d+)$/.exec(d.cell);
    if(match){
      const index=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
      const header=plan.headers[index],row=plan.rows[Number(match[2])-2];
      const role=row?.[plan.headers.indexOf('职责')];
      let color;
      if(header==='职责')color=role==='运营'?'#DBEAFE':role==='专业'?'#DCFCE7':undefined;
      else if(applicable[header])color=applicable[header].includes(role)
        ?(role==='运营'?'#DBEAFE':'#DCFCE7'):'#E5E7EB';
      if(color)cell.cell_styles={background_color:color};
    }
    return {sheet_id:sheetId,range:d.cell,cells:[[cell]]};
  });
}
export function verifyStyledWrites(writes,readback){
  if(readback.data?.has_more||readback.data?.truncated)throw Error('写后样式回读截断');
  const actual=new Map();
  for(const range of readback.data?.ranges||[]){
    if(range.truncated)throw Error('写后样式回读截断');
    for(let i=0;i<(range.cells||[]).length;i++)
      for(let j=0;j<(range.cells[i]||[]).length;j++)
        actual.set(`${range.col_indices[j]}${range.row_indices[i]}`,range.cells[i][j]);
  }
  const normalize=value=>{
    const raw=String(value||'').trim();
    const rgb=/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(raw);
    return rgb?'#'+rgb.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join('').toUpperCase():raw.toUpperCase();
  };
  for(const write of writes){
    const expected=write.cells[0][0].cell_styles?.background_color;
    if(expected&&normalize(actual.get(write.range)?.cell_styles?.background_color)!==normalize(expected))
      throw Error('样式回读不一致：'+write.range);
  }
}
export function runRoster(ctx,out,lark,{apply=false,online=false}={}){
  const {config,resolve}=ctx,settings=config.roster;
  if(!settings?.courses_file||(!settings?.export_file&&!settings?.offline_workbook))throw Error('名单配置缺少 courses_file 或 export_file/offline_workbook');
  const courses=recruitmentCourseInput(load(resolve(settings.courses_file)));
  fs.mkdirSync(out,{recursive:false});
  const courseFile=path.join(out,'助教课程事实.json');
  save(courseFile,courses);
  const token=settings.spreadsheet_token,sheet=settings.sheet_id;
  let target=settings.target_snapshot?resolve(settings.target_snapshot):null,structure=null,workbook=null;
  const scoped=['--spreadsheet-token',token,'--sheet-id',sheet];
  function fresh(){
    const wb=lark('sheets','+workbook-info',['--spreadsheet-token',token]);
    const data=wb.data||{}, sheets=data.sheets||data.spreadsheet?.sheets||[];
    const metadata=sheets.find(s=>s.sheet_id===sheet);
    if(!metadata)throw Error('目标子表不在当前工作簿');
    const columns=metadata.grid_properties?.column_count||metadata.column_count;
    const rows=metadata.grid_properties?.row_count||metadata.row_count;
    if(!Number.isInteger(columns)||!Number.isInteger(rows))throw Error('无法确认目标表完整行列范围');
    function col(n){let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
    const values=lark('sheets','+csv-get',[...scoped,'--range',`A1:${col(columns)}${rows}`,'--max-chars','10000000']);
    if(values.data?.has_more||values.data?.truncated)throw Error('源表截断，禁止写入');
    const layout=lark('sheets','+sheet-info',[...scoped,'--include','merges']);
    if(values.data?.revision&&layout.data?.revision&&values.data.revision!==layout.data.revision)throw Error('源表和合并结构版本不同，请重新读取');
    return {values,layout,wb};
  }
  if(online||apply){
    if(!token||!sheet)throw Error('在线名单操作需要 spreadsheet_token 和 sheet_id');
    const current=fresh();target=path.join(out,'写前源表.json');structure=current.layout;workbook=current.wb;
    save(target,current.values);save(path.join(out,'写前结构.json'),structure);save(path.join(out,'工作簿结构.json'),workbook);
  }
  const args=['-B',path.join(SKILL_ROOT,'scripts','助教清单.py'),'--period',config.period,
    '--courses',courseFile,'--export',resolve(settings.export_file||settings.offline_workbook),'--out',path.join(out,'preview')];
  if(settings.offline_workbook)args.push('--offline',resolve(settings.offline_workbook));
  if(target)args.push('--target',target);
  if(settings.aliases_file)args.push('--aliases',resolve(settings.aliases_file));
  run(python(config),args);
  const plan=load(path.join(out,'preview','名单写入计划.json'));
  save(path.join(out,'运行摘要.json'),{...plan.summary,write_ready:plan.write_ready,apply,online,screenshot_required:true,screenshot_verified:false});
  if(!apply)return {...plan.summary,write_ready:plan.write_ready,applied:false,screenshot_required:true,screenshot_verified:false};
  const metadata=(workbook.data.sheets||workbook.data.spreadsheet?.sheets||[]).find(s=>s.sheet_id===sheet);
  const availableRows=metadata.grid_properties?.row_count||metadata.row_count;
  if(plan.summary.slots+1>availableRows)throw Error('目标表行数不足；请先扩展原模板，再使用新运行目录预览');
  const changes=buildWrites(plan,sheet);
  const existing=(structure.data?.merged_cells||[]).map(x=>x.range);
  const merges=mergeDelta(existing,plan.merge_ranges);
  // 计划产生后再次完整读取，发现变化就停，避免用旧快照写入。
  const latest=fresh();
  if(signature(latest.values.data)!==signature(load(target).data)||signature(latest.layout.data)!==signature(structure.data))
    throw Error('预览后源表变化；本次没有写入，请使用新运行目录重新预览');
  const ledger=path.join(out,'执行台账.jsonl');
  for(let i=0;i<changes.length;i+=100){
    const chunk=changes.slice(i,i+100);
    lark('sheets','+cells-set',['--spreadsheet-token',token,'--writes','-'],JSON.stringify(chunk));
    fs.appendFileSync(ledger,JSON.stringify({step:'cells',count:chunk.length,at:new Date().toISOString()})+'\n');
  }
  if(merges.length){
    const name=(workbook.data.sheets||[]).find(s=>s.sheet_id===sheet)?.sheet_name;
    if(!name)throw Error('未取得子表名，无法提交合并规格');
    lark('sheets','+styles-put',['--spreadsheet-token',token,'--styles','-'],JSON.stringify({styles:[{name,cell_merges:merges.map(range=>({range}))}]}));
    fs.appendFileSync(ledger,JSON.stringify({step:'merges',ranges:merges,at:new Date().toISOString()})+'\n');
  }
  const after=fresh();save(path.join(out,'写后源表.json'),after.values);save(path.join(out,'写后结构.json'),after.layout);
  const styled=changes.some(w=>w.cells[0][0].cell_styles);
  if(styled){
    const styles=lark('sheets','+cells-get',['--spreadsheet-token',token,'--sheet-id',sheet,
      '--range',`C2:R${plan.summary.slots+1}`,'--include','style','--max-chars','10000000']);
    save(path.join(out,'写后样式回读.json'),styles);
    verifyStyledWrites(changes,styles);
  }
  const verifyArgs=[...args];const targetIndex=verifyArgs.indexOf('--target');
  verifyArgs[targetIndex+1]=path.join(out,'写后源表.json');verifyArgs[verifyArgs.indexOf('--out')+1]=path.join(out,'readback');
  run(python(config),verifyArgs);
  const checked=load(path.join(out,'readback','名单写入计划.json'));
  if(checked.diff.length||!checked.write_ready)throw Error('写后名单不一致；请检查台账与回读，不能盲目重发');
  const actualMerges=(after.layout.data?.merged_cells||[]).map(x=>x.range);
  if(plan.merge_ranges.some(r=>!actualMerges.includes(r)))throw Error('写后合并范围不完整');
  const result={...plan.summary,applied:true,written_cells:changes.length,merged:merges.length,
    readback:true,style_readback:styled,screenshot_required:true,screenshot_verified:false};
  save(path.join(out,'验收结果.json'),result);return result;
}
