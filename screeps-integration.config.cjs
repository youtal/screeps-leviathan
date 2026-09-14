/**
 * Screeps Integration Tests 的项目级配置。
 *
 * CLI 从 dist/ 读取正式 Rollup 产物，在独立子进程中为每个场景启动 storage、engine runner
 * 与 processor。缓存和性能报告留在 test/integration 下的忽略目录，不污染源码与正式产物。
 * 私服底层仍有进程级单例，因此默认串行执行；增加 jobs 前必须先验证端口与 storage 隔离。
 */
'use strict';

module.exports = {
  distDir: './dist',
  scenariosDir: './test/integration/scenarios',
  cacheDir: './test/integration/.cache',
  profilesDir: './test/integration/profiles',
  jobs: 1,
  timeout: 2 * 60 * 1000,
};
