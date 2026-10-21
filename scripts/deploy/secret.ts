/**
 * 文件摘要：读取本机的账户配置 .secret.json，供部署工具（scripts/deploy/cli.ts）与 inspector（scripts/inspector/cli.ts）共用。
 *
 * 所属位置：scripts/deploy/，开发工具，不进入游戏构建产物；由 Node 的类型剥离直接运行。
 * 副作用：读取当前目录的 .secret.json。内容含令牌，只在内存中使用，不输出；错误消息不包含文件内容。
 * 账户的校验与选择在 lib.ts（selectAccount）。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 本机账户配置文件，不进入版本控制。 */
export const SECRET_FILE = '.secret.json';

/**
 * @description 读取并解析当前目录的 .secret.json；内容可能含令牌，只在内存中使用，不输出。
 * @returns 解析后的 JSON 值，交给 lib.ts 校验。
 * @throws {Error} 文件不存在或不是合法 JSON（消息不包含文件内容）。
 */
export const readSecret = (): unknown => {
  if (!existsSync(SECRET_FILE)) {
    throw new Error(`未找到 ${SECRET_FILE}；参照 .secret.json.example 创建`);
  }
  try {
    return JSON.parse(readFileSync(SECRET_FILE, 'utf8'));
  } catch {
    throw new Error(`${SECRET_FILE} 不是合法的 JSON`);
  }
};
