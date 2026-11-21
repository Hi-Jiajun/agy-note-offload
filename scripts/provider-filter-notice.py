#!/usr/bin/env python3
"""Antigravity PreInvocation hook: 工作台绑定 + 撤回识别 + 错峰落盘补充 + 升级防空转。

行为边界：
  1. 工作台绑定：从 lastUserInput 自动提取显式 ~/agy-notes/<name>/ 并绑定到会话状态，
     杜绝与 <conv8> 双写分裂；后续 Stop 与断点卡片统一指向该目录。
  2. /compact 直通：用户执行 /compact 压缩上下文时直接放行，绝不阻断。
  3. 撤回识别：initialNumSteps <= prev_step 时重置旧熔断/计数，按新分支运行。
  4. 升级防空转（仅 UI 可见，systemMessage="" 零模型污染）：
     熔断后若新输入为极短催促词，或与上一条输入指纹完全相同（重复重发），
     直接 terminationBehavior="terminate" 拦下省配额，并展示断点就绪卡片；
     若为全新具体指令则仅弹 1 次卡片并放行试跑。
  5. 错峰补注：Stop 刚下发 [落盘]/[规划精简] 的当轮续跑跳过叠注，下一轮再补注 1 次持续规则。
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
    "严禁同时往多个落盘目录重复写入；规划阶段调 exit_plan_mode 只传简短路径指引；"
    "每轮收尾正文仅留一行指针（结论 + 路径，120 字内）；回看大文件用 read_file 分片读；"
    "涉及远端域名用 neturl 取别名（映射在 ~/.local/share/agy-note-offload/net-map.tsv）。"
)

NUDGE_WORDS = {
    "", "继续", "继续吧", "继续做", "继续执行", "接着", "接着做", "重试", "再试", "再试一次",
    "再来", "再来一次", "嗯", "好", "好的", "行", "可以", "收到", "go", "go on",
    "continue", "resume", "retry", "next", "ok", "okay", "yes", "y",
}


def is_short_nudge(text):
    s = (text or "").strip()
    cleaned = re.sub(r"[\s。，、！？!?,.;:：~～…\-_]+", " ", s).strip().lower()
    return (not cleaned) or (cleaned in NUDGE_WORDS)


def build_dead_card(conv, entry, dead_reason, block_kind):
    conv8 = (conv or "misc")[:8]
    note_dir = hooklib.resolve_note_dir(conv, entry, create=False)
    latest = hooklib.latest_note(conv, entry)

    cause = "连续零输出上下文锁定" if dead_reason == "context_locked" else "连续受限并达重试上限"
    if block_kind == "repeat":
        action = "已拦下重复重发的原指令以省配额；若确需在本会话重试，请换一条具体新指令。"
    elif block_kind == "nudge":
        action = "已拦下空转催促以省配额；若确需在本会话重试，请发具体新指令。"
    else:
        action = "已放行本次新指令；若仍失败建议开新会话接续。"

    if latest:
        loc_line = f"> 最新笔记：`{latest}`（目录 `{note_dir}`）"
        prompt = f"/note-offload 接续会话 {conv8}（先读 {latest}，需要历史再跑 agysum {conv8}），继续下一步"
    else:
        loc_line = f"> 落盘目录：`{note_dir}`（暂未生成笔记，可用 `agysum {conv8}` 提炼要点）"
        prompt = f"/note-offload 接续会话 {conv8}（先用 agysum {conv8} 提炼要点），继续下一步"

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

    has_input_field = "lastUserInput" in payload and payload.get("lastUserInput") is not None
    last_raw = payload.get("lastUserInput") or ""
    if last_raw.lstrip().startswith("/compact"):
        print("{}")
        return

    ws_dir = hooklib.extract_note_dir(last_raw)
    explicit_offload = ("/note-offload" in last_raw) or ("[落盘模式]" in last_raw) or ("[文件模式]" in last_raw)
    cur_sig = hooklib.input_sig(last_raw) if has_input_field else ""

    state = hooklib.load_state()
    entry = state.get(conv)

    if not isinstance(entry, dict):
        if not explicit_offload and not ws_dir:
            print("{}")
            return
        entry = {"ts": time.time(), "offload_mode": True}
        if ws_dir:
            entry["note_dir"] = ws_dir
        if cur_sig:
            entry["last_input_sig"] = cur_sig
    else:
        entry = dict(entry)

    # 识别用户在界面执行了撤回重发（initialNumSteps <= prev_step）
    init_steps = payload.get("initialNumSteps")
    prev_step = entry.get("step")
    if isinstance(init_steps, int) and isinstance(prev_step, int) and init_steps <= prev_step:
        hooklib.log("preinvocation rewind_reset conv=%s prev_step=%s init_steps=%s" % (conv, prev_step, init_steps))
        if explicit_offload or ws_dir:
            kept_dir = ws_dir or entry.get("note_dir")
            entry = {"ts": time.time(), "offload_mode": True}
            if kept_dir:
                entry["note_dir"] = kept_dir
            if cur_sig:
                entry["last_input_sig"] = cur_sig
            state[conv] = entry
            hooklib.save_state(state)
        else:
            state.pop(conv, None)
            hooklib.save_state(state)
            print("{}")
            return

    if ws_dir and entry.get("note_dir") != ws_dir:
        entry["note_dir"] = ws_dir
    if explicit_offload:
        entry["offload_mode"] = True

    now = time.time()
    within_window = now - float(entry.get("ts") or 0) <= RETRY_WINDOW
    dead = within_window and (bool(entry.get("dead")) or int(entry.get("tries") or 0) > 2)
    dead_reason = entry.get("dead_reason") or "max_retry"

    steps = []
    if dead:
        nudge = has_input_field and is_short_nudge(last_raw)
        repeat = has_input_field and bool(cur_sig) and (cur_sig == entry.get("last_input_sig"))
        if nudge or repeat:
            block_kind = "repeat" if (repeat and not nudge) else "nudge"
            entry["notified"] = True
            state[conv] = entry
            hooklib.save_state(state)
            card = build_dead_card(conv, entry, dead_reason, block_kind=block_kind)
            steps.append({
                "systemMessage": {
                    "systemMessage": "",
                    "metadata": {"user_markdown": card},
                }
            })
            hooklib.log("preinvocation block_%s conv=%s reason=%s" % (block_kind, conv, dead_reason))
            print(json.dumps({
                "injectSteps": steps,
                "terminationBehavior": "terminate",
            }, ensure_ascii=False))
            return

        if cur_sig:
            entry["last_input_sig"] = cur_sig
        if not entry.get("notified"):
            entry["notified"] = True
            card = build_dead_card(conv, entry, dead_reason, block_kind="pass")
            steps.append({
                "systemMessage": {
                    "systemMessage": "",
                    "metadata": {"user_markdown": card},
                }
            })
            hooklib.log("preinvocation notice conv=%s reason=%s" % (conv, dead_reason))
    else:
        if cur_sig:
            entry["last_input_sig"] = cur_sig
        entry["ts"] = now

    # 错峰补注：Stop 刚下发 [落盘]/[规划精简] 的当轮续跑只消费掉 defer_alias
    if within_window and entry.get("defer_alias"):
        entry.pop("defer_alias", None)
        state[conv] = entry
        hooklib.save_state(state)
        if not steps:
            print("{}")
            return
        print(json.dumps({"injectSteps": steps}, ensure_ascii=False))
        return

    offload_mode = bool(entry.get("offload_mode")) or (within_window and int(entry.get("tries") or 0) >= 2)
    if offload_mode and not entry.get("alias_injected"):
        entry["alias_injected"] = True
        note_dir = hooklib.resolve_note_dir(conv, entry, create=False)
        rule = sanitize.clean(OFFLOAD_RULE).replace("{dir}", note_dir)
        steps.append({"systemMessage": {"systemMessage": rule}})
        hooklib.log("preinvocation alias conv=%s dir=%s" % (conv, note_dir))

    state[conv] = entry
    hooklib.save_state(state)

    if not steps:
        print("{}")
        return
    print(json.dumps({"injectSteps": steps}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
