#!/usr/bin/env python3
"""Antigravity PreInvocation hook: 持续落盘规则补充 + 熔断智能防空转 + 断点就绪卡片。

行为边界：
  1. 持续落盘补充：一旦本会话切入落盘模式，注入 1 次精简去重版无痕规则（含分片读与
     neturl 别名），之后同会话不重复注入。
  2. 熔断智能防空转（仅 UI 可见，systemMessage="" 零模型污染）：
     - 若会话已标 dead 且用户新输入是极短催促词（如「继续」「continue」「重试」），
       直接 terminationBehavior="terminate" 拦下空转省 token，并展示断点就绪卡片；
     - 若用户输入了新的具体指令，则仅在同窗口弹 1 次断点就绪卡片并放行试跑。
  3. 断点就绪卡片（5 行内）：自动填入会话 ID 前 8 位、最新落盘文件路径（如有）与
     几乎免改即可复制的 note-offload 接续指令。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hooklib  # noqa: E402
import sanitize  # noqa: E402

EXPECTED = "PreInvocation"

RETRY_WINDOW = 15 * 60

OFFLOAD_RULE = (
    "[落盘模式] 后续回合正文仅留一行指针（结论 + 路径，120 字内），"
    "详稿写入 {dir}/turn-<序号>.md；回看旧文件用 read_file 分片读；"
    "涉及远端域名时用 neturl 取别名（映射在 ~/.gemini/config/scripts/net-map.tsv）。"
)

# 熔断后视为“空转催促”的极短输入（剥离空白与标点后小写匹配）
NUDGE_WORDS = {
    "", "继续", "继续吧", "继续做", "继续执行", "接着", "接着做", "重试", "再试", "再试一次",
    "再来", "再来一次", "嗯", "好", "好的", "行", "可以", "收到", "go", "go on",
    "continue", "resume", "retry", "next", "ok", "okay", "yes", "y",
}


def is_short_nudge(text):
    """判断用户输入是否为无新信息的极短催促词。"""
    s = (text or "").strip()
    # 去掉常见起止标点与空白
    cleaned = re.sub(r"[\s。，、！？!?,.;:：~～…\-_]+", " ", s).strip().lower()
    if cleaned in NUDGE_WORDS:
        return True
    # 纯符号/单字问号也视为空转催促
    if not cleaned:
        return True
    return False


def build_dead_card(conv, dead_reason, blocked_nudge):
    conv8 = (conv or "misc")[:8]
    note_dir = hooklib.note_dir(conv, create=False)
    latest = hooklib.latest_note(conv)

    cause = "连续零输出上下文锁定" if dead_reason == "context_locked" else "连续受限并达重试上限"
    action = "已拦下空转催促以省 token；若确需在本会话重试，请发具体新指令。" if blocked_nudge else "已放行本次新指令；若仍失败建议开新会话接续。"
    if latest:
        loc_line = f"> 最新笔记：`{latest}`（目录 `{note_dir}`）"
        prompt = f"用 note-offload 落盘模式接续会话 {conv8}（先读 {latest}，需要历史再跑 agysum {conv8}），继续下一步"
    else:
        loc_line = f"> 落盘目录：`{note_dir}`（暂未生成笔记，可用 `agysum {conv8}` 提炼要点）"
        prompt = f"用 note-offload 落盘模式接续会话 {conv8}（先用 agysum {conv8} 提炼要点），继续下一步"

    card = (
        f"> **会话已熔断（{cause}）**：{action}\n"
        f"{loc_line}\n"
        f"> **一键接续（复制发给新会话）**：\n"
        f"> `{prompt}`"
    )
    return sanitize.clean(card)


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        print("{}")
        return
    if not isinstance(payload, dict):
        payload = {}

    ev = str(payload.get("hookEventName") or "")
    if ev and ev != EXPECTED:
        hooklib.log("%s 事件不匹配 hookEventName=%s" % (EXPECTED, ev))
        print("{}")
        return

    conv = payload.get("conversationId") or ""
    if not conv:
        print("{}")
        return

    state = hooklib.load_state()
    entry = state.get(conv)
    if not isinstance(entry, dict):
        print("{}")
        return

    now = time.time()
    if now - float(entry.get("ts") or 0) > RETRY_WINDOW:
        print("{}")
        return

    steps = []
    dead = bool(entry.get("dead")) or int(entry.get("tries") or 0) > 2
    dead_reason = entry.get("dead_reason") or "max_retry"
    last_input = payload.get("lastUserInput") or ""

    # 熔断态优先检查智能防空转
    if dead:
        nudge = is_short_nudge(last_input)
        if nudge:
            entry["notified"] = True
            state[conv] = entry
            hooklib.save_state(state)
            card = build_dead_card(conv, dead_reason, blocked_nudge=True)
            steps.append({
                "systemMessage": {
                    "systemMessage": "",
                    "metadata": {"user_markdown": card},
                }
            })
            hooklib.log("preinvocation block_nudge conv=%s reason=%s" % (conv, dead_reason))
            print(json.dumps({
                "injectSteps": steps,
                "terminationBehavior": "terminate",
            }, ensure_ascii=False))
            return

        if not entry.get("notified"):
            entry["notified"] = True
            state[conv] = entry
            hooklib.save_state(state)
            card = build_dead_card(conv, dead_reason, blocked_nudge=False)
            steps.append({
                "systemMessage": {
                    "systemMessage": "",
                    "metadata": {"user_markdown": card},
                }
            })
            hooklib.log("preinvocation notice conv=%s reason=%s" % (conv, dead_reason))

    # 非阻断场景：切入落盘模式后补注一次持续落盘与别名规则
    offload_mode = bool(entry.get("offload_mode")) or int(entry.get("tries") or 0) >= 2
    if offload_mode and not entry.get("alias_injected"):
        entry["alias_injected"] = True
        state[conv] = entry
        hooklib.save_state(state)
        rule = sanitize.clean(OFFLOAD_RULE).replace("{dir}", hooklib.note_dir(conv))
        steps.append({"systemMessage": {"systemMessage": rule}})
        hooklib.log("preinvocation alias conv=%s" % conv)

    if not steps:
        print("{}")
        return
    print(json.dumps({"injectSteps": steps}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
