# Logger 使用说明

日志能力由 `src/core/logger` 提供：`createLogging(options)` 返回 `LoggerFactory`，`factory.scope(name, options?)` 派生带前缀的 `Logger`。业务模块通常不需要直接调用它——Runtime 会把同一个工厂注入 `context.env.log`。

## 装配

由 Runtime 统一创建，所有模块与内核组件共用一套等级、端口和邮件策略：

```ts
import { createRuntime } from '@/core/runtime';

const runtime = createRuntime({
  logging: {
    levels: { info: true }, // 打开 info；其余等级跟随项目默认
    notify: 'error',        // 允许作用域发送 error 邮件
    notifyInterval: 60,     // Game.notify 分组间隔（分钟）
  },
});
const context = runtime.createContext('Logistics');
context.env.log.info('shared bus ready');
```

Framework 从完整 Runtime 取得 Logger，不接受单独的日志替换项。直接创建 EventBus、MemoryManager、ErrorMapper 或环境适配器时，也必须显式传入 LoggerFactory。

独立使用（脚本、测试、工具）时直接创建工厂：

```ts
import { createLogging } from '@/core/logger';

const logging = createLogging({
  output: {
    write: (line) => console.log(line),        // 可换成收集数组、静默或转存
    notify: (line) => console.log('[mail]', line),
  },
});
logging.scope('Script').report('done');
```

`Logger`、`LogContent`、`LogOptions`、`LoggingOptions`、`ScopeLogOptions`、`LogOutput`、`LoggerFactory` 全部从 `@/contracts/logging`（或 `@/contracts`）导入类型；不要从实现文件推导公共类型。`createLogging` 的返回值标注为 `LoggerFactory`，可在测试中用结构兼容对象替换。

## 配置项（LoggingOptions）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `levels` | 项目设置 | 装配级等级默认值，逐字段回退 `DEFAULT_LOG_CONFIG` |
| `notify` | `'off'` | 邮件策略；`'error'` 允许作用域发送 error 邮件 |
| `notifyInterval` | `60` | 默认邮件端口的 `Game.notify` 分组间隔（分钟），正整数 |
| `output` | 内置端口 | 覆盖 `write`/`notify` 任一通道；未提供的通道保留默认实现 |

作用域覆盖（`ScopeLogOptions`）：`levels` 逐字段覆盖装配等级；`notify` 受装配策略约束——装配为 `off` 时任何取值都不会发送邮件，装配为 `error` 时 `undefined` 跟随、`false` 关闭、`true` 开启。

## 等级与默认开关

| 等级 | 默认 | 颜色 |
| --- | --- | --- |
| `debug` | 关 | 蓝 |
| `warn` | 开 | 橙 |
| `error` | 开 | 红 |
| `success` | 关 | 绿 |
| `info` | 关 | 青 |
| `report` | 开 | 紫 |

`undefined` 表示跟随上层开关，显式 `false` 只关闭该等级。关闭的等级不会产生任何格式化与输出开销。

调用方自己拼接日志文本时（如模板字符串），文本在调用 `log.xxx()` 之前就已求值。热路径可先用 `log.isEnabled('info')` 判断再拼接；结果与该等级是否实际输出一致，在作用域创建后不会变化。测试中自建 `Logger` 替身时需要提供 `isEnabled`。

### 惰性内容

每个日志方法既接受字符串，也接受返回字符串的回调。回调只在该等级开启时调用一次；关闭时连回调里的计算都不会发生：

```ts
log.debug(() => `path ${JSON.stringify(path)} cost ${cost}`); // debug 关闭时不序列化
```

选择写法：

| 场景 | 写法 |
| --- | --- |
| 普通、低频日志 | 直接传字符串，可读性最好 |
| 热路径，或消息构造昂贵（序列化、`map().join()`、状态快照） | 传回调 |
| 同一判断下要输出多条日志或做额外工作 | `if (log.isEnabled('debug')) { … }` |

回调必须同步、没有副作用。回调抛错时这条日志被丢弃，调用方不受影响。

```ts
const log = logging.scope('Defense', { levels: { info: true, report: false } });
log.info('wave incoming');   // 输出：[Defense] wave incoming（info 着色）
log.report('stats');         // 无输出（本作用域关闭 report）
```

## 邮件语义

- 只有 `error` 等级会发送邮件；其他等级即使作用域 `notify: true` 也不发送。
- 装配级策略是硬上限：默认 `off` 表示全项目不发邮件，作用域无法自行打开；需要邮件时先在装配层写 `notify: 'error'`，再由作用域用 `notify` 决定关闭或跟随。
- 默认邮件端口调用 `Game.notify(line, notifyInterval)`；`Game` 不可用时异常被吞掉，不影响业务。
- 邮件有发送成本与频率限制，热路径的 error 应先去重或降级为控制台日志。

## 错误处理与降级

- 输出端口抛错只丢弃当条日志，不向调用方传播，也不会触发二次记录。
- 惰性回调抛错同样只丢弃当条日志；返回非字符串时按 `String()` 转换。
- 日志不依赖 Memory、Profiler、ErrorMapper 与 Game；这些能力缺席时仍能输出（默认关闭邮件时完全不访问 Game）。
- 非法 `notifyInterval`（非正整数）在装配阶段抛 `Invalid notify interval`，属于配置错误，应在启动阶段暴露。

## 内核模块接入规范

内核模块（MemoryManager、EventBus、Profiler、ErrorMapper 等）按同一套规则接入，细则见 [Core 架构 §10](../../design/core/README.md)：

```ts
import type { LoggerFactory } from '@/contracts/logging';

interface Options {
  /** 由 Runtime 或测试组合边界显式注入。 */
  logging: LoggerFactory;
}

export const createKernelThing = (options: Options) => {
  // 作用域固定，每实例派生一次。
  const log = options.logging.scope('KernelThing');
  // …只在状态迁移与故障处输出：log.info / log.warn / log.error
};
```

| 场景 | 等级 | 说明 |
| --- | --- | --- |
| 每 tick 都会发生（提交、心跳） | `debug` | 默认关闭，排查时用 `levels: { debug: true }` 打开；需要拼接或计算的消息传惰性回调 |
| 状态迁移（初始化、后端切换、恢复完成） | `info` | 默认关闭，排查时打开 |
| 可自愈异常（写入失败、页面被占用、容量超限） | `warn` | 同一原因只记一次 |
| 不可自愈的数据问题（schema 非法、归属冲突、版本降级） | `error` | 每实例或每分区首次 |
| 周期性统计汇总 | 不建议 | `report` 默认开启，容易刷屏；用结构化状态接口代替 |

必须避免：在热路径输出 `info` 及以上等级；每次故障重新 `scope()`；模块内自行 `createLogging()`；用日志文本代替结构化诊断；把 logger 或日志文本写进持久数据；内核能力自行开启邮件通知。

## 注意事项

- 作用域名会成为 `[name] ` 前缀；同一运行期内同名作用域应保持一致，便于检索。
- Logger 不缓存历史、不做缓冲与去重；限流属于调用方的责任（见设计文档待决事项）。
- HTML 表单、帮助面板与房间链接不属于日志能力，它们继续使用 `@/utils/console` 的着色与模板函数。
- 业务模块通过 `context.env.log` 使用日志，不要自行创建工厂，否则会绕开 Runtime 的统一等级与端口配置。
