#!/usr/bin/env bash
# Hook + note-offload Skill 自检：支持在仓库内或 ~/.gemini/config/scripts/ 直接运行。
# 用法: bash scripts/selftest.sh  或  bash ~/.gemini/config/scripts/selftest.sh
set -uo pipefail
cd "$(dirname "$0")" || exit 1

PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"

# 自动判断在仓库目录运行还是在已安装目录运行
if [ -f "../hooks.json.example" ] && [ -f "../skills/note-offload/SKILL.md" ]; then
  HOOKS_FILE="../hooks.json.example"
  SKILL_FILE="../skills/note-offload/SKILL.md"
  IN_REPO=1
else
  HOOKS_FILE="$CONFIG_DIR/hooks.json"
  SKILL_FILE="$CONFIG_DIR/skills/note-offload/SKILL.md"
  IN_REPO=0
fi

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

TMP_BASE="${TMPDIR:-/tmp}"
BACKUP_STATE=$(mktemp "$TMP_BASE/selftest-state.XXXXXX")
HAD_STATE=0
if [ -f .filter-retry-state.json ]; then
  cp .filter-retry-state.json "$BACKUP_STATE"
  HAD_STATE=1
fi
BACKUP_LOG=$(mktemp "$TMP_BASE/selftest-log.XXXXXX")
HAD_LOG=0
if [ -f hook-invocations.log ]; then
  cp hook-invocations.log "$BACKUP_LOG"
  HAD_LOG=1
fi

T=$(mktemp "$TMP_BASE/selftest.XXXXXX.jsonl")
TEST_NOTE_DIR="$HOME/agy-notes/selftest"
reset_state() { rm -f .filter-retry-state.json; }
blocked() { printf '%s\n' '{"step_index":4,"output_tokens":90,"input_tokens":21000,"cache_read_tokens":0,"thinking":"t","content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"; }
blocked_zero() { printf '%s\n' '{"step_index":4,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"; }
call() { echo "{\"transcriptPath\":\"$T\",\"conversationId\":\"selftest\"}" | "$PYTHON_BIN" ./provider-filter-retry.py; }

# 1) hooks 配置合法、事件受支持且本套件 3 个脚本存在
if "$PYTHON_BIN" - "$HOOKS_FILE" "$IN_REPO" <<'PY'
import json, os, shlex, sys
hooks_file, in_repo = sys.argv[1], sys.argv[2] == "1"
d = json.load(open(hooks_file, encoding="utf-8"))
ok = {"SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop", "enabled"}
ours = {"gemini-filter-guardrail", "gemini-filter-retry", "gemini-filter-notice"}
found_ours = set()
for name, h in d.items():
    if not isinstance(h, dict):
        sys.exit(1)
    for k, v in h.items():
        if k not in ok and v is not None:
            sys.exit(1)
        if name in ours and isinstance(v, list):
            for item in v:
                parts = shlex.split(item.get("command", ""))
                if not parts:
                    sys.exit(1)
                target = os.path.expanduser(parts[-1])
                if in_repo:
                    target = os.path.join(".", os.path.basename(target))
                if not os.path.exists(target):
                    sys.exit(1)
                found_ours.add(name)
if found_ours != ours:
    sys.exit(1)
PY
then pass "hooks 配置合法、事件受支持且脚本存在"; else fail "hooks 配置非法或脚本缺失"; fi

# 2) 脚本可编译
if "$PYTHON_BIN" -m py_compile hooklib.py sanitize.py provider-filter-retry.py \
     provider-filter-guardrail.py provider-filter-notice.py 2>/dev/null
then pass "脚本编译通过"; else fail "脚本编译失败"; fi

# 3) 注入给模型的文案：零敏感词、零元描述、全中文化、正确替换目录
reset_state
blocked
g_out=$(echo '{"conversationId":"selftest"}' | "$PYTHON_BIN" ./provider-filter-guardrail.py)
r1_out=$(call); r2_out=$(call)
n_alias=$(echo '{"conversationId":"selftest","lastUserInput":"执行下一步分析"}' | "$PYTHON_BIN" ./provider-filter-notice.py)

if "$PYTHON_BIN" - "$g_out" "$r1_out" "$r2_out" "$n_alias" <<'PY'
import json, sys
sys.path.insert(0, '.')
import sanitize

texts = []
for raw in sys.argv[1:]:
    d = json.loads(raw)
    if d.get("reason"):
        texts.append(d["reason"])
    for st in d.get("injectSteps", []):
        sm = (st.get("systemMessage") or {}).get("systemMessage")
        if sm:
            texts.append(sm)

blob = "\n".join(texts)
banned = [
    "bypass", "fake password", "intercept", "exploit", "lockscreen", "root ca",
    "安全过滤器", "绕开", "攻防", "整段替换", "内容校验", "400 字", "连续受限",
]
hits = [w for w in banned if w in blob.lower()]
left = sanitize.latin_leftovers(blob)
if hits or left:
    print("HITS:", hits, "LEFT:", left, file=sys.stderr)
    sys.exit(1)
PY
then pass "模型注入文案零敏感词、零元描述且全中文化"; else fail "模型注入文案含禁词/元描述或残留拉丁词"; fi

echo "$g_out" | grep -q 'agy-notes/selftest' && ! echo "$g_out" | grep -q '{dir}' \
  && pass "SessionStart 极简落盘目录正确替换" || fail "SessionStart 输出异常: $g_out"

# 4) 正常回合放行并清除重试/熔断状态（保留 alias_injected）
reset_state
"$PYTHON_BIN" -c "import json,time;json.dump({'selftest':{'step':1,'tries':2,'zero_streak':1,'dead':True,'offload_mode':True,'alias_injected':True,'ts':time.time()}},open('.filter-retry-state.json','w'))"
printf '%s\n' '{"step_index":5,"content":"hello"}' > "$T"
out=$(call)
[ "$out" = "{}" ] && pass "正常回合放行" || fail "正常回合被误判: $out"
"$PYTHON_BIN" -c "import json;e=json.load(open('.filter-retry-state.json'))['selftest'];assert e.get('alias_injected') and 'tries' not in e and 'dead' not in e and 'offload_mode' not in e" 2>/dev/null \
  && pass "正常回合清除重试与熔断态但保留 alias_injected" || fail "正常回合状态清理异常"

# 5) 2 档无痕分级：新会话(21k)首拦重述 → 二拦切落盘 → 三拦直接停机标 dead
reset_state
blocked
out=$(call)
echo "$out" | grep -q '"decision": "continue"' && echo "$out" | grep -q '\[重写\]' \
  && pass "小上下文首拦走 1 档无痕重述" || fail "1 档异常: $out"
out=$(call)
echo "$out" | grep -q '"decision": "continue"' && echo "$out" | grep -q '\[落盘\]' \
  && pass "二拦切 2 档无痕落盘" || fail "2 档异常: $out"
out=$(call)
[ "$out" = "{}" ] && pass "超过 2 档上限直接停机（不再硬跑第 3 轮）" || fail "2 档上限失效: $out"
"$PYTHON_BIN" -c "import json;e=json.load(open('.filter-retry-state.json'))['selftest'];assert e.get('dead') and e.get('dead_reason')=='max_retry'" 2>/dev/null \
  && pass "超上限正确标 dead(max_retry)" || fail "超上限状态错误"

# 5b) 总上下文判定：input=2400 + cache=150000 直接切落盘，并立刻联动 PreInvocation
reset_state
printf '%s\n' '{"step_index":4,"output_tokens":90,"input_tokens":2400,"cache_read_tokens":150000,"thinking":"t","content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
out=$(call)
echo "$out" | grep -q '\[落盘\]' && pass "大缓存总上下文首拦直切落盘模式" || fail "大缓存未识别为大上下文: $out"
out=$(echo '{"conversationId":"selftest","lastUserInput":"继续排查驱动日志"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
echo "$out" | grep -q '\[落盘模式\]' && echo "$out" | grep -q 'agy-notes/selftest' \
  && pass "首轮直切落盘立即联动 PreInvocation 补充规则" || fail "首轮直切未联动 PreInvocation: $out"

# 5c) 长回答直切落盘
reset_state
printf '%s\n' '{"step_index":4,"output_tokens":3031,"input_tokens":5000,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
out=$(call)
echo "$out" | grep -q '\[落盘\]' && pass "长回答首拦直切落盘模式" || fail "长回答未直切落盘: $out"

# 5d) 连续 2 次零输出预检拦截立即熔断（context_locked）
reset_state
blocked_zero
out=$(call)
echo "$out" | grep -q '\[重写\]' && pass "首次零输出允许尝试 1 次" || fail "首次零输出处理异常: $out"
out=$(call)
[ "$out" = "{}" ] && pass "连续 2 次零输出立即熔断停机" || fail "连续零输出未熔断: $out"
"$PYTHON_BIN" -c "import json;e=json.load(open('.filter-retry-state.json'))['selftest'];assert e.get('dead') and e.get('dead_reason')=='context_locked'" 2>/dev/null \
  && pass "零输出熔断正确记录 context_locked" || fail "零输出熔断状态错误"

# 6) PreInvocation 熔断智能防空转 + 断点就绪卡片（含最新落盘文件）
mkdir -p "$TEST_NOTE_DIR"
printf '# test\n' > "$TEST_NOTE_DIR/turn-99.md"
out=$(echo '{"conversationId":"selftest","lastUserInput":"继续"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
if echo "$out" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); s=d["injectSteps"][0]["systemMessage"]; md=s["metadata"]["user_markdown"]; assert d.get("terminationBehavior")=="terminate" and s["systemMessage"]=="" and "turn-99.md" in md and "note-offload" in md and "selftest" in md' 2>/dev/null
then pass "熔断后发「继续」触发防空转 terminate + 断点就绪卡片（含最新笔记）"; else fail "防空转输出异常: $out"; fi

"$PYTHON_BIN" -c "import json;d=json.load(open('.filter-retry-state.json'));d['selftest']['notified']=False;json.dump(d,open('.filter-retry-state.json','w'))"
out=$(echo '{"conversationId":"selftest","lastUserInput":"改查本地 Makefile 的编译选项"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
if echo "$out" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); s=d["injectSteps"][0]["systemMessage"]; assert "terminationBehavior" not in d and s["systemMessage"]=="" and "user_markdown" in s["metadata"]' 2>/dev/null
then pass "熔断后发具体新指令不阻断，仅弹一次断点卡片"; else fail "具体新指令被误拦或未提示: $out"; fi
out2=$(echo '{"conversationId":"selftest","lastUserInput":"再检查一下头文件引用"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
[ "$out2" = "{}" ] && pass "同窗口再次发具体新指令不重复刷屏" || fail "熔断卡片重复刷屏: $out2"
rm -f "$TEST_NOTE_DIR/turn-99.md"

# 7) 长正文引用拦截原文不误判 & 窗口过期重置
reset_state
"$PYTHON_BIN" -c "
import json, sys
body = \"回答里引用了 This request was blocked by Gemini's filters. 然后继续写\" + 'x' * 700
json.dump({'step_index': 5, 'content': body}, open(sys.argv[1], 'w'), ensure_ascii=False)
" "$T"
out=$(call)
[ "$out" = "{}" ] && pass "长正文引用原文不误判" || fail "长正文被误判: $out"

reset_state; blocked
"$PYTHON_BIN" -c "import json,time;json.dump({'selftest':{'step':4,'tries':3,'zero_streak':2,'dead':True,'ts':time.time()-3600}},open('.filter-retry-state.json','w'))"
out=$(call); echo "$out" | grep -q '\[重写\]' && pass "窗口过期后重置到 1 档" || fail "窗口过期未重置: $out"

# 8) PreInvocation：普通模式不注入，落盘模式注入一次且不重复
reset_state; blocked
call >/dev/null
out=$(echo '{"conversationId":"selftest","lastUserInput":"继续分析"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
[ "$out" = "{}" ] && pass "普通模式不注入落盘规则" || fail "普通模式误注入: $out"
call >/dev/null
out=$(echo '{"conversationId":"selftest","lastUserInput":"继续分析"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
echo "$out" | grep -q 'agy-notes/selftest' && pass "落盘模式注入一次持续规则" || fail "未注入持续规则: $out"
out=$(echo '{"conversationId":"selftest","lastUserInput":"继续分析"}' | "$PYTHON_BIN" ./provider-filter-notice.py)
[ "$out" = "{}" ] && pass "持续规则不重复注入" || fail "规则重复注入: $out"

# 9) 容错：USER_CANCELED、非法 stdin、事件错投
reset_state; blocked
out=$(echo "{\"transcriptPath\":\"$T\",\"conversationId\":\"selftest\",\"terminationReason\":\"USER_CANCELED\"}" | "$PYTHON_BIN" ./provider-filter-retry.py)
[ "$out" = "{}" ] && pass "USER_CANCELED 放行" || fail "取消仍续跑: $out"
out=$(echo 'not json' | "$PYTHON_BIN" ./provider-filter-retry.py)
[ "$out" = "{}" ] && pass "非法 stdin 放行" || fail "非法 stdin 崩了"
reset_state; blocked
out=$(echo "{\"transcriptPath\":\"$T\",\"conversationId\":\"selftest\",\"hookEventName\":\"PreInvocation\"}" | "$PYTHON_BIN" ./provider-filter-retry.py)
[ "$out" = "{}" ] && pass "错投事件不误发" || fail "错投事件仍续跑: $out"
out=$(echo "{\"transcriptPath\":\"$T\",\"conversationId\":\"selftest\",\"hookEventName\":\"Stop\"}" | "$PYTHON_BIN" ./provider-filter-retry.py)
echo "$out" | grep -q continue && pass "事件匹配照常续跑" || fail "事件匹配未续跑: $out"

# 10) note-offload Skill 完整性检查
if "$PYTHON_BIN" - "$SKILL_FILE" <<'PY'
import os, sys
txt = open(sys.argv[1], encoding="utf-8").read()
assert txt.startswith("---\n") and "name: note-offload\n" in txt and "description:" in txt
for banned in ("安全过滤器", "绕开", "攻防", "bypass", "exploit", "fake password"):
    assert banned not in txt.lower(), f"banned term in skill: {banned}"
for script in ("agysum", "neturl"):
    assert os.path.exists(os.path.join(".", script))
PY
then pass "note-offload Skill 格式、去毒与脚本引用均正常"; else fail "note-offload Skill 检查失败"; fi

# 11) agysum 只出要点、剥标签、带拦截统计
SUM=$(mktemp "$TMP_BASE/selftest.XXXXXX.jsonl")
printf '%s\n' '{"step_index":1,"type":"USER_INPUT","content":"<USER_REQUEST> 测一下 </USER_REQUEST>"}' \
  '{"step_index":2,"type":"PLANNER_RESPONSE","content":"答案正文"}' \
  '{"step_index":3,"type":"PLANNER_RESPONSE","content":"This request was blocked by Gemini'"'"'s filters."}' > "$SUM"
out=$(./agysum "$SUM" --width 40)
echo "$out" | grep -q 'U1:' && echo "$out" | grep -q 'M2: 答案正文' && pass "agysum 输出要点" || fail "agysum 异常: $out"
echo "$out" | grep -q '<USER_REQUEST>' && fail "agysum 未剥标签" || pass "agysum 剥标签"
echo "$out" | grep -q '被拦 1 次' && pass "agysum 统计拦截" || fail "agysum 未统计"
rm -f "$SUM"

# 12) 日志轮转（全新环境下显式写入超限行并验证截断）
"$PYTHON_BIN" -c "open('hook-invocations.log','a',encoding='utf-8').write(('y'*40+'\n')*20)"
before=$(stat -c%s hook-invocations.log 2>/dev/null || stat -f%z hook-invocations.log 2>/dev/null || echo 0)
"$PYTHON_BIN" -c "import sys;sys.path.insert(0,'.');import hooklib;hooklib.MAX_LOG_BYTES=1;hooklib.KEEP_LINES=5;hooklib.log('rotation-probe')"
after=$(stat -c%s hook-invocations.log 2>/dev/null || stat -f%z hook-invocations.log 2>/dev/null || echo 0)
[ "$after" -lt "$before" ] && pass "日志会轮转" || fail "日志未轮转 ($before -> $after)"

if [ "$HAD_STATE" -eq 1 ]; then
  cp "$BACKUP_STATE" .filter-retry-state.json
else
  rm -f .filter-retry-state.json
fi
if [ "$HAD_LOG" -eq 1 ]; then
  cp "$BACKUP_LOG" hook-invocations.log
else
  rm -f hook-invocations.log
fi
rm -rf "$TEST_NOTE_DIR" "$T" "$BACKUP_STATE" "$BACKUP_LOG"

echo "----"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails 项失败"; exit 1; fi
