// 单元测试配置：用 ts-jest 直接运行 TypeScript 测试，类型检查使用 tsconfig.test.json。
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // 用 testMatch 而不是 roots：test/ 为空时 Git 不会保留该目录，roots 指向缺失目录会让 Jest 报错。
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};
