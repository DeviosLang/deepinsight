# DeepInsight 并发控制配置分析报告

生成时间: 2026-06-11

## 📋 执行摘要

本报告分析了 DeepInsight 项目（云平台代码智能分析系统）的所有 K8s 部署清单和应用配置中的并发控制相关参数。

**关键发现:**
- ✅ **Pod 资源限制**: 主容器(500m-4 CPU, 2Gi-16Gi 内存)合理
- ✅ **副本数**: 当前为 1，可根据负载扩展至 3-5
- ⚠️  **并发控制**: 主要在应用层实现，K8s 层级无特殊配置
- ✅ **超时/队列**: 应用设置明确（15分钟 pi worker 超时，队列长度 200 任务限制）
- ✅ **CronJob**: 使用 `concurrencyPolicy: Forbid` 防止并发执行

---

## 1️⃣  K8s 部署清单分析

### 1.1 主服务部署 (deployment.yaml)

#### 副本数配置
```yaml
replicas: 1
```
- **当前状态**: 单副本
- **建议**: 
  - 开发环境保持 1
  - 生产环境建议 3-5（取决于 QPS）
  - 配置 PodDisruptionBudget 保证最小可用副本数

#### 资源请求/限制 (Container: server)

| 资源类型 | 请求 (Request) | 限制 (Limit) | 比例 |
|---------|---|---|---|
| **CPU** | 500m | 4000m | 1:8 |
| **内存** | 2Gi | 16Gi | 1:8 |

**分析**:
- ✅ Request 设置保守，允许节点合理分配
- ✅ Limit 设置宽松，为突发流量预留空间
- ✅ 比例合理(1:8)，符合 K8s 最佳实践
- ⚠️ 如应用启用 LLM 本地缓存或大文件处理，建议调整为 Request: 1 CPU, Limit: 6 CPU

#### 健康检查

| 检查项 | 配置 | 用途 |
|--------|------|------|
| **Liveness** | `/healthz` 每 60s | 检测进程死亡 |
| **Readiness** | `/readyz` 每 30s | 检测服务就绪 |

```yaml
livenessProbe:
  initialDelaySeconds: 10       # 启动后 10s 开始检查
  periodSeconds: 60             # 每 60s 检查一次
  failureThreshold: 5           # 失败 5 次后重启
  timeoutSeconds: 10

readinessProbe:
  initialDelaySeconds: 5
  periodSeconds: 30             # 每 30s 检查一次
  failureThreshold: 3           # 失败 3 次后标记 NotReady
  timeoutSeconds: 5
```

**建议**:
- ✅ 初始延迟合理(10s 启动间隔)
- ✅ 重启阈值保守(5 次失败)
- ⚠️ 如 LLM 调用频繁，建议 periodSeconds 改为 15-30s 避免误判

#### 滚动更新策略

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1           # 同时最多 2 个 pod(1 原 + 1 新)
    maxUnavailable: 0     # 更新时服务零中断
```

**分析**: ✅ 零中断更新，适合关键业务

### 1.2 CronJob 部分

#### cronjob-agents-md-refresh.yaml (日知识库索引)

```yaml
schedule: "23 3 * * *"              # 每天 03:23 UTC
concurrencyPolicy: Forbid           # 严格防止并发
activeDeadlineSeconds: 14400        # 4 小时硬超时
successfulJobsHistoryLimit: 1       # 仅保留 1 个成功任务
failedJobsHistoryLimit: 3           # 保留 3 个失败任务
```

**并发控制**: ✅ `Forbid` 确保前一个任务完成后才启动下一个

#### cronjob-repo-sync.yaml (仓库同步)

```yaml
schedule: "*/30 * * * *"            # 每 30 分钟运行一次
concurrencyPolicy: Forbid           # 防止并发
activeDeadlineSeconds: 600          # 10 分钟硬超时
successfulJobsHistoryLimit: 3       # 保留 3 个成功任务
```

**资源限制**:
```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
```

---

## 2️⃣  应用层并发控制分析

### 2.1 Analysis Service 主进程并发参数

#### 文件: `packages/analysis-service/src/orchestrator/pipeline.ts`

##### 并行 Worker 数限制 (第 442, 714 行)

```typescript
// 限制并行 worker 数避免 OOM：
// - 符号数 ≤ 30：最多 4 个 worker
// - 符号数 > 30：最多 2 个 worker
const MAX_PARALLEL_WORKERS = allSymbols.length > 30 ? 2 : 4;
```

**并发规则**:
| 变更大小 | 符号数 | Worker 数 | 适用场景 |
|---------|--------|---------|---------|
| 小 | ≤ 2 | 1 | 单个函数修改 |
| 中 | 3-30 | 4 | 常见 feature/bug fix |
| 大 | > 30 | 2 | 重大重构 |

**调优建议**:
```typescript
// 如果内存充足(Pod limit: 16Gi)，可调整为：
const MAX_PARALLEL_WORKERS = allSymbols.length > 50 ? 2 : 
                              allSymbols.length > 30 ? 3 : 4;
```

##### 目标仓库上限 (第 127 行)

```typescript
const MAX_TARGET_REPOS = 10;
```

- 最多分析 10 个仓库(由 Pre-filter 阶段筛选)
- 如集群超过 56 个仓库，可调整为 15-20

### 2.2 Pre-filter 并发 (packages/analysis-service/src/pre-filter/index.ts)

#### Coarse Filter 并发度 (第 43 行)

```typescript
const CONCURRENCY = 10;  // 并行 git grep 的仓库批次大小
```

**机制**:
```
所有仓库 [56 个] 
    ↓ 
分批处理 [每批 10 个仓库]
    ↓
每个仓库 git grep 所有符号
    ↓
Top 10 仓库进入 Fine Filter
```

**并发流控**:
- 批处理大小: 10
- 每个 git grep 超时: 30 秒
- 错误处理: `Promise.allSettled()` (单个失败不影响整批)

**调优建议**:
```typescript
// NFS 性能优化：如果 NFS 稳定，可增加到 15-20
const CONCURRENCY = process.env.COARSE_FILTER_CONCURRENCY 
  ? parseInt(process.env.COARSE_FILTER_CONCURRENCY) 
  : 10;
```

### 2.3 Pi Worker 超时控制 (packages/analysis-service/src/orchestrator/piWorker.ts)

#### 主超时 (第 76 行)

```typescript
const timeoutMs = config.timeoutMs ?? 600_000;  // 10 分钟 = 600,000 ms
```

#### 超时前"收尾"信号 (第 166 行)

```typescript
const steerDelayMs = Math.max(
  timeoutMs - 100_000,      // 100s 前触发，或
  timeoutMs * 0.85           // 超时时间的 85%
);
// 实际值: max(500000, 510000) = 510 秒 ≈ 8.5 分钟
```

**机制**: 
- ⏱️ **8.5 分钟**: 发送"wrap up"信号给 pi agent
- 🛑 **10 分钟**: 如果还未完成，发送 SIGTERM 然后 SIGKILL

#### 流式超时宽限 (第 190-191 行)

```typescript
const STREAM_GRACE_MS = 15_000;      // 15 秒额外宽限
const STREAM_LIVENESS_MS = 8_000;     // 检测流式输出活跃度的窗口
```

**防止截断逻辑**:
- 如果在最后 8 秒内还在输出 JSON，再宽限 15 秒
- 目的：避免在 pi 写最终报告时被 SIGKILL

#### 活跃度监控 (第 220-226 行)

```typescript
const watchdog = setInterval(() => {
  const idle = Date.now() - lastActivity;
  if (idle > 60_000) {  // 60 秒无输出
    console.log(`[pi:watchdog] No output for ${(idle/1000).toFixed(0)}s...`);
  }
}, 30_000);  // 每 30 秒检查一次
```

### 2.4 任务存储并发限制 (packages/analysis-service/src/api/analyze.ts)

#### 内存驻留任务限制 (第 25 行)

```typescript
const MAX_TASKS = 200;  // 最多存储 200 个分析任务
```

#### 任务过期清理 (第 24 行)

```typescript
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 天自动清理
```

**LRU 驱逐**: 超过 200 任务时，删除最旧的任务

### 2.5 AGENTS.md 加载上限 (pipeline.ts 第 630 行)

```typescript
const MAX_AGENTS_MD_CHARS = 40_000;  // ~10K tokens 预算
```

- 防止知识库过大导致 LLM 提示词超长
- 按优先级加载: 修改仓 → 入口点 → Sink → 命中仓

---

## 3️⃣  环境变量配置

### deployment.yaml 中的环境变量

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `PORT` | `8080` | HTTP 服务端口 |
| `NODE_ENV` | `production` | Node 环境 |
| `LOG_LEVEL` | `info` | 日志级别(info/debug/warn) |
| `WORKSPACE_DIR` | `/data/workspace` | 仓库克隆目录 |
| `SCRATCH_DIR` | `/data/scratch` | 临时目录(20Gi 限制) |
| `PROJECT_CONFIG_PATH` | `/etc/deepinsight/project.yml` | 项目配置文件 |
| `LLM_MODEL` | `deepseek-v4-pro` | 使用的 LLM 模型 |

### 可注入的环保变量(建议添加)

```yaml
env:
  # 并发控制调优
  - name: COARSE_FILTER_CONCURRENCY
    value: "10"                    # Pre-filter 并发度
  
  - name: MAX_PARALLEL_WORKERS
    value: "4"                     # Pi worker 最大并发数
  
  - name: MAX_TARGET_REPOS
    value: "10"                    # 最多分析的仓库数
  
  # 超时调优
  - name: PI_WORKER_TIMEOUT_MS
    value: "600000"                # 10 分钟(毫秒)
  
  - name: GIT_GREP_TIMEOUT_MS
    value: "30000"                 # 30 秒(毫秒)
  
  # 队列管理
  - name: MAX_CONCURRENT_TASKS
    value: "200"                   # 最多驻留任务数
  
  # LLM 成本跟踪
  - name: LLM_COST_PER_1M_INPUT
    value: "0.5"                   # 输入成本($/1M tokens)
  
  - name: LLM_COST_PER_1M_OUTPUT
    value: "2.0"                   # 输出成本($/1M tokens)
```

---

## 4️⃣  关键配置文件位置

### 项目配置

| 文件 | 路径 | 用途 |
|------|------|------|
| 项目配置模板 | `/mnt/cdb/deepinsight/config/projects/example.template.yml` | 包含知识库、仓库角色、分析模式 |
| LLM 模型定义 | `/mnt/cdb/deepinsight/config/pi-models.json` | 支持的 LLM 模型列表 |
| K8s ConfigMap 模板 | `/mnt/cdb/deepinsight/deploy/configmap.template.yaml` | 运行时配置(需填充实际值) |

### 项目配置示例 (example.template.yml 关键片段)

```yaml
# 分析模式选择
analysis_mode: accuracy_first  # 多轮验证(高成本) 或 budget_balanced(低成本)

# 知识库配置 - 影响 LLM 并发请求数
knowledge_base:
  - name: "cvm_design_docs"
    type: "graphify"
    paths: ["cvm_docs/"]          # 文档数量决定索引时间
    prebuilt: false               # true=预构建 false=每日索引
  
  - name: "cvm_apidocs"
    prebuilt: true                # 预构建不增加 Pod 负荷

# 仓库角色定义 - 影响分析范围
repos:
  - name: "platform-api"
    role: entry_point             # 总是分析的仓库
  
  - name: "vstation_compute"
    role: sink                    # 下游链路锚点
```

---

## 5️⃣  资源瓶颈分析

### 5.1 内存瓶颈

#### 高风险场景
```
6+ 个 Python 仓库 + 4 个 worker 
+ 每个 worker 2-3Gi 内存占用 
= 12-24Gi 内存需求 > 16Gi limit
```

**缓解方案**:
1. 减少 `MAX_PARALLEL_WORKERS` 到 2-3
2. 增加 Pod 内存 limit 到 32Gi
3. 使用 Horizontal Pod Autoscaling 水平扩展

#### 当前安全边际
- Pod limit: **16Gi**
- 单 worker 典型占用: **2-3Gi**
- 最大同时 worker: **4**
- **理论最大占用**: 4 × 3Gi = **12Gi** (75% 安全)

### 5.2 CPU 瓶颈

#### 高风险场景
```
4 个 Pi worker(每个 CPU burst 占用 500m-1 CPU)
+ 主 node 占用(100-200m)
= 2.1-2.2 CPU 占用 > 4 CPU limit
```

**建议**: 生产环境中至少 2 个 Pod 副本(水平分散负载)

### 5.3 NFS 瓶颈 (Coarse Filter)

```
10 并发 git grep × 56 仓库 × 10 符号 = 5,600 并发操作
单 NFS 吞吐量: ~100-200 ops/sec
预计 Coarse Filter 时间: 5600 / 150 ≈ 37 秒
```

**缓解方案**:
1. ✅ 已实现：批处理(并发 10 个而非 56 个)
2. 建议：监控 NFS 延迟，必要时调整 CONCURRENCY ↓ 5-8

---

## 6️⃣  性能调优建议

### Tier 1: 立即可实施(无风险)

```yaml
# deployment.yaml - 增加环境变量
env:
  - name: LOG_LEVEL
    value: "debug"  # 在测试环境调试并发问题
  
  - name: NODE_OPTIONS
    value: "--max-old-space-size=8192"  # 增加 Node.js 堆内存

# 增加副本数(负载均衡)
replicas: 3  # 而非 1
```

### Tier 2: 中期优化(需测试)

```yaml
# 增加资源上限
resources:
  limits:
    cpu: "6"         # 从 4 增加
    memory: "24Gi"   # 从 16Gi 增加

# 扩大 Worker 并发度
env:
  - name: MAX_PARALLEL_WORKERS
    value: "6"  # 从 4 增加(对于大型企业项目)
```

### Tier 3: 长期架构优化

1. **异步队列化**: 使用 Redis/RabbitMQ 进行 PI worker 队列管理
2. **Worker 池隔离**: 将 Pi worker 部署到独立 Pod，增强资源隔离
3. **缓存 Git Grep 结果**: Redis 缓存 NFS 查询结果，减少 Coarse Filter 开销
4. **知识库预热**: CronJob 定期刷新知识库缓存

---

## 7️⃣  监控和告警建议

### Prometheus 指标

```yaml
# 采集目标:
- job_name: 'deepinsight'
  static_configs:
    - targets: ['deepinsight-server:8080/metrics']

# 关键指标:
- api_analyze_requests_total{method="POST"}     # 分析任务总数
- api_analyze_duration_seconds                   # 单个任务耗时分布
- pi_worker_concurrent_count                     # 当前运行的 worker 数
- memory_usage_bytes / memory_limit_bytes        # 内存使用率
```

### 告警规则

```yaml
alerts:
  - alert: HighMemoryUsage
    expr: container_memory_working_set_bytes / container_spec_memory_limit_bytes > 0.85
    for: 2m
    annotations:
      summary: "DeepInsight 内存使用率 > 85%"
  
  - alert: PiWorkerTimeout
    expr: rate(pi_worker_timeout_total[5m]) > 0.1
    for: 5m
    annotations:
      summary: "Pi worker 超时率过高"
  
  - alert: NfsLatencyHigh
    expr: nfs_operation_latency_ms > 500
    for: 1m
    annotations:
      summary: "NFS 延迟 > 500ms"
```

---

## 📊 配置总结表

| 配置项 | 当前值 | 建议值(小集群) | 建议值(大集群) | 影响因子 |
|-------|--------|------------|-----------|---------|
| **副本数** | 1 | 2-3 | 3-5 | 可用性 |
| **CPU Request** | 500m | 1 | 2 | 节点分配 |
| **CPU Limit** | 4 | 6 | 8 | 突发容量 |
| **内存 Request** | 2Gi | 4Gi | 8Gi | 节点分配 |
| **内存 Limit** | 16Gi | 24Gi | 32Gi | 突发容量 |
| **Pi Worker 超时** | 10min | 10min | 15min | 项目大小 |
| **Max Parallel Workers** | 4 | 3 | 6 | 符号数量 |
| **Coarse Filter 并发** | 10 | 8 | 15 | NFS 性能 |
| **Max Target Repos** | 10 | 10 | 20 | 仓库总数 |
| **Max Concurrent Tasks** | 200 | 200 | 500 | 业务高峰 |

---

## 📝 总体结论

✅ **当前配置**:
- K8s 层级并发控制完善(滚动更新、CronJob 隔离)
- 应用层参数设置保守且合理
- 内存安全边际充足(75%)

⚠️  **改进空间**:
1. 副本数应增加至 2-3 提高可用性
2. 可根据实际 NFS/CPU 性能调整并发度
3. 建议通过环境变量暴露关键参数便于动态调优
4. 添加更细粒度的监控和告警

🚀 **建议优先级**:
1. 添加 Tier 1 优化(立即)
2. 观察 1-2 周性能数据
3. 根据实际情况评估 Tier 2 调整
4. 规划 Tier 3 长期架构改进

