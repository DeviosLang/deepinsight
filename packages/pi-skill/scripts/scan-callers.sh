#!/bin/bash
# scan-callers.sh — 使用 ast-grep 扫描跨仓调用者
# 用法: ./scan-callers.sh <symbol> <language> <repos_root>

set -euo pipefail

SYMBOL="${1:?Usage: scan-callers.sh <symbol> <language> <repos_root>}"
LANG="${2:-python}"
REPOS_ROOT="${3:-/tmp/deepinsight-workspace}"

# 生成临时规则文件
RULE_FILE="/tmp/impact-${SYMBOL}.yml"
cat > "$RULE_FILE" << EOF
id: find-callers-${SYMBOL}
language: ${LANG}
rule:
  any:
    - pattern: "${SYMBOL}(\$\$\$)"
    - pattern: "\$OBJ.${SYMBOL}(\$\$\$)"
    - pattern: "from \$MOD import ${SYMBOL}"
EOF

# 扫描
echo "=== Scanning for ${SYMBOL} in ${REPOS_ROOT} ==="
sg scan --rule "$RULE_FILE" --json "$REPOS_ROOT" 2>/dev/null | \
  jq -r '.[] | "\(.file):\(.range.start.line): \(.text)"' | \
  head -200

# 清理
rm -f "$RULE_FILE"
