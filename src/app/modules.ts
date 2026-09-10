/**
 * 文件摘要：声明 app 层使用的服务插件，业务工厂由 Framework 的 setup 调用。
 * RoomShortcuts 只依赖注入上下文，Kernel 不导入业务实现。
 * 事件订阅经框架自动登记清理，停用后释放，重新启用时重建模块闭包缓存。
 *
 * 本文件是业务模块与 Framework 之间的适配层：业务工厂保持“只接收上下文、
 * 返回能力对象”的既有形态，插件负责把这份能力注册成依赖者可见的服务。
 * 因此这里不导入 Kernel 内部实现，新增模块也只需追加一个插件描述。
 */
import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import type { LeviathanPlugin } from '@/core/framework';

/**
 * 将既有查询工厂适配为基础服务，不添加业务决策钩子。
 * 本插件不声明持久化；房间索引驻留工厂闭包，重启后按查询重新建立。
 * critical 允许低 bucket 时初始化基础查询能力，但仍受内核硬预算检查限制。
 * 使用者声明 requires: ['roomShortcuts']，再通过 services.get 取得工厂返回的查询接口。
 *
 * manifest 字段与内核语义一一对应：id 是诊断、服务归属与熔断统计的键，注册后必须稳定；
 * version 是 Memory schema 版本，未声明 persistence 的插件不会创建分区，版本目前只用于
 * 未来的 migrate 校验；provides 中的服务必须在 setup 内发布，否则 setup 判定失败并回滚；
 * critical 让它在低 bucket 时也能通过准入，代价是熔断后会触发内核 safeMode。
 * 插件不注册任何 onTick* 钩子：它的运行期行为完全由 RoomShortcuts 在 setup 期间订阅的
 * 事件和外部查询驱动，因此这里只需要 setup 一个生命周期入口，也不存在每 tick 固定开销。
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
