/**
 * 文件摘要：预留 source map 堆栈还原功能所需的依赖与实现位置。
 *
 * 当前尚未导出运行时行为；保留导入是为了明确后续错误映射将使用
 * `source-map` 解析位置，并复用控制台的红色文本格式。
 */
import { SourceMapConsumer } from 'source-map';
import { dyeRed } from '@/utils/console';

/**
 * Source map 错误映射模块占位。
 *
 * 未来这里会负责把压缩/打包后的 Screeps 运行时堆栈映射回 TypeScript 源码位置，
 * 并用控制台染色工具输出更可读的错误信息。
 *
 * 当前文件只保留依赖引用，实际功能尚未实现。
 */
