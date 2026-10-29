"""Native PowerPoint batch renderer using the shared certificate business engine."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import struct
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
import certificates as engine

FIELDS = engine.FIELDS
SCRIPT = Path(__file__).with_name("certificate-ppt-export.ps1")


def png_dimensions(value):
    data = value if isinstance(value, bytes) else Path(value).read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise engine.Pending(["PowerPoint 导出的图片不是有效 PNG"])
    return struct.unpack(">II", data[16:24])


def template_dimensions(template, ppt):
    configured = (ppt.get("output_width"), ppt.get("output_height"))
    if all(isinstance(value, int) and value > 0 for value in configured):
        return configured
    with zipfile.ZipFile(template) as archive:
        backgrounds = sorted(name for name in archive.namelist()
                             if name.startswith("ppt/media/") and name.lower().endswith(".png"))
        if not backgrounds:
            raise engine.Pending(["PPT 模板缺内嵌 PNG 底图，且未配置 ppt.output_width/output_height"])
        return png_dimensions(archive.read(backgrounds[0]))


def powershell(job_file, timeout=600):
    start = time.perf_counter()
    process = subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-File",
                                str(SCRIPT), "-JobFile", str(job_file)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", errors="replace",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        job = engine.read_json(job_file)
        Path(job["cancel_file"]).touch()
        cleanup = "已请求PowerPoint关闭本次测试文稿"
        try:
            process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            cleanup = "COM未响应取消；只终止本次PowerShell，请检查并关闭本次生成文稿，不要关闭其他文稿或清空编号账本"
        raise engine.Pending(["PowerPoint超过时限，未提交新编号或成品；" + cleanup])
    if process.returncode:
        raise engine.Pending(["PowerPoint 导图失败: " + (stderr or stdout)[-2500:]])
    return time.perf_counter()-start


def renderer(template, config_dir, timeout=600):
    template = (Path(config_dir) / template).resolve()
    if not template.is_file():
        raise engine.Pending(["缺少 PPT 模板: " + str(template)])

    def batch(rows, config, _assets, stage):
        ppt = config.get("ppt", {})
        if not ppt.get("font_family"):
            raise engine.Pending(["缺少已确认的 ppt.font_family"])
        width, height = template_dimensions(template, ppt)
        job = {"template": str(template), "width": width, "height": height, "font_family": ppt["font_family"],
               "layout": config["layout"], "output_pptx": str(stage / "certificates.pptx"),
               "report": str(stage / "ppt-export-report.json"), "template_only": False,
               "cancel_file": str(stage / "ppt-cancel.flag"),
               "rows": []}
        for row in rows:
            relative = engine.certificate_relative_path(row)
            job["rows"].append({"key": row["key"], "number": row["number"],
                "png_path": str(stage / relative), "fields": {
                    "name": row["name"], "course": row["course_text"],
                    "role": "特授予“%s”" % row["role"], "date": row["date"], "number": row["number"]}})
        job_file = stage / "ppt-job.json"
        engine.atomic_json(job_file, job)
        elapsed = powershell(job_file, timeout)
        report = engine.read_json(job["report"])
        if report.get("ok") is not True or report["slide_count"] != len(rows):
            raise engine.Pending(["PPT 页数或导图报告不完整"])
        bounds = {item["key"]: item["bounds"] for item in report["checks"]}
        if set(bounds) != {row["key"] for row in rows}:
            raise engine.Pending(["PPT 字段校验记录不完整"])
        for item in job["rows"]:
            if png_dimensions(item["png_path"]) != (width, height):
                raise engine.Pending(["PPT 导出像素尺寸不一致"])
        with zipfile.ZipFile(job["output_pptx"]) as archive:
            if archive.testzip() is not None:
                raise engine.Pending(["PPTX 压缩结构损坏"])
            for index, row in enumerate(job["rows"], 1):
                root = ET.fromstring(archive.read(f"ppt/slides/slide{index}.xml"))
                ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
                      "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}
                for field in FIELDS:
                    shapes = [shape for shape in root.findall(".//p:sp", ns)
                              if shape.find("p:nvSpPr/p:cNvPr", ns).get("name") == "cert."+field]
                    if len(shapes) != 1 or "".join(shapes[0].itertext()).find("{{") >= 0:
                        raise engine.Pending(["PPT 字段未完整替换: " + field])
                    actual = "".join(node.text or "" for node in shapes[0].findall(".//a:t", ns))
                    if actual != row["fields"][field]:
                        raise engine.Pending(["PPT 字段与名单不符: " + field])
        return {"bounds": bounds, "extra_files": ["certificates.pptx", "ppt-export-report.json"],
                "assets_sha256": {"ppt_template": hashlib.sha256(template.read_bytes()).hexdigest()},
                "renderer_config": {"template": str(template), "font_family": ppt["font_family"]},
                "renderer": "powerpoint", "metrics": {"process_seconds": elapsed,
                    "fill_seconds": report["fill_seconds"], "export_seconds": report["export_seconds"],
                    "powerpoint_seconds": report["powerpoint_seconds"], "direct_llm_requests": 0}}
    return batch


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="固定 PPT 模板 → 批量填字段 → 证书昵称+证书类型.png")
    for option in ("people", "config", "output", "ledger", "template"):
        parser.add_argument("--"+option, required=True)
    parser.add_argument("--test-fixture", action="store_true")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    config = engine.read_json(args.config)
    start = time.perf_counter()
    try:
        result = engine.run(engine.load_people(args.people), config, Path(args.config).resolve().parent,
                            args.output, args.ledger, args.test_fixture,
                            batch_renderer=engine.select_renderer("ppt", config, Path(args.config).resolve().parent,
                                                                  args.template, args.test_fixture, args.timeout))
        print(json.dumps({"ok": True, "image_count": len(result["certificates"]),
                          "elapsed_seconds": time.perf_counter()-start,
                          "direct_llm_requests": 0, "direct_llm_tokens": 0}, ensure_ascii=False))
    except (engine.Pending, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "pending": getattr(error, "issues", [str(error)])}, ensure_ascii=False))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
