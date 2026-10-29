"""Validate a final roster and run the approved PowerPoint certificate renderer.

No online state writes. Output contains the PPT deck, PNG images, report, and manifest.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import subprocess

def verify_workflow_audit(audit_file, people_file, config_file):
    if not audit_file:
        raise ValueError('正式制作缺 --workflow-audit 全流程核对输入.json；先刷新来源并核对全部对象去向')
    checker=Path(__file__).resolve().parents[2]/'shared'/'workflow-audit.mjs'
    result=subprocess.run(['node',str(checker),'assert',str(Path(audit_file).resolve()),'certificates',
        str(Path(people_file).resolve()),str(Path(config_file).resolve()),'--coverage',str(Path(people_file).resolve())],capture_output=True,text=True,encoding='utf8')
    if result.returncode:
        raise ValueError('全流程核对未通过：'+(result.stderr or result.stdout).strip())
    return json.loads(result.stdout)

def component(value):
    if (not isinstance(value,str) or not value or value != value.strip()
        or re.search(r'[<>:"/\\|?*\x00-\x1f]',value) or value.endswith(('.', ' '))
        or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)',value,re.I)
        or value in ('无','？','?') or len(value.encode('utf8'))>180):
        raise ValueError('不能原样用于文件名：'+str(value))
    return value

def certificate_name(value):
    if not isinstance(value,str) or not value or value!=value.strip() or value in ('无','？','?','.','..'):
        raise ValueError('证书昵称异常：'+str(value))
    component(value)
    return value

def verify_final_ledger(people, config, requested):
    if not config.get('final_roster_source'):
        return
    canonical=config.get('certificate_ledger_path')
    if not canonical or not Path(canonical).is_absolute():
        raise ValueError('终版制证配置缺正式账本绝对路径，请刷新当前终版输入')
    target=Path(canonical).resolve()
    if requested and Path(requested).resolve()!=target:
        raise ValueError('必须沿用终版配置中的正式账本，不能更换或新建编号账本')
    ledger=json.loads(target.read_text(encoding='utf8'))
    if ledger.get('test_mode') is not False:
        raise ValueError('终版制证必须使用正式编号账本')
    for p in people:
        key=json.dumps([p['所学课程'],p['营期编号'],p['角色'],p['稳定人员标识']],ensure_ascii=False,separators=(',',':'))
        number=p.get('证书编号')
        if number and ledger.get('entries',{}).get(key,{}).get('number')!=number:
            raise ValueError('终版证书编号与实际正式账本不一致：'+str(p.get('证书昵称',key)))

def main():
    parser=argparse.ArgumentParser(description='终版人员JSON → PPT模板 → 证书昵称+证书类型.png')
    for name in ('people','config','engine'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--output');parser.add_argument('--ledger');parser.add_argument('--check',action='store_true')
    parser.add_argument('--test-fixture',action='store_true')
    parser.add_argument('--workflow-audit')
    args=parser.parse_args()
    try:
        audit=None
        if not args.test_fixture and (not args.check or args.workflow_audit):
            audit=verify_workflow_audit(args.workflow_audit,args.people,args.config)
        engine_file=Path(args.engine).resolve();sys.path.insert(0,str(engine_file.parent))
        spec=importlib.util.spec_from_file_location('certificate_source_engine',engine_file)
        engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
        people=engine.load_people(args.people);config=engine.read_json(args.config);config_dir=Path(args.config).resolve().parent
        if config.get('final_roster_source') and any(p.get('资格核验',{}).get('source_kind')!='final_roster' for p in people):
            raise ValueError('已启用终版Base，请先用最终证书名单.mjs实时读取当前最终名单')
        verify_final_ledger(people,config,args.ledger)
        # Readiness is an export decision, not a mutation of historical human approvals.
        personal_names={}
        for p in people:
            certificate_name(p.get('证书昵称'))
            personal_key=(p.get('所学课程'),p.get('稳定人员标识'))
            if personal_key in personal_names and personal_names[personal_key]!=p['证书昵称']:raise ValueError('同固定身份不同角色的制证昵称冲突，请先确认')
            personal_names[personal_key]=p['证书昵称']
            if p.get('资格核验',{}).get('source_kind')=='final_roster':
                if p.get('名单核准状态')!='已核准' or not p.get('最终名单记录ID') or not p.get('制证依据'):raise ValueError('缺当前终版Base制证依据')
            elif p.get('角色')==config.get('normal_role','结课证书'):
                if p.get('资格核验',{}).get('source_kind')=='manual_graduation':
                    if p.get('名单核准状态')!='已核准' or not p.get('优秀申报记录ID') or not p.get('制证依据'):raise ValueError('人工结营名单缺本批明确确认及来源依据')
                elif p.get('名单核准状态')!='自动通过' or p.get('制证依据')!='当前结营主记录自动通过':raise ValueError('普通名单缺本批自动通过依据')
            elif p.get('名单核准状态')!='已核准' or not p.get('优秀申报记录ID') or not p.get('制证依据'):raise ValueError('优秀名单缺明确确认及来源依据')
        config={**config,'approved_statuses':['自动通过','已核准']};config.pop('certificate_sheet_token',None)
        rows,roles,assets=engine.prepare(people,config,config_dir,args.test_fixture)
        if args.check:
            print(json.dumps({'ok':True,'phase':'preflight','certificate_count':len(rows),'online_write':False,
                'full_scope_verified':bool(audit),'reminder':None if audit else '仅制证参数检查；正式制作前须运行全流程核对'},ensure_ascii=False));return 0
        if not args.output or not args.ledger:raise ValueError('实际制作需要 --output 与持久 --ledger')
        output=Path(args.output).resolve()
        if output.exists():raise ValueError('输出目录已存在，请使用新目录')
        output.parent.mkdir(parents=True,exist_ok=True)
        callback=engine.select_renderer('ppt',config,config_dir,test_mode=args.test_fixture)
        result=engine.run(people,config,config_dir,output,args.ledger,args.test_fixture,batch_renderer=callback)
        if audit:
            (output/'全流程执行核对.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'ok':True,'phase':'complete','test_mode':args.test_fixture,'image_count':len(result['certificates']),
            'manifest':str(output/'manifest.json'),'pptx':str(output/'certificates.pptx'),'online_write':False},ensure_ascii=False));return 0
    except (ValueError,OSError,KeyError) as error:
        print(json.dumps({'ok':False,'pending':str(error)},ensure_ascii=False));return 2

if __name__=='__main__':raise SystemExit(main())
