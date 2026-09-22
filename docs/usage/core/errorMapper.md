# ErrorMapper 使用说明

应用通常通过 Runtime 取得共享实例：

```ts
const runtime = createRuntime();
const result = runtime.errorMapper.capture(
  { tick: Game.time, pluginId: 'planner', phase: 'tickExecute' },
  () => runPlanner()
);

if (!result.ok) runtime.logging.scope('App').error(result.failure.message);
```

需要独立测试时，必须显式注入 LoggerFactory：

```ts
import { createErrorMapper } from '@/core/errorMapper';
import { createLogging } from '@/core/logger';

const mapper = createErrorMapper(createLogging(), {
  loadSourceMap: () => require('main.js.map'),
  report: (failure) => console.log(failure.message),
});
```

`capture` 只接受同步回调，成功时返回 `{ ok: true, value }`，失败时返回 `{ ok: false, failure }`。消息与堆栈都会被截到 16 KB，直接调用 `mapStack` 传入的文本同样按这一上限截断。

省略 `report` 时，故障以 error 级别写入 `ErrorMapper` 作用域日志，并按插件与阶段去重：同一插件在同一阶段连续报出相同消息只记录第一次，消息变化时重新记录，该插件在该阶段成功一次后重置。持续存在的故障因此不会逐 tick 刷屏，也不会逐 tick 触发邮件。注入的 `report` 每次故障都会被调用，需要去重或限流时由回调自行实现。去重不影响 `capture` 的返回值，每次失败都返回完整的 `failure`。`mapStack(stack)` 可单独映射堆栈；不可映射的帧保持原样。`setMeasure` 是 Framework 的装配端口，普通业务模块不应反复替换它。
