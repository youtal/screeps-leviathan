/**
 * 文件摘要
 *
 * 模块角色：utils/console 的基础文本工具实现，供日志前缀、表单和帮助渲染共用。
 *
 * 主要功能：替换模板占位符、删除换行、转义外来文本、校验写入脚本的标识符，
 * 以及生成着色文字、普通链接和当前 shard 的房间链接。
 *
 * 实现过程：replaceHtml 逐键执行全局正则替换，fixRetraction 删除换行字符；escapeHtml 按字符表
 * 替换标记字符，assertScriptSafe 用正则拒绝会破坏属性或内联脚本的字符；着色与链接函数拼接 HTML，
 * createRoomLink 调用时读取 Game.shard.name，再委托 createLink 生成链接。
 *
 * 技术要点：没有结果缓存或日志输出；除房间链接需读取 Game 外，结果由传入参数决定。
 * replaceHtml 的键按字面量匹配、值按字面量插入（`$` 模式不生效），但不做 HTML 转义：
 * 控制台按 HTML 渲染输出并执行内联事件处理器，外来文本必须先经 escapeHtml，
 * 会进入属性或脚本的标识符必须先经 assertScriptSafe。信任边界见 docs/design/utils/console.md。
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
 * - 键名先做正则转义再拼入表达式，含 `.`、`*` 等元字符的键名按字面量匹配；
 * - 替换值通过函数形式返回，`$&`、`` $` ``、`$'`、`$n`、`$$` 原样输出，不会被当作替换模式；
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
    // 转义键名中的正则元字符（含花括号）；函数形式的替换值绕开 `$` 模式解释。
    const escaped = nxtKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(
      new RegExp(`\\{${escaped}\\}`, 'g'),
      () => replaceContent[nxtKey]
    );
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
 * HTML 标记字符 → 实体。用对照表而不是链式 replace：`&` 必须与其它字符在同一趟替换中
 * 处理，否则先替换 `&` 会把后续实体里的 `&` 再转义一次（`<` → `&amp;lt;`）。
 *
 * 除了常规的 `& < > " '`，这里还转义花括号：replaceHtml 逐键替换且结果会参与后续键的
 * 替换，文本中出现 `{content}` 这类占位符时会被下一个键的值顶替。转义为实体后，浏览器
 * 仍按 `{`、`}` 渲染，但不再与占位符语法碰撞。
 */
const HTML_ESCAPES: { [char: string]: string } = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '{': '&#123;',
  '}': '&#125;',
};

/**
 * 把外来文本转义为纯文本，供写入元素内容或属性值。
 *
 * Screeps 控制台以 HTML 渲染日志并执行内联事件处理器，因此其他玩家可以控制的字符串
 * （敌方 creep 名称、控制器签名、公开的 saying，以及拼进异常消息的同类文本）在进入
 * 控制台输出前必须经过这里，否则可能在浏览器会话中执行脚本。
 *
 * 只做一次正则替换，成本与文本长度线性相关；不改变非标记字符，也不处理 URL 语义
 * （链接地址的可信性由调用方保证）。
 *
 * @param text 外来文本
 * @returns 可安全写入元素内容或带引号属性的文本
 */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"'{}]/g, (char) => HTML_ESCAPES[char]);

/**
 * 标识符禁用字符：破坏属性或内联脚本的标记字符、引号、转义符、花括号与控制字符。
 * 控制字符（含换行）会截断属性或让内联脚本出现新语句，因此一并拒绝。
 */
const UNSAFE_TOKEN = /[<&"'`\\{}\u0000-\u001f\u007f]/;

/**
 * 会被写进属性与内联脚本的标识符（表单名、字段名、命令、帮助的函数名）的字符白名单校验。
 *
 * 为什么不转义而是拒绝：这些值同时出现在两种上下文里，例如表单名既在 `name="…"` 属性中，
 * 又在 `document.forms['…']` 这个位于属性内部的 JS 字符串里。跨上下文转义需要先做 JS
 * 字符串转义再做 HTML 属性转义，顺序错一次就会留下注入点；而这些值本来就只需要标识符，
 * 直接拒绝可疑字符更可靠，也让错误在渲染时立刻暴露。
 *
 * 拒绝的内容：`< & " ' 反引号 \ { }` 与控制字符。其中 `{` 同时挡住模板字符串的 `${`
 * 与 replaceHtml 的占位符语法。允许空格与非 ASCII 文本，因此中文表单名仍可使用。
 *
 * @param kind 出错信息中的用途名称
 * @param value 待校验的文本
 * @returns 原值，便于在表达式中串联使用
 */
export const assertScriptSafe = (kind: string, value: string): string => {
  if (typeof value !== 'string' || value === '' || UNSAFE_TOKEN.test(value)) {
    throw new Error(`Unsafe ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
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
