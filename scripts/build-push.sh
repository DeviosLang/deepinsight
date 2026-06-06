#!/bin/bash
# scripts/build-push.sh — 构建 Docker 镜像并推送到腾讯镜像源
#
# 用法:
#   ./scripts/build-push.sh              # 使用默认 tag: latest
#   ./scripts/build-push.sh v0.2.1       # 使用指定 tag
#   ./scripts/build-push.sh --no-push    # 只构建不推送（本地测试）

set -euo pipefail

REGISTRY="mirrors.tencent.com"
IMAGE="${REGISTRY}/cvm/deepinsight"
TAG="${1:-latest}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ─── 参数处理 ───────────────────────────────────────────────────────────────

NO_PUSH=false
if [[ "${TAG}" == "--no-push" ]]; then
  NO_PUSH=true
  TAG="latest"
fi

echo "══════════════════════════════════════════════════"
echo "  DeepInsight Docker Build & Push"
echo "══════════════════════════════════════════════════"
echo "  Image:   ${IMAGE}:${TAG}"
echo "  Context: ${PROJECT_ROOT}"
echo "  Push:    $(if $NO_PUSH; then echo 'NO (dry run)'; else echo 'YES'; fi)"
echo "══════════════════════════════════════════════════"
echo ""

# ─── Step 1: Build ──────────────────────────────────────────────────────────

echo "▶ [1/2] Building image..."
docker build \
  -t "${IMAGE}:${TAG}" \
  -f "${PROJECT_ROOT}/Dockerfile" \
  "${PROJECT_ROOT}"

echo "✓ Build complete: ${IMAGE}:${TAG}"
echo ""

# ─── Step 2: Push ───────────────────────────────────────────────────────────

if $NO_PUSH; then
  echo "⏭ Push skipped (--no-push)"
else
  echo "▶ [2/2] Pushing to ${REGISTRY}..."
  docker push "${IMAGE}:${TAG}"

  # Also tag + push 'latest' if a version tag was specified
  if [[ "${TAG}" != "latest" ]]; then
    docker tag "${IMAGE}:${TAG}" "${IMAGE}:latest"
    docker push "${IMAGE}:latest"
    echo "✓ Also pushed: ${IMAGE}:latest"
  fi

  echo "✓ Push complete"
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  Done! Next: ./scripts/deploy.sh"
echo "══════════════════════════════════════════════════"
