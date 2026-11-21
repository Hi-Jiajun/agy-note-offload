#!/usr/bin/env python3
"""Antigravity PreInvocation hook: 撤回识别 + 错峰持续落盘补充 + 熔断智能防空转 + 断点就绪卡片。

行为边界：
  1. 撤回识别：若 initialNumSteps <= 上次记录的 step（说明用户刚做了 Undo 撤回重发），
     立即清除旧熔断/重试状态并放行，绝不误弹卡片或误计旧 tries。
  2. 错峰补注：Stop 刚下发 [落盘] 的当轮自动续跑（defer_alias=True）跳过叠注，避免同一秒
     连塞两条系统指令引发二次零输出拦截；待下一轮正常调用时再补注 1 次持续落盘规则。
  3. 熔断智能防空转（仅 UI 可见，systemMessage="" 零模型污染）：
     - 极短催促词（「继续」「continue」等）→ terminate 拦下空转 + 展示断点就绪卡片；
     - 具体新指令 → 仅弹 1 次断点就绪卡片并放行试跑。
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
    "[落盘模式] 本会话采用双向文件工作流：中间调用工具时不输出过渡文字；"
    "每完成一阶段先用 write_file 更新 {dir}/status.md 与 turn-<序号>.md（脚本长输出直接写文件）；"
    "每轮收尾正文仅留一行指针（结论 + 路径，120 字内）；回看大文件用 read_file 分片读；"
    "涉及远端域名用 neturl 取别名（映射在 ~/.gemini/config/scripts/net-map.tsv）。"
)

NUDGE_WORDS = {
    "", "继续", "继续吧", "继续做", "继续执行", "接着", "接着做", "重试", "再试", "再试一次",
    "再来", "再来一次", "嗯", "好", "好的", "行", "可以", "收到", "go", "go on",
    "continue", "resume", "retry", "next", "ok", "okay", "yes", "y",
}


def is_short_nudge(text):
    """判断用户输入是否为无新信息的极短催促词。"""
    s = (text or "").strip()
    cleaned = re.sub(r"[\s。，、！？!?,.;:：~～…\-_]+", " ", s).strip().lower()
    return (not cleaned) or (cleaned in NUDGE_WORDS)


def build_dead_card(conv, dead_reason, blocked_nudge):
    conv8 = (conv or "misc")[:8]
    note_dir = hooklib.note_dir(conv, create=False)
    latest = hooklib.latest_note(conv)

    cause = "连续零输出上下文锁定" if dead_reason == "context_locked" else "连续受限并达重试上限"
    action = "已拦下空转催促以省配额；若确需在本会话重试，请发具体新指令。" if blocked_nudge else "已放行本次新指令；若仍失败建议开新会话接续。"
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
    last_raw = payload.get("lastUserInput") or ""
    explicit_offload = ("/note-offload" in last_raw) or ("[落盘模式]" in last_raw) or ("[文件模式]" in last_raw)

    if not isinstance(entry, dict):
        if not explicit_offload:
            print("{}")
            return
        entry = {"ts": time.time(), "offload_mode": True}

    # 识别用户在界面执行了撤回重发（initialNumSteps 小于等于之前记录的拦截 step）
    init_steps = payload.get("initialNumSteps")
    prev_step = entry.get("step")
    if isinstance(init_steps, int) and isinstance(prev_step, int) and init_steps <= prev_step:
        hooklib.log("preinvocation rewind_reset conv=%s prev_step=%s init_steps=%s" % (conv, prev_step, init_steps))
        if explicit_offload:
            entry = {"ts": time.time(), "offload_mode": True}
            state[conv] = entry
            hooklib.save_state(state)
        else:
            state.pop(conv, None)
            hooklib.save_state(state)
            print("{}")
            return
    elif explicit_offload:
        entry["offload_mode"] = True
        entry["ts"] = time.time()

    now = time.time()
    if now - float(entry.get("ts") or 0) > RETRY_WINDOW:
        print("{}")
        return

    steps = []
    dead = bool(entry.get("dead")) or int(entry.get("tries") or 0) > 2
    dead_reason = entry.get("dead_reason") or "max_retry"

    if dead:
        # 仅当存在真实 lastUserInput 字段时才判断短催促词；若宿主未传该字段则不误判为空串催促
        has_input_field = "lastUserInput" in payload and payload.get("lastUserInput") is not None
        last_input = payload.get("lastUserInput") or ""
        nudge = has_input_field and is_short_nudge(last_input)
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

    # 错峰补注：Stop 刚下发 [落盘] 的当轮续跑只消费掉 defer_alias，不在同秒叠注第二条消息
    if entry.get("defer_alias"):
        entry.pop("defer_alias", None)
        state[conv] = entry
        hooklib.save_state(state)
        if not steps:
            print("{}")
            return
        print(json.dumps({"injectSteps": steps}, ensure_ascii=False))
        return

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
