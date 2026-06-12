# DeepInsight 并发控制快速参考

## 🎯 核心参数速查

### K8s 资源配置
| 配置 | 当前 | 推荐(小集群) | 推荐(大集群) |
|-----|------|-----------|-----------|
| Pod 副本数 | 1 | **2-3** ⭐ | 3-5 |
| CPU Request | 500m | 1 CPU ⭐ | 2 CPU |
| CPU Limit | 4 CPU | 6 CPU ⭐ | 8 CPU |
| 内存 Request | 2Gi | 4Gi ⭐ | 8Gi |
| 内存 Limit | 16Gi | 24Gi ⭐ | 32Gi |

### 应用并发控制参数
| 参数 | 值 | 含义 | 文件位置 |
|-----|-----|------|---------|
| Pi Worker 超时 | 10min | 单个分析任务最长运行时间 | `piWorker.ts:76` |
| Pi 收尾信号 | 8.5min | 触发 wrap-up 消息时间 | `piWorker.ts:166` |
| 最大并发 Worker | 4/2 | ≤30 符号用 4，>30 用 2 | `pipeline.ts:442/714` |
| Coarse Filter 并发 | 10 | git grep 批处理大小 | `pre-filter/index.ts:43` |
| 最大分析仓库 | 10 | Pre-filter 后的仓库数 | `pre-filter/index.ts:127` |
| 最大任务存储 | 200 | 内存驻留任务上限 | `analyze.ts:25` |
| AGENTS.md 限制 | 40KB | 知识库提示词预算 | `pipeline.ts:630` |

---

## 🚀 快速部署步骤

### 1️⃣  立即实施 (Tier 1 - 5 分钟)

```bash
# 编辑 deployment.yaml
kubectl set image deployment/deepinsight-server \
  server=mirrors.tencent.com/cvm/deepinsight:latest

# 增加副本数
kubectl scale deployment deepinsight-server --replicas=3 -n rag-etl

# 更新资源请求
kubectl set resources deployment deepinsight-server \
  -c=server \
  --requests=cpu=1,memory=4Gi \
  --limits=cpu=6,memory=24Gi \
  -n rag-etl
```

### 2️⃣  验证部署 (5 分钟)

```bash
# 检查 Pod 状态
kubectl get pods -n rag-etl -l app=deepinsight-server

# 查看资源使用
kubectl top pods -n rag-etl

# 测试健康检查
kubectl exec -it <pod-name> -n rag-etl -- \
  curl localhost:8080/healthz
```

### 3️⃣  监控性能 (持续)

```bash
# 查看日志
kubectl logs -f deployment/deepinsight-server -n rag-etl

# 监控 Pi worker 活动
kubectl logs -f deployment/deepinsight-server -n rag-etl | \
  grep -E "\[pi:|Worker|timeout"

# 监控内存使用
kubectl top pods -n rag-etl --containers | \
  grep deepinsight-server
```

---

## 🔧 常见调优场景

### 场景 1️⃣ : 内存使用过高 (>85%)

**症状**: Pod 频繁 OOMKilled

**解决**:
```yaml
# 方案 A: 减少并发
env:
  - name: MAX_PARALLEL_WORKERS
    value: "2"  # 从 4 降低

# 方案 B: 增加内存
resources:
  limits:
    memory: "32Gi"  # 从 16Gi 增加

# 方案 C: 水平扩展
kubectl scale deployment deepinsight-server --replicas=5
```

**诊断**:
```bash
# 查看内存峰值
kubectl top pods -n rag-etl --containers | grep deepinsight

# 查看 OOM 事件
kubectl describe node <node-name> | grep -A 5 "memory pressure"
```

### 场景 2️⃣ : Pi Worker 频繁超时

**症状**: 日志中出现 `[pi:timeout]` 信息

**解决**:
```yaml
# 方案 A: 增加超时时间
env:
  - name: PI_WORKER_TIMEOUT_MS
    value: "900000"  # 15 分钟

# 方案 B: 减少任务复杂度
env:
  - name: MAX_PARALLEL_WORKERS
    value: "2"

# 方案 C: 减少目标仓库数
env:
  - name: MAX_TARGET_REPOS
    value: "5"
```

**诊断**:
```bash
# 查看超时日志
kubectl logs deployment/deepinsight-server -n rag-etl | \
  grep -i "timeout\|steer"

# 查看 pi worker 启动频率
kubectl logs deployment/deepinsight-server -n rag-etl | \
  grep "\[pi:rpc\] Starting pi"
```

### 场景 3️⃣ : NFS 访问缓慢

**症状**: Coarse Filter 耗时 > 60 秒

**解决**:
```yaml
# 方案 A: 减少并发度
env:
  - name: COARSE_FILTER_CONCURRENCY
    value: "5"  # 从 10 降低

# 方案 B: 增加超时
env:
  - name: GIT_GREP_TIMEOUT_MS
    value: "60000"  # 从 30s 增加到 60s

# 方案 C: 检查 NFS 节点负载
# 无法从代码解决，需要基础设施调优
```

**诊断**:
```bash
# 查看 Pre-filter 耗时
kubectl logs deployment/deepinsight-server -n rag-etl | \
  grep "\[pre-filter\]"

# 检查 NFS 延迟
kubectl exec -it <pod> -- \
  time find /data/workspace -name ".git" | head -1
```

### 场景 4️⃣ : 任务队列堆积 (>100 任务)

**症状**: 分析请求延迟增加

**解决**:
```yaml
# 方案 A: 增加并发处理能力
replicas: 5  # 从 3 增加

# 方案 B: 增加任务存储上限
env:
  - name: MAX_CONCURRENT_TASKS
    value: "500"  # 从 200 增加

# 方案 C: 实现异步队列(长期方案)
# 使用 Redis/RabbitMQ 替代内存队列
```

**诊断**:
```bash
# 查看当前任务数
kubectl exec -it <pod> -c server -- \
  curl -s localhost:8080/api/tasks | jq '.total'

# 查看任务分布
kubectl exec -it <pod> -c server -- \
  curl -s localhost:8080/api/tasks | jq '.tasks[] | .status' | sort | uniq -c
```

---

## 📊 性能基准 (Baseline)

### 预期性能指标

| 指标 | 值 | 条件 |
|-----|-----|------|
| 单个分析耗时 | 30-120 秒 | 5-10 个仓库，3-10 个符号 |
| Pre-filter 耗时 | 30-40 秒 | 56 个仓库，Coarse 并发 10 |
| Pi Worker 耗时 | 300-900 秒 | 取决于分析复杂度 |
| 峰值内存占用 | 8-12Gi | 4 个并发 worker |
| 峰值 CPU 占用 | 2-3 CPU | 4 个并发 worker |

### 扩展性指标

| 变更大小 | 最大耗时 | CPU 占用 | 内存占用 |
|---------|--------|--------|---------|
| 小 (1-2 符号) | ~120 秒 | 2 CPU | 5Gi |
| 中 (3-10 符号) | ~300 秒 | 3 CPU | 10Gi |
| 大 (11-30 符号) | ~600 秒 | 3.5 CPU | 12Gi |
| 超大 (>30 符号) | ~900 秒+ | 2.5 CPU | 14Gi |

---

## ⚠️ 风险提示

### 不要做的事

❌ **不要同时改动所有参数** - 一次一个，观察 1 周效果

❌ **不要将副本数增加到 > 5** - NFS 会成为瓶颈

❌ **不要将 MAX_PARALLEL_WORKERS 设置 > 6** - 内存会爆

❌ **不要禁用健康检查** - 会导致僵尸 Pod

❌ **不要将 Pi Worker 超时设置 < 5 分钟** - 正常任务会超时

### 应该做的事

✅ **使用环境变量控制所有参数** - 便于不停机调整

✅ **设置监控告警** - 内存 > 85%、超时率 > 10%

✅ **定期审查日志** - 查找性能瓶颈

✅ **负载测试后再上生产** - 至少分析 100 个任务

✅ **设置 PodDisruptionBudget** - 保证高可用性

---

## 🔍 故障排查清单

- [ ] 检查 Pod 是否 Running
  ```bash
  kubectl get pods -n rag-etl
  ```

- [ ] 检查资源是否充足
  ```bash
  kubectl describe node <node>
  ```

- [ ] 检查日志中的错误
  ```bash
  kubectl logs -f deployment/deepinsight-server -n rag-etl | grep -i error
  ```

- [ ] 检查 NFS 连接
  ```bash
  kubectl exec -it <pod> -- ls -la /data/workspace
  ```

- [ ] 检查 LLM API 连接
  ```bash
  kubectl exec -it <pod> -- curl -s $LLM_BASE_URL/models
  ```

- [ ] 检查任务队列状态
  ```bash
  kubectl exec -it <pod> -- curl -s localhost:8080/api/tasks | jq
  ```

- [ ] 重启 Pod 并观察
  ```bash
  kubectl rollout restart deployment/deepinsight-server -n rag-etl
  ```

---

## 📞 获取帮助

### 查看详细分析报告
```bash
cat docs/CONCURRENCY_ANALYSIS.md
```

### 查看推荐配置
```bash
cat docs/DEPLOYMENT_RECOMMENDATIONS.yaml
```

### 检查应用源代码中的硬编码常量
```bash
grep -r "const.*=" packages/analysis-service/src | grep -E "MAX_|CONCURRENCY|TIMEOUT|LIMIT"
```

### 查看配置文件示例
```bash
cat config/projects/example.template.yml
```

---

**最后更新**: 2026-06-11
**文档版本**: 1.0
**适用版本**: DeepInsight v0.1.0+
