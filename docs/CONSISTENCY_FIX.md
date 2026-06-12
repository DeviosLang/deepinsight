# GET 一致性修复（多 Pod stale in-memory）

> 改动：`packages/analysis-service/src/api/analyze.ts`
> 关联问题：外网 LB 多次 GET 同一 taskId 返回结果不一致
> 决策日期：2026-06-12

---

## 1. 现象

外网 `curl http://<EXTERNAL_IP>:8080/api/analyze/<taskId>` 多次访问，
返回的 `status` / `result` 不一致：

- 有时 `status: completed`，有 `result.symbols / test_scenarios`
- 有时 `status: running`，无 `result`

而**进入 pod 内部** `kubectl exec ... -- node -e "...localhost:8080/api/analyze/<id>"` 永远返回 completed 完整版。

---

## 2. 根因（两层叠加）

### 2.1 多 Pod + 共享 NFS + 各自 in-memory cache

deepinsight 用 3 层状态：

```text
Pod A in-memory ─┐
Pod B in-memory ─┤  ← 各 Pod 独立，不互通
                  │
                  ▼  fallback on miss
        NFS task json (单一持久化源)
```

写入：
- 任务运行中：**只更新 owner Pod 的 in-memory**，不写 NFS（progress 不持久化）
- 任务完成时：owner Pod **同时写 in-memory + NFS**

读取（旧版）：
```ts
const task = tasks.get(taskId) ?? readTaskFromDisk(taskId);
```
in-memory 命中就直接用，不交叉验证 NFS。

### 2.2 Pod 启动时灌入"运行中"快照，运行期不再刷新

`loadTasksFromDisk()` 在 Pod 启动时把 NFS 上**所有任务**一次性加载进 `tasks` Map。
关键失败序列：

```text
T0:  Pod B 创建任务 X，NFS 写入 status=queued
T1:  Pod B 任务进入 running，更新自己 in-memory（NFS 未刷新，仍是 queued）
T2:  Pod A 重启（rolling update / OOM 恢复）→ loadTasksFromDisk 把 X 灌入 in-memory，
     但读到的 NFS 仍是 queued/running 旧版
T3:  Pod B 任务完成，**Pod B 自己**写 NFS（status=completed + result）+ 自己 in-memory
T4:  外网 GET 命中 Pod A：tasks.get(X) → 返回 T2 时灌入的旧版 ❌
T4': 外网 GET 命中 Pod B：tasks.get(X) → 返回 T3 时的新版 ✅
```

**Pod A 的 in-memory 永远不会主动从 NFS 刷新**——它只在启动时读了一次。

### 2.3 调试可观测性缺失

旧版 GET 不带响应头标识 Pod，看到不一致也无法定位是哪个 Pod 答的。

---

## 3. 修复（两条独立改动）

### 3.1 X-Pod-Name 响应头（可观测性）

```ts
const POD_NAME = process.env.HOSTNAME ?? process.env.POD_NAME ?? "unknown";

// 在 GET /analyze/:taskId 与 GET /tasks 的 handler 开头：
reply.header("X-Pod-Name", POD_NAME);
```

调试：

```bash
curl -i http://<EXTERNAL_IP>:8080/api/analyze/<id> | grep -i x-pod-name
# X-Pod-Name: deepinsight-server-7c7f6df775-7dk7r
```

### 3.2 GET 时按需交叉验证 NFS（一致性）

新增 `getFreshestTask(taskId)`：

```ts
function getFreshestTask(taskId: string): AnalysisTask | null {
  const inMemory = tasks.get(taskId);
  if (!inMemory) return readTaskFromDisk(taskId);

  // 终止态 — 自己 Pod 写的，可信
  if (inMemory.status === "completed" || inMemory.status === "failed") {
    return inMemory;
  }

  // 非终止态 — 可能是启动时灌进来的旧快照，交叉读 NFS
  const onDisk = readTaskFromDisk(taskId);
  if (
    onDisk &&
    (onDisk.status === "completed" || onDisk.status === "failed") &&
    onDisk.completedAt
  ) {
    // NFS 已是终止态 — 采纳并刷新本地 cache
    tasks.set(taskId, onDisk);
    return onDisk;
  }
  return inMemory;
}
```

---

## 4. 性能与正确性权衡

| 维度 | 修前 | 修后 |
|------|------|------|
| in-memory 命中（终止态） | 直接返回 | 直接返回（不变）|
| in-memory 命中（非终止态） | 直接返回 | **额外读一次 NFS**（< 100KB，内核缓存）|
| in-memory 不命中 | 读 NFS | 读 NFS（不变）|
| 多 Pod 一致性 | 弱（启动后永久 stale） | **强**（每次 GET 自愈） |
| 单 Pod 部署 | 不变 | 不变（in-memory 即真相） |

性能代价：每次 GET 在任务运行中阶段额外 1 次 NFS 读。任务完成后零成本。
NFS 文件已被 Linux page cache 缓存，单次 readFileSync 通常 < 1ms。

---

## 5. 不解决的问题

- **运行中任务的 progress 不一致**：progress 不写 NFS，所以 Pod A 看不到 Pod B 在跑的任务的实时步骤。这是设计取舍——progress 写 NFS 太频繁会产生 IOPS 压力。
- **不同 client 看到不同 progress**：跨 Pod 时仍可能 quueed/running 反复（因为 NFS 上是旧 running 快照而 in-memory 不存在该任务）。需要后续优化（如 sticky session 或 Redis）。

---

## 6. 终极方案（未来）

| 方案 | 何时做 | 说明 |
|------|------|------|
| Service `sessionAffinity: ClientIP` | 短期可选 | 同 client 永远命中同 Pod，不解决跨 client 不一致 |
| 用 Redis 共享 task map | 长期 | 彻底消除 cache 一致性问题，引入新依赖 |
| progress 也写 NFS（带节流） | 中期 | 每 30s 或每个 step 切换写入，运行中任务 GET 也强一致 |

---

## 7. 验证步骤（部署后）

1. 触发一个新任务 `analysis-XXXX`
2. 任务进行中，外网连续 5 次 curl，每次记录 X-Pod-Name 与 status
3. 任务完成后，外网连续 5 次 curl，**所有响应应都是 completed + 完整 result**
4. 跨多个 Pod 也应返回一致结果

```bash
for i in 1 2 3 4 5; do
  curl -sS -D /tmp/h$i -o /tmp/b$i \
    http://<EXTERNAL_IP>:8080/api/analyze/<taskId>
  pod=$(grep -i x-pod-name /tmp/h$i | tr -d '\r')
  status=$(jq -r .status /tmp/b$i)
  has_result=$(jq -r '.result | (.symbols | length) // 0' /tmp/b$i)
  echo "$i  $pod  status=$status  symbols=$has_result"
done
```

期望：5 次都命中 `status=completed`，`symbols` 数一致。

---

## 8. 一句话总结

**GET handler 在 in-memory 是非终止态时**额外查 NFS，
若 NFS 已是 completed/failed 就采纳并刷新本地缓存。
配合 X-Pod-Name 头便于排查，从根上解决"多 Pod 重启后老 in-memory 永远 stale"问题。
