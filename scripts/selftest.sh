#!/usr/bin/env bash
# Note Offload 插件全量四维门禁与沙箱自检入口。
# 用法: bash scripts/selftest.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

TMP_BASE="${TMPDIR:-/tmp}"
TEST_DATA_DIR="$(mktemp -d "$TMP_BASE/agy-selftest-data.XXXXXX")"
TEST_NOTE_ROOT="$(mktemp -d "$TMP_BASE/agy-selftest-notes.XXXXXX")"
TEST_DIST_DIR="$(mktemp -d "$TMP_BASE/agy-selftest-dist.XXXXXX")"

cleanup() {
  node -e 'import("node:fs").then((fs) => { for (const p of process.argv.slice(1)) fs.rmSync(p, { recursive: true, force: true }); })' \
    "$TEST_DATA_DIR" "$TEST_NOTE_ROOT" "$TEST_DIST_DIR"
}
trap cleanup EXIT

export AGY_OFFLOAD_DATA_DIR="$TEST_DATA_DIR"
export AGY_NOTE_ROOT="$TEST_NOTE_ROOT"

echo "1) 校验单一版本源与共享文档同步..."
node ./scripts/sync-meta.mjs --check

echo "2) 扫描仓库隐私、残留文件与安全红线..."
node ./scripts/check-privacy.mjs

echo "3) 运行 L1/L2 Node 内置模块化测试与故障回放套件..."
node --test ./tests/*.test.mjs

echo "4) 运行 L4 技能与提示词行为契约评测..."
node ./scripts/offload-skill-eval.mjs

echo "5) 运行 L3 真浏览器 CDP UI 冒烟测试（无浏览器时自动跳过）..."
node ./scripts/offload-ui-smoke.mjs

echo "6) 验证 Deflate 压缩 Release ZIP 打包输出..."
node ./scripts/build-release.mjs "$TEST_DIST_DIR"

if command -v agy >/dev/null 2>&1; then
  echo "7) 运行官方 agy plugin validate ./plugin --strict..."
  agy plugin validate ./plugin --strict --json
else
  echo "7) 跳过 agy plugin validate（当前环境未安装 agy CLI）"
fi

echo "----"
echo "ALL PASS"
