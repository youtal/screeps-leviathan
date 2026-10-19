// 单元测试配置：用 ts-jest 直接运行 TypeScript 测试，类型检查使用 tsconfig.test.json。
/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  // 用 testMatch 而不是 roots：test/ 为空时 Git 不会保留该目录，roots 指向缺失目录会让 Jest 报错。
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // 由 Node 直接运行的脚本以 `.ts` 后缀互相导入，编译时被改写为 `.js`；这里去掉后缀，让 Jest 解析到源文件。
  // `@/` 是 src/ 的别名（tsconfig.json 的 paths），跨模块导入一律使用；Jest 不读 paths，需要在此同步映射。
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
