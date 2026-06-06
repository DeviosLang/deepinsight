#!/bin/bash
# scripts/deploy.sh — Apply K8s manifests 并滚动重启 pod
#
# 用法:
#   ./scripts/deploy.sh                  # apply + rollout restart + wait
#   ./scripts/deploy.sh --apply-only     # 只 apply 不 restart（配置变更）
#   ./scripts/deploy.sh --restart-only   # 只 restart 不 apply（镜像更新后）

set -euo pipefail

NAMESPACE="rag-etl"
DEPLOYMENT="deepinsight-server"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${PROJECT_ROOT}/deploy"

# ─── 参数处理 ───────────────────────────────────────────────────────────────

MODE="full"
case "${1:-}" in
  --apply-only)   MODE="apply" ;;
  --restart-only) MODE="restart" ;;
esac

echo "══════════════════════════════════════════════════"
echo "  DeepInsight Deploy"
echo "══════════════════════════════════════════════════"
echo "  Namespace:  ${NAMESPACE}"
echo "  Deployment: ${DEPLOYMENT}"
echo "  Mode:       ${MODE}"
echo "══════════════════════════════════════════════════"
echo ""

# ─── Step 1: Apply manifests ────────────────────────────────────────────────

if [[ "${MODE}" == "full" || "${MODE}" == "apply" ]]; then
  echo "▶ [1] Applying manifests from ${DEPLOY_DIR}/..."

  # Apply deployment + service (skip secrets/templates)
  for f in deployment.yaml service.yaml cronjob-repo-sync.yaml; do
    if [[ -f "${DEPLOY_DIR}/${f}" ]]; then
      echo "   kubectl apply -f ${f}"
      kubectl apply -f "${DEPLOY_DIR}/${f}" -n "${NAMESPACE}"
    fi
  done

  echo "✓ Manifests applied"
  echo ""
fi

# ─── Step 2: Rollout restart ────────────────────────────────────────────────

if [[ "${MODE}" == "full" || "${MODE}" == "restart" ]]; then
  echo "▶ [2] Rolling restart deployment/${DEPLOYMENT}..."
  kubectl rollout restart deployment/${DEPLOYMENT} -n "${NAMESPACE}"

  echo "▶ [3] Waiting for rollout to complete..."
  kubectl rollout status deployment/${DEPLOYMENT} -n "${NAMESPACE}" --timeout=300s

  echo ""
  echo "✓ Rollout complete"
fi

# ─── Step 3: Verify ─────────────────────────────────────────────────────────

echo ""
echo "▶ [4] Pod status:"
kubectl get pods -n "${NAMESPACE}" -l app="${DEPLOYMENT}" -o wide

echo ""
echo "══════════════════════════════════════════════════"
echo "  Deploy complete!"
echo ""
echo "  验证命令:"
echo "    kubectl -n ${NAMESPACE} logs deploy/${DEPLOYMENT} --tail=20"
echo "    kubectl -n ${NAMESPACE} exec deploy/${DEPLOYMENT} -- curl -s localhost:8080/healthz"
echo ""
echo "  首次运行 indexer 生成 AGENTS.md:"
echo "    kubectl -n ${NAMESPACE} exec deploy/${DEPLOYMENT} -- npx tsx packages/indexer/src/generate-layer1.ts --workspace /data/workspace"
echo "══════════════════════════════════════════════════"
