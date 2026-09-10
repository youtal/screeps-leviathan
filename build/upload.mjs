/**
 * 文件摘要：命令行上传入口（npm run upload / npm run upload:validation）。
 *
 * 职责：解析 CLI 目标 → 写入 process.env.DEST → 加载 rollup 配置 → 执行真实构建 →
 * 由 writeBundle 中的部署插件上传或复制产物。输入来自 process.argv，副作用是写 dist/
 * 并发起真实网络请求（使用 .secret.json 中的目标配置，缺失时 rollup.config.mjs 直接抛错）。
 * 构建或上传失败时异常向上冒泡，使进程以非零码退出，便于 CI 察觉。
 */
import { rollup } from 'rollup';
import { parseUploadDestination } from './rollupPlugins.mjs';

const destination = parseUploadDestination(process.argv.slice(2));

// rollup.config.mjs 在模块顶层读取 DEST 来决定部署插件，因此必须在它被求值之前写入环境变量。
process.env.DEST = destination;

// 这里必须用动态 import：静态 import 会被提升到赋值之前，导致 DEST 尚未设置就被读取。
const { default: config } = await import('../rollup.config.mjs');
const bundle = await rollup(config);

try {
  await bundle.write(config.output);
} finally {
  // 即使 writeBundle（上传）抛错也要关闭 bundle，释放 rollup 缓存与文件句柄，避免进程无法退出。
  await bundle.close();
}
