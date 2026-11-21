#!/usr/bin/env bash
# 一键安装 agy-note-offload 到 ~/.gemini/config/
# - 合并写入 hooks.json（保留用户既有的其他 hook）
# - 安装 scripts/ 与 skills/note-offload/
# - 若本机尚无 net-map.tsv，从示例文件初始化；已有则原样保留
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
SCRIPTS_DIR="$CONFIG_DIR/scripts"
SKILL_DIR="$CONFIG_DIR/skills/note-offload"
HOOKS_JSON="$CONFIG_DIR/hooks.json"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

mkdir -p "$SCRIPTS_DIR" "$SKILL_DIR"

for f in \
  hooklib.py \
  sanitize.py \
  provider-filter-guardrail.py \
  provider-filter-retry.py \
  provider-filter-notice.py \
  agysum \
  neturl \
  file-mode-prompt.md \
  selftest.sh
do
  cp "$REPO_DIR/scripts/$f" "$SCRIPTS_DIR/$f"
done

chmod +x \
  "$SCRIPTS_DIR/provider-filter-guardrail.py" \
  "$SCRIPTS_DIR/provider-filter-retry.py" \
  "$SCRIPTS_DIR/provider-filter-notice.py" \
  "$SCRIPTS_DIR/agysum" \
  "$SCRIPTS_DIR/neturl" \
  "$SCRIPTS_DIR/selftest.sh"

if [ ! -f "$SCRIPTS_DIR/net-map.tsv" ]; then
  cp "$REPO_DIR/scripts/net-map.tsv.example" "$SCRIPTS_DIR/net-map.tsv"
  echo "已初始化示例别名表: $SCRIPTS_DIR/net-map.tsv"
else
  echo "已保留现有别名表: $SCRIPTS_DIR/net-map.tsv"
fi

cp "$REPO_DIR/skills/note-offload/SKILL.md" "$SKILL_DIR/SKILL.md"

"$PYTHON_BIN" - "$HOOKS_JSON" "$SCRIPTS_DIR" "$PYTHON_BIN" <<'PY'
import json
import os
import sys

hooks_path, scripts_dir, py_bin = sys.argv[1:4]
data = {}
if os.path.exists(hooks_path):
    try:
        with open(hooks_path, encoding="utf-8") as fh:
            loaded = json.load(fh)
            if isinstance(loaded, dict):
                data = loaded
    except ValueError:
        backup = hooks_path + ".bak"
        os.replace(hooks_path, backup)
        print(f"原 hooks.json 解析失败，已备份至 {backup}", file=sys.stderr)

data["gemini-filter-guardrail"] = {
    "SessionStart": [{
        "type": "command",
        "command": f"{py_bin} {scripts_dir}/provider-filter-guardrail.py",
        "timeout": 10,
    }]
}
data["gemini-filter-retry"] = {
    "Stop": [{
        "type": "command",
        "command": f"{py_bin} {scripts_dir}/provider-filter-retry.py",
        "timeout": 10,
    }]
}
data["gemini-filter-notice"] = {
    "PreInvocation": [{
        "type": "command",
        "command": f"{py_bin} {scripts_dir}/provider-filter-notice.py",
        "timeout": 5,
    }]
}

tmp = hooks_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, hooks_path)
PY

echo "安装完成：$HOOKS_JSON、$SCRIPTS_DIR、$SKILL_DIR"
echo "运行自检..."
AGY_CONFIG_DIR="$CONFIG_DIR" bash "$SCRIPTS_DIR/selftest.sh"
