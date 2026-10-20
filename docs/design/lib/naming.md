# 模块设计：naming（命名规范）

| 项目 | 内容 |
| --- | --- |
| 源码 | `src/lib/naming/` |
| 架构章节 | 9.2 命名规范、11.3 `sig(name)`、11.5 跨 shard 判定、11.6 认领、5.7 保底名称 |
| 成熟度 | creep 名称定稿 · M1；spawn 名称词库定稿 · M2，随第一个建造 spawn 的使用方交付（第 4 节） |

## 1. 职责

正常流程创建的 creep 的名称格式化与校验，以及 spawn 名称词库（第 4 节）。只做无状态的格式化、解析与校验；序号分配、重名检查与解析结果的缓存由调用方负责（9.2：分配器属于 spawnQueue，heap 中按名称复用解析结果）。

## 2. 名称格式

```text
<前缀>-<来源 shard>-<出生用途>-<目标 shard>-<出生 tick 的 base36>.<同 tick 序号的 base36>-<校验位>
```

| 字段 | 规则 | 说明 |
| --- | --- | --- |
| 前缀 | 小写字母开头，最多 8 个小写字母或数字 | 项目标识，来自运营配置 |
| 来源 shard、目标 shard | 1–16 个字母或数字 | 身份用的 shard 名（11.3 的 `here`）：官服 `shard0`–`shard3`、`shardSeason`；私服为 `x`，不使用 driver 注入的主机名（F7）；不跨 shard 时目标为 `x` |
| 出生用途 | 小写字母开头，最多 4 个小写字母或数字 | 恢复与观察提示 |
| 出生 tick | 规范 base36（小写、无前导零），非负安全整数 | 完整的 `Game.time`，不取模 |
| 同 tick 序号 | 规范 base36，非负安全整数 | 该 shard 全部 spawn 的孵化共享 |
| 校验位 | 单个 base36 字符 | `hashString(校验位之前的全部文本 + salt) % 36`（[hash](./hash.md)） |

- **分隔符**：字段之间为 `-`，tick 与序号之间为 `.`；各字段的字符集都不含这两个字符，所以按 `-` 切分恰好得到 6 段。
- **规范形式**：每个字段只接受一种写法，`formatName(verifyName(n)) === n`。同一组字段只对应一个名称，唯一性由来源 shard、出生 tick 与序号的组合保证（9.2），不依赖校验位。
- **长度**：例如 `lv-shard0-hv-x-18nrw9.2-` 加一位校验位，共 25 个字符。名称是实体空间的键，长度直接计入 Memory 体积，因此前缀与用途都限制为短代码。
- **保底名称**：`fb-<来源 shard>-<tick>-<序号>`（5.7）只有 4 段，总是不能通过校验，符合"应急前缀不作为签名证据"。

## 3. 接口与用法

```ts
interface NamingKey { readonly prefix: string; readonly salt: string }
interface NameFields {
  readonly source: string; readonly purpose: string; readonly target: string;
  readonly tick: number; readonly seq: number;
}

formatName(key: NamingKey, fields: NameFields): string            // 字段非法时抛 TypeError
verifyName(key: NamingKey, name: string): NameFields | undefined  // 11.3 的 sig(name)；不抛错
```

- `NamingKey` 由 app.config 提供，经装配传给 spawnQueue 与 app.boot。salt 区分项目：其他使用同一格式的代码，即使前缀相同，校验位一般也不符。
- `verifyName` 只检查名称本身：前缀为本项目、各字段符合规范形式、校验位正确。跨 shard 判定（11.5 的 E_name⁺、E_name）读取返回值中的来源与目标 shard；用途只作辅助线索，不能代替 core 中的角色与任务（9.2）。
- 校验位只有 36 种取值，外来名称恰好通过的概率不超过 1/36，且须同时满足前缀与全部字段格式。所以 11.6 的 σ 按比例统计，不依赖单个名称。

## 4. spawn 名称词库

spawn 名称不使用上面的签名格式，从词库中随机抽取（9.2，[提案](../../proposal/2026-10-20-spawn-name-lexicon.md)）。

- **词库**：约 1000 个英文单词，主题与项目名 Leviathan 呼应（深海、航海与神话），首字母大写。每个词只含 ASCII 字母，不含 `-`，所以不会被 `verifyName` 误判为签名名称；不超过 50 个字符，玩家放置首个 spawn 时可以手工输入（backend `place-spawn` 的上限），也满足创建工地时 100 个字符的上限。
- **存储形式**：lib 中的只读常量，一个以空格分隔的字符串，首次需要时才切分并在 heap 中缓存；正常运营放置 spawn 的频率极低，多数 global 不切分。约 8 KB，计入构建产物。
- **只追加、不改序**：已用记录按词的下标保存，词库只在末尾追加新词，不删除、不重排。
- **职责划分**：lib.naming 只提供词库与按下标取词、判断名称是否在词库中；抽取（排除已用、现存与本 tick 预留的名称，`Math.random` 均匀抽取）与已用位图（约 170 个字符，存于本系统 Memory）属于建造 spawn 的流程，词库用尽时清空记录、只排除现存名称。
- **开局**：app.boot 判为 FRESH_START 时，首个 spawn 的名称在词库中则记为已用，否则记录一条 info 提示，不影响判定。

## 5. 成本

`verifyName` 切分一次字符串、执行少量正则匹配并计算一次哈希，约为名称长度的线性成本。正常运行按 core 分组，只在初次发现、启动判定与认领时校验，不在每 tick 的热路径上。

## 6. 验证

单元测试覆盖：格式与往返（500 组字段）、校验位、前缀与 salt 不符、非规范写法（前导零、大写、缺少或多出分隔符、超出安全整数的 tick）、保底名称与外来名称、非法字段与配置。
