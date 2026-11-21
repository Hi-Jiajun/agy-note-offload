#!/usr/bin/env bash
# Note Offload 插件全量自检：使用隔离临时 DATA_DIR，零污染真实状态与日志。
# 用法: bash scripts/selftest.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PLUGIN_ROOT" || exit 1

PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
TMP_BASE="${TMPDIR:-/tmp}"
TEST_DATA_DIR=$(mktemp -d "$TMP_BASE/agy-selftest-data.XXXXXX")
export AGY_OFFLOAD_DATA_DIR="$TEST_DATA_DIR"

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

T=$(mktemp "$TMP_BASE/selftest-transcript.XXXXXX.jsonl")
TEST_CONV_DIR="$HOME/agy-notes/selftest"
TEST_WS_DIR="$HOME/agy-notes/selftest-ws"
rm -rf "$TEST_CONV_DIR" "$TEST_WS_DIR"

reset_state() { rm -f "$TEST_DATA_DIR/.filter-retry-state.json"; }
blocked() { printf '%s\n' "{\"step_index\":${1:-4},\"output_tokens\":90,\"input_tokens\":21000,\"cache_read_tokens\":0,\"thinking\":\"t\",\"content\":\"This request was blocked by Gemini's filters.\"}" > "$T"; }
blocked_zero() { printf '%s\n' "{\"step_index\":${1:-4},\"content\":\"This request was blocked by Gemini's filters.\"}" > "$T"; }
call() { echo "{\"transcriptPath\":\"$T\",\"conversationId\":\"selftest\"}" | "$PYTHON_BIN" ./scripts/provider-filter-retry.py; }

# 1) 原生插件结构校验：plugin.json 字段合法、logo 存在、hooks.json 从插件根路径可用
if "$PYTHON_BIN" - <<'PY'
import json, os, shlex, sys
pj = json.load(open("plugin.json", encoding="utf-8"))
allowed = {"name", "displayName", "version", "description", "author", "homepage", "repository", "logo", "suggestedPrompts", "disabled"}
unknown = set(pj) - allowed
assert not unknown, f"unknown plugin.json keys: {unknown}"
assert pj.get("name") == "note-offload"
assert pj.get("logo") and os.path.exists(pj["logo"])

hj = json.load(open("hooks.json", encoding="utf-8"))
ok = {"SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop", "enabled"}
ours = {"note-offload-guardrail", "note-offload-retry", "note-offload-notice"}
assert set(hj) == ours
for name, spec in hj.items():
    for k, v in spec.items():
        assert k in ok
        if isinstance(v, list):
            for item in v:
                parts = shlex.split(item.get("command", ""))
                assert parts and os.path.exists(parts[-1]), f"missing script: {parts}"
PY
then pass "plugin.json、logo.svg 与插件根 hooks.json 结构校验通过"; else fail "原生插件元数据或 hooks.json 校验失败"; fi

# 2) 脚本编译通过
if "$PYTHON_BIN" -m py_compile ./scripts/hooklib.py ./scripts/sanitize.py ./scripts/provider-filter-retry.py \
     ./scripts/provider-filter-guardrail.py ./scripts/provider-filter-notice.py ./scripts/agynote ./scripts/agysum 2>/dev/null
then pass "全量 Python 脚本编译通过"; else fail "脚本编译失败"; fi

# 3) SessionStart 惰性建目录 + 清理旧 state + 全中文化文案
"$PYTHON_BIN" -c "import json,os,time;json.dump({'selftest':{'step':9,'tries':3,'dead':True,'ts':time.time()}},open(os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json','w'))"
g_out=$(echo '{"conversationId":"selftest"}' | "$PYTHON_BIN" ./scripts/provider-filter-guardrail.py)
[ ! -d "$TEST_CONV_DIR" ] && pass "SessionStart 惰性建目录（未产生 0 文件空文件夹）" || fail "SessionStart 提前建了空目录"
"$PYTHON_BIN" -c "import json,os;p=os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json';assert not os.path.exists(p) or 'selftest' not in json.load(open(p))" 2>/dev/null \
  && pass "SessionStart 自动清零同会话旧状态" || fail "SessionStart 未清旧状态"
echo "$g_out" | grep -q 'agy-notes/selftest' && ! echo "$g_out" | grep -q '{dir}' \
  && pass "SessionStart 正确替换目标目录" || fail "SessionStart 输出异常: $g_out"

# 4) 注入给模型的文案去毒与全中文化检验
reset_state
blocked 4
r1_out=$(call)
blocked 5
r2_out=$(call)
echo '{"conversationId":"selftest","lastUserInput":"执行下一步"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py >/dev/null
n_alias=$(echo '{"conversationId":"selftest","lastUserInput":"执行下一步"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)

if "$PYTHON_BIN" - "$g_out" "$r1_out" "$r2_out" "$n_alias" <<'PY'
import json, sys
sys.path.insert(0, './scripts')
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
then pass "模型注入文案零敏感词、零元描述且全中文化"; else fail "模型注入文案含禁词或残留拉丁词"; fi

# 5) 命名工作台自动绑定：不分裂写到 <conv8>
reset_state
echo '{"conversationId":"selftest","lastUserInput":"/note-offload 读取 ~/agy-notes/selftest-ws/task.md 与 status.md"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py >/dev/null
printf '%s\n' '{"step_index":4,"output_tokens":1200,"input_tokens":5000,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
out_ws=$(call)
echo "$out_ws" | grep -q 'selftest-ws/turn-4.md' && ! echo "$out_ws" | grep -q 'selftest/turn-4.md' \
  && pass "Stop 自动绑定命名工作台（不写往 <conv8>）" || fail "工作台未绑定: $out_ws"

mkdir -p "$TEST_WS_DIR"
printf '# ws\n' > "$TEST_WS_DIR/turn-99.md"
blocked 5
call >/dev/null
blocked 6
call >/dev/null
out_ws_card=$(echo '{"conversationId":"selftest","initialNumSteps":10,"lastUserInput":"继续"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
echo "$out_ws_card" | grep -q 'selftest-ws/turn-99.md' \
  && pass "熔断卡片准确引用命名工作台最新笔记" || fail "熔断卡片未引用命名工作台: $out_ws_card"
rm -rf "$TEST_WS_DIR" "$TEST_CONV_DIR"

# 6) Orchestrator / Plan Mode 识别：禁要求 write_file，引导精简 exit_plan_mode
reset_state
printf '%s\n' '{"step_index":335,"type":"PLANNER_RESPONSE","model":"gemini-pro-orchestrator","output_tokens":3078,"input_tokens":3066,"cache_read_tokens":161730,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
out_plan=$(call)
echo "$out_plan" | grep -q '\[规划精简\]' && echo "$out_plan" | grep -q 'exit_plan_mode' && ! echo "$out_plan" | grep -q '只调 write_file' \
  && pass "Plan Mode / Orchestrator 被拦走专用规划精简分流（不再要求 write_file 死锁）" || fail "Plan Mode 分流异常: $out_plan"

reset_state
printf '%s\n' \
  '{"step_index":10,"type":"SYSTEM_MESSAGE","content":"Plan mode is on: this turn runs on the planning model."}' \
  '{"step_index":11,"type":"PLANNER_RESPONSE","model":"gemini-4-carbon-high","output_tokens":1200,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
out_pm=$(call)
echo "$out_pm" | grep -q '\[规划精简\]' \
  && pass "非 orchestrator 模型在 Plan mode is on 时同样走规划精简分流" || fail "Plan mode is on 识别失败: $out_pm"

# 7) 普通执行 2 档分级 + 错峰补注 + 正常回合清状态
reset_state
blocked 4
out=$(call)
echo "$out" | grep -q '\[重写\]' && pass "小上下文首拦走 1 档无痕重述" || fail "1 档异常: $out"
blocked 5
out=$(call)
echo "$out" | grep -q '\[落盘\]' && echo "$out" | grep -q 'write_file' && pass "二拦切 2 档 write_file 落盘" || fail "2 档异常: $out"
out_same=$(echo '{"conversationId":"selftest","lastUserInput":"执行下一步"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
[ "$out_same" = "{}" ] && pass "当轮续跑跳过叠注" || fail "当轮仍叠注: $out_same"
out_next=$(echo '{"conversationId":"selftest","lastUserInput":"执行下一步"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
echo "$out_next" | grep -q '\[落盘模式\]' && pass "下一轮正常调用错峰补注持续落盘规则" || fail "错峰补注失败: $out_next"
blocked 6
out=$(call)
[ "$out" = "{}" ] && pass "超过 2 档上限直接停机标 dead" || fail "上限失效: $out"

printf '%s\n' '{"step_index":7,"content":"hello"}' > "$T"
out_ok=$(call)
[ "$out_ok" = "{}" ] && pass "正常回合放行" || fail "正常回合误判: $out_ok"
"$PYTHON_BIN" -c "import json,os;e=json.load(open(os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json'))['selftest'];assert 'tries' not in e and 'dead' not in e and e.get('alias_injected')" 2>/dev/null \
  && pass "正常回合清除重试与熔断态但保留工作台/落盘绑定" || fail "正常回合状态清理异常"

# 8) 升级防空转：短催促与「重复重发同一句启动词」均拦下，全新指令放行一次，/compact 直通
reset_state
printf '%s\n' \
  '{"step_index":1,"type":"USER_INPUT","content":"<USER_REQUEST>\n/note-offload 读取 ~/agy-notes/selftest-ws/task.md 执行阶段2\n</USER_REQUEST>"}' \
  '{"step_index":2,"type":"PLANNER_RESPONSE","output_tokens":1200,"content":"This request was blocked by Gemini'"'"'s filters."}' > "$T"
call >/dev/null
blocked 3; call >/dev/null
# 此时 tries=2 -> 若连续第 3 次标 dead
blocked 4; call >/dev/null

# 8a) 重复重发完全相同的长指令 -> terminate
out_rep=$(echo '{"conversationId":"selftest","initialNumSteps":10,"lastUserInput":"/note-offload 读取 ~/agy-notes/selftest-ws/task.md 执行阶段2"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
echo "$out_rep" | grep -q '"terminationBehavior": "terminate"' && echo "$out_rep" | grep -q '重复重发' \
  && pass "熔断后重复重发原长指令被 terminate 拦下省配额" || fail "重复重发未拦下: $out_rep"

# 8b) /compact 直通
out_cmp=$(echo '{"conversationId":"selftest","initialNumSteps":10,"lastUserInput":"/compact"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
[ "$out_cmp" = "{}" ] && pass "/compact 在熔断态直接放行" || fail "/compact 被误拦: $out_cmp"

# 8c) 全新具体指令放行一次并弹提示卡片
"$PYTHON_BIN" -c "import json,os;p=os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json';d=json.load(open(p));d['selftest']['notified']=False;json.dump(d,open(p,'w'))"
out_new=$(echo '{"conversationId":"selftest","initialNumSteps":10,"lastUserInput":"改为本地离线统计文件行数，不再执行远端请求"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
if echo "$out_new" | "$PYTHON_BIN" -c 'import json,sys;d=json.load(sys.stdin);assert "terminationBehavior" not in d and d["injectSteps"][0]["systemMessage"]["systemMessage"]==""' 2>/dev/null
then pass "熔断后发全新具体指令不阻断，仅弹一次断点卡片"; else fail "全新指令处理异常: $out_new"; fi

# 9) 撤回重发与连续零输出熔断
"$PYTHON_BIN" -c "import json,os,time;json.dump({'selftest':{'step':98,'tries':3,'dead':True,'ts':time.time()}},open(os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json','w'))"
out_rw=$(echo '{"conversationId":"selftest","initialNumSteps":29,"lastUserInput":"继续"}' | "$PYTHON_BIN" ./scripts/provider-filter-notice.py)
[ "$out_rw" = "{}" ] && pass "PreInvocation 识别撤回回退并清空旧熔断" || fail "PreInvocation 撤回未清: $out_rw"

"$PYTHON_BIN" -c "import json,os,time;json.dump({'selftest':{'step':98,'tries':3,'dead':True,'ts':time.time()}},open(os.environ['AGY_OFFLOAD_DATA_DIR']+'/.filter-retry-state.json','w'))"
blocked 64
out_rw_stop=$(call)
echo "$out_rw_stop" | grep -q '"decision": "continue"' && pass "Stop 识别撤回后新分支首拦正常续跑" || fail "Stop 撤回分支仍停机: $out_rw_stop"

reset_state
blocked_zero 4; call >/dev/null
blocked_zero 5; out_z=$(call)
[ "$out_z" = "{}" ] && pass "连续 2 次零输出立即熔断" || fail "连续零输出未熔断: $out_z"

# 10) agynote (init/show/status/clean) + agysum + neturl + SKILL.md 校验
out_note=$(printf '# 测试任务\n' | ./scripts/agynote init selftest-ws - && ./scripts/agynote show selftest-ws)
echo "$out_note" | grep -q 'task.md' && echo "$out_note" | grep -q '进度看板' \
  && pass "agynote init/show 正常" || fail "agynote init/show 异常"
mkdir -p "$HOME/agy-notes/selftest-empty-dir"
out_st=$(./scripts/agynote status)
echo "$out_st" | grep -q 'selftest-ws' && pass "agynote status 健康看板输出正常" || fail "agynote status 异常: $out_st"
out_cl=$(./scripts/agynote clean)
[ ! -d "$HOME/agy-notes/selftest-empty-dir" ] && [ -d "$TEST_WS_DIR" ] \
  && pass "agynote clean 只清 0 文件空目录、保留有效目录" || fail "agynote clean 异常: $out_cl"
rm -rf "$TEST_WS_DIR" "$TEST_CONV_DIR"

out_net=$(./scripts/neturl --set gw-test https://api-test.example.com test && ./scripts/neturl gw-test /v1/ping)
echo "$out_net" | grep -q 'https://api-test.example.com/v1/ping' && pass "neturl 读写隔离 DATA_DIR 正常" || fail "neturl 异常: $out_net"

if "$PYTHON_BIN" - <<'PY'
txt = open("skills/note-offload/SKILL.md", encoding="utf-8").read()
assert txt.startswith("---\n") and "name: note-offload\n" in txt
assert "单一目标目录" in txt and "Orchestrator" in txt and "agynote status" in txt
for banned in ("安全过滤器", "绕开", "攻防", "bypass", "exploit", "fake password"):
    assert banned not in txt.lower()
PY
then pass "note-offload Skill 纪律与去毒校验通过"; else fail "SKILL.md 校验失败"; fi

# 11) agysum 与日志轮转
SUM=$(mktemp "$TMP_BASE/selftest-sum.XXXXXX.jsonl")
printf '%s\n' '{"step_index":1,"type":"USER_INPUT","content":"<USER_REQUEST> 测一下 </USER_REQUEST>"}' \
  '{"step_index":2,"type":"PLANNER_RESPONSE","content":"答案正文"}' \
  '{"step_index":3,"type":"PLANNER_RESPONSE","content":"This request was blocked by Gemini'"'"'s filters."}' > "$SUM"
out_sum=$(./scripts/agysum "$SUM" --width 40)
echo "$out_sum" | grep -q 'M2: 答案正文' && echo "$out_sum" | grep -q '被拦 1 次' \
  && pass "agysum 摘要与统计正常" || fail "agysum 异常: $out_sum"
rm -f "$SUM"

"$PYTHON_BIN" -c "import os;open(os.environ['AGY_OFFLOAD_DATA_DIR']+'/hook-invocations.log','a',encoding='utf-8').write(('y'*40+'\n')*20)"
before=$(stat -c%s "$TEST_DATA_DIR/hook-invocations.log" 2>/dev/null || stat -f%z "$TEST_DATA_DIR/hook-invocations.log" 2>/dev/null || echo 0)
"$PYTHON_BIN" -c "import sys;sys.path.insert(0,'./scripts');import hooklib;hooklib.MAX_LOG_BYTES=1;hooklib.KEEP_LINES=5;hooklib.log('rotation-probe')"
after=$(stat -c%s "$TEST_DATA_DIR/hook-invocations.log" 2>/dev/null || stat -f%z "$TEST_DATA_DIR/hook-invocations.log" 2>/dev/null || echo 0)
[ "$after" -lt "$before" ] && pass "DATA_DIR 日志轮转正常" || fail "日志未轮转 ($before -> $after)"

# 12) Sidecar Aux Pane 元数据、语法检查与端到端 HTTP API 自检
NODE_BIN="$(command -v node || true)"
if "$PYTHON_BIN" - <<'PY'
import json, os
sj = json.load(open("sidecars/board/sidecar.json", encoding="utf-8"))
assert sj.get("has_web_ui") is True
views = (sj.get("ui_config") or {}).get("views") or []
assert any(v.get("entrypoint") == "SIDECAR_UI_ENTRYPOINT_AUX_PANE" for v in views)
for f in ("package.json", "main.mjs", "index.html", "styles.css", "app.js"):
    assert os.path.exists(os.path.join("sidecars/board", f))
PY
then pass "sidecar.json 与 Aux Pane 前端资产完整"; else fail "sidecar.json 元数据或资产缺失"; fi

if [ -n "$NODE_BIN" ] && "$NODE_BIN" --check ./sidecars/board/main.mjs ./sidecars/board/app.js 2>/dev/null; then
  pass "Sidecar JS 语法检查通过"

  TEST_NOTE_ROOT=$(mktemp -d "$TMP_BASE/selftest-noteroot.XXXXXX")
  TEST_SC_DATA=$(mktemp -d "$TMP_BASE/selftest-scdata.XXXXXX")
  SC_PORT=$("$PYTHON_BIN" -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
  SC_TOKEN="selftest-token-123"

  AGY_NOTE_ROOT="$TEST_NOTE_ROOT" \
  AGY_OFFLOAD_DATA_DIR="$TEST_SC_DATA" \
  ANTIGRAVITY_SIDECAR_WEB_PORT="$SC_PORT" \
  ANTIGRAVITY_SIDECAR_UI_TOKEN="$SC_TOKEN" \
  "$NODE_BIN" ./sidecars/board/main.mjs >/dev/null 2>&1 &
  SC_PID=$!

  if "$PYTHON_BIN" - "$SC_PORT" "$SC_TOKEN" "$TEST_NOTE_ROOT" "$TEST_SC_DATA" <<'PY'
import json, os, sys, time, urllib.error, urllib.request

port, token, note_root, data_dir = sys.argv[1:5]
base = f"http://127.0.0.1:{port}"

def req(method, path, body=None, use_token=True):
    headers = {}
    if use_token:
        headers["x-sidecar-token"] = token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=3) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")

# 等待服务就绪
ready = False
for _ in range(30):
    try:
        st, html = req("GET", "/", use_token=False)
        if st == 200 and "/preload.js" in html:
            ready = True
            break
    except Exception:
        time.sleep(0.1)
assert ready, "sidecar did not start in time"

# 1. 无 token POST 必须返回 401
st, _ = req("POST", "/api/workspace/init", {"name": "ws1"}, use_token=False)
assert st == 401, f"expected 401 without token, got {st}"

# 2. 初始化工作台 + 在线保存 task.md + 快照与文件读取
st, raw = req("POST", "/api/workspace/init", {"name": "ws1", "taskContent": "# T1\nhello\n"})
assert st == 200 and json.loads(raw)["ok"] is True
st, raw = req("POST", "/api/workspace/save", {"workspace": "ws1", "file": "task.md", "content": "# T1 updated\n"})
assert st == 200 and json.loads(raw)["ok"] is True
st, raw = req("GET", "/api/file?workspace=ws1&file=task.md")
assert st == 200 and json.loads(raw)["content"] == "# T1 updated\n"

# 3. 禁止覆写非 task/status 文件 + 路径穿越拦截
open(os.path.join(note_root, "ws1", "turn-1.md"), "w").write("frozen")
st, _ = req("POST", "/api/workspace/save", {"workspace": "ws1", "file": "turn-1.md", "content": "hack"})
assert st == 403, f"expected 403 for turn-1 write, got {st}"
st, _ = req("GET", "/api/file?workspace=../etc&file=passwd")
assert st in (400, 403), f"path traversal not blocked: {st}"

# 4. 别名增删 + 状态重置 + snapshot 检验
st, raw = req("POST", "/api/alias/upsert", {"key": "gw-z", "value": "https://api-z.example.com", "note": "test"})
assert st == 200 and any(a["key"] == "gw-z" for a in json.loads(raw)["aliases"])
st, raw = req("POST", "/api/alias/delete", {"key": "gw-z"})
assert st == 200 and not any(a["key"] == "gw-z" for a in json.loads(raw)["aliases"])

json.dump({"deadconv1234": {"tries": 3, "dead": True, "dead_reason": "max_retry", "ts": time.time()}},
          open(os.path.join(data_dir, ".filter-retry-state.json"), "w"))
st, raw = req("GET", "/api/snapshot")
snap = json.loads(raw)
assert len(snap["workspaces"]) == 1 and snap["trackedSessions"][0]["dead"] is True
st, _ = req("POST", "/api/state/reset", {"conversationId": "deadconv1234"})
assert st == 200
st, raw = req("GET", "/api/snapshot")
assert json.loads(raw)["trackedSessions"][0]["dead"] is False

# 5. 清理空目录
os.makedirs(os.path.join(note_root, "empty-ws"), exist_ok=True)
st, raw = req("POST", "/api/workspace/clean", {})
assert st == 200 and json.loads(raw)["removedCount"] == 1
PY
  then pass "Sidecar 侧边栏后端端到端 HTTP 鉴权、读写、熔断重置与防穿越全通过"
  else fail "Sidecar HTTP 端到端自检失败"
  fi

  kill "$SC_PID" 2>/dev/null || true
  wait "$SC_PID" 2>/dev/null || true
  rm -rf "$TEST_NOTE_ROOT" "$TEST_SC_DATA"
else
  fail "Sidecar JS 语法检查失败或缺少 node"
fi

rm -rf "$TEST_DATA_DIR" "$T"

echo "----"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails 项失败"; exit 1; fi
