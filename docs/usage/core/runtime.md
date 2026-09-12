# Runtime 使用说明

`createRuntime` 创建共享核心设施，并返回按模块名派生上下文的函数：

```ts
import { createRuntime } from '@/core/runtime';

const createContext = createRuntime({ enableProfiler: false });
const logisticsContext = createContext('Logistics');
const defenseContext = createContext('Defense', { notify: true });
```

两个上下文共享 `bus` 和 `profiler`，但拥有不同日志前缀的 `env`。`env` 提供 `getGame/getRoom/getCreep/getPowerCreep/getFlag/getObjectById`，便于模块测试时替换 Screeps 运行环境。

可用配置如下：

| 配置 | 作用 |
| --- | --- |
| `bus` | 注入已有 EventBus |
| `profiler` | 注入 Profiler；传入 `null` 可禁用 |
| `enableProfiler` | 控制默认 Profiler 的初始开关 |
| `getProfilerMemory` | Profiler 的底层兼容适配器，返回当前统计对象 |
| `markProfilerMemoryDirty` | 与底层适配器配套，在统计修改前标脏 |

没有提供存储适配器时，默认 Profiler 数据只保存在 Runtime 闭包 heap，不访问全局 `Memory`。这两个选项仅保留给底层集成与测试；业务模块不得用它们建立另一条 Memory 访问路径。

项目正式业务模块应通过 Framework 的 `PluginContext` 使用这些能力。Framework 管理基础设施与 heap Profiler 统计，插件无需自行创建 Runtime，也不应直接访问 `Memory` 或 RawMemory。
