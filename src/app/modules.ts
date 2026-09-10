/**
 * 文件摘要：声明 app 层使用的服务插件，业务工厂由 Framework 的 setup 调用。
 * RoomShortcuts 只依赖注入上下文，Kernel 不导入业务实现。
 * 事件订阅经框架自动登记清理，停用后释放，重新启用时重建模块闭包缓存。
 */
import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import type { LeviathanPlugin } from '@/core/framework';

/**
 * 将既有查询工厂适配为基础服务，不添加业务决策钩子。
 * 本插件不声明持久化；房间索引驻留工厂闭包，重启后按查询重新建立。
 * critical 允许低 bucket 时初始化基础查询能力，但仍受内核硬预算检查限制。
 * 使用者声明 requires: ['roomShortcuts']，再通过 services.get 取得工厂返回的查询接口。
 */
export const roomShortcutsPlugin: LeviathanPlugin = {
  manifest: {
    id: 'roomShortcuts',
    version: 1,
    provides: ['roomShortcuts'],
    critical: true,
  },
  // 工厂在此订阅全局事件，框架代理自动登记释放；服务在 setup 成功后供依赖者访问。
  setup(context) {
    context.services.provide('roomShortcuts', createRoomShortcuts(context));
  },
};
