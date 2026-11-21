#!/usr/bin/env bash
# 卸载 agy-note-offload（仅移除本套件注册项与脚本，保留其他 hook、net-map.tsv 与 ~/agy-notes/）
set -euo pipefail

CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
SCRIPTS_DIR="$CONFIG_DIR/scripts"
SKILL_DIR="$CONFIG_DIR/skills/note-offload"
HOOKS_JSON="$CONFIG_DIR/hooks.json"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

if [ -f "$HOOKS_JSON" ]; then
  "$PYTHON_BIN" - "$HOOKS_JSON" <<'PY'
import json
import os
import sys

p = sys.argv[1]
try:
    with open(p, encoding="utf-8") as fh:
        data = json.load(fh)
except (OSError, ValueError):
    sys.exit(0)

if not isinstance(data, dict):
    sys.exit(0)

for k in ("gemini-filter-guardrail", "gemini-filter-retry", "gemini-filter-notice"):
    data.pop(k, None)

tmp = p + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, p)
PY
fi

rm -rf "$SKILL_DIR"
for f in \
  provider-filter-guardrail.py \
  provider-filter-retry.py \
  provider-filter-notice.py \
  hooklib.py \
  sanitize.py \
  agysum \
  neturl \
  file-mode-prompt.md \
  selftest.sh
do
  rm -f "$SCRIPTS_DIR/$f"
done

echo "已卸载 agy-note-offload（已保留 $SCRIPTS_DIR/net-map.tsv 与 ~/agy-notes/）"
