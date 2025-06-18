import clear from "rollup-plugin-clear";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "rollup-plugin-typescript2";
import screeps from "rollup-plugin-screeps";
import copy from "rollup-plugin-copy";
import html from "rollup-plugin-html";
import configData from "./.secret.json";

let config = null;
if (!process.env.DEST)
  console.log("dest is not specified, compiling but not uploading");
else if (!configData[process.env.DEST]) {
  console.log("specified dest is not found in secret.json, please check");
} else {
  config = configData[process.env.DEST];
}

// 根据指定的配置决定是上传还是复制到文件夹
const deployPlugin =
  config && config.copyPath
    ? // 复制到指定路径
      copy({
        targets: [
          {
            src: "dist/main.js",
            dest: config.copyPath,
          },
          {
            src: "dist/main.js.map",
            dest: config.copyPath,
            rename: (name) => name + ".map.js",
            transform: (contents) => `module.exports = ${contents.toString()};`,
          },
        ],
        hook: "writeBundle",
        verbose: true,
      })
    : // 更新 .map 到 .map.js 并上传
      screeps({ config, dryRun: !config });

export default {
  input: "src/index.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    // 清除上次编译成果
    clear({ targets: ["dist"] }),
    // 打包依赖
    resolve(),
    // 模块化依赖
    commonjs(),
    // 构建可能存在的 html 文件
    html({
      include: "**/*.html",
      htmlMinifierOptions: {
        collapseWhitespace: true,
        collapseInlineTagWhitespace: true,
        minifyCSS: true,
        removeComments: true,
      },
    }),
    // 编译 ts
    typescript({ tsconfig: "./tsconfig.json" }),
    // 执行上传或者复制
    deployPlugin,
  ],
};
