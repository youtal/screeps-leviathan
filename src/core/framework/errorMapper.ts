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
