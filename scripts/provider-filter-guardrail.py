#!/usr/bin/env python3
"""Antigravity SessionStart hook: 惰性落盘目录提示并清理同会话残留状态。

原则：
  * 只在新会话开头（或撤回重发触发 SessionStart 时）注入 1 条极简落盘目录约定；
  * 调用 resolve_note_dir(..., create=False)，不提前在磁盘建空目录；
  * 若状态文件中存在同 conversationId 的旧记录，立即清零；
  * 提示词保持纯正面、全中文化，不提任何审核/替换/重试类元描述。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hooklib  # noqa: E402
import sanitize  # noqa: E402

EXPECTED = "SessionStart"

GUIDE = (
    "[落盘目录] 本会话的大段日志、长表格、反汇编或长清单优先写入 {dir}/"
    "（若指定了专属 {root}/<工作台>/ 则写该目录），"
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
        with hooklib.state_lock():
            state = hooklib.load_state()
            if conv in state:
                state.pop(conv, None)
                hooklib.save_state(state)

    hooklib.log("sessionstart conv=%s" % (conv or None))
    msg = (
        sanitize.clean(GUIDE)
        .replace("{root}", hooklib.note_root_display())
        .replace("{dir}", hooklib.resolve_note_dir(conv, create=False))
    )
    print(json.dumps({
        "injectSteps": [{"systemMessage": {"systemMessage": msg}}],
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
