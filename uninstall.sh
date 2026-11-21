#!/usr/bin/env bash
# 卸载 note-offload 原生插件（移除插件目录、旧散装残留与软链接，保留 DATA_DIR/net-map.tsv 与 ~/agy-notes/）
set -euo pipefail

CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
PLUGIN_DIR="$CONFIG_DIR/plugins/note-offload"
BIN_DIR="${AGY_BIN_DIR:-$HOME/.local/bin}"
LEGACY_SCRIPTS_DIR="$CONFIG_DIR/scripts"
LEGACY_HOOKS_JSON="$CONFIG_DIR/hooks.json"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

rm -rf "$PLUGIN_DIR"

for cmd in agynote agysum neturl; do
  if [ -L "$BIN_DIR/$cmd" ]; then
    target="$(readlink "$BIN_DIR/$cmd" || true)"
    case "$target" in
      *"/plugins/note-offload/"*) rm -f "$BIN_DIR/$cmd" ;;
    esac
  fi
  if [ -L "$LEGACY_SCRIPTS_DIR/$cmd" ]; then
    rm -f "$LEGACY_SCRIPTS_DIR/$cmd"
  fi
done

if [ -L "$LEGACY_SCRIPTS_DIR/net-map.tsv" ]; then
  rm -f "$LEGACY_SCRIPTS_DIR/net-map.tsv"
fi

if [ -f "$LEGACY_HOOKS_JSON" ]; then
  "$PYTHON_BIN" - "$LEGACY_HOOKS_JSON" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    with open(p, encoding="utf-8") as fh:
        data = json.load(fh)
except (OSError, ValueError):
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
for k in (
    "gemini-filter-guardrail", "gemini-filter-retry", "gemini-filter-notice",
    "note-offload-guardrail", "note-offload-retry", "note-offload-notice",
):
    data.pop(k, None)
tmp = p + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, p)
PY
fi

echo "已卸载 note-offload 插件（已保留 ~/.local/share/agy-note-offload/ 与 ~/agy-notes/）"
