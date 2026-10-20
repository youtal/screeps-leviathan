/**
 * 文件摘要：面向使用者的运行开关（架构设计 4.3），集中存放经常需要手动切换的设置。
 *
 * 所属位置：src/settings.ts，根目录文件。只导入 contracts 中的类型，只被 app.assembly 与 main.ts 导入（边界测试检查）；
 * kernel 等层不直接读取它，由装配方把其中的值作为参数注入。调参用的配置表（身体模板、阈值等）仍在 app.config。
 * 组织方式：每个模块一个具名常量，命名为 `<模块名>Settings`，类型为 src/contracts/settings.ts 中的同名接口。
 * 本文件只含常量，没有运行时副作用。
 */
import type { LoggerSettings, MemorySettings, ProfilerSettings } from '@/contracts/settings';

/** kernel.logger：各级别默认开关（debug 关闭，其余打开）与前缀上色。 */
export const loggerSettings: LoggerSettings = {
  levels: { debug: false, info: true, success: true, warn: true, error: true },
  color: true,
};

/** kernel.memory：每次提交抽查的未标脏单元数，0 关闭；私服调试与场景测试时可改为例如 4。 */
export const memorySettings: MemorySettings = {
  auditUnits: 0,
};

/** kernel.profiler：是否对动态实例单独计时，默认关闭。 */
export const profilerSettings: ProfilerSettings = {
  instances: false,
};
