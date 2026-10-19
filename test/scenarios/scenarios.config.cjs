/**
 * 文件摘要：私服场景测试框架（screeps-integration-tests）的配置，只在测试镜像中使用。
 *
 * 镜像内的布局由 runner/Dockerfile 决定：场景在 /opt/runner/scenarios，产物模块表在 /opt/runner/bot。
 * 缓存与性能报告写入 /work（运行时的内存文件系统，容器退出即释放）。私服底层有进程级单例，场景串行执行。
 */
'use strict';

module.exports = {
  distDir: '/opt/runner/bot',
  scenariosDir: '/opt/runner/scenarios',
  cacheDir: '/work/cache',
  profilesDir: '/work/profiles',
  jobs: 1,
  timeout: 5 * 60 * 1000,
};
