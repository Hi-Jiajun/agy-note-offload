#!/usr/bin/env python3
"""Antigravity SessionStart hook: 仅做落盘目录准备，零日常回复干扰。

原则：
  * 只在新会话开头注入 1 条极简约定：大块产出优先写入 ~/agy-notes/<会话前8位>/；
  * 不设 400 字上限，不提任何审核/替换/重试类元描述，保持平时原生体验；
  * 顺手创建好落盘目录，为随时切入落盘模式或启用 note-offload 做好准备。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hooklib  # noqa: E402
import sanitize  # noqa: E402

EXPECTED = "SessionStart"

GUIDE = (
    "[落盘目录] 本会话的大段日志、长表格、反汇编或长清单优先写入 {dir}/，"
    "正文只给结论与路径；读大文件用 grep 定位加 sed 或 read_file 分片读取。"
)


def main():
    payload = {}
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        pass
    if not isinstance(payload, dict):
        payload = {}

    ev = str(payload.get("hookEventName") or "")
    if ev and ev != EXPECTED:
        hooklib.log("%s 事件不匹配 hookEventName=%s" % (EXPECTED, ev))
        print("{}")
        return

    conv = payload.get("conversationId") or ""
    hooklib.log("sessionstart conv=%s" % (conv or None))
    msg = sanitize.clean(GUIDE).replace("{dir}", hooklib.note_dir(conv))
    print(json.dumps({
        "injectSteps": [{"systemMessage": {"systemMessage": msg}}],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
