import { EventBus } from './EventBus';
import { EventType, DataByEvent, EventList, EventCategory } from './types';

/**
 * 全局事件总线实例
 */
export const globalEventBus = new EventBus();

/**
 * 便捷的事件发布函数
 */
export function emitEvent<T extends EventType>(
  eventType: T,
  data: DataByEvent<T>
): boolean {
  return globalEventBus.emit(eventType, data);
}

/**
 * 便捷的事件订阅函数
 */
export function onEvent<T extends EventType>(
  eventType: T,
  listener: (data: DataByEvent<T>) => void
): void {
  globalEventBus.on(eventType, listener);
}

/**
 * 便捷的一次性事件订阅函数
 */
export function onceEvent<T extends EventType>(
  eventType: T,
  listener: (data: DataByEvent<T>) => void
): void {
  globalEventBus.once(eventType, listener);
}

/**
 * 便捷的事件取消订阅函数
 */
export function offEvent<T extends EventType>(
  eventType: T,
  listener: (data: DataByEvent<T>) => void
): void {
  globalEventBus.off(eventType, listener);
}

/**
 * 资源相关事件辅助函数
 */
export const ResourceEvents = {
  /**
   * 发布资源不足事件
   */
  emitResourceLow(
    resourceType: ResourceConstant,
    amount: number,
    from: Id<ObjectWithStore>
  ) {
    return emitEvent(EventList.resourceLow, {
      resourceType,
      amount,
      from,
      to: from, // 资源不足时 to 和 from 相同
      timestamp: Game.time,
    });
  },

  /**
   * 发布资源转移事件
   */
  emitResourceTransfer(
    resourceType: ResourceConstant,
    amount: number,
    from: Id<ObjectWithStore>,
    to: Id<ObjectWithStore>
  ) {
    return emitEvent(EventList.resourceTransfer, {
      resourceType,
      amount,
      from,
      to,
      timestamp: Game.time,
    });
  },

  /**
   * 发布资源采集事件
   */
  emitResourceHarvest(
    resourceType: ResourceConstant,
    amount: number,
    source: Id<ObjectWithStore>
  ) {
    return emitEvent(EventList.resourceHarvest, {
      resourceType,
      amount,
      from: source,
      to: source, // 采集时来源和目标相同
      timestamp: Game.time,
    });
  },
};

/**
 * Creep 相关事件辅助函数
 */
export const CreepEvents = {
  /**
   * 发布 Creep 生成事件
   */
  emitCreepSpawn(creepName: string) {
    return emitEvent(EventList.creepSpawn, {
      creepName,
      timestamp: Game.time,
    });
  },

  /**
   * 发布 Creep 死亡事件
   */
  emitCreepDeath(creepName: string) {
    return emitEvent(EventList.creepDeath, {
      creepName,
      timestamp: Game.time,
    });
  },
};

/**
 * 建筑相关事件辅助函数
 */
export const StructureEvents = {
  /**
   * 发布建筑建造完成事件
   */
  emitStructureBuilt(structureId: Id<Structure>) {
    return emitEvent(EventList.structureBuilt, {
      structureId,
      timestamp: Game.time,
    });
  },

  /**
   * 发布建筑受损事件
   */
  emitStructureDamaged(structureId: Id<Structure>) {
    return emitEvent(EventList.structureDamaged, {
      structureId,
      timestamp: Game.time,
    });
  },

  /**
   * 发布建筑摧毁事件
   */
  emitStructureDestroyed(structureId: Id<Structure>) {
    return emitEvent(EventList.structureDestroyed, {
      structureId,
      timestamp: Game.time,
    });
  },
};

/**
 * 房间相关事件辅助函数
 */
export const RoomEvents = {
  /**
   * 发布房间占领事件
   */
  emitRoomClaimed(roomName: string) {
    return emitEvent(EventList.roomClaimed, {
      roomName,
      timestamp: Game.time,
    });
  },

  /**
   * 发布房间侦察事件
   */
  emitRoomScouted(roomName: string) {
    return emitEvent(EventList.roomScouted, {
      roomName,
      timestamp: Game.time,
    });
  },

  /**
   * 发布房间等级提升事件
   */
  emitRoomLevelUp(roomName: string) {
    return emitEvent(EventList.roomLevelUp, {
      roomName,
      timestamp: Game.time,
    });
  },

  /**
   * 发布房间等级下降事件
   */
  emitRoomLevelDown(roomName: string) {
    return emitEvent(EventList.roomLevelDown, {
      roomName,
      timestamp: Game.time,
    });
  },

  /**
   * 发布房间失去事件
   */
  emitRoomLost(roomName: string) {
    return emitEvent(EventList.roomLost, {
      roomName,
      timestamp: Game.time,
    });
  },
};

/**
 * 战斗相关事件辅助函数
 */
export const CombatEvents = {
  /**
   * 发布战斗开始事件
   */
  emitCombatStarted(
    roomName: string,
    warType: 'defense' | 'invasion' | 'raid'
  ) {
    return emitEvent(EventList.combatStarted, {
      roomName,
      warType,
      timestamp: Game.time,
    });
  },

  /**
   * 发布战斗结束事件
   */
  emitCombatEnded(roomName: string, warType: 'defense' | 'invasion' | 'raid') {
    return emitEvent(EventList.combatEnded, {
      roomName,
      warType,
      timestamp: Game.time,
    });
  },

  /**
   * 发布战斗胜利事件
   */
  emitCombatVictory(
    roomName: string,
    warType: 'defense' | 'invasion' | 'raid'
  ) {
    return emitEvent(EventList.combatVictory, {
      roomName,
      warType,
      timestamp: Game.time,
    });
  },

  /**
   * 发布战斗失败事件
   */
  emitCombatDefeat(roomName: string, warType: 'defense' | 'invasion' | 'raid') {
    return emitEvent(EventList.combatDefeat, {
      roomName,
      warType,
      timestamp: Game.time,
    });
  },
};
