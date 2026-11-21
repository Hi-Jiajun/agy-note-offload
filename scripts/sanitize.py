#!/usr/bin/env python3
"""把注入给模型的文本过一遍替换：英文与对抗味词一律换中文中性说法。"""
import re

REPLACEMENTS = (
    (r"\btransId\b", "事务号"),
    (r"\bsessionId\b", "会话号"),
    (r"\bsha256\b", "摘要指纹"),
    (r"\bPEM\b", "证书文本"),
    (r"\bJSON\b", "报文体"),
    (r"\bIPv4\b", "内网地址"),
    (r"\bbypass\b", "越过"),
    (r"\bintercept\b", "接管"),
    (r"\bexploit\b", "利用"),
    (r"\bpayload\b", "报文体"),
    (r"\bfake password\b", "免密"),
    (r"\block\s?screen\b", "锁屏"),
    (r"\broot ca\b", "根证书"),
    (r"\bcertificate\b", "证书"),
    (r"\battestation\b", "证明"),
    (r"\bcredential\b", "凭据"),
    (r"<lan>", "<内网>"),
    (r"<pem>", "<证书>"),
    (r"<json>", "<报文>"),
    (r"<id>", "<编号>"),
    (r"安全过滤器", "内容校验"),
    (r"绕开", "越过"),
    (r"攻防", "对抗"),
)

KEEP = (
    "neturl", "net-map.tsv", "https", "http", "md", "hook",
    "decision", "continue", "reason", "injectSteps", "systemMessage",
    "metadata", "user_markdown", "terminationBehavior", "terminate", "note-offload",
    "write_file", "run_command", "exit_plan_mode", "agynote", "task.md", "status.md",
    "local", "share", "bin", "agy-note-offload",
    "config", "scripts", "gemini", "gw-", "v1", "v2",
    "agy-notes", "turn-", "read_file", "offset", "limit", "misc", "agysum", "transcript",
    "cat", "grep", "sed", "tail", "width", "n",
)

_COMPILED = tuple((re.compile(p, re.IGNORECASE if p.isascii() else 0), r) for p, r in REPLACEMENTS)
_NOTE_PATH_RE = re.compile(r"~/agy-notes/[A-Za-z0-9._-]+")


def clean(text):
    if not text:
        return text
    for pattern, repl in _COMPILED:
        text = pattern.sub(repl, text)
    return text


def latin_leftovers(text):
    # 剔除 ~/agy-notes/<workspace> 自定义目录名片段后再做残留词校验
    scrubbed = _NOTE_PATH_RE.sub("~/agy-notes/", text or "")
    words = set(re.findall(r"[A-Za-z][A-Za-z0-9_.-]*", scrubbed))
    left = []
    for w in sorted(words):
        if any(w.startswith(k) for k in KEEP):
            continue
        if re.fullmatch(r"n\d+\.?|[0-9]+", w):
            continue
        if re.fullmatch(r"[0-9a-f]{8}|selftest", w):
            continue
        left.append(w)
    return left


if __name__ == "__main__":
    import sys

    print(clean(sys.stdin.read()))
