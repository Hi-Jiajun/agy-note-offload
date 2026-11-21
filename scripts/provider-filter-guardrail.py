#!/usr/bin/env python3
"""Antigravity SessionStart hook: 预建落盘目录并清理同会话残留状态（含撤回重发场景）。

原则：
  * 只在新会话开头（或撤回重发触发 SessionStart 时）注入 1 条极简落盘目录约定；
  * 若状态文件中存在同 conversationId 的旧熔断/重试记录（例如用户撤回重跑），立即清零；
  * 不设 400 字上限，不提任何审核/替换/重试类元描述，保持平时原生体验。
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
    if conv:
        state = hooklib.load_state()
        if conv in state:
            state.pop(conv, None)
            hooklib.save_state(state)

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
