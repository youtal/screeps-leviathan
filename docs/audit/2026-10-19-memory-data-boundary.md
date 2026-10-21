# Memory 纯数据原则一致性核对

- 基线：`feat/kernel-memory` 工作区，HEAD `57f1290`；包含尚未提交的 Memory v1 实现及 undefined 拒绝规则。以下行号对应本次核对时的源码。
- 范围：[Memory 设计的纯数据原则](../design/kernel/memory.md#纯数据原则显式转换非法类型直接拒绝)与写入、初始化、迁移、提交路径。
- 结论：主要入口使用统一校验，但发现 1 项不一致。本轮仅修改文档、记录核对结果，不整改代码。

## 已核实路径

| 路径 | 源码依据 | 结果 |
| --- | --- | --- |
| set / replace | [accessor.ts](../../src/kernel/memory/accessor.ts) 的 copyJson 调用 | 修改存储前校验并复制 |
| 初始化 / 迁移 | [unit.ts](../../src/kernel/memory/unit.ts) 的 initializeUnit / prepareUnit | 回调结果经 copyJson；迁移输入也先复制 |
| update 后提交 | [commit.ts:60](../../src/kernel/memory/commit.ts) 的 validateJson → JSON.stringify | 先校验再编码，write 位于完整候选文本生成之后 |
| 非支持类型 | [json.ts:32](../../src/kernel/memory/json.ts) 的 walk | 显式 undefined、非有限数字、一般非数组类实例、原生 Map/Set 等拒绝；数组子类存在下述例外 |

`npm test -- --runInBand test/kernel/memory`：2 个套件、46 项测试通过。已有测试覆盖 Map 显式转换、普通对象自有 toJSON 不执行、undefined 拒绝及非法 update 阻止提交，但未覆盖 Array 子类。

## MD-01 · P2 · Array 子类绕过纯数据边界

**分类：范围内修正。证据：源码核实与运行探针复现。**

- 来源：[json.ts:36](../../src/kernel/memory/json.ts) 的 `walk` 使用 `Array.isArray(value)` 放行数组，未限制数组原型；随后仅检查自有属性。
- 复制落点：[json.ts:42](../../src/kernel/memory/json.ts) 为数组分配普通 `[]`。因此 `copyJson(new CustomArray(...))` 不报错，而是静默丢弃子类原型。
- 提交传播：`Accessor.update` 允许原地放入该子类；[commit.ts:60](../../src/kernel/memory/commit.ts) 校验通过后对原包络调用 JSON.stringify。继承的 toJSON 不属于自有属性，不会被现有校验拒绝，编码时会执行，持久文本可与 heap 数据结构不一致。

复现代码（以当前 json.ts 经 TypeScript 转译后导出的函数运行）：

```ts
let calls = 0;
class CustomArray extends Array {
  toJSON() { calls++; return 'converted'; }
}
const value = new CustomArray(1, 2);
validateJson(value); // 实际通过
const copy = copyJson(value); // 实际返回普通 Array
JSON.stringify({ data: value }); // 实际得到 {"data":"converted"}，calls === 1
```

建议：数组分支也应限制为普通数组，拒绝自定义数组原型；补充复制入口与 update/commit 路径的回归和反向验证。该修正服务于已明确的纯数据原则，不新增转换接口。此次探针直接复现校验与编码行为；未运行真实私服，也未把探针声称为完整平台场景测试。

## MD-01 整改与复核（2026-10-19）

- 授权：用户明确要求“修正不一致的地方”。范围为上述 MD-01。
- 修正：[json.ts](../../src/kernel/memory/json.ts) 的 walk 在数组分支检查直接原型必须为当前运行域的 Array.prototype；复制与提交前校验共用该入口，异常在复制或编码前抛出。每个数组增加一次原型查询，不增加序列化或平台调用。
- 回归：[array-boundary.test.ts](../../test/kernel/memory/array-boundary.test.ts) 新增 5 项测试，覆盖数组子类、自定义原型、无原型数组、嵌套输入、set/replace 不修改旧数据，以及 update 后 commit 拒绝写入且不执行继承的 toJSON。恢复普通数组原型后能再次提交，普通数组仍可正常复制。
- 反向验证：先确认 5 项通过，临时移除数组原型检查后运行同一测试文件，5 项全部失败（预期 TypeError 未抛出）；恢复原检查后执行全量验证通过。
- 验证：`npm run check` 通过，9 个套件共 145 项测试通过，类型检查与构建通过；本次未运行真实私服，沿用平台替身覆盖跨 tick 保存与重试行为。
- 结论：MD-01 已修正并完成回归、反向验证；原审计记录保留，按原基线阅读。
