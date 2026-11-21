#!/usr/bin/env python3
"""Antigravity 钩子共用工具：自轮转日志、带 TTL 的状态文件与落盘笔记目录管理。

设计目标是把维护压到零：
  * 日志超过 MAX_LOG_BYTES 就只保留最后 KEEP_LINES 行，不需要外部 logrotate；
  * 状态文件只记最近 TTL_SECONDS 内还在用的会话，过期条目自动丢弃；
  * 所有写入失败都静默，钩子绝不因为磁盘问题阻断 agent。
"""
import json
import os
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "hook-invocations.log")
STATE_PATH = os.path.join(SCRIPT_DIR, ".filter-retry-state.json")

MAX_LOG_BYTES = 200_000
KEEP_LINES = 300
TTL_SECONDS = 7 * 24 * 3600
NOTE_ROOT = os.path.join(os.path.expanduser("~"), "agy-notes")


def log(line):
    """追加一行调用日志，超限先就地轮转。"""
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_LOG_BYTES:
            with open(LOG_PATH, encoding="utf-8", errors="replace") as fh:
                tail = fh.read().splitlines()[-KEEP_LINES:]
            with open(LOG_PATH, "w", encoding="utf-8") as fh:
                fh.write("\n".join(tail) + "\n")
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%F %T"), line))
    except OSError:
        pass


def housekeeping():
    """状态文件超过一天没被动过就清一次过期条目。"""
    try:
        if os.path.getmtime(STATE_PATH) < time.time() - 86400:
            save_state(load_state())
    except OSError:
        pass


def load_state():
    """读状态；顺手丢掉过期会话条目。"""
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {
        conv: entry
        for conv, entry in raw.items()
        if isinstance(entry, dict) and now - float(entry.get("ts") or 0) < TTL_SECONDS
    }


def save_state(state):
    try:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def _note_abs_dir(conv):
    key = (conv or "misc")[:8]
    return os.path.join(NOTE_ROOT, key)


def note_dir(conv, create=True):
    """给会话一个固定的落盘笔记目录，默认顺手建出来。"""
    path = _note_abs_dir(conv)
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


def latest_note(conv):
    """返回该会话落盘目录下最新修改的 .md 文件（~/ 缩写路径）；没有则返回空串。"""
    path = _note_abs_dir(conv)
    if not os.path.isdir(path):
        return ""
    best_mtime = -1.0
    best_path = ""
    try:
        for name in os.listdir(path):
            if not name.endswith(".md"):
                continue
            full = os.path.join(path, name)
            if not os.path.isfile(full):
                continue
            mtime = os.path.getmtime(full)
            if mtime > best_mtime:
                best_mtime = mtime
                best_path = full
    except OSError:
        return ""
    if not best_path:
        return ""
    home = os.path.expanduser("~")
    return "~" + best_path[len(home):] if best_path.startswith(home) else best_path
