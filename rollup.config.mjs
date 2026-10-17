// 构建配置：把 src/main.ts 打包为 Screeps 可直接运行的单个 CommonJS 文件 dist/main.js，并输出 source map。
// 游戏运行时不能加载外部模块，所有依赖都必须打进这一个文件；运行时不引入任何 npm 包。
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    exports: 'named',
    sourcemap: true,
  },
  plugins: [typescript({ tsconfig: './tsconfig.json', noEmit: false, rootDir: 'src', outDir: 'dist' })],
};
