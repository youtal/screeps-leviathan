# M1 官服验证记录

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-21 |
| 代码基线 | `dev` 的 `cb51f01`，版本 `0.1.18` |
| 测试分支 | `test/m1-official-validation`，从上述基线建立；临时日志与夹具不合并进 `dev` |
| 授权范围 | 用户明确指定 pinkpunk 官服账号用于运行验证，可用旗帜等制造场景；本次实际运行测试依该指令执行，不修改章程中的一般发布流程 |
| 目标 | pinkpunk，shard0，W16N8；测试前生效代码分支 `M1` |
| 初始事实 | tick 78458917，RCL1，Spawn1，300 能量，无 creep、无旗帜，CPU limit=100、bucket=10000；NORMAL/strong、健康 ok、Memory ready、epoch=1 |

## 1. 测试夹具与观察入口

本分支只添加调试观察与测试驱动。M1 没有自动发展模块，夹具里的四个模块不代表运营功能：

| 位置 | 内容 |
| --- | --- |
| `src/app/assembly/officialProbe.ts` | 仅 pinkpunk/shard0 且有己方 spawn 时装配；`m1Probe` 记录五阶段与分区计数；`m1Fault` 为单钩子生存层故障靶；`m1Economy` 观察旗帜与实例；`m1Dependent` 为默认暂停的依赖方 |
| `src/app/assembly/index.ts` | 装配夹具，打开 debug、每次提交抽查 4 个未标脏单元、实例 profiler，打印构建与 InterShardMemory 特性检测 |
| `src/app/boot/index.ts` | 完整判定时打印 case、mode、action、paused、hold |
| `src/kernel/lifecycle/index.ts` | 每 20 tick 打印健康、Memory、epoch、CPU 预算与预留、准入计数、模块数、计时标签数与提交失败数 |
| `src/main.ts` | 保底运行时每 20 tick 打印资产数量；原有接管规则不变 |

控制台命令在 shard0 执行：

```js
ops.status()
boot.assess()
m1.help()
m1.status()
m1.profile()
ops.log('debug', false) // 关闭限频调试日志；重新装配后默认打开
ops.log('debug', true)
```

可重复场景：

```js
Game.spawns.Spawn1.pos.createFlag('m1-check') // 创建一个动态实例与旗帜切片
ops.resume('m1Dependent')                   // 下一 tick 运行
ops.pause('m1Economy')                      // 其动态实例与依赖方一起暂停
ops.resume('m1Economy')
ops.unset('m1Dependent')                    // 恢复默认暂停
m1.fault('instance', 12)                    // 仅实例熔断；到期自动恢复
m1.fault('module', 60)                      // 生存层熔断，触发真实保底；到期自动恢复
m1.recover()                               // 提前取消故障并恢复
Game.flags['m1-check'].remove()             // 释放实例；实体切片由 Memory 按生命周期回收
m1.backup()                                // 备份本 kernel 加载时的文本，覆盖 80–89 页旧备份
m1.reset()                                 // 下一 tick 请求软重置
Game.cpu.halt()                             // 强制 global reset，执行前确保前一 tick 已提交
```

故障命令允许 3–100 tick，未到期不能叠加；实例须先有旗帜。生存层连续失败 3 次熔断后，连续 degraded 达到 3 tick 才运行保底，因此测试时长须足够观察。保底可能孵化并驱动真实 creep，正常循环恢复后 M1 没有运营模块接手其工作。

## 2. 本地验证

- `npm run typecheck`：通过。
- `npm test -- --runInBand`：38 suites、496 tests 通过，包含夹具的期限恢复、旗帜删除及备份/软重置集成验证。
- `npm run build`：通过；另在 `/tmp/m1-no-secret-wtx4gstr/` 仅复制源码、构建配置与 package.json、链接已安装依赖，确认没有 `.secret.json` 时同样构建成功。
- `npm run test:scenarios -- --only kernel-smoke`：真实私服引擎通过；夹具限定官服账户，私服运行基线模块清单。
- `npm run test:scenarios -- --only chaos`：真实私服引擎通过，含 global reset、预算 B 105→16、Memory 失效后的保底孵化与恢复。
- `git diff --check` 与文档本地链接检查：通过；本次新增链接没有章节锚点。

首次官服请求被沙箱网络阻止（`fetch failed` / `EAI_AGAIN`），首次私服场景被 Docker socket 权限阻止；按环境权限流程提升后重跑。未经执行的结果不记为通过。

## 3. 官服操作与结果

原始控制台记录、四个 shard 的初始 Memory、原 `M1` 代码与旧备份页保存在本机 `/tmp/m1-official-evidence/`，不提交仓库；该目录属于临时证据，长期复查以本报告记录为准。shard0 原备份页 80–89 均为空。

以下均为真实官服观测，测试模块与人工故障只用于驱动已交付机制：

| 场景 | tick / 证据 | 结果 |
| --- | --- | --- |
| 上传与切换 | 上传 `m1-validation-0.1.18`，main 与 source map 回读一致；随后单独 activate，原 `M1` 分支保留 | 通过 |
| 五阶段、分区与 lib | 78459005：`sense>plan>arbitrate>act>move`，计数 4，setup=1；setup 中 geometry 真实坐标往返、hash 固定向量、naming 往返均无异常 | 通过 |
| 默认暂停与 resume | 78459005：m1Dependent 为 paused、计数 0；resume 后至 78459062 计数 57 | 通过 |
| 旗帜与实例 | 78459005 创建 m1-check 返回名称；78459006 日志确认 `m1Economy:flag` 创建；实例计数开始增长 | 通过 |
| 暂停依赖传播 | 78459062 pause m1Economy；78459066 状态 paused、依赖方 blocked；economy/dependent/instance 维持 61/57/57，m1Probe 从 61 增至 65 | 通过 |
| 生存层暂停保护与 console/errorMapper | 78459062 拒绝暂停 m1Fault；错误被 console 隔离，堆栈映射至 `src/kernel/lifecycle/ops.ts` 的 `set` / `setSwitch`，正文正确转义 | 通过 |
| 实例熔断 | 78459073–75 连续三次预期故障；78459078 `brokenInstances=1`、健康 ok、其他模块计数继续；78459085 自动恢复、setup 仍为 1 | 通过 |
| stats / segments / inspector | 第 50 页 g=78459041：20 tick 全 ok、CPU avg=0.26、max=0.33、finish=0.08、bucket=10000、待写 0；g=78459081 的 breakers=1、健康仍全 ok | 通过；CPU 含探针，只代表所读窗口，统计点不包含其后的 segment 提交、调试日志及入口保底耗用 |
| Memory 落盘 | inspector 读取 `leviathan.part.m1Probe.state`：ticks=59、last=78459060，与持续推进的控制台计数一致 | 通过 |
| 模块缓存修复复验 | 在 78459005 保存 require 引用，78459078 与 78459095 仍为同一引用；timestamp 类型 string，setup=1 | 通过；同一 global 的有限窗口 |
| 故障窗口统计 | 第 50 页 g=78459141：20 tick 全为 degraded、down=[m1Fault]、只准入生存探针，bucket=10000、待写页 0 | 与生存层故障事实一致；此页 CPU 不含入口追加的保底耗用 |
| 生存层故障与保底 | 78459086–88 连续三次故障后熔断；78459095 健康 degraded、依赖方 blocked、入口连续 degraded=8；真实应急 creep 正在孵化；78459186 自动恢复，78459192 健康 ok、入口 degraded=0、setup=1、依赖方继续计数 | 通过 |
| 应急采集与补能 | 应急 creep `fb-shard0-1apnf6-0`；78459141–44 在 (23,5) 的携带能量为 44→46→48→50；78459183→184 在 spawn 相邻格 (21,25)，携带能量 50→0、房间能量 193→244（50 转移 + 1 自然补能）；62 个连续 tick 采样保存为 energy-trace.json | 真实官服一次完整采集、返程、补能通过；未外推长期运营 |
| profiler / context | 78459202：10 个固定计时标签，包含 `m1Economy:flag.act`，上一完整 tick 各 calls=1；五阶段顺序正确 | 通过 |
| bootPort / segments 备份 | 78459195/196 pending，78459197 done；inspector 第 80 页 owner=backup、g=78459195、epoch=1、n=1，正文 495 字符，lastRun=78459001，符合“本 kernel 加载时的原始文本”语义；主 Memory 继续推进 | 通过；没有清空主 Memory |
| 软重置 | 78459209 计数 206；78459210 释放实例；78459211 新装配恢复计数 206、last=78459209，并重建旗帜实例；78459222 计数 218、健康 ok、启停覆盖保留 | 通过；暂停 tick 不增加业务计数 |
| global reset | 78459228 执行 halt，收到预期 `CPU halted`；78459229 重新装配，恢复计数 223、last=78459227，命令与实例重新安装 | 通过；halt 当 tick 的未完成结果作废，恢复的是此前已落盘数据 |
| 清理与实体回收 | 78459237 remove 测试旗帜返回 OK、unset 两个启停覆盖；78459238 实例释放；inspector 回读 flags={}、kernel.switches.data={} | 通过；旗帜切片已回收 |
| 回滚 | deploy rollback 确认 `m1-validation-0.1.18 → M1`；78459250 原代码健康 ok、Memory ready、NORMAL、没有测试模块，房间、spawn 与应急 creep 保留 | 通过；原 M1 代码未覆盖 |

首轮官服运行构建为 `0.1.18+mvhtrhq5`。最终上传规范化了夹具 JSDoc 注释，并把备份命令说明明确为“本 kernel 加载时的 Memory”；运行机制与首轮相同。最终构建为 `0.1.18+mvhuayxb`，main 与 source map 再次回读校验一致：

- `dist/main.js` SHA-256：`2d5fe24ca3fc3b08b0787d8789d2d4acdaa12b2c588ad48991237ffea28de4c1`。
- `dist/main.js.map` SHA-256：`8df39e692db1849f033400c17d0f32e5e117f31a12c2c43f63a6e622b372aa7a`。
- 78459273：健康 ok、NORMAL/strong、Memory ready、无故障注入、无旗帜或实例；持久计数 249。m1Dependent 按清单默认暂停，其余三个测试模块运行。
- 第 50 页 g=78459284：新构建首个 20 tick 窗口全部 ok，无熔断、无落选、待写页 0；Memory 527 字符、epoch=1；CPU avg=0.98、max=13.62（包含新装配开销），bucket 最小值与末值均为 10000。不能据此当作无探针的稳定性能基准。
- 78459280 的低频日志确认 `commitFailures=0`；最终分支查询确认 `m1-validation-0.1.18` 生效。
- 原 `M1` 分支代码逐字回读与本次备份一致；shard1、shard2、shard3 的 Memory 文本与本次测试前一致。
- 采集到 33 条去重日志，其中 7 条错误日志分别为生存层暂停保护 1 条、两组故障注入各 3 条；平台另返回预期的 `CPU halted`。已采集记录中没有预期之外的错误；控制台订阅是分段窗口，不代表全时段无遗漏。

测试分支保持独立，并保留每 20 tick 的 debug 输出，版本号仍为 `0.1.18`。测试旗帜、旗帜切片与启停覆盖已清理；保留小型测试计数分区与第 80 页备份。保底测试生成的 1 个应急 creep 保留，验证结束时房间能量已回到 300；恢复正常循环后它不再由保底驱动，M1 尚无运营模块接管。

后续可用 `ops.status()`、`boot.assess()`、`m1.status()`、`m1.profile()` 观察；`m1.help()` 查看测试命令。需要回到测试前代码时，当前本机部署历史支持 `npm run deploy -- rollback --account pinkpunk` 回到原 `M1`；该命令只切代码，不撤销测试计数、备份页或实际资产变化。

## 4. 验证边界

- 本次不新增 M2 自动发展能力，不以测试夹具运行成功代表 RCL1→4 闭环成立。
- 保底的塔防、治疗等需要对应资产与敌情；没有真实场景时仅报告私服或单元证据。
- 不为触发场景而清空真实主 Memory、改写 schema、放弃控制器或删除已有资产。备份测试先保存原有备份页；软重置与 halt 验证已有持久数据恢复。
- 低 bucket / CPU 硬终止、所有启动判定分支和跨 shard 清空不以单次官服运行宣称全部验证。
- 平台方法与限制参照 [Screeps API](https://docs.screeps.com/api/)；网页接口调用按[官方认证令牌与限流说明](https://docs.screeps.com/auth-tokens.html)执行。

## 修订记录（2026-10-22，合入 dev）

- 本报告原在测试分支 `test/m1-official-validation`（提交 `5e3edde`）上，按用户指令只把报告合入 `dev`，探针与夹具代码不合入。
- 第 1 节表格中的五个源码位置原为链接，指向测试分支上的探针改动：`officialProbe.ts` 在 `dev` 上不存在，其余四个文件在 `dev` 上也不是本报告描述的版本，所以改为文字路径。查看夹具源码以测试分支为准。正文与结论未改动。
