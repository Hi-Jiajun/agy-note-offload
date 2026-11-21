#!/usr/bin/env python3
"""把注入给模型的文本过一遍替换：英文与对抗味词一律换中文中性说法。

为什么要单独一层：多段提示词分散在多个脚本里，改一处漏两处。集中在这里，只维护一张表，
所有 hook 在打印前都过一遍，加了新词也只改这个文件。

替换只作用于「注入文本」，不作用于真值文件与命令本身，所以 neturl、net-map.tsv、https
这些必须保留的标识符放在 KEEP 里不参与匹配，也不参与漏网判定。
"""
import re

# 顺序有意义：先长后短，避免半边被吃掉。
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

# 这些词允许原样出现：命令、文件名、协议头、JSON 键名、路径片段、别名与技能名。
KEEP = (
    "neturl", "net-map.tsv", "https", "http", "md", "hook",
    "decision", "continue", "reason", "injectSteps", "systemMessage",
    "metadata", "user_markdown", "terminationBehavior", "terminate", "note-offload",
    "config", "scripts", "gemini", "gw-", "v1", "v2",
    "agy-notes", "turn-", "read_file", "offset", "limit", "misc", "agysum", "transcript",
    "cat", "grep", "sed", "tail", "width", "n",
)

_COMPILED = tuple((re.compile(p, re.IGNORECASE if p.isascii() else 0), r) for p, r in REPLACEMENTS)


def clean(text):
    """把敏感英文与对抗味词换成中文中性说法。"""
    if not text:
        return text
    for pattern, repl in _COMPILED:
        text = pattern.sub(repl, text)
    return text


def latin_leftovers(text):
    """返回注入文本里残留的拉丁词（KEEP 之外），给自检用。"""
    words = set(re.findall(r"[A-Za-z][A-Za-z0-9_.-]*", text or ""))
    left = []
    for w in sorted(words):
        if any(w.startswith(k) for k in KEEP):
            continue
        if re.fullmatch(r"n\d+\.?|[0-9]+", w):  # 行内换行标记 \n1.
            continue
        if re.fullmatch(r"[0-9a-f]{8}|selftest", w):  # 会话目录名
            continue
        left.append(w)
    return left


if __name__ == "__main__":
    import sys

    print(clean(sys.stdin.read()))
