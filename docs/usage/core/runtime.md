# Runtime 使用说明

`createRuntime(options?, overrides?)` 创建完整 Core Runtime。正式应用只传第一个参数，再将返回值交给 Framework：

```ts
import { createFramework } from '@/core/framework';
import { createRuntime } from '@/core/runtime';

const runtime = createRuntime({
  profiler: { enabled: false },
  errorMapper: {
    loadSourceMap: () => require('main.js.map'),
  },
});
const framework = createFramework({ runtime, plugins: [] });

export const loop = framework.loop;
```

直接使用模块上下文时，通过 `runtime.createContext` 派生：

```ts
const logistics = runtime.createContext('Logistics');
const defense = runtime.createContext('Defense', { notify: true });
```

两个上下文共享 `bus`、`profiler` 和 `memory` 主机，但拥有独立日志作用域。`env` 提供 `getGame/getRoom/getCreep/getPowerCreep/getFlag/getObjectById`；这些方法每次读取当前 Game。

## RuntimeOptions

| 配置组          | 内容                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `platform`      | `getGame`：返回当前 tick 的 Game                                     |
| `logging`       | Logger 的等级、邮件策略和输出端口配置                                |
| `memoryManager` | MemoryManager 配置（平台端口）；LoggerFactory 与 tick 来源由 Runtime 注入，tick 取自 `platform.getGame().time` |
| `profiler`      | `{ enabled, storage }`；传入 `false` 完全禁用 Profiler               |
| `errorMapper`   | `{ loadSourceMap, report }`                                          |

`profiler: false` 不创建统计器；`profiler: { enabled: false }` 创建统计器但暂停采样，之后可调用 `runtime.profiler.enable()`。

Profiler 的自定义存储通过同一个对象提供：

```ts
const runtime = createRuntime({
  profiler: {
    enabled: true,
    storage: profilerStorage,
  },
});
```

其中 `profilerStorage` 遵守 `ProfilerStorage`：`getMemory()` 必须返回稳定的当前统计对象，`markDirty()` 在每次原地修改前执行；普通内存统计可以省略，持久化适配必须提供。方法可以通过 `this` 访问存储对象的字段，创建后可替换其内部统计表，但不重新选择方法。业务代码不得借该端口直接访问全局 Memory 或 RawMemory。

## RuntimeOverrides

第二个参数只用于单元测试或特殊宿主替换现成实例：

```ts
const runtime = createRuntime(
  { platform: { getGame: () => fakeGame } },
  { bus: fakeBus, memory: fakeMemory, profiler: null }
);
```

可替换 `logging`、`bus`、`memory`、`profiler` 和 `errorMapper`。替换项优先于对应的创建配置，未提供的能力仍按配置创建；`overrides.profiler: null` 禁用统计器，即使配置中已启用采样。普通 App 不应使用该参数；生产策略应写入第一个参数，让 Runtime 保持唯一组合根。

## 返回值

`CoreRuntime` 提供：

- `getGame`：取得当前 tick 的 Game；
- `logging`、`bus`、`memory`、`profiler`、`errorMapper`：唯一 Core 实例；
- `createContext(name, options)`：派生模块上下文。

Profiler 默认统计只保存在 heap。需要持久化时，不得直接访问 Memory 或 RawMemory；应使用基于 MemoryManager 的存储适配。
