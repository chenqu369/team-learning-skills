"""Exercise the production Python -> Node audit gate without rendering or online access."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

ROOT = pathlib.Path(__file__).resolve().parents[1]
module_spec = importlib.util.spec_from_file_location('certificate_maker', ROOT/'runtime/assistant/scripts/个人证书制作.py')
maker = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(maker)

class CertificateAuditTest(unittest.TestCase):
    def test_no_audit_blocks_production_before_renderer(self):
        with self.assertRaisesRegex(ValueError, 'workflow-audit'):
            maker.verify_workflow_audit(None, 'missing-people.json', 'missing-config.json')

    def test_audit_is_recomputed_and_bound_to_actual_personnel(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)
            def write(name, data):
                file=root/name; file.write_text(json.dumps(data),encoding='utf8'); return file
            people=write('people.json',[{'id':'one'}])
            config=write('config.json',{})
            now=datetime.now(timezone.utc)
            sources=[{'id':file.name,'kind':'manual' if file==people else 'file',
                'used':{'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()},
                'current':{'path':str(file),'captured_at':now.isoformat()}} for file in [people,config]]
            spec=write('audit.json',{'schema_version':1,'workflow':'certificates','phase':'preflight',
                'run_started_at':(now-timedelta(seconds=60)).isoformat(),'sources':sources,
                'coverage':{'expected':{'path':str(people),'key_fields':['id']},
                    'actual':[{'path':str(people),'key_fields':['id'],'status':'planned'}]}})
            result=maker.verify_workflow_audit(spec,people,config)
            self.assertTrue(result['ready'])
            write('people.json',[{'id':'one'},{'id':'late'}])
            with self.assertRaises(ValueError):
                maker.verify_workflow_audit(spec,people,config)

if __name__=='__main__': unittest.main()
