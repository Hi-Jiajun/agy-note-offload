#!/usr/bin/env python3
"""Antigravity Stop hook: 2 档纯任务态无痕续跑 + Plan Mode 分流 + 撤回回退识别 + 快速熔断。

策略（RETRY_WINDOW 秒窗口内）：
  * 撤回回退识别：若当前 step_index < 上次记录的 step（用户在界面撤回/编辑重发），
    立即清零旧计数与 dead 标记，按新分支首次拦截处理。
  * Plan Mode / Orchestrator 分流：识别到当前处于 Plan Mode 或由 orchestrator
    生成（系统禁用 write_file）时，下发 PLAN_OFFLOAD_MODE，指引调 exit_plan_mode
    仅传 5 行内纯路径/行号极简计划，把落盘写文件交给执行模型，不再硬逼写文件导致死锁。
  * 正常执行阶段：
    - 1 档（REWORD）：仅首拦且回答不长（< 800 out）且总上下文不大（< 120k）时发无痕重述指令。
    - 2 档（OFFLOAD_MODE）：长回答、大上下文或二次命中时，要求本步仅调 write_file 写入
      绑定的工作台目录（禁止再调 run_command），并标记 defer_alias=True 避免同秒叠注。
  * 快速熔断：连续 2 次零输出预检拦截或超过 2 档上限，立即停机标 dead。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hooklib  # noqa: E402
import sanitize  # noqa: E402

EXPECTED = "Stop"

MARKER = "blocked by Gemini"
RETRY_WINDOW = 15 * 60
MAX_RETRY = 2           # 最多续跑 2 次：1 档重述 / 规划精简 -> 2 档落盘；第 3 次直接停机
ZERO_OUT_LIMIT = 2      # 连续 2 次零输出预检拦截直接判定上下文锁定
LONG_ANSWER = 800       # 单轮输出 token 达此阈值直接切落盘模式
BIG_CONTEXT = 120_000   # input + cache 总上下文达此阈值直接切落盘模式

REWORD = (
    "[重写] 请换平实简短的中文重述本轮结论、错误码与下一步，先给结论再分条，控制在 5 行内。"
)
OFFLOAD_MODE = (
    "[落盘] 本步仅调用 write_file 将目前已查实的结论、数据与下一步写入 {dir}/turn-{n}.md"
    "（不要再调 run_command 执行新命令）；写完后正文只回一行文件路径与结论（80 字内）。"
)
PLAN_OFFLOAD_MODE = (
    "[规划精简] 当前处于只读规划阶段（不可直接写文件）。若仍有待执行步骤，请调用 exit_plan_mode"
    " 且计划参数控制在 5 行内（仅写文件路径、行号与目标，将写入 {dir}/turn-{n}.md 与"
    " status.md 交给执行阶段）；若已全部完工，正文只回一行结论与 {dir}/status.md 路径（80 字内）。"
)

_USER_REQ_RE = re.compile(r"<USER_REQUEST>(.*?)</USER_REQUEST>", re.S)


def tail_records(path):
    """读取 transcript 末尾 256KB 内所有能解析的 JSON 记录（按时间升序）。"""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 262144))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    recs = []
    for line in data.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            recs.append(rec)
    return recs


def extract_last_user_info(recs):
    """从尾部记录中找最后一条 USER_INPUT，提取其正文指纹与绑定的工作台路径。"""
    for r in reversed(recs):
        if r.get("type") != "USER_INPUT":
            continue
        raw = r.get("content") or ""
        m = _USER_REQ_RE.search(raw)
        body = m.group(1).strip() if m else raw.strip()
        return hooklib.input_sig(body), hooklib.extract_note_dir(body)
    return "", ""


def is_plan_mode(rec, recs):
    """判断是否处于只读 Plan Mode（禁用 write_file）。"""
    model = (rec.get("model") or "").lower()
    if "orchestrator" in model:
        return True
    for r in reversed(recs[-40:]):
        if r.get("type") != "SYSTEM_MESSAGE":
            continue
        c = r.get("content") or ""
        if "Plan mode is off:" in c:
            return False
        if "Plan mode is on:" in c:
            return True
    return False


def is_zero_output_block(rec):
    """判断是否在生成前/首帧即被零输出拦截（通常意味着历史上下文已锁定）。"""
    out_tokens = rec.get("output_tokens")
    thinking = (rec.get("thinking") or "").strip()
    tool_calls = rec.get("tool_calls") or []
    return out_tokens is None and not thinking and not tool_calls


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

    hooklib.housekeeping()
    conv = payload.get("conversationId") or "unknown"
    reason_tag = str(payload.get("terminationReason") or "")
    hooklib.log("stop conv=%s reason=%s" % (conv, reason_tag))

    if reason_tag.lower() in ("user_canceled", "user_cancelled"):
        print("{}")
        return

    transcript = payload.get("transcriptPath") or ""
    if not transcript or not os.path.exists(transcript):
        print("{}")
        return

    recs = tail_records(transcript)
    if not recs:
        print("{}")
        return
    rec = recs[-1]

    now = time.time()
    state = hooklib.load_state()
    entry = state.get(conv) or {}
    cur_step = rec.get("step_index")
    prev_step = entry.get("step")

    # 检测用户撤回（Undo / 编辑重发导致 step_index 回退）：旧熔断/计数全部作废
    rewound = isinstance(cur_step, int) and isinstance(prev_step, int) and cur_step < prev_step
    if rewound:
        hooklib.log("stop conv=%s rewind_reset prev_step=%s cur_step=%s" % (conv, prev_step, cur_step))
        entry = {}

    body = rec.get("content") or ""
    # 只认「短回复且含拦截字样」：模型正文引用该句原文时不误判
    if MARKER not in body or len(body) > 600:
        if conv in state:
            entry_keep = {} if rewound else dict(state[conv])
            for k in ("tries", "zero_streak", "dead", "dead_reason", "notified", "defer_alias"):
                entry_keep.pop(k, None)
            entry_keep["step"] = cur_step
            entry_keep["ts"] = now
            if entry_keep.get("alias_injected") or entry_keep.get("offload_mode") or entry_keep.get("note_dir"):
                state[conv] = entry_keep
            else:
                state.pop(conv, None)
            hooklib.save_state(state)
        print("{}")
        return

    within_window = (not rewound) and (now - float(entry.get("ts") or 0) <= RETRY_WINDOW)
    zero_out = is_zero_output_block(rec)
    if within_window:
        tries = int(entry.get("tries") or 0) + 1
        zero_streak = (int(entry.get("zero_streak") or 0) + 1) if zero_out else 0
    else:
        tries = 1
        zero_streak = 1 if zero_out else 0

    preserved = {}
    if isinstance(entry, dict):
        for k in ("alias_injected", "offload_mode", "note_dir", "last_input_sig"):
            if entry.get(k):
                preserved[k] = entry[k]

    entry = dict(entry) if within_window else preserved

    # 顺手从尾部 USER_INPUT 回填 last_input_sig 与工作台绑定（普通会话首拦也能拿到完整信息）
    u_sig, u_dir = extract_last_user_info(recs)
    if u_sig and not entry.get("last_input_sig"):
        entry["last_input_sig"] = u_sig
    if u_dir and not entry.get("note_dir"):
        entry["note_dir"] = u_dir

    entry.update({
        "step": cur_step,
        "tries": tries,
        "zero_streak": zero_streak,
        "ts": now,
    })

    # 连续零输出预检拦截：上下文已锁定，立即熔断停机
    if zero_streak >= ZERO_OUT_LIMIT:
        entry.pop("defer_alias", None)
        entry.update({"dead": True, "dead_reason": "context_locked"})
        state[conv] = entry
        hooklib.save_state(state)
        hooklib.log("stop conv=%s ladder=dead reason=context_locked tries=%s zero_streak=%s" % (conv, tries, zero_streak))
        print("{}")
        return

    # 超过 2 档上限：直接熔断停机，不再硬跑第 3 轮
    if tries > MAX_RETRY:
        entry.pop("defer_alias", None)
        entry.update({"dead": True, "dead_reason": "max_retry"})
        state[conv] = entry
        hooklib.save_state(state)
        hooklib.log("stop conv=%s ladder=dead reason=max_retry tries=%s" % (conv, tries))
        print("{}")
        return

    plan_mode = is_plan_mode(rec, recs)
    long_answer = int(rec.get("output_tokens") or 0) >= LONG_ANSWER
    total_ctx = int(rec.get("input_tokens") or 0) + int(rec.get("cache_read_tokens") or 0)
    big_ctx = total_ctx >= BIG_CONTEXT

    if plan_mode:
        tier, reason_tpl = "plan", PLAN_OFFLOAD_MODE
        entry["offload_mode"] = True
        entry["defer_alias"] = True
        note_dir = hooklib.resolve_note_dir(conv, entry, create=False)
    elif tries == 1 and not long_answer and not big_ctx:
        tier, reason_tpl = 1, REWORD
        entry.pop("defer_alias", None)
        note_dir = hooklib.resolve_note_dir(conv, entry, create=False)
    else:
        tier, reason_tpl = 2, OFFLOAD_MODE
        entry["offload_mode"] = True
        entry["defer_alias"] = True
        note_dir = hooklib.resolve_note_dir(conv, entry, create=True)

    state[conv] = entry
    hooklib.save_state(state)

    reason = sanitize.clean(reason_tpl.format(dir=note_dir, n=cur_step or tries))
    hooklib.log(
        "stop conv=%s tier=%s plan=%s long=%s big=%s ctx=%s zero_out=%s dir=%s"
        % (conv, tier, int(plan_mode), int(long_answer), int(big_ctx), total_ctx, int(zero_out), note_dir)
    )
    print(json.dumps({"decision": "continue", "reason": reason}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        print("{}")
