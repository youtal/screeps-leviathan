# Profiler 使用说明

Runtime 通过 `createRuntime({ profiler: { enabled: true } })` 启用 Framework 阶段统计；传入 `{ profiler: false }` 则不创建 Profiler。插件可以使用 `context.profiler`，该值可能为 null；关闭采样不会关闭 Framework 的异常隔离。

```ts
setup(context) {
  const calculate = () => 42;
  const wrapped = context.profiler
    ? context.profiler.wrap('example.calculate', calculate)
    : calculate;
  context.services.provide('calculate', wrapped);
}
```

示例服务必须预先声明到 manifest.provides。wrap 每个 label 只创建一次；同名重复 wrap 会警告并返回未包装的原函数。

控制方法：

- `enable()` / `disable()`：改变已经创建的包装器的采样状态。
- `reset()`：清空当前统计数据。
- `report(false, label)`：输出单项报告。
- `report()`：按 selfTime 降序输出累计报告。

报告的标题行与数据行都以 `report` 级别输出，该级别默认开启；关闭 Profiler 作用域的 `report` 等级会隐藏整份报告。`report` 的第一个参数 `detailed` 为预留参数，传入 `true` 与 `false` 的输出相同。

在 Framework 插件中通常直接使用 `context.profiler`，无需自行组装依赖。Runtime 的默认统计器将累计值保存在实例 heap，global reset 后清空，不写入 RawMemory。

独立调用 `createProfiler` 时，通过 `context.env` 提供 `getGame` 和日志，通过 `context.storage` 提供 `getMemory/markDirty`，通过 `context.enable` 提供初始开关。`ProfilerStorage` 是 Profiler 与宿主之间的底层适配器，不是业务 Memory 接口；业务不能使用旧 context.persistence。独立 Profiler 如果不接 Runtime，应把统计留在调用者闭包中。

统计写入或 CPU 读取异常不会改变被包装函数的返回值、this 和业务异常；发生观测故障时样本可能缺失。calls 包含已成功记录的失败调用，不能用它直接推导业务成功次数。

`storage` 的方法可以使用 `this` 访问自身字段，Profiler 创建时绑定该对象，每次操作仍读取当前统计表。`markDirty` 对普通内存统计可省略；需要写回时必须提供。创建后替换内部统计表会影响后续样本，不需要重建包装函数。
