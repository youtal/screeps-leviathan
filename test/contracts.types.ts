/**
 * 文件摘要：编译期契约回归；由 tsc 检查，不由 Jest 执行。
 *
 * 覆盖范围：Memory 访问判别联合、事件作用域与载荷对应、Logger 完整形状与作用域
 * 覆盖、插件清单与上下文的边界。负例必须保留 `@ts-expect-error` 错误，防止公共
 * 能力、事件载荷或 readonly 边界意外放宽；正例则保证契约仍可被正常实现承诺。
 *
 * 运行方式：随 `npx tsc --noEmit` 编译；不进入 Jest（testMatch 只收 *.test.ts）。
 */
import type {
  Bus,
  Logger,
  LoggerFactory,
  LoggingOptions,
  MemoryAccess,
  PluginContext,
  PluginManifest,
} from '@/contracts';

interface State {
  nested: { count: number };
  items: { value: number }[];
}
export function verifyContracts(
  access: MemoryAccess<State>,
  bus: Bus,
  context: PluginContext
) {
  if (access.status === 'pending') {
    // @ts-expect-error pending 不提供读取能力
    access.query();
  } else {
    const snapshot = access.query();
    // @ts-expect-error interface 形状的嵌套字段也必须只读
    snapshot.nested.count++;
    // @ts-expect-error 数组元素必须递归只读
    snapshot.items[0].value++;
    const result: number = access.commit((state) => ++state.nested.count);
    void result;
  }
  // @ts-expect-error 已移除旧持久化能力
  context.persistence.query();
  // @ts-expect-error room 作用域必须提供 roomName
  bus.publish({ scope: 'room' }, 'creep:death', { creepName: 'worker' });
  // @ts-expect-error 事件载荷必须与事件名一致
  bus.publish({ scope: 'global' }, 'creep:death', { roomName: 'W1N1' });
}

// @ts-expect-error 缺少其余日志等级，不能承诺完整 Logger
const incompleteLogger: Logger = { info: (_content: string) => {} };
const manifest: PluginManifest = {
  id: 'example',
  version: 1,
  // @ts-expect-error 旧持久化声明不是插件清单协议
  persistence: { layer: 'critical' },
};
void incompleteLogger;
void manifest;

/** 日志装配与作用域协议的正例：装配级配置 + 作用域覆盖都应可组合。 */
export function verifyLoggingContract(factory: LoggerFactory): Logger {
  const options: LoggingOptions = {
    levels: { report: false },
    notify: 'error',
    notifyInterval: 30,
    output: { write: (_line: string) => {} },
  };
  void options;
  // @ts-expect-error 作用域等级键必须来自 LogOptions（warning 不是对外契约键）
  factory.scope('contract', { levels: { warning: true } });
  return factory.scope('contract', { levels: { debug: true }, notify: true });
}
