/**
 * 文件摘要：提供控制台模板替换、文本着色与链接生成等纯文本工具。
 *
 * 模块位置：src/utils/console 的基础实现层，被 console/index.ts 作为公共出口转发，
 * 同时被 form/、help/ 两个渲染器复用（它们只负责拼装模板，不做着色与输出）。
 * 日志能力已迁入 core/logger，本文件只保留它的格式化依赖（Color、dyeText、dye*）。
 *
 * 主要输入 / 输出：输入是普通字符串与颜色常量，输出是可直接 console.log 的 HTML
 * 字符串。所有函数（replaceHtml、fixRetraction、dyeText、dye*、createLink、
 * createRoomLink）都是纯函数：不读写 Memory、不写输出、不缓存状态。
 *
 * 外部依赖：无。生成的 HTML 面向 Screeps 控制台渲染环境，因此可以直接使用
 * span/style/a 等标记；着色函数与 Logger 共用，但不因此让本文件依赖 core。
 */
/**
 * 占位符名称到替换文本的映射。
 *
 * 键同时充当正则片段，值会被原样插入（不做 HTML 转义），因此调用方需要对内容负责。
 */
interface ReplaceContent {
  [placeholder: string]: string;
}

/**
 * 将内容插入 HTML 模板。
 *
 * 实现方式与取舍：以 Object.keys 的顺序对每个键执行一次全局正则替换，而不是先扫描
 * 模板再一次性替换。模板规模很小（几百字符），多次 replace 的常数开销可以忽略，
 * 换取的是无需解析模板语法即可支持任意占位符名。
 *
 * 边界条件（使用时需要留意）：
 * - 键名被直接拼进正则表达式，含正则元字符的键名会改变匹配语义，约定只用标识符式名称；
 * - 替换值通过 String.replace 的字符串形式写入，值中的 `$&`、`` $` ``、`$'`、`$n`
 *   会被当作替换模式解释，需要字面量 `$` 时应先自行转义；
 * - 按顺序逐键替换，若某个替换结果中又包含后续待替换的占位符，会被继续替换（级联）；
 * - 模板中未出现在映射里的 `{...}` 原样保留。
 *
 * @param html 要进行替换的模板 html
 * @param replaceContent 要替换的内容
 * @returns 替换完成的 html 内容
 */
export const replaceHtml = function (
  html: string,
  replaceContent: ReplaceContent = {}
): string {
  return Object.keys(replaceContent).reduce((html, nxtKey) => {
    return html.replace(new RegExp(`{${nxtKey}}`, 'g'), replaceContent[nxtKey]);
  }, html);
};

/**
 * 删除模板换行，避免控制台对多行 HTML/内嵌脚本的缩进解析产生干扰。
 *
 * Screeps 控制台按行拆分 console.log 的内容，换行会让同一段 HTML 被拆成多条消息并
 * 破坏面板排版，因此输出前统一折叠为单行。只处理 `\n`，不处理 `\r`。
 *
 * 调用约定：折叠后行注释不会自动换行，因此被拼接的 HTML 内嵌脚本不应使用 `//` 行注释，
 * 否则同一行后续语句会被一并注释掉；需要注释时应使用块注释。
 *
 * @param html 要进行修复的 html 字符串
 * @returns 修复完成的 html 字符串
 */
export const fixRetraction = (html: string): string => {
  return html.replace(/\n/g, '');
};

/**
 * 控制台文本使用的固定调色板，值可直接写入 CSS color 属性。
 *
 * 颜色按深色控制台背景选择对比度，集中定义避免各模块自行写死色值。
 * 这里使用普通 enum 而不是 const enum：前者在产物中是真实对象，可被 JS 运行时
 * 与调试代码读取，也不依赖编译器的常量内联策略；代价是模块级多一个小常量表。
 */
export enum Color {
  Yellow = '#b58a00',
  Orange = '#cc4c18',
  Red = '#dd332f',
  Magenta = '#d53783',
  Violet = '#6c71c4',
  Blue = '#278bd2',
  Cyan = '#2aa199',
  Green = '#869a01',
}

/**
 * 用 span 包装文本，并按需添加颜色和粗体样式。
 *
 * 两个样式片段都允许为空：color 传 null 时只应用粗体，bold 为 false 时只应用颜色，
 * 两者都缺省时退化为无样式的 span（仍保留 span 结构，便于调用方统一拼接）。
 * 内联 style 而非 class，是为了让输出不依赖控制台页面的外部样式表。
 * content 不做 HTML 转义，调用方需自行保证内容可信。
 *
 * @param content 要添加颜色的文本
 * @param colorName 要添加的颜色常量字符串
 * @param bolder 是否加粗
 */
export const dyeText = (
  content: string,
  color: Color | null = null,
  bold = false
): string => {
  const colorStyle = color ? `color: ${color};` : '';
  const boldStyle = bold ? 'font-weight: bold;' : '';
  return `<span style="${colorStyle} ${boldStyle}">${content}</span>`;
};

/**
 * 语义化着色快捷方法：把具体色号收敛为“绿色=成功、红色=错误、橙色=警告”等约定，
 * 调用方只表达语义，换配色时不需要改动业务代码。bold 省略时为 undefined，
 * 由 dyeText 的默认参数按“不加粗”处理。
 */
export const dyeGreen = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Green, bold);
export const dyeRed = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Red, bold);
export const dyeBlue = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Blue, bold);
export const dyeYellow = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Yellow, bold);
export const dyeCyan = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Cyan, bold);
export const dyeMagenta = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Magenta, bold);
export const dyeViolet = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Violet, bold);
export const dyeOrange = (content: string, bold?: boolean): string =>
  dyeText(content, Color.Orange, bold);

/**
 * 生成控制台可点击的 HTML 链接。
 *
 * Screeps 控制台会把日志按 HTML 渲染，因此这里直接输出 a 标签。newTab 默认 true，
 * 使外部链接不打断游戏页面；url 与 content 都不做转义，调用方需保证其可信。
 *
 * @param content 要显示的内容
 * @param url 要跳转到的 url
 * @param newTab 是否在新标签页打开
 */
export function createLink(
  content: string,
  url: string,
  newTab = true
): string {
  return `<a href="${url}" target="${
    newTab ? '_blank' : '_self'
  }">${content}</a>`;
}

/**
 * 为房间名生成指向当前 shard 对应房间的控制台链接。
 *
 * 链接在调用时才读取 `Game.shard.name`，因此模块加载期不依赖 Game，可用于打印
 * 本 tick 观察到的任意房间（包括其它 shard 的房名需另行拼接）。固定使用 newTab=false：
 * 游戏页面本身是单页应用，在同一标签页内跳转可以保留控制台上下文。
 *
 * @param roomName 添加调整链接的房间名
 * @returns 打印在控制台上后可以点击跳转的房间名
 */
export function createRoomLink(roomName: string): string {
  return createLink(
    roomName,
    `https://screeps.com/a/#!/room/${Game.shard.name}/${roomName}`,
    false
  );
}
