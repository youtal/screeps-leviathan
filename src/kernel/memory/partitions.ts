/**
 * 文件摘要：kernel.memory 的模块分区工厂，按 owner/localId 建立唯一单元并发布缓存 Accessor。
 * 工厂由模块实例持有，重复取得不会重新分配；初始化先完成再写入根表，抛错不会留下空记录。
 * 不提供跨 owner 访问给业务模块，宿主只注入绑定后的工厂。销毁后的旧工厂与访问器均拒绝使用。
 */
import type { Json, PartitionFactory, UnitSpec } from '../../contracts/memory';
import { accessorFor } from './accessor';
import { checkKey } from './json';
import { type Runtime, unitId } from './runtime';
import { initializeUnit, prepareUnit } from './unit';

/**
 * @description 创建 owner 绑定入口；工厂缓存在闭包内，单元身份由共享 Runtime 管理。
 * @param state 当前 Memory 实例的运行状态。
 * @returns 接收 owner 并返回其 PartitionFactory 的函数，调用时检查实例与名称。
 */
export const createPartitions = (state: Runtime): ((owner: string) => PartitionFactory) => {
  // { [模块 owner]: 绑定该模块的分区工厂 }；随 Memory 实例释放。
  const factories = new Map<string, PartitionFactory>();
  /**
   * @description 创建或复用绑定指定模块的工厂，不创建持久分区。
   * @param owner 模块身份，不得为空或使用危险原型键。
   * @returns 对应 owner 的缓存工厂。
   * @throws {Error} 模块不可用或 owner 非法。
   */
  return (owner) => {
    state.check();
    checkKey(owner);
    const cached = factories.get(owner);
    if (cached) return cached;
    const factory: PartitionFactory = {
      /**
       * @description 取得唯一分区，必要时初始化或迁移，成功后发布访问器。
       * @template T 分区数据类型。
       * @param localId 当前 owner 内的分区名称。
       * @param spec 版本及初始化/迁移声明，重复申请须沿用同一对象。
       * @returns 该分区的缓存访问器。
       * @throws {Error} 实例不可用、名称或声明非法、声明冲突或返回数据非法。
       * @throws {*} 初始化或迁移回调异常原样传播，不发布访问器。
       */
      partition<T extends Json>(localId: string, spec: UnitSpec<T>) {
        state.check(); checkKey(localId);
        let unit = state.units.get(unitId('part', owner, localId));
        if (!unit) {
          // initialize/校验/复制都可能抛错，必须在创建 owner 表前完成，避免遗留空分区。
          const record = initializeUnit(spec);
          const groups = state.data!.part;
          // owner 可能恰为 toString 等继承键，不能用 groups[owner] ?? {} 判断是否存在。
          const table = Object.hasOwn(groups, owner) ? groups[owner] : (groups[owner] = {});
          table[localId] = record;
          unit = state.register('part', owner, localId, record, true);
        }
        // 已加载单元在这里检查版本；失败不发布访问器，重复声明必须沿用同一 spec 对象。
        prepareUnit(unit, spec);
        return accessorFor<T>(unit);
      },
    };
    factories.set(owner, factory);
    return factory;
  };
};
