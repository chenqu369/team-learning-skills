import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareRosterSheet,buildWrites,verifyStyledWrites} from '../runtime/assistant/scripts/飞书清单同步.mjs';

const tempDirs=[];
const temp=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roster-sheet-'));tempDirs.push(dir);return path.join(dir,'result');};
after(()=>{for(const dir of tempDirs)fs.rmSync(dir,{recursive:true,force:true});});
const headers=JSON.parse(fs.readFileSync(new URL('../runtime/assistant/assets/单维表列序.json',import.meta.url),'utf8')).headers;
const ctx={config:{period:'2026-10',roster:{spreadsheet_token:'book',courses_file:'courses.json'}},
  resolve:p=>p};
const courses={courses:[{name:'课程A',group_count:1}]};

test('只读预检给出当期月份名称且不建子表',()=>{
  const out=temp(),calls=[];
  const lark=(group,action,args)=>{calls.push(action);return {ok:true,data:{sheets:[]}};};
  const result=prepareRosterSheet(ctx,out,lark,{apply:false,courses});
  assert.equal(result.sheet_name,'10月');
  assert.equal(result.created,false);
  assert.deepEqual(calls,['+workbook-info']);
});

test('新建子表后必须回读 ID，设置四状态单选并保留 22 列',()=>{
  const out=temp(),calls=[];let reads=0;
  const lark=(group,action,args,input)=>{
    calls.push({action,args,input});
    if(action==='+workbook-info')return {ok:true,data:{sheets:reads++?[
      {sheet_id:'new123',sheet_name:'10月',resource_type:'sheet',row_count:200,column_count:22}
    ]:[]}};
    if(action==='+cells-get'){
      const range=args[args.indexOf('--range')+1];
      if(range==='A1:V1')return {ok:true,data:{ranges:[{cells:[headers.map(value=>({value}))]}]}};
      return {ok:true,data:{ranges:[{cells:[Array.from({length:10},()=>({data_validation:{type:'list',enable_highlight:false,items:['待核对','已核实完成','存在问题','不适用']}}))]}]}};
    }
    return {ok:true,data:{}};
  };
  const result=prepareRosterSheet(ctx,out,lark,{apply:true,courses});
  assert.equal(result.sheet_id,'new123');
  assert.equal(result.created,true);
  assert.deepEqual(calls.map(c=>c.action),['+workbook-info','+sheet-create','+workbook-info','+cells-set','+styles-put','+dropdown-update','+cells-get','+cells-get']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--title')+1],'10月');
  assert.equal(JSON.parse(calls[3].input)[0].length,22);
  assert.deepEqual(JSON.parse(calls[5].args[calls[5].args.indexOf('--options')+1]),
    ['待核对','已核实完成','存在问题','不适用']);
  assert.ok(calls[5].args.includes('--multiple=false'));
  const styles=JSON.parse(calls[4].input).styles[0];
  assert.deepEqual(styles.freeze,{rows:1,cols:5});
  assert.equal(styles.cell_styles[0].background_color,'#E5E7EB');
  assert.equal(result.readback,true);
});

test('已有同名子表未明确指定 ID 时不写入',()=>{
  const out=temp(),calls=[];
  const lark=(group,action)=>{calls.push(action);return {ok:true,data:{sheets:[
    {sheet_id:'old',sheet_name:'10月',resource_type:'sheet',row_count:200,column_count:22}
  ]}};};
  const preview=prepareRosterSheet(ctx,out,lark,{apply:false,courses});
  assert.equal(preview.candidate_sheet_id,'old');
  assert.equal(preview.pending_confirmation,true);
  assert.throws(()=>prepareRosterSheet(ctx,temp(),lark,{apply:true,courses}),/已有同名子表.*sheet_id/);
  assert.deepEqual(calls,['+workbook-info','+workbook-info']);
});

test('已确认的同名子表只补单选配置，不重建或改已有值',()=>{
  const out=temp(),calls=[];
  const confirmed={...ctx,config:{...ctx.config,roster:{...ctx.config.roster,sheet_id:'old'}}};
  const lark=(group,action,args)=>{
    calls.push(action);
    if(action==='+workbook-info')return {ok:true,data:{sheets:[
      {sheet_id:'old',sheet_name:'10月',resource_type:'sheet',row_count:200,column_count:22}
    ]}};
    if(action==='+cells-get'){
      const range=args[args.indexOf('--range')+1];
      if(range==='A1:V1')return {ok:true,data:{ranges:[{cells:[headers.map(value=>({value}))]}]}};
      if(range==='I2:R200')return {ok:true,data:{ranges:[{actual_range:'I2:R200',
        cells:Array.from({length:199},(_,i)=>Array.from({length:10},()=>({value:i===0?'待核对':undefined})))}]}};
      return {ok:true,data:{ranges:[{cells:[Array.from({length:10},()=>({data_validation:{type:'list',enable_highlight:false,items:['待核对','已核实完成','存在问题','不适用']}}))]}]}};
    }
    return {ok:true,data:{}};
  };
  const result=prepareRosterSheet(confirmed,out,lark,{apply:true,courses});
  assert.equal(result.created,false);
  assert.equal(result.readback,true);
  assert.equal(calls.includes('+sheet-create'),false);
  assert.equal(calls.includes('+cells-set'),false);
  assert.equal(calls.filter(x=>x==='+dropdown-update').length,1);
});

test('已有人工检查值不在四状态内时不安装下拉',()=>{
  const confirmed={...ctx,config:{...ctx.config,roster:{...ctx.config.roster,sheet_id:'old'}}};
  const calls=[];
  const lark=(group,action,args)=>{
    calls.push(action);
    if(action==='+workbook-info')return {ok:true,data:{sheets:[
      {sheet_id:'old',sheet_name:'10月',resource_type:'sheet',row_count:200,column_count:22}
    ]}};
    const range=args[args.indexOf('--range')+1];
    if(range==='A1:V1')return {ok:true,data:{ranges:[{cells:[headers.map(value=>({value}))]}]}};
    return {ok:true,data:{ranges:[{actual_range:'I2:R200',
      cells:Array.from({length:199},(_,i)=>Array.from({length:10},(_,j)=>({value:i===0&&j===0?'人工备注':undefined})))}]}};
  };
  assert.throws(()=>prepareRosterSheet(confirmed,temp(),lark,{apply:true,courses}),/人工值/);
  assert.equal(calls.includes('+dropdown-update'),false);
});

test('清单写入只给岗位适用检查项着色，灰色不适用',()=>{
  const plan={write_ready:true,headers:['课程名','职责','群欢迎公告','答疑'],
    rows:[['课程A','运营','待核对','不适用'],['','专业','不适用','待核对']],
    diff:[{cell:'B2',after:'运营'},{cell:'C2',after:'待核对'},
      {cell:'D2',after:'不适用'},{cell:'C3',after:'不适用'},{cell:'D3',after:'待核对'}]};
  const writes=buildWrites(plan,'new123');
  const color=cell=>writes.find(w=>w.range===cell).cells[0][0].cell_styles?.background_color;
  assert.equal(color('B2'),'#DBEAFE');
  assert.equal(color('C2'),'#DBEAFE');
  assert.equal(color('D2'),'#E5E7EB');
  assert.equal(color('C3'),'#E5E7EB');
  assert.equal(color('D3'),'#DCFCE7');
});

test('写后样式回读发现岗位颜色不符时停止验收',()=>{
  const writes=[{range:'C2',cells:[[{value:'运营',cell_styles:{background_color:'#DBEAFE'}}]]}];
  const good={data:{ranges:[{row_indices:[2],col_indices:['C'],cells:[[{cell_styles:{background_color:'rgb(219, 234, 254)'}}]]}]}};
  assert.doesNotThrow(()=>verifyStyledWrites(writes,good));
  const wrong={data:{ranges:[{row_indices:[2],col_indices:['C'],cells:[[{cell_styles:{background_color:'#DCFCE7'}}]]}]}};
  assert.throws(()=>verifyStyledWrites(writes,wrong),/样式回读不一致/);
});
