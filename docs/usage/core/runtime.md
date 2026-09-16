# Runtime 使用说明

`createRuntime()` 创建完整 Core Runtime。正式应用创建一次，再将它交给 Framework：

```ts
import { createFramework } from '@/core/framework';
import { createRuntime } from '@/core/runtime';

const runtime = createRuntime({ enableProfiler: false });
const framework = createFramework({ runtime, plugins: [] });

export const loop = framework.loop;
```

直接使用模块上下文时，通过 `runtime.createContext` 派生：

```ts
const logistics = runtime.createContext('Logistics');
const defense = runtime.createContext('Defense', { notify: true });
```

两个上下文共享 `bus`、`profiler` 和 `memory` 主机，但拥有独立日志作用域。`env` 提供 `getGame/getRoom/getCreep/getPowerCreep/getFlag/getObjectById`；这些方法每次读取当前 Game。

## 配置

| 配置 | 作用 |
| --- | --- |
| `getGame` | 注入当前 Game 访问器，主要用于测试 |
| `logging` | 注入 LoggerFactory；省略时 Runtime 创建一个项目默认工厂 |
| `bus` | 注入已有 EventBus |
| `memory` | 注入符合 MemoryHost 的存储实例；省略时创建 MemoryManager |
| `profiler` | 注入 Profiler；传入 `null` 禁用 |
| `errorMapper` | 注入 ErrorMapper |
| `enableProfiler` | 控制默认 Profiler 的初始开关 |
| `getProfilerMemory` | 返回默认 Profiler 的统计对象 |
| `markProfilerMemoryDirty` | Profiler 修改统计前调用的标脏回调 |
| `loadSourceMap` | ErrorMapper 首次映射时同步取得 source map |
| `report` | ErrorMapper 的结构化故障出口 |

注入项用于测试或宿主适配。应用不应分别创建一组能力再绕过 Runtime 交给 Framework。

## 返回值

`CoreRuntime` 提供：

- `getGame`：取得当前 tick 的 Game；
- `logging`、`bus`、`memory`、`profiler`、`errorMapper`：唯一 Core 实例；
- `createContext(name, options)`：派生模块上下文。

Profiler 的默认统计只保存在 heap。需要持久化时，不得直接访问 Memory 或 RawMemory；应通过 MemoryManager 设计的分区接入完成。
