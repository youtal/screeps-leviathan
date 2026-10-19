/**
 * 文件摘要：kernel.memory 的实体私有切片与有限维护扫描，复用单元迁移与 Accessor。
 * 业务模块只能取得 owner 绑定的 rooms/creeps/flags；core 保留给后续专用能力，不在这里发布。
 * 声明和访问器缓存在实例内，回收使整条记录的所有单元失效。维护用跨 tick Map 游标轮转，
 * 每 tick 累计最多处理 limit 条实体记录，不每次分配全量 key 数组；reset 后重新积累缺席证据。
 * 房间回收依据宿主提供的保护/观测事实，缺失则保留，不在持久层推断 colony 业务。
 */
import type { EntitySpace, EntitySlices, Json, UnitSpec } from '../../contracts/memory';
import { accessorFor } from './accessor';
import { checkKey } from './json';
import { recordId, type Runtime, unitId } from './runtime';
import { checkSpec, initializeUnit, prepareUnit } from './unit';

type EntityKind = 'rooms' | 'creeps' | 'flags';
export type EntitySpaces = Readonly<Record<EntityKind, EntitySpace>>;
/** 同一 space/owner 共用一份声明；维护扫描据此迁移尚未被 of 访问的已有记录。 */
interface Declaration { readonly spec: UnitSpec<Json>; readonly slices: EntitySlices<Json> }

/**
 * @description 创建实体工厂与维护入口；声明、缓存及扫描游标跨 tick 保留，新实例重新建立。
 * @param state 当前 Memory 实例的运行状态。
 * @returns owner 绑定入口 entities 与维护扫描入口 maintain。
 */
export const createEntities = (state: Runtime) => {
  // { [模块 owner]: 三种实体空间的绑定能力 }。
  const owners = new Map<string, EntitySpaces>();
  // { [JSON 编码的 space,owner 二元组]: 该私有切片的 spec 及访问入口 }。
  const declarations = new Map<string, Declaration>();
  // Map 游标避免每次维护复制所有实体键；走到末尾后重建，以纳入后续新增记录。
  let cursor = state.records.values();
  // used 按实际扫描次数计费（不是删除数），同 tick 多次调用共享预算；换 tick 才归零。
  let maintenanceTick = -1;
  let used = 0;

  /**
   * @description 创建或复用 owner 的三种实体空间，不创建持久记录。
   * @param owner 模块身份，core 保留给专用能力。
   * @returns rooms、creeps、flags 的 owner 绑定入口。
   * @throws {Error} 实例不可用、名称非法或 owner 为 core。
   */
  const entities = (owner: string): EntitySpaces => {
    state.check(); checkKey(owner);
    if (owner === 'core') throw new Error('core 切片不能通过私有接口取得');
    const cached = owners.get(owner);
    if (cached) return cached;
    /**
     * @description 为当前 owner 创建指定实体空间的声明入口。
     * @param space 实体空间种类。
     * @returns 仅提供 slice 声明方法的空间能力。
     */
    const spaceFor = (space: EntityKind): EntitySpace => ({
      /**
       * @description 声明本 owner 的切片规则；不立即遍历或迁移已有实体。
       * @template T 该切片的数据类型。
       * @param spec 全空间共用的版本声明，重复声明须使用同一对象。
       * @returns 缓存的实体切片集合入口。
       * @throws {Error} 实例不可用、spec 非法或同一切片存在冲突声明。
       */
      slice<T extends Json>(spec: UnitSpec<T>): EntitySlices<T> {
        // 声明阶段只绑定迁移规则，不遍历已有实体；of 或 maintain 才执行具体迁移。
        state.check(); checkSpec(spec);
        const id = JSON.stringify([space, owner]);
        const existing = declarations.get(id);
        if (existing) {
          if (existing.spec !== spec) throw new Error('同一切片重复声明了不同 spec');
          return existing.slices as EntitySlices<T>;
        }
        const slices: EntitySlices<T> = {
          /**
           * @description 惰性初始化或迁移当前 owner 的实体切片，保留其他 owner 的数据。
           * @param key 房间名、creep 名或 flag 名。
           * @returns 当前切片的唯一访问器；回收后同名重建会创建新访问器。
           * @throws {Error} 实例不可用、名称或数据非法、声明冲突。
           * @throws {*} 初始化或迁移回调异常原样传播。
           */
          of(key) {
            state.check(); checkKey(key);
            let unit = state.units.get(unitId(space, key, owner));
            if (!unit) {
              // 数据先初始化成功，再接入共享实体表；其他 owner 的切片保持原引用。
              const record = initializeUnit(spec);
              const groups = state.data![space];
              const table = Object.hasOwn(groups, key) ? groups[key] : (groups[key] = {});
              table[owner] = record;
              // 只在整条记录首次出现时登记创建 tick；为已有记录增加切片不能刷新它，否则会反复推迟回收。
              const id = recordId(space, key);
              if (!state.records.has(id)) state.records.set(id, { space, key, slices: table, createdAt: state.facts!.time });
              unit = state.register(space, key, owner, record, true);
            }
            prepareUnit(unit, spec);
            return accessorFor<T>(unit);
          },
          /**
           * @description 只查当前 owner 的单元索引，不创建实体或触发迁移。
           * @param key 实体名称。
           * @returns 当前 owner 已有该切片时为 true，否则为 false。
           * @throws {Error} 实例不可用或实体名称非法。
           */
          has(key) { state.check(); checkKey(key); return state.units.has(unitId(space, key, owner)); },
        };
        // 表内混存各 owner 的 T，统一擦除为 Json；命中时凭同一 spec 身份恢复调用方的 T。
        declarations.set(id, { spec: spec as UnitSpec<Json>, slices: slices as EntitySlices<Json> });
        return slices;
      },
    });
    const result = { rooms: spaceFor('rooms'), creeps: spaceFor('creeps'), flags: spaceFor('flags') };
    owners.set(owner, result);
    return result;
  };

  /**
   * @description 扫描实体以回收过期记录并迁移已声明切片，预算按 tick 累计。
   * 单条成本随切片数及迁移函数变化，这不是 CPU 时间预算；宿主仍负责维护阶段准入。
   * 迁移抛错向上传播，已处理记录不回滚；游标已前进，失败记录会在后续轮转再次访问。
   * @param limit 本 tick 累计扫描记录上限，默认 50；重复调用不会重新获得全部配额。
   * @returns 本次实际扫描的记录数，包含未删除的记录。
   * @throws {Error} 实例不可用或 limit 不是非负安全整数。
   * @throws {*} 切片迁移失败时原样传播异常，失败记录的原数据保留。
   */
  const maintain = (limit = 50): number => {
    state.check();
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('维护上限非法');
    if (maintenanceTick !== state.facts!.time) { maintenanceTick = state.facts!.time; used = 0; }
    let processed = 0;
    const bound = Math.min(Math.max(0, limit - used), state.records.size);
    while (processed < bound) {
      let item = cursor.next();
      if (item.done) { cursor = state.records.values(); item = cursor.next(); }
      if (item.done) break;
      processed += 1;
      used += 1;
      const { space, key, slices, createdAt } = item.value;
      const facts = state.facts!;
      const room = facts.rooms && Object.hasOwn(facts.rooms, key) ? facts.rooms[key] : undefined;
      // 名称快照取自 beginTick，看不到之后才创建的 creep/flag（引擎在 spawnCreep、createFlag 调用内即加入 Game）。
      // 因此 creep 记录至少存在 2 tick、flag 记录至少存在 1 tick，才以缺席为由回收。
      const age = facts.time - createdAt;
      // creep 必须有相邻 tick 证据；flag 按当前事实；房间缺事实、受保护或尚未过期都保留。
      const remove = space === 'creeps'
        ? age >= 2 && state.previousCreeps !== undefined && !state.previousCreeps.has(key) && !facts.creeps.has(key)
        : space === 'flags' ? age >= 1 && !facts.flags.has(key)
          : room?.owned === false && room.protected === false && Number.isSafeInteger(room.lastSeen)
            && room.lastSeen >= 0 && facts.time - room.lastSeen > 20000;
      for (const owner of Object.keys(slices)) {
        const id = unitId(space, key, owner);
        const unit = state.units.get(id)!;
        // 先撤销旧能力并移出编码队列，再删根记录；同名重建会分配新单元，不复活旧访问器。
        if (remove) { unit.active = false; state.dirty.delete(unit); state.units.delete(id); }
        else {
          const declaration = declarations.get(JSON.stringify([space, owner]));
          // 未声明切片缺少迁移规则，原样保留；模块暂停不等于授权删除其数据。
          if (declaration) prepareUnit(unit, declaration.spec);
        }
      }
      if (remove) {
        delete state.data![space][key];
        state.records.delete(recordId(space, key));
        state.structural = true; // 即使删除的是最后一个脏单元，也必须重新拼串持久化删除。
      }
    }
    return processed;
  };
  return { entities, maintain };
};
