/**
 * 文件摘要：Jest 配置，用于在 Node 环境运行 test/ 下的 TypeScript 单元测试。
 *
 * 覆盖范围：testMatch 只匹配 *.test.ts，因此 .test.mjs（buildPlugins、frameworkBundle）
 * 由 npm test 中后续的 `node test/*.test.mjs` 命令负责，两者互不重复。ts-jest 直接编译 TS，
 * moduleNameMapper 复用 tsconfig 的 paths，使测试与源码使用同一套 @/、@modules/ 等别名。
 * .html 模板由 test/support/htmlTransform.cjs 转换为默认导出的字符串，对应构建期的
 * htmlString 插件，使 createForm、createHelp 等导入模板的源码可以直接被测试。
 *
 * 前提：不依赖 .secret.json，不执行 rollup 构建，也不发起网络请求；Screeps 全局对象
 * 由各测试自行注入。
 */
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig');

module.exports = {
  preset: 'ts-jest',
  // Screeps 代码不依赖 DOM；游戏全局对象由测试用例按需注入。
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json', 'html'],
  testMatch: ['**/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.html$': '<rootDir>/test/support/htmlTransform.cjs',
  },
  moduleNameMapper: {
    // 从 tsconfig 的 paths 生成映射，避免测试与构建各维护一份别名；
    // prefix '<rootDir>/' 把 './src/*' 这类相对 tsconfig 的路径锚定到 jest 根目录，
    // 防止 jest 工作目录不同导致解析失败；paths 缺失时用 {} 兜底保持配置可用。
    ...pathsToModuleNameMapper(compilerOptions.paths || {}, {
      prefix: '<rootDir>/',
    }),
  },
};
