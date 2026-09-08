import clear from 'rollup-plugin-clear';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import copy from 'rollup-plugin-copy';
import { existsSync, readFileSync } from 'fs';
import { htmlString, screepsUpload } from './build/rollupPlugins.mjs';

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
            transform: (contents) => `module.exports = ${contents.toString()};`,
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
    htmlString({
      htmlMinifierOptions: {
        collapseWhitespace: true,
        collapseInlineTagWhitespace: true,
        minifyCSS: true,
        removeComments: true,
      },
    }),
    // 编译 ts
    typescript({
      tsconfig: './tsconfig.json',
      include: ['src/**/*.ts'],
    }),
    // 执行上传或者复制
    deployPlugin,
  ],
};
