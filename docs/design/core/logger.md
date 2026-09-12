# Logger 设计

交付状态：等级、作用域、格式化、双通道输出与 Runtime/Framework 装配已交付；日志限流/采样、结构化字段与内核插件化未交付。

Logger 是基础输出能力，负责日志等级、模块作用域、格式化及输出端口，不参与具体游戏对象管理和业务决策。公共调用协议由 [contracts/logging.ts](../../../src/contracts/logging.ts) 发布，消费者不依赖输出实现；模块目录为 `src/core/logger`。

## 1. 定位与边界

- Logger 属于内核能力，与 EventBus、Profiler、ErrorMapper、MemoryManager 同层，由 Runtime 统一组装。
- 日志必须能在 Memory、Profiler 或错误映射不可用时独立输出，避免递归诊断依赖。
- HTML 模板、表单、帮助面板和房间链接属于工具与业务辅助，不因复用着色函数而进入内核职责：着色函数仍由 `src/utils/console` 提供，Logger 单向依赖它们。
- Logger 不读写 Memory/RawMemory，不访问 Game，除非装配启用了错误邮件且真的触发 error 等级。

## 2. 装配模型

```text
Runtime
└── LoggerFactory（唯一实例：等级 + 端口 + 邮件策略）
    ├── ModuleContext.env.log      （按模块名作用域）
    ├── Profiler 的 env.log        （Profiler 作用域）
    ├── EventBus 诊断日志          （EventBus 作用域）
    └── ErrorMapper 默认报告出口   （ErrorMapper 作用域）
```

`createLogging(options)` 返回 `LoggerFactory`；`scope(name, options?)` 按作用域派生 `Logger`。装配在 App/Runtime 实例化阶段完成一次，运行期不再读取配置；作用域只能逐字段覆盖等级与邮件开关。

Framework 在统一装配交付前可以自建实例，但仍接受可选注入：注入时与 Runtime 共用同一工厂，未注入时使用 `defaultLoggerFactory` 兜底，保证 `createFramework`、`createBus`、`createEnvMethods` 等入口可独立使用与测试。内核对 Logger 采用强制装配语义：集合固定，不通过普通插件的 `disable/unregister` 卸载；停止输出属于配置行为（等级关闭），不等于移除能力。

内核模块与普通模块的接入方式统一遵循 [Core 架构 §10](./README.md) 的通用规范：注入工厂、固定作用域且每实例派生一次、只在状态迁移与故障上输出、一次事件一次、日志不作为唯一诊断。

## 3. 等级模型

- 六个等级与 `Logger` 方法一一对应：`debug`、`warn`、`error`、`success`、`info`、`report`。
- 默认开关来自项目设置 `DEFAULT_LOG_CONFIG`（warning/error/report 开，debug/success/info 关）；解析顺序为「作用域覆盖 → 装配覆盖 → 项目默认」。
- 使用 `??` 逐字段回退：`undefined` 表示跟随上层，`false` 显式关闭，`true` 显式开启。
- 关闭的等级在格式化之前返回，热路径只付一次布尔判断，不产生字符串拼接。

## 4. 作用域与格式化

- 作用域名成为 `[name] ` 前缀，并按等级取色（蓝=调试、橙=警告、红=错误、绿=成功、青=信息、紫=报告）；空作用域名输出无前缀文本，便于独立工具复用。
- 前缀使用加粗着色，正文保持原样：Screeps 控制台以 HTML 渲染，颜色只用于快速区分来源与严重程度。着色前缀按等级在作用域内惰性生成一次，之后每条日志只做一次拼接。
- 一次输出只做一次前缀拼接与一次端口写入，不保留历史、不做缓冲。
- Logger 不改写内容：换行原样保留。普通业务日志约定为单行，避免控制台把一段内容拆成多条消息；错误堆栈（ErrorMapper 的报告）天然多行，控制台按行拆分显示是排查时的预期行为，不做转义或截断。

## 5. 输出端口与邮件策略

- `LogOutput` 定义两个通道：`write`（控制台）与 `notify`（邮件）。默认实现分别是 `console.log` 与 `Game.notify(line, notifyInterval)`；装配方可以整条通道替换，用于测试收集、静默或转存。
- 邮件策略是装配级开关 `notify: 'off' | 'error'`，默认 `off`，并且是**硬上限**：装配为 `off` 时任何作用域都不能发送邮件；装配为 `error` 时，作用域可以用 `notify: false` 关闭、用 `undefined` 跟随，无法越权开启。App 由此保留对邮件行为的集中控制。
- 只有 `error` 等级会考虑邮件，其余等级即使作用域 `notify` 为 `true` 也不发送。
- `notifyInterval` 是默认邮件端口的 `Game.notify` 分组间隔（分钟），必须为正整数，默认 60；非法值在装配阶段立即抛错。
- 端口不可信：写入或通知抛错只丢弃当条日志，不向上传播，也不触发二次记录，避免形成错误处理回路。

## 6. 性能与生命周期

- 工厂闭包只保存解析后的等级、策略与端口引用，不随 tick 变化；`scope()` 的调用方（模块 env）在激活期创建一次。
- 单条启用的日志成本 = 一次布尔判断 + 一次前缀拼接 + 一次字符串写入；控制台输出本身是主要 CPU 与配额来源，因此默认等级保守，热路径不应开启 debug/info。
- 邮件通道成本更高（发送 + 频率限制），只由 error 等级在装配允许时触发。
- global reset 后 Runtime 重新装配，工厂与日志器随模块图重建，不保留跨 global 状态。

## 7. 失败降级

- Logger 不依赖 Memory、Profiler、ErrorMapper 与 Game，观测设施缺席时仍能输出（默认关闭邮件即可完全不需要 Game）。
- 装配阶段只做配置校验，不访问宿主；运行期输出错误按“丢弃当条”处理。
- 内核其他能力失败时的最小输出由 Logger 提供：错误映射退回原始堆栈、观测可暂停，但日志等级与端口保持不变。

## 8. 待决事项

- 高频 `error` 的限流/采样策略（按作用域或按标签去重、每分钟上限）尚未设计，当前依赖调用方自律与默认等级。
- 是否需要结构化字段（tick、pluginId、分类）而非单一字符串；若引入，需要同时定义控制台渲染与邮件文本两种格式。
- Logger 是否提升为带 manifest 的内核插件以纳入统一装配校验；当前以内核能力（工厂 + 注入）形式交付，不注册到插件注册表。
- **单一组合根（待决）**：正式 App 只允许一个内核装配入口。设计取向是 Runtime 以完整的内核运行时对象交付能力集合（logging、事件总线、Profiler、错误映射与存储端口），Framework 接受该对象并消费其中的能力，而不是分别接受 `createContext` 与 `logging`；各能力的兜底实例只服务独立调用与测试，不构成第二条正式装配路径。该形态与 Core 架构的统一装配一并交付。
