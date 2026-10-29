"""离线清单应保留可操作的单选状态和岗位适用色。"""
import importlib.util
import json
import pathlib
import tempfile
import unittest

from openpyxl import load_workbook

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'runtime' / 'assistant' / 'scripts' / '助教清单.py'
spec = importlib.util.spec_from_file_location('roster', SCRIPT)
roster = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roster)
HEADERS = json.loads((ROOT / 'runtime' / 'assistant' / 'assets' / '单维表列序.json').read_text(encoding='utf8'))['headers']


class RosterExcelTest(unittest.TestCase):
    def test_status_dropdown_and_applicability_colors(self):
        rows = []
        for role in ('运营', '专业'):
            row = [''] * len(HEADERS)
            row[HEADERS.index('职责')] = role
            row[HEADERS.index('群欢迎公告')] = '待核对' if role == '运营' else '不适用'
            row[HEADERS.index('答疑')] = '不适用' if role == '运营' else '待核对'
            rows.append(row)
        plan = {'period': '2026-10', 'headers': HEADERS, 'rows': rows, 'merge_ranges': []}
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            file = pathlib.Path(folder) / 'roster.xlsx'
            roster.write_workbook(plan, file)
            book = load_workbook(file)
            sheet = book.active
            validations = list(sheet.data_validations.dataValidation)
            self.assertEqual(len(validations), 10)
            self.assertTrue(all(v.type == 'list' and not v.allow_blank for v in validations))
            self.assertTrue(all('已核实完成' in v.formula1 and '存在问题' in v.formula1 for v in validations))
            self.assertEqual(sheet['J2'].fill.fgColor.rgb[-6:], 'DBEAFE')
            self.assertEqual(sheet['J3'].fill.fgColor.rgb[-6:], 'E5E7EB')
            self.assertEqual(sheet['O2'].fill.fgColor.rgb[-6:], 'E5E7EB')
            self.assertEqual(sheet['O3'].fill.fgColor.rgb[-6:], 'DCFCE7')
            book.close()


if __name__ == '__main__':
    unittest.main()
