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
  # Don't rely on `kubectl rollout status --watch` alone — its underlying watch
  # stream intermittently stalls with "event bookmark expired" and then times
  # out even when pods are already healthy (observed repeatedly on this cluster).
  # Poll the deployment's status fields directly as the source of truth.
  ROLLOUT_OK=false
  for i in $(seq 1 60); do
    sleep 5
    DESIRED=$(kubectl get deploy "${DEPLOYMENT}" -n "${NAMESPACE}" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
    UPDATED=$(kubectl get deploy "${DEPLOYMENT}" -n "${NAMESPACE}" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null || echo 0)
    READY=$(kubectl get deploy "${DEPLOYMENT}" -n "${NAMESPACE}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
    AVAIL=$(kubectl get deploy "${DEPLOYMENT}" -n "${NAMESPACE}" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo 0)
    if [[ "${DESIRED}" != "0" && "${UPDATED}" == "${DESIRED}" && "${READY}" == "${DESIRED}" && "${AVAIL}" == "${DESIRED}" ]]; then
      ROLLOUT_OK=true
      break
    fi
    echo "   [${i}] updated=${UPDATED}/${DESIRED} ready=${READY}/${DESIRED} available=${AVAIL}/${DESIRED}"
  done

  if $ROLLOUT_OK; then
    echo "✓ Rollout complete"
  else
    echo "⚠ Rollout not confirmed as healthy after 5 min — check pod status below."
    echo "  (Common cause: a pod stuck ContainerCreating due to CNI IP exhaustion on a node —"
    echo "   force-delete it so the scheduler reschedules elsewhere.)"
  fi
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
echo "    kubectl -n ${NAMESPACE} exec deploy/${DEPLOYMENT} -- node -e \"require('http').get('http://localhost:8080/healthz',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(r.statusCode,d))})\""
echo ""
echo "  首次运行 indexer 生成 AGENTS.md:"
echo "    kubectl -n ${NAMESPACE} exec deploy/${DEPLOYMENT} -- npx tsx packages/indexer/src/generate-layer1.ts --workspace /data/workspace"
echo ""
echo "  ⚠ 改 Secret 后的部署:"
echo "    Secret 不在本脚本 apply 范围内（模板不含真实值）。改 Secret 后必须"
echo "    重启 Pod 才能生效:"
echo "      ./scripts/deploy.sh --restart-only    # 或 kubectl rollout restart"
echo "    用 --apply-only 不会重新加载 Secret 值。"
echo "══════════════════════════════════════════════════"
