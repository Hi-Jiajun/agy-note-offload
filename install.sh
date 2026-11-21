#!/usr/bin/env bash
# 一键安装 agy-note-offload 为 Antigravity 原生插件（~/.gemini/config/plugins/note-offload/）
# - 同步插件文件（plugin.json, hooks.json, assets/, scripts/, skills/）
# - 数据目录迁入 ~/.local/share/agy-note-offload/（保留已有 net-map.tsv/state/log，不污染插件仓库）
# - 清理旧散装注册（hooks.json 中的旧条目、旧 ~/.gemini/config/skills/note-offload 与旧脚本）防止双倍触发
# - 在 ~/.local/bin 与 ~/.gemini/config/scripts/ 建立 CLI 软链接，确保终端直敲与旧会话零中断
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
PLUGIN_DIR="$CONFIG_DIR/plugins/note-offload"
DATA_DIR="${AGY_OFFLOAD_DATA_DIR:-$HOME/.local/share/agy-note-offload}"
BIN_DIR="${AGY_BIN_DIR:-$HOME/.local/bin}"

LEGACY_SCRIPTS_DIR="$CONFIG_DIR/scripts"
LEGACY_SKILL_DIR="$CONFIG_DIR/skills/note-offload"
LEGACY_HOOKS_JSON="$CONFIG_DIR/hooks.json"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

mkdir -p "$PLUGIN_DIR/assets" "$PLUGIN_DIR/scripts" "$PLUGIN_DIR/skills/note-offload" "$DATA_DIR" "$BIN_DIR"

# 1) 安装/同步原生插件包文件（若直接在 PLUGIN_DIR 内运行则跳过自我拷贝）
if [ "$(readlink -f "$REPO_DIR")" != "$(readlink -f "$PLUGIN_DIR")" ]; then
  cp "$REPO_DIR/plugin.json" "$PLUGIN_DIR/plugin.json"
  cp "$REPO_DIR/hooks.json" "$PLUGIN_DIR/hooks.json"
  cp "$REPO_DIR/README.md" "$PLUGIN_DIR/README.md"
  cp "$REPO_DIR/LICENSE" "$PLUGIN_DIR/LICENSE"
  cp "$REPO_DIR/assets/logo.svg" "$PLUGIN_DIR/assets/logo.svg"
  cp "$REPO_DIR/skills/note-offload/SKILL.md" "$PLUGIN_DIR/skills/note-offload/SKILL.md"
  for f in \
    hooklib.py \
    sanitize.py \
    provider-filter-guardrail.py \
    provider-filter-retry.py \
    provider-filter-notice.py \
    agynote \
    agysum \
    neturl \
    net-map.tsv.example \
    file-mode-prompt.md \
    selftest.sh
  do
    cp "$REPO_DIR/scripts/$f" "$PLUGIN_DIR/scripts/$f"
  done
fi

chmod +x \
  "$PLUGIN_DIR/scripts/provider-filter-guardrail.py" \
  "$PLUGIN_DIR/scripts/provider-filter-retry.py" \
  "$PLUGIN_DIR/scripts/provider-filter-notice.py" \
  "$PLUGIN_DIR/scripts/agynote" \
  "$PLUGIN_DIR/scripts/agysum" \
  "$PLUGIN_DIR/scripts/neturl" \
  "$PLUGIN_DIR/scripts/selftest.sh"

# 2) 平滑迁移旧散装运行时数据至 DATA_DIR（保留用户已有数据，清洗无效脏键）
if [ -f "$LEGACY_SCRIPTS_DIR/net-map.tsv" ] && [ ! -L "$LEGACY_SCRIPTS_DIR/net-map.tsv" ] && [ ! -f "$DATA_DIR/net-map.tsv" ]; then
  mv "$LEGACY_SCRIPTS_DIR/net-map.tsv" "$DATA_DIR/net-map.tsv"
  echo "已迁移别名表至数据目录: $DATA_DIR/net-map.tsv"
elif [ ! -f "$DATA_DIR/net-map.tsv" ]; then
  cp "$PLUGIN_DIR/scripts/net-map.tsv.example" "$DATA_DIR/net-map.tsv"
  echo "已初始化示例别名表: $DATA_DIR/net-map.tsv"
fi

if [ -f "$LEGACY_SCRIPTS_DIR/.filter-retry-state.json" ] && [ ! -f "$DATA_DIR/.filter-retry-state.json" ]; then
  mv "$LEGACY_SCRIPTS_DIR/.filter-retry-state.json" "$DATA_DIR/.filter-retry-state.json"
fi
if [ -f "$LEGACY_SCRIPTS_DIR/hook-invocations.log" ] && [ ! -f "$DATA_DIR/hook-invocations.log" ]; then
  mv "$LEGACY_SCRIPTS_DIR/hook-invocations.log" "$DATA_DIR/hook-invocations.log"
fi

if [ -f "$DATA_DIR/.filter-retry-state.json" ]; then
  "$PYTHON_BIN" - "$DATA_DIR/.filter-retry-state.json" <<'PY'
import json, sys
p = sys.argv[1]
try:
    raw = json.load(open(p, encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(0)
if isinstance(raw, dict):
    dirty = ("probe", "selftest", "None", "unknown")
    cleaned = {k: v for k, v in raw.items() if k not in dirty and isinstance(v, dict)}
    if cleaned != raw:
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cleaned, fh)
        import os
        os.replace(tmp, p)
PY
fi

# 3) 清理旧散装 hooks.json 注册与旧脚本/旧 Skill（防止双倍触发）
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
old_keys = (
    "gemini-filter-guardrail", "gemini-filter-retry", "gemini-filter-notice",
    "note-offload-guardrail", "note-offload-retry", "note-offload-notice",
)
changed = False
for k in old_keys:
    if k in data:
        data.pop(k, None)
        changed = True
if changed:
    if data:
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, p)
    else:
        os.remove(p)
        print("已清理空的旧全局 hooks.json（Hook 已迁至插件目录）")
PY
fi

rm -rf "$LEGACY_SKILL_DIR"
for old in \
  provider-filter-guardrail.py \
  provider-filter-retry.py \
  provider-filter-notice.py \
  hooklib.py \
  sanitize.py \
  selftest.sh \
  file-mode-prompt.md \
  retry-terms.txt
do
  rm -f "$LEGACY_SCRIPTS_DIR/$old"
done

# 4) 建立 ~/.local/bin 软链与旧路径向后兼容软链（不中断正在运行的会话）
for cmd in agynote agysum neturl; do
  ln -sfn "$PLUGIN_DIR/scripts/$cmd" "$BIN_DIR/$cmd"
done

if [ -d "$LEGACY_SCRIPTS_DIR" ] || [ ! -e "$LEGACY_SCRIPTS_DIR" ]; then
  mkdir -p "$LEGACY_SCRIPTS_DIR"
  for cmd in agynote agysum neturl; do
    ln -sfn "$PLUGIN_DIR/scripts/$cmd" "$LEGACY_SCRIPTS_DIR/$cmd"
  done
  ln -sfn "$DATA_DIR/net-map.tsv" "$LEGACY_SCRIPTS_DIR/net-map.tsv"
fi

echo "原生插件安装完成："
echo "  插件目录: $PLUGIN_DIR"
echo "  数据目录: $DATA_DIR"
echo "  CLI 软链: $BIN_DIR/{agynote,agysum,neturl}"
echo "运行插件自检..."
AGY_CONFIG_DIR="$CONFIG_DIR" AGY_OFFLOAD_DATA_DIR="$DATA_DIR" bash "$PLUGIN_DIR/scripts/selftest.sh"
