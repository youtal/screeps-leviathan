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

`capture` 只接受同步回调，成功时返回 `{ ok: true, value }`，失败时返回 `{ ok: false, failure }`。`mapStack(stack)` 可单独映射堆栈；不可映射的帧保持原样。`setMeasure` 是 Framework 的装配端口，普通业务模块不应反复替换它。
