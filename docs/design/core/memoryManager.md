# MemoryManager 设计方案

交付状态：访问与申请类型契约已交付；模块目录已建立；存储实现、分配、迁移与生命周期接入未交付。

MemoryManager 定位为独立的 `core/memoryManager` 模块，由 Runtime 统一组装并由 Framework 驱动，遵循 [Core 架构原则](./README.md)。接口约定由 `src/contracts/memory.ts` 发布，使用状态见 [使用说明](../../usage/core/memoryManager.md)。

## 1. 目标及固定边界

仅使用固定的 10 个 Segment，初始规划为 ID `0..9`，持续请求激活，不调度剩余 90 个页。按照既有 API 约束，10 个页提供约 1 MB 的额外容量，但单页仍限 100 KB；主 Memory 与 Segment 是不同存储容器。

明确提供 `priority` 的初始申请按降序竞争 10 个槽位；没有 priority 或未进入前十者使用主 RawMemory。该参数表示独立存储分配优先级，适合频繁写入的模块。高频只读本身不引起 dirty，不能据此推断 Segment 一定更省 CPU。它与 Framework 执行优先级及 `critical/checkpoint` 提交策略独立。

仅在 global reset 后的启动阶段重新规划、抢占及搬迁。前十内部次序变化不交换 Segment ID，仍合格的所有者保留原页。分配完成后本 global 冻结；运行期热插拔不释放、重排或抢占槽位。

参考 API：[中文 RawMemory](https://screeps-cn.github.io/api/#RawMemory)、[官方 RawMemory](https://docs.screeps.com/api/#RawMemory)。固定激活不免除首次请求的下一 tick 加载延迟；主 Memory 与 Segment 之间没有可依赖的联合事务承诺。

## 2. 申请身份及公共契约

每份申请必须有确定且跨 global 稳定的身份。默认由 Framework 注入 `pluginId`，支持多个 Accessor 时由模块提供 `localMemoryId`，使用二元组作目录键。局部 ID 可默认 `main`。不采用随机数、注册序号、函数名或构建 hash 作为持久身份。

公共协议设计：

```ts
type MemoryPendingReason =
  | 'loading'
  | 'segment-activating'
  | 'migration'
  | 'recovery'
  | 'verification';

type MemoryAccess<M> =
  | {
      status: 'pending';
      reason: MemoryPendingReason;
      retryAt: number;
    }
  | {
      status: 'ready';
      query(): DeepReadonly<M>;
      commit<R>(mutator: (memory: M) => R): R;
    };

interface MemoryAccessor<M> {
  access(): MemoryAccess<M>;
}
```

模块通过作用域内 `applyMemoryAccessor<M>(localId, options)` 获取稳定句柄。`MemoryApplicationOptions<M>` 包含可选 `priority`、正整数 `version`、`initialize(): M`、可选 `migrate(memory: unknown, fromVersion: number): M`、`layer` 和可选 `checkpointInterval`。迁移调用者负责校验未知旧数据。priority 缺省表示不竞争 Segment，显式 `0` 仍参与，不能用真值判断；只接受有限数值。同分按稳定身份排序，不依赖申请顺序。

`query()` 返回 heap 数据的类型级深只读视图，不引入递归 Proxy 或默认深克隆。`commit()` 在回调之前标脏、原地更新并返回回调结果；回调须同步，返回值不表示已落盘，也不表示有事务回滚。回调抛错可能留下部分修改，dirty 保留。

相同身份及相同声明的重复申请返回同一 Accessor；配置冲突拒绝。初始化/迁移回调不能靠比较函数源码认定相同；允许的重复声明规则须由实现明确验证。TypeScript 泛型不能验证存储内容，版本和运行时校验仍不可缺少。

## 3. 模块等待行为：强制开发约束

指定 priority 的模块必须正确处理 `pending`，因为其历史数据可能位于尚未可见的 Segment。`retryAt` 是建议下次尝试的 Game.time，不承诺那个 tick 一定 ready。

模块仅跳过依赖该 Accessor 的行为，其他活动继续；Framework 不因此禁止该插件全部 Intent、跳过其所有钩子或增加失败计数。

```ts
onTickExecute(context) {
  observeCurrentWorld(context);

  const access = stateAccessor.access();
  if (access.status === 'ready') {
    runMemoryDependentPlan(access.query(), context);
    access.commit((state) => {
      state.lastTick = context.tick;
    });
  }

  runIndependentWork(context);
}
```

Accessor 可以跨 tick 持有；`MemoryAccess` ready 句柄及其数据引用只用于当 tick。下一 tick 重新调用 `access()`，不得以旧引用绕过 pending；实现应为 ready 句柄校验 tick/绑定有效性。多个 Accessor 独立报告状态。

在 setup 中申请后返回 pending，不能假定 Framework 会重跑 setup：模块应保存句柄，在后续 tick 重试依赖 Memory 的初始化，只执行一次成功初始化。申请本身必须先于这一等待判断完成。

真正的数据损坏、未知 schema 或归属冲突必须提供错误诊断，不能无恢复进展地永久报告“下 tick 再试”。最终错误出口需在落地协议中明确；未就绪时禁止写空数据覆盖历史状态。

## 4. 首 tick 收集及稳定 heap 分区

启动时 MemoryManager 读取目录并申请固定 Segment。模块调用申请接口时：

| 已有状态 | 处理 |
| --- | --- |
| 目录指向 RawMemory | 恢复该身份的有效数据 |
| 目录指向已加载 Segment | 校验 owner、generation 和数据版本后恢复 |
| 目录指向未加载 Segment | 返回 Accessor，access 报 pending，后续 tick 加载 |
| 确认没有历史数据 | 在 heap 创建新分区，初始化成功即可 ready，后端暂未决定 |
| 存在未完成迁移 | 按 journal 判断有效源，不能只根据正式目录读取 |

Accessor 始终间接访问内部 Partition。后端未决定不代表逻辑数据不可用。目录缺项若与 Segment 信封或 journal 冲突，应恢复/报错而非认作新模块。

所有用户 tickEnd 完成后，Memory 的专用收尾阶段封存申请并计算前十。完整性的保证来自契约：初始模块必须在受保证执行的启动申请阶段申请；不能依赖 CPU 准入、延迟业务条件或 Memory ready 后才申请。

申请须发生在工厂阶段或保证执行的初始化入口，不受普通业务的 CPU 准入与依赖等待影响；若首 tick 未完成全部申请，不能错误封存，必须继续启动窗口。普通业务是否执行与申请收集是否完成分开判断。

窗口关闭后的新申请使用 RawMemory。已存在身份的重新申请继续使用其冻结分配；不能因热卸载再注册而切换后端。卸载保留数据、归属和已 dirty 的待提交状态，按原策略处理。临时插件代码不会被持久化，下一 global 只有再次装配/申请的插件才参与排名。

## 5. 数据布局与职责

主 RawMemory 保存小型控制目录、Raw 后端分区及必要迁移暂存：

```text
MemoryManager namespace
├── schemaVersion
├── allocations[pluginId][localId]
│   └── backend / segmentId? / generation
├── rawPartitions[pluginId][localId]
│   └── dataVersion / payload
└── migrationJournal
    └── source / target / phase / generation / staging
```

Segment 保存信封：

```ts
interface SegmentEnvelope<M> {
  schemaVersion: number;
  owner: { pluginId: string; localMemoryId: string };
  generation: number;
  dataVersion: number;
  payload: M;
}
```

Segment 中的数据版本与 payload 一起写入，避免每次升级还要求同时更新主 Memory 中的版本。Framework 健康状态和 Profiler 数据是独立消费者的 schema，MemoryManager 不硬编码其字段。

多 Accessor 情况下，建议每份显式 priority 的申请竞争一个槽位，最多 10 个申请而不保证 10 个不同插件。这是“模块可申请多份”后的必要细化；若希望严格一插件一页，应限制每插件至多一个 priority 申请。该选择需在实现前固定，不能隐式改变分配粒度。

## 6. 提交与 dirty

- `critical`：正常 tick 收尾提交本 tick 变化。
- `checkpoint`：从首次 dirty 开始计时，后续修改不延后期限；可沿用默认 100 tick，间隔 1 当 tick 提交。
- Raw 后端：只序列化到期 dirty 分区，clean 分区复用字符串片段，最终仍拼装完整 RawMemory。
- Segment 后端：只序列化对应分区信封，写入对应 Segment，不因普通 payload 更新重写主目录。
- 迁移与版本更新有独立的强制持久化要求，不能被普通 checkpoint 延迟破坏恢复协议。

只有本地编码和存储端口接受写入后才推进本地基线与 dirty 状态；这不等于获得远端数据库持久化确认。Segment tick 末保存的失败/硬终止语义须在目标环境测试，迁移依赖后续 tick 重读验证。

写入失败保留 dirty。不同 Segment 尽量独立处理序列化错误；一个主 RawMemory 候选字符串生成失败则该次整串提交失败，不能清除其中分区 dirty。不以跨后端联合原子性作为任何业务保证。

## 7. 启动分配与可恢复迁移

启动阶段可以跨多个 tick，固定槽位免除了动态激活调度，但不会消除搬迁一致性问题。

```text
恢复既有 journal / 收集申请
→ 冻结申请、规划目标分配
→ 复制与验证
→ 切换正式目录
→ 延迟清理
→ READY（本 global 分配冻结）
```

新 reset 若发现未完成 journal，先恢复它，再按本轮已收集申请规划新分配；不能并行启动相互覆盖的迁移。已经写出的步骤须可重复执行，以 generation 和阶段信息判定。

抢占示例：A 从 Segment 3 迁出，B 从 RawMemory 迁入。

1. 预检主 Memory 暂存和 Segment 目标容量，持久化计划及 A 的可恢复副本，保留原 Segment。
2. 后续 tick 验证 A 副本及 journal；确认即使覆盖 Segment 3，恢复过程仍能找到 A。
3. 将 B 信封写入 Segment 3，保留 B 的 Raw 副本。
4. 后续 tick 重读 Segment 3，验证 owner、generation、数据版本及必要的内容校验。
5. 提交正式目录：A 归 Raw、B 归 Segment。此后按新目录解析；journal 仍支持中断恢复。
6. 确认目录提交后再删除 B 旧副本与暂存/journal。

在第 3～5 步，正式目录可能仍指向旧 Segment，因此恢复逻辑必须优先解释 journal。只保留副本而恢复时不查 journal，仍然会造成错误读取。

迁移对象若继续 commit，会使快照失效。首版建议仅将正在复制/切换的 Accessor 设为 pending，冻结其修改直到目录提交；其他 Accessor 和模块独立行为照常执行。不采用无版本追踪的“边搬迁边任意修改”。未来若支持在线修改，须增加修订号和重复制/双写协议。

新分区若目标 Segment 尚不可用，可以先用有日志记录的 Raw 暂存副本承接首 tick 数据；这属于明确的迁移源，不是遇到历史 Segment 未加载时临时创建另一份空数据。若暂存空间不足，保留现有有效数据、报告阻塞，不能覆盖唯一副本。

## 8. 容量、外部兼容与失败恢复

每页 100 KB 包含信封开销，不能将 10 页容量自动合并给一个模块。目标页超限应拒绝写入并保留旧数据；不在运行期自动拆页或改变分配。迁入前不满足容量时，报告规划不可执行，具体人工降级规则需在实施时明确。

容量计量口径属于待决设计事项：须验证目标 Screeps 运行时对主 Memory 和 Segment 使用的字符串长度/字节限制；不能未经核实固定 `TextEncoder` 计量或假定其全局可用。

首次使用 `0..9` 前须检查既有内容，不能把其他工具的数据当作可覆盖空槽。只有本模块已经认领或明确初始化授权的页可写；配置冲突应明确报告。

运行中仍以已恢复的 heap 数据为事实源，不自动合并控制台外部编辑。工具若修改存储，需要遵守 owner/generation/journal 协议并通过受控重载接纳；global reset 本身不修复不一致的外部编辑。

首次从旧 `Memory.leviathan` 布局切换，需要独立兼容迁移，保护插件数据、Profiler 和健康状态，并保留无关根字段。升级策略及回退能力在实施前验证，不直接覆盖旧 schema。

## 9. 性能与 heap 生命周期

首次加载解析需要的分区；稳态复用 heap 对象，不每 tick 重复解析。Segment 写入减少主 Memory 整串重组，但固定加载也有宿主成本，实际 CPU 收益通过目标环境测量。

常驻数据包括 Partition、目录、Accessor 以及 Raw 分区字符串；迁移副本、JSON 编码临时对象和输出字符串影响峰值 heap。仅为可重建缓存节省 CPU 时优先 heap，不为填满 10 个槽位强行持久化数据。

可用 `Game.cpu.getHeapStatistics()` 观察解析、编码、搬迁前后趋势。不要把单次差值当作精确插件占用，也不要把 `total_available_size - externally_allocated_size` 当作官方剩余内存公式。独立 heap 监控设施不属于本模块交付范围。

## 10. 实现划分与验证要求

建议内部按申请/Accessor、分配目录、Raw 后端、Segment 后端、迁移恢复划分；具体文件数量以实现复杂度决定。对外导出工厂和契约，Framework 只驱动生命周期，Runtime 管理唯一实例。

落地验证应覆盖：

- priority 缺省、0、同分及超过 10 个申请；全局重启前后确定性。
- 重复 ID、重复配置冲突、稳定 owner 注入及插件重新注册。
- 首 tick Segment 不可见；pending 后局部活动继续；setup 不自动重跑。
- 收集未完成时不得封存；窗口后申请不能抢占；前十内部重排不搬页。
- 每一迁移步骤之后注入 reset/写入失败，确认至少一个有效副本且恢复不读错 owner。
- 迁移期间访问冻结、旧 ready 句柄跨 tick 失效、checkpoint dirty 期限。
- 单页超限、主 Memory 暂存不足、坏 JSON、未知版本、页被其他工具占用。
- clean tick、独立 Segment dirty 不触发主 RawMemory 重组、串行化失败后重试。
- 旧 schema 迁移及无关根数据保留；目标环境真实 tick 末保存和容量口径。

单元桩必须模拟 Segment 下一 tick 可见及 tick 末保存，而非将字符串赋值当作立即远端落盘。代码实现完成后按根 AGENTS.md 完成类型检查、测试、无密钥构建和差异检查；部署须另获明确要求。
