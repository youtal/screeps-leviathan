/**
 * 文件摘要：kernel.memory 的项目标记访问器 sys()（设计见 docs/design/kernel/memory.md、docs/design/kernel/bootPort.md 第 4 节）。
 *
 * 项目标记 Memory[NS].sys 不使用单元包络，持久形式就是标记对象本身。为复用 Accessor 的路径语义、复制与标脏规则，
 * 这里为它建立一个不进入单元索引的运行时单元：record.data 是读写 state.data.sys 的访问器属性，
 * 所以 replace 后、乃至 clear 换掉整个命名空间后，同一访问器始终指向当前命名空间的标记，清空后无需重新取得。
 * 结构校验不在写入时做，而在提交时按项目标记的结构与装配身份校验；失败时沿用 state.sysText 写出并告警（commit.ts）。
 * 状态：单元保存在 Runtime.sysUnit，随实例存在；dispose 使其失效。
 */
import type { ProjectMarker } from '@/contracts/boot';
import type { Accessor, Json } from '@/contracts/memory';
import { accessorFor } from './accessor';
import type { Runtime } from './runtime';
import type { UnitRecord } from './unit';

/**
 * @description 取得项目标记的访问器，首次调用时创建 sys 单元并缓存。
 * 单元的 encoded 字段不参与提交：update 在尚无基线时会顺带编码一次，提交只使用 state.sysText 作为合法基线。
 * @param state 当前 Memory 实例的运行状态。
 * @returns 项目标记的访问器；方法调用时仍检查实例是否可用。
 * @throws {Error} 实例不可用、正在提交、加载失败或命名空间尚未加载或初始化（Memory 为 empty）。
 */
export const sysAccessor = (state: Runtime): Accessor<ProjectMarker> => {
  state.check();
  if (!state.sysUnit) {
    // version 只为满足包络形状，不写入持久文本。data 为可枚举访问器属性，读写都转发到当前命名空间。
    const record = { version: 0 } as UnitRecord;
    Object.defineProperty(record, 'data', {
      enumerable: true,
      /**
       * @description 读取当前命名空间的项目标记。
       * @returns state.data.sys 的原引用。
       */
      get: (): Json => state.data!.sys,
      /**
       * @description 以已复制校验的新值替换项目标记（Accessor.replace 的落点）。
       * @param value 新的项目标记副本；结构合法性在提交时校验。
       * @returns 无返回值。
       */
      set: (value: Json) => { state.data!.sys = value as ProjectMarker; },
    });
    state.sysUnit = { id: 'sys', owner: 'sys', record, head: '', parentHead: '', dirty: state.dirty, check: state.check,
      active: true, needsValidation: false, isolated: false };
  }
  return accessorFor<ProjectMarker>(state.sysUnit);
};
