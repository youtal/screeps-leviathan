// 构建配置：把 src/main.ts 打包为 Screeps 可直接运行的单个 CommonJS 文件 dist/main.js，并输出 source map。
// 游戏运行时不能加载外部模块，所有依赖都必须打进这一个文件；运行时不引入任何 npm 包。
//
// 版本号注入：内联插件提供虚拟模块 virtual:release，导出 package.json 的 version，由 app.assembly 写入新建的项目标记
// （docs/design/kernel/bootPort.md 第 6 节）。不新增依赖；类型声明在 src/env.d.ts，测试由 Jest 映射到替身。
import { readFileSync } from 'node:fs';

import typescript from '@rollup/plugin-typescript';

/** 虚拟模块名与 rollup 内部 id（\0 前缀约定表示虚拟模块，其他插件不会把它当作文件处理）。 */
const RELEASE_ID = 'virtual:release';
const RELEASE_INTERNAL = '\0virtual:release';

/**
 * @description 提供 virtual:release 的内联插件；版本号在构建开始时确定一次。
 * @returns rollup 插件对象。
 */
const release = () => {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  return {
    name: 'release',
    /**
     * @description 把虚拟模块名解析为内部 id。
     * @param id 导入说明符。
     * @returns 内部 id；其他模块交给后续插件。
     */
    resolveId: (id) => (id === RELEASE_ID ? RELEASE_INTERNAL : null),
    /**
     * @description 生成虚拟模块的源码。
     * @param id 模块 id。
     * @returns 导出 release 常量的源码；其他模块交给后续插件。
     */
    load: (id) => (id === RELEASE_INTERNAL ? `export const release = ${JSON.stringify(version)};` : null),
  };
};

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    exports: 'named',
    sourcemap: true,
  },
  plugins: [release(), typescript({ tsconfig: './tsconfig.json', noEmit: false, rootDir: 'src', outDir: 'dist' })],
};
