#!/usr/bin/env python3
"""Antigravity 钩子共用工具：数据目录隔离、工作台绑定、惰性目录与并发状态管理。

目录与隔离原则：
  * 运行时日志、状态文件与 net-map.tsv 统一存放在 DATA_DIR（默认为
    ~/.local/share/agy-note-offload，支持 AGY_OFFLOAD_DATA_DIR 覆盖），
    避免污染插件目录或 git 工作树。
  * 落盘工作台根目录默认 ~/agy-notes，支持 AGY_NOTE_ROOT 环境变量覆盖。
  * resolve_note_dir 默认惰性（create=False），仅在真正写笔记时创建目录，
    彻底杜绝普通问答产生大量空文件夹。
"""
import contextlib
import hashlib
import json
import os
import re
import time
import uuid

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.path.expanduser(
    os.environ.get("AGY_OFFLOAD_DATA_DIR") or "~/.local/share/agy-note-offload"
))
LOG_PATH = os.path.join(DATA_DIR, "hook-invocations.log")
LOG_LOCK_PATH = os.path.join(DATA_DIR, "hook-invocations.log.lock")
STATE_PATH = os.path.join(DATA_DIR, ".filter-retry-state.json")
STATE_LOCK_PATH = os.path.join(DATA_DIR, ".filter-retry-state.lock")

MAX_LOG_BYTES = 200_000
KEEP_LINES = 300
TTL_SECONDS = 7 * 24 * 3600
NOTE_ROOT = os.path.abspath(os.path.expanduser(
    os.environ.get("AGY_NOTE_ROOT") or "~/agy-notes"
))

WS_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_NOTE_DIR_RE = re.compile(r"(?:~|/[^\s\"'`<>]+)?/agy-notes/([A-Za-z0-9][A-Za-z0-9._-]{0,63})")
_FENCED_CODE_RE = re.compile(r"(`{3,}|~{3,})[\s\S]*?\1")
_INLINE_CODE_RE = re.compile(r"`+[^`\n]*?`+")
_EXPLICIT_CMD_RE = re.compile(r"(?<![A-Za-z0-9._~/-])/note-offload(?![A-Za-z0-9._/-])")
_PLACEHOLDERS = {"name", "task", "work", "dir", "conv", "conv8", "session", "workspace", "example"}


def _ensure_data_dir():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        pass


def short_path(path):
    """若路径位于当前用户主目录下则压缩为 ~/...，否则返回规范化绝对路径。"""
    abs_p = os.path.abspath(os.path.expanduser(path))
    home = os.path.abspath(os.path.expanduser("~"))
    if abs_p == home:
        return "~"
    if abs_p.startswith(home + os.sep):
        return "~" + abs_p[len(home):]
    return abs_p


def note_root_display():
    """返回当前生效落盘根目录的展示路径（默认 ~/agy-notes）。"""
    return short_path(NOTE_ROOT)


@contextlib.contextmanager
def _file_lock(lock_path):
    if fcntl is None:
        yield
        return
    fh = None
    locked = False
    try:
        _ensure_data_dir()
        fh = open(lock_path, "a+", encoding="utf-8")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        locked = True
    except OSError:
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
            fh = None
    try:
        yield
    finally:
        if fh is not None:
            if locked:
                try:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            try:
                fh.close()
            except OSError:
                pass


def state_lock():
    """获取状态文件排他事务锁，用于并发读改写保护。"""
    return _file_lock(STATE_LOCK_PATH)


def log(line):
    """追加一行调用日志，在文件锁保护下超限先原子轮转。"""
    with _file_lock(LOG_LOCK_PATH):
        tmp = None
        try:
            _ensure_data_dir()
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_LOG_BYTES:
                with open(LOG_PATH, encoding="utf-8", errors="replace") as fh:
                    tail = fh.read().splitlines()[-KEEP_LINES:]
                tmp = f"{LOG_PATH}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}"
                with open(tmp, "w", encoding="utf-8") as fh:
                    if tail:
                        fh.write("\n".join(tail) + "\n")
                    fh.flush()
                os.replace(tmp, LOG_PATH)
                tmp = None
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write("%s %s\n" % (time.strftime("%F %T"), line))
        except OSError:
            pass
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass


def housekeeping():
    """状态文件超过一天没被动过就清一次过期条目。"""
    try:
        if not os.path.exists(STATE_PATH) or os.path.getmtime(STATE_PATH) >= time.time() - 86400:
            return
    except OSError:
        return
    with state_lock():
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
    tmp = None
    try:
        _ensure_data_dir()
        tmp = f"{STATE_PATH}.tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
            fh.flush()
        os.replace(tmp, STATE_PATH)
        tmp = None
    except OSError:
        pass
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def strip_markdown_code(text, strip_inline=True):
    """剥离围栏代码块（以及可选的行内反引号代码片段），避免引用示例误触发。"""
    if not text:
        return ""
    cleaned = _FENCED_CODE_RE.sub(" ", text)
    if strip_inline:
        cleaned = _INLINE_CODE_RE.sub(" ", cleaned)
    return cleaned


def has_explicit_offload(text):
    """仅当非代码文本出现独立命令词 /note-offload 或 [落盘模式]/[文件模式] 才返回 True。"""
    plain = strip_markdown_code(text, strip_inline=True)
    if "[落盘模式]" in plain or "[文件模式]" in plain:
        return True
    return bool(_EXPLICIT_CMD_RE.search(plain))


def extract_note_dir(text):
    """从非围栏代码文本中提取显式指定的命名工作台路径。"""
    if not text:
        return ""
    cleaned = strip_markdown_code(text, strip_inline=False)
    patterns = [_NOTE_DIR_RE]
    root_disp = note_root_display()
    for base in {NOTE_ROOT.rstrip("/"), root_disp.rstrip("/")}:
        if base and not base.endswith("/agy-notes"):
            patterns.append(
                re.compile(re.escape(base) + r"/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?![A-Za-z0-9._-])")
            )
    candidates = []
    for pat in patterns:
        for match in pat.finditer(cleaned):
            candidates.append((match.start(), match.group(1)))
    candidates.sort(key=lambda item: item[0])
    for _, raw_name in candidates:
        name = raw_name.rstrip(".")
        if not name or ".." in name or not WS_NAME_RE.fullmatch(name) or name.lower() in _PLACEHOLDERS:
            continue
        return f"{root_disp}/{name}"
    return ""


def _to_abs_note_dir(conv, entry=None):
    if isinstance(entry, dict):
        nd = entry.get("note_dir") or ""
        if isinstance(nd, str):
            rel = ""
            prefixes = (
                "~/agy-notes/",
                note_root_display().rstrip("/") + "/",
                NOTE_ROOT.rstrip("/") + "/",
            )
            for pfx in prefixes:
                if nd.startswith(pfx):
                    rel = nd[len(pfx):].strip("/")
                    break
            if rel and "/" not in rel and ".." not in rel and WS_NAME_RE.fullmatch(rel):
                return os.path.join(NOTE_ROOT, rel)
    raw_key = (conv or "misc")[:8]
    safe_key = re.sub(r"[^A-Za-z0-9._-]", "_", raw_key).lstrip(".") or "misc"
    if ".." in safe_key:
        safe_key = "misc"
    return os.path.join(NOTE_ROOT, safe_key)


def resolve_note_dir(conv, entry=None, create=False):
    """解析本会话目标落盘目录（优先绑定的命名工作台，否则回退 <conv8>），默认惰性不建目录。"""
    path = _to_abs_note_dir(conv, entry)
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
    return short_path(path)


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
    return short_path(picked)


def input_sig(text):
    """将用户输入规整后生成 12 位指纹，用于识别原样重发。"""
    norm = " ".join((text or "").split())
    if not norm:
        return ""
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]
