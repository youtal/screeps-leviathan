# Logger 使用说明

日志能力由 `src/core/logger` 提供：`createLogging(options)` 返回 `LoggerFactory`，`factory.scope(name, options?)` 派生带前缀的 `Logger`。业务模块通常不需要直接调用它——Runtime 会把同一个工厂注入 `context.env.log`。

## 装配

由 Runtime 统一创建，所有模块与内核组件共用一套等级、端口和邮件策略：

```ts
import { createLogging } from '@/core/logger';
import { createRuntime } from '@/core/runtime';

const logging = createLogging({
  levels: { info: true },   // 打开 info；其余等级跟随项目默认
  notify: 'error',          // 允许作用域发送 error 邮件
  notifyInterval: 60,       // Game.notify 分组间隔（分钟）
});

const createContext = createRuntime({ logging });
const context = createContext('Logistics');
context.env.log.info('shared bus ready');
```

Framework 路径同样接受注入；不注入时使用 `defaultLoggerFactory` 兜底，因此 `createFramework({ plugins })` 与 `createBus()` 可以直接调用，无需显式装配日志。

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

`Logger`、`LogOptions`、`LoggingOptions`、`ScopeLogOptions`、`LogOutput`、`LoggerFactory` 全部从 `@/contracts/logging`（或 `@/contracts`）导入类型；不要从实现文件推导公共类型。`createLogging` 的返回值标注为 `LoggerFactory`，可在测试中用结构兼容对象替换。

## 配置项（LoggingOptions）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `levels` | 项目设置 | 装配级等级默认值，逐字段回退 `DEFAULT_LOG_CONFIG` |
| `notify` | `'off'` | 邮件策略；`'error'` 允许作用域发送 error 邮件 |
| `notifyInterval` | `60` | 默认邮件端口的 `Game.notify` 分组间隔（分钟），正整数 |
| `output` | 内置端口 | 覆盖 `write`/`notify` 任一通道；未提供的通道保留默认实现 |

作用域覆盖（`ScopeLogOptions`）：`levels` 逐字段覆盖装配等级，`notify` 覆盖装配策略（`undefined` 跟随，`false` 强制关闭，`true` 在装配允许时开启）。

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

```ts
const log = logging.scope('Defense', { levels: { info: true, report: false } });
log.info('wave incoming');   // 输出：[Defense] wave incoming（info 着色）
log.report('stats');         // 无输出（本作用域关闭 report）
```

## 邮件语义

- 只有 `error` 等级会发送邮件；其他等级即使作用域 `notify: true` 也不发送。
- 默认策略 `off`，即项目默认不发邮件；需要时在装配层写 `notify: 'error'`，再由作用域决定是否开启。
- 默认邮件端口调用 `Game.notify(line, notifyInterval)`；`Game` 不可用时异常被吞掉，不影响业务。
- 邮件有发送成本与频率限制，热路径的 error 应先去重或降级为控制台日志。

## 错误处理与降级

- 输出端口抛错只丢弃当条日志，不向调用方传播，也不会触发二次记录。
- 日志不依赖 Memory、Profiler、ErrorMapper 与 Game；这些能力缺席时仍能输出（默认关闭邮件时完全不访问 Game）。
- 非法 `notifyInterval`（非正整数）在装配阶段抛 `Invalid notify interval`，属于配置错误，应在启动阶段暴露。

## 注意事项

- 作用域名会成为 `[name] ` 前缀；同一运行期内同名作用域应保持一致，便于检索。
- Logger 不缓存历史、不做缓冲与去重；限流属于调用方的责任（见设计文档待决事项）。
- HTML 表单、帮助面板与房间链接不属于日志能力，它们继续使用 `@/utils/console` 的着色与模板函数。
- 业务模块通过 `context.env.log` 使用日志，不要自行创建工厂，否则会绕开 Runtime 的统一等级与端口配置。
