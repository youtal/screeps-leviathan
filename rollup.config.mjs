/**
 * 文件摘要：Rollup 主构建配置，负责把 src/index.ts 打包成 Screeps 可加载的 dist/main.js。
 *
 * 输入是单一入口 src/index.ts（游戏只自动加载 main 模块，其余模块由打包结果内联），
 * 输出是 CJS 格式加 sourcemap。插件顺序有依赖关系：先 clear 清理 dist，再 resolve/commonjs
 * 把 lodash 等 CJS 依赖转成可打包模块，随后 htmlString 处理 html 模板导入，最后 typescript
 * 编译 TS；部署插件必须排在最后并依赖 writeBundle 钩子。
 *
 * 部署行为由 DEST 环境变量决定：未设置时只编译（因此没有 .secret.json 也能构建成功，
 * 见 AGENTS.md 第 7 节）；设置后从 .secret.json 读取对应目标，选择复制到本地目录或上传。
 * 凭据只在构建进程内用于 HTTP 请求头，从不进入模块图，所以产物里不含任何密钥。
 */
import clear from 'rollup-plugin-clear';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import copy from 'rollup-plugin-copy';
import { existsSync, readFileSync } from 'fs';
import {
  htmlString,
  screepsUpload,
  sourceMapModule,
} from './build/rollupPlugins.mjs';

// DEST 由外部注入：npm start 通过 --environment DEST:main 传入，build/upload.mjs 则先写
// process.env 再动态加载本文件。三种情况必须区分清楚：未指定 → 只编译；指定但缺少
// .secret.json 或目标不存在 → 立即抛错，避免「以为上传了其实没有」。
let config = null;
const destination = process.env.DEST;

if (!destination) {
  console.log('dest is not specified, compiling but not uploading');
} else if (!existsSync('.secret.json')) {
  throw new Error(
    '.secret.json is required when DEST is specified; copy .secret.json.example and fill in the target configuration'
  );
} else {
  const configData = JSON.parse(readFileSync('.secret.json', 'utf8'));

  if (!configData[destination]) {
    throw new Error(
      `Upload destination "${destination}" is not defined in .secret.json`
    );
  } else {
    config = configData[destination];
  }
}

// 根据指定的配置决定是上传还是复制到文件夹
// 部署策略二选一：配置了 copyPath 说明目标是本地目录（连同 sourcemap 一起复制，并与 API
// 上传共用 sourceMapModule：剥离 sourcesContent、包装成 module.exports 供游戏内 require）；
// 否则走 screepsUpload 上传到分支；
// 没有 config 时为 null，rollup 会忽略这个 falsy 插件项。
const deployPlugin =
  config && config.copyPath
    ? // 复制到指定路径
      copy({
        targets: [
          {
            src: 'dist/main.js',
            dest: config.copyPath,
          },
          {
            src: 'dist/main.js.map',
            dest: config.copyPath,
            rename: (name) => name + '.map.js',
            transform: (contents) => sourceMapModule(contents.toString()),
          },
        ],
        hook: 'writeBundle',
        verbose: true,
      })
    : config
      ? screepsUpload({ config })
      : null;

export default {
  input: 'src/index.ts',
  // CJS 单文件输出：Screeps 运行时按 CommonJS 加载模块；sourcemap 用于线上错误的 TS 栈映射。
  output: {
    file: 'dist/main.js',
    format: 'cjs',
    sourcemap: true,
  },
  plugins: [
    // 清除上次编译成果
    clear({ targets: ['dist'] }),
    // 打包依赖
    resolve(),
    // 模块化依赖
    commonjs(),
    // 构建可能存在的 html 文件
    // htmlString 必须排在 typescript 之前：先让 .html 变成可导入的 JS 模块，TS 才能解析这些 import。
    htmlString({
      htmlMinifierOptions: {
        collapseWhitespace: true,
        collapseInlineTagWhitespace: true,
        minifyCSS: true,
        removeComments: true,
      },
    }),
    // 编译 ts
    // include 限定只编译 src：测试文件由 ts-jest 单独处理，不进入游戏产物。
    typescript({
      tsconfig: './tsconfig.json',
      include: ['src/**/*.ts'],
    }),
    // 执行上传或者复制
    deployPlugin,
  ],
};
