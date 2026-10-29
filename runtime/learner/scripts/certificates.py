"""Shared validation, numbering, and manifest engine for the PPT certificate renderer.

Config: courses keyed by exact 所学课程 with 课程编号/营期编号/营期名/结营日期;
role_codes keyed by role; ppt contains the confirmed editable template; layout is keyed
by name/course/role/date/number with {xy:[x,y], size:n, max_width:n}. Paths are relative
to the config file. normal_role defaults to 结课证书; 结营证书 needs explicit selection.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


ROLES = ("结课证书", "优秀学习者证书", "优秀队长证书")
FIELDS = ("name", "course", "role", "date", "number")


class Pending(ValueError):
    def __init__(self, issues):
        self.issues = issues
        super().__init__("；".join(issues))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def load_people(path):
    path = Path(path)
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    value = read_json(path)
    return value if isinstance(value, list) else value["personnel"]


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".certificate-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def text(value):
    return "" if value is None else str(value)


def component(value):
    value = text(value)
    if (not value or re.search(r'[<>:"/\\|?*\x00-\x1f]', value)
            or value in (".", "..") or value.endswith((".", " "))
            or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", value, re.I)):
        raise ValueError("不能作为目录或文件名: " + value)
    return value


def prepare(people, config, config_dir, test_mode=False):
    issues, rows, seen, identities = [], [], {}, {}
    normal = config.get("normal_role", "结课证书")
    if normal not in ("结课证书", "结营证书"):
        issues.append("normal_role 必须为结课证书或显式结营证书")
    roles = (normal, "优秀学习者证书", "优秀队长证书")
    for field in FIELDS:
        spec = config.get("layout", {}).get(field, {})
        if (not isinstance(spec.get("xy"), list) or len(spec["xy"]) != 2
                or not all(isinstance(v, (int, float)) and v >= 0 for v in spec.get("xy", []))
                or not isinstance(spec.get("size"), int) or spec["size"] <= 0
                or not isinstance(spec.get("max_width"), (int, float)) or spec["max_width"] <= 0):
            issues.append("缺少有效文字布局: " + field)
    if not people:
        issues.append("人员名单为空")
    if not test_mode:
        contract = Path(__file__).with_name("learning-record-contract.mjs")
        check = subprocess.run([config.get("node_cli", "node"), str(contract), "verify-personnel"],
                               input=json.dumps({"people": people, "normal_role": normal, "current_rules": config.get("rules", []), "manual_graduation_approvals": config.get("manual_graduation_approvals", []), "final_roster_approvals": config.get("final_roster_approvals", [])}, ensure_ascii=False),
                               encoding="utf-8", capture_output=True, check=False)
        try:
            checked = json.loads(check.stdout)
        except (ValueError, TypeError):
            issues.append("统一打卡合同核验失败: " + check.stderr)
        else:
            issues.extend(checked.get("issues", []))
    for index, person in enumerate(people, 1):
        label = "第%d行" % index
        course, role = text(person.get("所学课程")), text(person.get("角色"))
        name = text(person.get("证书昵称") or person.get("微信昵称"))
        group = text(person.get("群号"))
        wx = text(person.get("微信昵称"))
        stable = text(person.get("稳定人员标识") or person.get("person_id"))
        if not stable and wx and test_mode:
            seed = json.dumps([course, wx], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            stable = "TEST-" + hashlib.sha256(seed).hexdigest()[:16]
        if not stable:
            issues.append(label + "缺稳定身份，显示昵称不能单独识别人员")
        if not name.strip() or any(ord(ch) < 32 for ch in name) or name != name.strip():
            issues.append(label + "证书昵称异常，待人工核对")
        if text(person.get("名单核准状态")) not in config.get("approved_statuses", ["已核准"]):
            issues.append(label + "名单尚未核准")
        if role not in roles:
            issues.append(label + "角色不在本次三个证书角色中: " + role)
        metadata = config.get("courses", {}).get(course, {})
        for key in ("课程编号", "营期编号", "营期名", "结营日期"):
            if not isinstance(metadata.get(key), str) or not metadata[key].strip():
                issues.append(label + "待补课程配置字符串 " + key)
        role_code = config.get("role_codes", {}).get(role)
        if not isinstance(role_code, str) or not role_code.strip():
            issues.append(label + "待补角色编码: " + role)
        try:
            component(course)
            component(group)
            component(name + role + ".png")
            prefix = component(text(role_code) + text(metadata.get("课程编号")) + text(metadata.get("营期编号")))
        except ValueError as error:
            issues.append(label + str(error))
            prefix = ""
        identity = (course, stable)
        if identity in identities and identities[identity] != group:
            issues.append(label + "同一身份群号冲突")
        identities[identity] = group
        key = json.dumps([course, metadata.get("营期编号"), role, stable], ensure_ascii=False, separators=(",", ":"))
        row = dict(key=key, name=name, course=course, role=role, group=group,
                   date=metadata.get("结营日期"), prefix=prefix,
                   course_text="于%s《%s》自组织学习中%s，" % (metadata.get("营期名", ""), course,
                        "完成全部学习" if role == normal else "表现优异"))
        if key in seen:
            if seen[key] != row:
                issues.append(label + "同一证书身份存在冲突行")
            continue
        seen[key] = row
        rows.append(row)
    if issues:
        raise Pending(issues)
    return sorted(rows, key=lambda row: row["key"]), roles, {}


def allocate(rows, ledger):
    entries = ledger.setdefault("entries", {})
    counters = ledger.setdefault("counters", {})
    occupied = {entry["number"] for entry in entries.values()}
    for row in rows:
        entry = entries.get(row["key"])
        if entry:
            if entry["prefix"] != row["prefix"]:
                raise Pending(["已有编号的编码配置变化，须核对而不能重新编号: " + row["name"]])
            row["number"] = entry["number"]
            continue
        sequence = counters.get(row["prefix"], 0) + 1
        if sequence > 99999:
            raise Pending(["五位编号序列已满"])
        number = row["prefix"] + str(sequence).zfill(5)
        if number in occupied:
            raise Pending(["编号前缀歧义或 ledger 损坏: " + number])
        counters[row["prefix"]] = sequence
        occupied.add(number)
        entries[row["key"]] = dict(prefix=row["prefix"], number=number)
        row["number"] = number


def certificate_relative_path(row):
    stable = json.loads(row["key"])[3]
    identity_dir = "person-" + hashlib.sha256(stable.encode("utf-8")).hexdigest()[:16]
    return Path(component(row["course"])) / identity_dir / (component(row["name"] + row["role"]) + ".png")


def run(people, config, config_dir, output, ledger_path, test_mode=False, batch_renderer=None):
    rows, _, assets = prepare(people, config, config_dir, test_mode)
    if batch_renderer is None:
        raise Pending(["仅支持使用确认的 PPT 模板制作证书"])
    output, ledger_path = Path(output).resolve(), Path(ledger_path).resolve()
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock = ledger_path.with_suffix(ledger_path.suffix + ".lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise Pending(["编号账本正在使用；若上次异常退出，请先确认没有运行进程再处理锁文件"])
    os.close(fd)
    try:
        ledger = read_json(ledger_path) if ledger_path.exists() else {"version": 1, "test_mode": test_mode}
        if ledger.get("test_mode") is not test_mode:
            raise Pending(["测试和正式必须使用不同编号账本"])
        allocate(rows, ledger)
        output.mkdir(parents=True, exist_ok=True)
        manifest_path = output / "manifest.json"
        previous = read_json(manifest_path) if manifest_path.exists() else None
        if not previous and any(output.iterdir()):
            raise Pending(["输出目录已有文件但无本引擎 manifest，请使用独立输出目录"])
        if previous and previous.get("test_mode") is not test_mode:
            raise Pending(["测试和正式必须使用不同输出目录"])
        manifest = {"version": 2, "test_mode": test_mode, "certificates": [],
                    "renderer": "powerpoint", "status": "preparing", "assets_sha256": {}}
        with tempfile.TemporaryDirectory(prefix=".certificate-stage-", dir=output) as stage_dir:
            stage = Path(stage_dir)
            bulk = batch_renderer(rows, config, assets, stage)
            extra_files = bulk.get("extra_files", [])
            for relative in extra_files:
                target = (stage / relative).resolve()
                if not target.is_relative_to(stage) or not target.is_file():
                    raise Pending(["批量渲染附加文件无效: " + str(relative)])
            manifest["renderer"] = bulk.get("renderer", "powerpoint")
            manifest["extra_files"] = extra_files
            manifest["render_metrics"] = bulk.get("metrics", {})
            manifest["assets_sha256"].update(bulk.get("assets_sha256", {}))
            manifest["renderer_config"] = bulk.get("renderer_config", {})
            for row in rows:
                relative = certificate_relative_path(row)
                bounds = bulk["bounds"][row["key"]]
                manifest["certificates"].append({k: row[k] for k in ("name", "course", "role", "group", "date", "number")}
                    | {"stable_id": json.loads(row["key"])[3]}
                    | {"path": str(output / relative), "relative_path": relative.as_posix(),
                       "sha256": hashlib.sha256((stage / relative).read_bytes()).hexdigest(), "text_bounds": bounds})
            # Reserve numbers before moving artifacts: a interrupted run can reuse reserved numbers.
            atomic_json(ledger_path, ledger)
            current_files = {c["relative_path"] for c in manifest["certificates"]}
            current_files.update(extra_files)
            previous_files = set(previous.get("previous_files", [])) if previous else set()
            if previous:
                previous_files.update(c["relative_path"] for c in previous["certificates"])
                previous_files.update(g["zip_relative_path"] for g in previous.get("groups", []))
                previous_files.update(previous.get("extra_files", []))
            atomic_json(manifest_path, dict(manifest, status="publishing", previous_files=sorted(previous_files)))
            for relative in current_files:
                target = output / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(stage / relative, target)
            if previous_files:
                for relative in previous_files - current_files:
                    target = (output / relative).resolve()
                    if target.is_relative_to(output) and target.is_file():
                        target.unlink()
            manifest["status"] = "complete"
            atomic_json(manifest_path, manifest)
        return manifest
    finally:
        lock.unlink()


def select_renderer(method, config, config_dir, template=None, test_mode=False, timeout=600):
    if method != "ppt":
        raise Pending(["证书制作仅支持 PPT 模板，renderer 必须为 ppt"])
    spec = config.get("ppt", {})
    if not test_mode and (spec.get("confirmed") is not True or not spec.get("provenance")
                          or spec.get("provenance") == "test_fixture"):
        raise Pending(["PPT 版式尚未确认，须先确认样张并填写 ppt.confirmed/provenance"])
    configured = spec.get("template")
    if not configured and not test_mode:
        raise Pending(["缺少已确认的 ppt.template"])
    chosen = template or configured
    if not chosen:
        raise Pending(["缺少 PPT 模板"])
    chosen = (Path(config_dir) / chosen).resolve()
    if not test_mode and configured and chosen != (Path(config_dir) / configured).resolve():
        raise Pending(["PPT 模板与已确认配置不一致"])
    if not chosen.is_file() or not spec.get("font_family"):
        raise Pending(["待补存在的PPT模板及 ppt.font_family"])
    if timeout <= 0:
        raise Pending(["PPT timeout 必须大于0"])
    if spec.get("sha256") and hashlib.sha256(chosen.read_bytes()).hexdigest() != spec["sha256"]:
        raise Pending(["PPT模板哈希与配置不符，请重新核对"])
    import certificates_ppt
    return certificates_ppt.renderer(chosen, config_dir, timeout)


def sync_production_status(result, token, manifest_path):
    if result.get("test_mode") is True:
        return {"status": "skipped_test"}
    if result.get("status") != "complete":
        raise Pending(["证书未制作完成，不能回写状态"])
    if not token:
        return {"status": "not_configured"}
    completed = subprocess.run(["node", str(Path(__file__).with_name("certificate-status.mjs")),
                                "complete", token, str(Path(manifest_path).resolve()), "--apply"],
                               cwd=Path(__file__).resolve().parents[2], capture_output=True,
                               encoding="utf-8", errors="replace")
    if completed.returncode:
        raise Pending(["证书已制作完成，但人员名单状态回写失败；可单独重试回写：" +
                       (completed.stderr or completed.stdout).strip()])
    return json.loads(completed.stdout)


def main():
    parser = argparse.ArgumentParser(description="核准名单 → 稳定编号 → PPT 模板 → 证书图片")
    parser.add_argument("--people", required=True, help="JSON 或 UTF-8 CSV 人员名单")
    parser.add_argument("--config", required=True, help="显式课程、角色编码、素材和布局 JSON")
    parser.add_argument("--output", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--test-fixture", action="store_true", help="只生成测试图片，使用独立测试账本")
    parser.add_argument("--pending-report", help="待补项 JSON 文件")
    parser.add_argument("--renderer", choices=["ppt"], default="ppt", help="固定为 ppt")
    parser.add_argument("--ppt-template", help="PPT 模板路径；正式运行须与已确认配置一致")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--details", action="store_true", help="展开每张证书结果；默认只输出摘要")
    args = parser.parse_args()
    start = time.perf_counter()
    try:
        config = read_json(args.config)
        config_dir = Path(args.config).resolve().parent
        callback = select_renderer(args.renderer, config, config_dir,
                                   args.ppt_template, args.test_fixture, args.timeout)
        result = run(load_people(args.people), config, config_dir,
                     args.output, args.ledger, args.test_fixture, batch_renderer=callback)
        status_sync = sync_production_status(result, config.get("certificate_sheet_token"),
                                            Path(args.output) / "manifest.json")
        summary = {"ok": True, "status": result["status"], "renderer": result["renderer"],
            "test_mode": args.test_fixture, "image_count": len(result["certificates"]),
            "manifest": str(Path(args.output).resolve()/"manifest.json"),
            "elapsed_seconds": time.perf_counter()-start, "direct_llm_requests": 0, "direct_llm_tokens": 0,
            "status_sync": status_sync}
        summary["pptx"] = str(Path(args.output).resolve()/"certificates.pptx")
        if args.details:
            summary["certificates"] = result["certificates"]
        print(json.dumps(summary, ensure_ascii=False))
    except (Pending, OSError, ValueError, KeyError, TypeError) as error:
        report = {"ok": False, "pending": getattr(error, "issues", [str(error)])}
        if args.pending_report:
            atomic_json(args.pending_report, report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
