/**
 * 文件摘要
 *
 * 模块角色：app 中连接业务模块与框架插件接口的文件，决定业务能力如何成为服务。
 *
 * 主要功能：声明 roomShortcuts 插件，向其他插件提供同名房间查询服务。
 *
 * 实现过程：在 manifest 中登记插件名、服务名和 critical 标记；setup 接收框架上下文，
 * 调用 createRoomShortcuts，再用 services.provide 发布返回的查询方法。
 *
 * 技术要点：导入时只生成插件描述；房间缓存和事件订阅在 setup 时创建。
 * 订阅由框架记录并在停用时释放，重新启用或 global reset 后重新建立；
 * onTickBegin 仅负责按配置间隔清扫过期缓存。
 */
import {
  createRoomShortcuts,
  RoomShortcutsService,
} from '@/modules/roomShortcuts';
import type { LeviathanPlugin } from '@/contracts';

/**
 * 将既有查询工厂适配为基础服务，不添加业务决策钩子。
 * 本插件只使用可重建缓存；房间索引驻留工厂闭包，重启后按查询重新建立。
 * critical 允许低 bucket 时初始化基础查询能力，但仍受内核硬预算检查限制。
 * 使用者声明 requires: ['roomShortcuts']，再通过 services.get 取得工厂返回的查询接口。
 *
 * manifest 字段与内核语义一一对应：id 是诊断、服务归属与熔断统计的键，注册后必须稳定；
 * version 是插件协议版本，不触发 Memory 迁移；provides 中的服务必须在 setup 内发布，
 * 否则 setup 判定失败并回滚；服务令牌把公开查询接口与服务名绑定，内部清扫仍走原入口；
 * critical 让它在低 bucket 时也能通过准入，代价是熔断后会触发内核 safeMode。
 * 插件只注册 onTickBegin 一个运行期钩子，用于调用模块的缓存回收：查询与事件驱动的行为都
 * 由 RoomShortcuts 在 setup 期间订阅的事件和外部查询完成，回收则需要一个不依赖查询的时机，
 * 否则只被查询过一次的房间索引会一直留在 heap 中。未到清扫间隔时该钩子只是一次比较。
 */
export const roomShortcutsPlugin: LeviathanPlugin = {
  manifest: {
    id: 'roomShortcuts',
    version: 1,
    provides: [RoomShortcutsService.name],
    critical: true,
  },
  // 工厂在此订阅全局事件，框架代理自动登记释放；服务在 setup 成功后供依赖者访问。
  setup(context) {
    context.services.provide(
      RoomShortcutsService,
      createRoomShortcuts(context)
    );
  },
  /**
   * 缓存回收：按“使用时读取服务”的规则取回自身服务，不在 setup 中缓存实例。
   * CPU 不足时跳过，回收可以推迟到下一 tick；本插件是 critical，钩子里不做其他工作。
   */
  onTickBegin(context) {
    if (!context.cpu.admit()) return;
    context.services
      .get<ReturnType<typeof createRoomShortcuts>>('roomShortcuts')
      .sweep(context.tick);
  },
};
