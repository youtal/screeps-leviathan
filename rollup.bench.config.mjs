// bench 专用产物的构建配置：把 test/bench/main.ts 打包为 dist/bench/main.js，由 scripts/bench/cli.ts 调用。
// 产物只在私服场景镜像中替代正常的 bot 运行，不上传到任何服务器。被测代码经 `@/` 别名从 src/ 导入，
// 编译选项继承 tsconfig.json，tsconfig.bench.json 只把 test/bench 加入编译范围；rootDir 放宽到仓库根目录。
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'test/bench/main.ts',
  output: {
    file: 'dist/bench/main.js',
    format: 'cjs',
    exports: 'named',
    sourcemap: true,
  },
  plugins: [typescript({
    tsconfig: './tsconfig.bench.json',
    noEmit: false,
    rootDir: '.',
    outDir: 'dist/bench',
  })],
};
