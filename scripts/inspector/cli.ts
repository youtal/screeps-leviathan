/**
 * 文件摘要：inspector 的命令行入口，由 package.json 的 inspect 脚本调用（设计见 docs/proposal/2026-10-21-m1-scope.md 第 4 节）。
 *
 * 所属位置：scripts/inspector/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行，不经编译。
 * 用法见 lib.ts 的 USAGE。每条命令都必须用 --account 指定 .secret.json 中的账户，可选 --shard（官服）。
 * 流程：解析参数 → 选择账户 → 经 scripts/deploy/api.ts 的只读接口读取 Memory 或 segment → 由 lib.ts 解码并格式化输出。
 * 副作用：读取 .secret.json；向服务器发起只读请求，不写入 Memory、segment 或代码。输出不包含令牌。
 */
import { createApi } from '../deploy/api.ts';
import { selectAccount } from '../deploy/lib.ts';
import { readSecret } from '../deploy/secret.ts';
import { decodeMemoryData, formatMarker, formatSegment, formatSizes, formatValue, parseInspectArgs } from './lib.ts';

/**
 * @description 执行一条命令并输出结果。
 * @returns 无返回值；结果写到标准输出。
 * @throws {Error} 参数错误、账户配置错误或请求失败。
 */
const main = async (): Promise<void> => {
  const args = parseInspectArgs(process.argv.slice(2));
  const api = createApi(selectAccount(readSecret(), args.account));
  switch (args.command) {
    case 'marker':
      console.log(formatMarker(decodeMemoryData(await api.getMemory(undefined, args.shard))));
      break;
    case 'sizes':
      console.log(formatSizes(decodeMemoryData(await api.getMemory(undefined, args.shard))));
      break;
    case 'get':
      console.log(formatValue(args.path!, decodeMemoryData(await api.getMemory(args.path, args.shard))));
      break;
    case 'segment':
      console.log(formatSegment(args.segment!, await api.getSegment(args.segment!, args.shard)));
      break;
  }
};

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
