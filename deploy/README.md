# DeepInsight Deployment Guide

## Prerequisites

- K8s cluster with namespace `rag-etl`
- `shirakami-workspace-nfs` PVC already available (shared with shirakami-server)
- Image registry access: `mirrors.tencent.com/cvm/`
- `imagePullSecrets`: `memorix-base`

## Steps

### 1. Create Secret (manual, one-time)

```bash
kubectl create secret generic deepinsight-secrets \
  --namespace=rag-etl \
  --from-literal=llm-api-key='<YOUR_KEY>' \
  --from-literal=llm-base-url='<YOUR_URL>'
```

Or copy and fill `secret.template.yaml`:
```bash
cp secret.template.yaml .secrets/secret.yaml
# Edit .secrets/secret.yaml with real values
kubectl apply -f .secrets/secret.yaml
```

### 2. Create ConfigMap (contains repo list with git tokens)

```bash
cp configmap.template.yaml .secrets/configmap.yaml
# Edit .secrets/configmap.yaml with real repo URLs + tokens
kubectl apply -f .secrets/configmap.yaml
```

### 3. Deploy

```bash
kubectl apply -f service.yaml
kubectl apply -f deployment.yaml
```

### 4. Verify

```bash
kubectl get pods -n rag-etl -l app=deepinsight-server
kubectl logs -n rag-etl -l app=deepinsight-server --tail=20

# Health check
kubectl exec -n rag-etl deploy/deepinsight-server -- curl -s localhost:8080/healthz
```

## Architecture Notes

- **Workspace (NFS)**: Shared with shirakami-server at `/data/workspace`. Contains git clones of all repos.
- **Scratch (emptyDir)**: Local fast storage at `/data/scratch`. Used for temporary worktrees during ast-grep analysis. Auto-cleaned on pod restart.
- **Config**: Mounted from ConfigMap at `/etc/deepinsight/project.yml`.
- **Secrets**: LLM API credentials injected via env vars from K8s Secret.

## Updating

```bash
# Build & push new image
docker build -t mirrors.tencent.com/cvm/deepinsight:latest .
docker push mirrors.tencent.com/cvm/deepinsight:latest

# Rolling restart
kubectl rollout restart deployment/deepinsight-server -n rag-etl
```
