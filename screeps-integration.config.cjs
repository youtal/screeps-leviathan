/**
 * Screeps Integration Tests 的项目级配置。
 *
 * CLI 从 dist/ 读取正式 Rollup 产物，在独立子进程中为每个场景启动 storage、engine runner
 * 与 processor。输入来自只读镜像；缓存和性能报告写入 /work 临时内存目录，容器退出即释放。
 * 私服底层仍有进程级单例，因此默认串行执行；增加 jobs 前必须先验证端口与 storage 隔离。
 */
'use strict';

const path = require('node:path');

module.exports = {
  distDir: path.join(__dirname, 'dist'),
  scenariosDir: path.join(__dirname, 'test/integration/scenarios'),
  cacheDir: '/work/cache',
  profilesDir: '/work/profiles',
  jobs: 1,
  timeout: 2 * 60 * 1000,
};
