/**
 * 文件摘要：Logger 内核模块的公共出口：装配工厂、兜底工厂与契约类型转导。
 *
 * 模块位置：core/logger 的 barrel。Runtime 在装配阶段调用 createLogging 创建
 * 唯一工厂，再注入模块环境与内核消费者；Framework 过渡期接受可选注入，缺省
 * 使用本文件的兜底工厂，保证 createBus()、createEnvMethods() 等独立调用仍可用。
 *
 * 主要能力：createLogging（装配级工厂，遵守 `src/contracts/logging.ts` 的
 * LoggerFactory 协议）与 defaultLoggerFactory（未注入时的进程内兜底实例）。
 * 本文件不定义日志行为、不访问 Game/Memory，导入它只建立函数与一个纯闭包。
 *
 * 状态与副作用：defaultLoggerFactory 在模块求值期创建一次，只解析默认配置并
 * 持有端口引用；在某个作用域真正输出之前不会调用 console 或 Game。global reset
 * 后模块重新求值，兜底实例随之重建，行为与首次加载一致。
 */
import type { LoggerFactory } from '@/contracts/logging';
import { createLogging } from './createLogging';

export { createLogging } from './createLogging';

/**
 * 未接入 Runtime 时的兜底工厂。
 *
 * 只服务独立调用（例如直接 new 一个总线、单独创建 env、复用错误映射器）和测试；
 * 正常运行时 Runtime/Framework 会把共享工厂注入各消费者，因此不会产生第二套
 * 等级或输出配置。它是 heap 单例，不读写 Memory，也不跨 global reset 保留。
 */
export const defaultLoggerFactory: LoggerFactory = createLogging();

/**
 * 公共协议整体转导：契约只含类型，编译后不留下代码，新增日志类型无需在此登记。
 */
export type * from '@/contracts/logging';
