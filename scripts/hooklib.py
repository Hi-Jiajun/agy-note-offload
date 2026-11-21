#!/usr/bin/env python3
"""Antigravity 钩子共用工具：数据目录隔离、工作台绑定、惰性目录与状态管理。

目录与隔离原则：
  * 运行时日志、状态文件与 net-map.tsv 统一存放在 DATA_DIR（默认为
    ~/.local/share/agy-note-offload，支持 AGY_OFFLOAD_DATA_DIR 覆盖），
    避免污染插件目录或 git 工作树。
  * resolve_note_dir 默认惰性（create=False），仅在真正写笔记时创建目录，
    彻底杜绝普通问答产生大量空文件夹。
"""
import hashlib
import json
import os
import re
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.expanduser(
    os.environ.get("AGY_OFFLOAD_DATA_DIR") or "~/.local/share/agy-note-offload"
)
LOG_PATH = os.path.join(DATA_DIR, "hook-invocations.log")
STATE_PATH = os.path.join(DATA_DIR, ".filter-retry-state.json")

MAX_LOG_BYTES = 200_000
KEEP_LINES = 300
TTL_SECONDS = 7 * 24 * 3600
NOTE_ROOT = os.path.join(os.path.expanduser("~"), "agy-notes")

_NOTE_DIR_RE = re.compile(r"(?:~|/[^\s\"'`<>]+)?/agy-notes/([A-Za-z0-9][A-Za-z0-9._-]{0,63})")
_PLACEHOLDERS = {"name", "task", "work", "dir", "conv", "conv8", "session", "workspace", "example"}


def _ensure_data_dir():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        pass


def log(line):
    """追加一行调用日志，超限先就地轮转。"""
    try:
        _ensure_data_dir()
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
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    return {
        conv: entry
        for conv, entry in raw.items()
        if isinstance(entry, dict) and now - float(entry.get("ts") or 0) < TTL_SECONDS
    }


def save_state(state):
    try:
        _ensure_data_dir()
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def extract_note_dir(text):
    """从文本中提取显式指定的命名工作台路径（~/agy-notes/<name>）。"""
    if not text:
        return ""
    for match in _NOTE_DIR_RE.finditer(text):
        name = match.group(1).rstrip(".")
        if not name or name.lower() in _PLACEHOLDERS:
            continue
        return f"~/agy-notes/{name}"
    return ""


def _to_abs_note_dir(conv, entry=None):
    if isinstance(entry, dict):
        nd = entry.get("note_dir") or ""
        if isinstance(nd, str) and nd.startswith("~/agy-notes/"):
            rel = nd[len("~/agy-notes/"):].strip("/")
            if rel and "/" not in rel and ".." not in rel:
                return os.path.join(NOTE_ROOT, rel)
    key = (conv or "misc")[:8]
    return os.path.join(NOTE_ROOT, key)


def resolve_note_dir(conv, entry=None, create=False):
    """解析本会话目标落盘目录（优先绑定的命名工作台，否则回退 <conv8>），默认惰性不建目录。"""
    path = _to_abs_note_dir(conv, entry)
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


def note_dir(conv, create=False):
    """兼容旧调用入口的轻量包装。"""
    return resolve_note_dir(conv, None, create=create)


def latest_note(conv, entry=None):
    """在绑定的落盘目录中查找最新输出笔记（优先 turn-*.md，其次 status.md，跳过 task.md）。"""
    path = _to_abs_note_dir(conv, entry)
    if not os.path.isdir(path):
        return ""

    best_turn = (-1.0, "")
    status_path = ""
    try:
        for name in os.listdir(path):
            full = os.path.join(path, name)
            if not os.path.isfile(full):
                continue
            if name.startswith("turn-") and name.endswith(".md"):
                mtime = os.path.getmtime(full)
                if mtime > best_turn[0]:
                    best_turn = (mtime, full)
            elif name == "status.md":
                status_path = full
    except OSError:
        return ""

    picked = best_turn[1] or status_path
    if not picked:
        return ""
    home = os.path.expanduser("~")
    return "~" + picked[len(home):] if picked.startswith(home) else picked


def input_sig(text):
    """将用户输入规整后生成 12 位指纹，用于识别原样重发。"""
    norm = " ".join((text or "").split())
    if not norm:
        return ""
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]
