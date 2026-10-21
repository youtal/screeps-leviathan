# 模块设计：segments（整页覆盖写入）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/kernel/segments/` |
| 架构章节 | 6.8 Segment 冷存储；附录 A F9 |
| 成熟度 | 整页覆盖写入定稿 · M1；读调度与分片 store 定稿 · M5（不在本文范围） |

## 1. 职责与范围

segments 是 kernel 内部模块，是除 kernel.memory 外唯一访问 `RawMemory.segments` 与 `RawMemory.setActiveSegments` 的模块（架构 4.2）。M1 只提供**整页覆盖**语义的 store：使用方每次提交一页的完整内容，segments 负责页头、页号归属、体积检查与跨 tick 写回调度。

M1 的使用方都在 kernel 内部：

| store | 页号 | 使用方 | 优先级 |
| --- | --- | --- | --- |
| `backup` | 80–89 | bootPort（Memory 备份，见 [bootPort](./bootPort.md)） | 高 |
| `stats` | 50 | kernel.stats（[stats](./stats.md)） | 低 |

本文的接口是 kernel 内部接口，不进入 contracts。`ModuleContext.segments`（`SegmentStore`、`PENDING`，6.8）随第一个使用 segment 的业务模块加入（[contracts](../contracts/README.md#7-待加入的接口)），届时在 M5 的读调度上实现。

## 2. 平台事实

| 事实 | 处理 |
| --- | --- |
| 100 页 × 100 KB（字符数），页号 0–99 | 体积检查以字符串长度计 |
| 同时最多激活 10 页，激活在下一 tick 生效并保持到再次调用；激活集中的页每 tick 都被载入 | 只有本模块调用 `setActiveSegments`；每 tick 至多调用一次；读过的页在下一次提交时退出激活集（第 5 节） |
| tick 结束时 `RawMemory.segments` 中的每个键都被保存，**包括本 tick 读到的激活页**；键超过 10 个、页号非法、值不是字符串或超过单页上限时，driver 在收尾阶段抛错，**整个 tick 的结果被丢弃**：intent、Memory 文本、segment 写入与激活请求全部丢失 | 读完激活页后从 `RawMemory.segments` 删除这些键；写出页数加上残留的键数不超过上限（第 5 节的不变量） |
| 写入不要求该页处于激活状态：driver 在用户代码结束后遍历 `RawMemory.segments` 的全部键保存，不检查激活集；tick 开始时载入的激活页也是这些键 | 已在严格平台模拟中建模；私服中由场景 boot-judgment 的备份写出与回读覆盖，官服确认列在架构 15.1 |

平台依据：driver 的 [runtime.js](https://github.com/screeps/driver/blob/master/lib/runtime/runtime.js)（segment 载入与收尾保存）、[make.js](https://github.com/screeps/driver/blob/master/lib/runtime/make.js)（激活集只在本 tick 调用过 `setActiveSegments` 时更新）、[data.js](https://github.com/screeps/driver/blob/master/lib/runtime/data.js)（每 tick 按激活集载入页面）。

## 3. 页格式

每页为一行页头 JSON、一个换行符、正文：

```
{"v":1,"o":"backup","g":75012345,"e":3,"i":0,"n":4}
<正文>
```

| 字段 | 含义 |
| --- | --- |
| `v` | 数据版本（6.8），由使用方在取得写入器时给出：backup 为 1，stats 由 stats 模块设计规定。页格式本身由页头字段集合识别，M1 不单独编号 |
| `o` | owner，即 store 名；与页号分配表不符的页视为不属于该 store |
| `g` | generation：该次提交的批次号，由使用方给出（备份取快照 tick） |
| `e` | epoch：写出时项目标记的 `epoch`；与当前不一致的页视为空页（重生不清除 segment，F5） |
| `i`、`n` | 多页批次中的序号与总页数；单页 store 为 0 与 1 |

正文不做 JSON 编码，原样拼在换行符之后，避免转义放大体积；页头本身不含换行符。

## 4. 接口（kernel 内部）

```ts
interface SegmentsHost {
  beginTick(): void;                                   // 读取上一 tick 激活的页，随后从 RawMemory.segments 删除这些键
  writer(store: 'backup' | 'stats', version: number): PageWriter; // 只能写本 store 的页；version 写入页头 v
  reader(store: 'backup'): PageReader;                 // M1 只有备份校验需要读
  pending(): number;                                   // 全部 store 尚未写出的页数，供 stats 观测写回积压
  commit(): void;                                      // commit 阶段每 tick 一次：调度写回、提交激活请求
}

interface PageWriter {
  submit(page: number, batch: { g: number; i: number; n: number }, body: string): SubmitResult; // 覆盖该页的待写内容
  pending(): number;                                   // 尚未写出的页数
}

type SubmitResult = 'queued' | 'too-large' | 'not-owned';

interface PageReader {
  request(pages: readonly number[]): void;             // 登记激活请求，下一 tick 可读
  read(page: number): { header: PageHeader; body: string } | 'pending' | 'empty';
}
```

- `submit` 不抛错（6.8 安全规则 4）：页号不属于该 store 返回 `not-owned`，页头加正文超过单页上限返回 `too-large`，均经告警端口报告一次。同一页再次 `submit` 覆盖尚未写出的内容。
- `read` 对页头缺失、无法解析、owner 不符或 epoch 不一致的页返回 `empty`。
- 创建时由宿主注入平台端口、告警端口、bucket 读取函数与 epoch 读取函数。epoch 读取函数取最近一次合法项目标记的 epoch（kernel.memory 的 `epoch()`，[memory](./memory.md)），Memory 不可用时为 0；`read` 校验与写出页头时调用它，因此 boot 在本 tick 清空后，本 tick 写出的页即使用新的 epoch。它不读 heap 中的 `sys`：boot 写入的非法标记被隔离、或 Memory 提交失败时，heap 中的值没有持久化，页头若采用它，之后的实例会把这些页当作空页。kernel 先提交 Memory 再提交 segments，所以同一 tick 经 `sys` 合法写入并提交成功的 epoch 也在本 tick 的页头上生效。

## 5. 写回调度

- **键数不变量**：`commit()` 结束时 `RawMemory.segments` 中的键都是合法页号、值都是不超过单页上限的字符串，键数不超过 10。违反时整个 tick 被丢弃（第 2 节），所以 `commit()` 在写出前检查残留的键（读后删除失败或其他来源），按剩余名额减少写出页数，并经告警端口报告；kernel 其他模块不得向 `RawMemory.segments` 写入键（4.2 已禁止）。
- **每 tick 上限**：写出页数不超过 `SEG_WRITES_PER_TICK`（默认 5），且写出页数加上本 tick 残留在 `RawMemory.segments` 中的键不超过 10。
- **顺序**：先按 store 优先级（backup 高于 stats），同优先级按变脏时长，避免饿死。
- **bucket 门槛**：低优先级 store 在 bucket 低于 `SEG_LOW_BUCKET`（默认 1000）时推迟写回；backup 不受限制，因为它挡在不可逆操作前面。
- **最小写回间隔与合并**：6.8 要求每个 store 设最小写回间隔以合并写入。整页覆盖时，同一页再次 `submit` 直接覆盖尚未写出的内容，合并自然发生；写回频率由使用方的提交频率决定：backup 每次备份只提交一批，stats 的提交间隔由 stats 模块设计规定。segments 不另设间隔参数。
- **序列化 CPU**：正文由使用方序列化后以字符串提交，segments 只拼接页头，没有需要设上限的序列化开销；写出成本由每 tick 写出页数限制。
- **激活请求**：`commit()` 汇总各读取器本 tick 登记的页，最多 10 页，调用一次 `setActiveSegments`。判断依据是 `beginTick` 实际观察到的载入页：载入页集合与本 tick 的请求不同就调用，没有请求时提交空列表，使读过的页退出激活集（6.8）；两者相同时不调用。以实际载入为准而不是以 heap 中记录的上次请求为准，所以撤销激活的那个 tick 即使被驱动丢弃，下一 tick 仍会再次撤销。
- **失败语义**：写入只有在 tick 被驱动接受后才生效。整页覆盖的 store 不依赖“上次写入成功”，需要确认的使用方（备份）用 `PageReader` 回读校验。

## 6. 安全规则对应

| 6.8 安全规则 | 本模块的处理 |
| --- | --- |
| 1. owner 与分配表不符的页拒绝写入 | `PageWriter` 只接受本 store 的页号；`read` 校验页头 owner |
| 2. epoch 不一致的页视为空页 | `read` 返回 `empty`；写出时页头取当前 epoch。epoch 从 1 开始时可能与旧页相同，见 [bootPort](./bootPort.md#3-操作) 的“epoch 的起点” |
| 3. 未成功加载过的页禁止写入 | 整页覆盖 store 例外（6.8），M1 只有整页覆盖 store |
| 4. 写入前检查体积，超限执行溢出策略，不允许抛错 | `submit` 返回 `too-large`，由使用方处理（备份判为失败，统计自行裁剪） |

## 7. 状态与成本

- heap 中保存待写页（每页最新一份）、激活请求与本 tick 读到的页；随 kernel 实例存在，软重置与 global reset 后清空。backup 的待写页最多 10 × 100 KB。
- 每 tick 固定成本：检查 `RawMemory.segments` 的键与待写队列。写出成本与页长度成正比，只发生在有待写页的 tick。读过的页及时退出激活集，所以平时没有激活页，不产生载入成本。
- 当前 epoch 经创建时注入的读取函数取得（第 4 节）。

## 8. 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `SEG_PAGE_LIMIT` | 102400 字符 | 平台单页上限 |
| `SEG_WRITES_PER_TICK` | 5 | 每 tick 写出页数上限，给其他 store 与激活页留余量 |
| `SEG_LOW_BUCKET` | 1000 | 低优先级 store 推迟写回的 bucket 门槛 |

## 9. 验证

单元测试用严格平台模拟（`test/platform/memory.ts`）覆盖：页头与正文格式、owner 与 epoch 校验、同 tick 清空后写出页使用新 epoch、超限返回值、每 tick 写出上限与“已读页 + 写出页 ≤ 10”、残留键时减少写出页数且平台不报错、优先级与变脏时长排序、bucket 推迟、激活请求在下一 tick 可读、读后删除激活键、读过的页在下一次提交时退出激活集（撤销的 tick 被丢弃时下一 tick 重新撤销）、激活集不变时不调用 `setActiveSegments`。真实引擎中的写入语义与回读由私服场景 boot-judgment 的备份流程验证。
