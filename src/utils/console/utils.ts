import { DEFAULT_LOG_CONFIG } from '@/setting';

interface ReplaceContent {
  [placeholder: string]: string;
}

/**
 * 将内容插入到 html 模板
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
 * 修复 js 内容缩进引起的问题
 *
 * @param html 要进行修复的 html 字符串
 * @returns 修复完成的 html 字符串
 */
export const fixRetraction = (html: string): string => {
  return html.replace(/\n/g, '');
};

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
 * 给指定文本添加颜色
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
 * 生成控制台链接
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
 * 给房间内添加跳转链接
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

/**
 * 全局日志
 *
 * @param content 日志内容
 * @param prefix 日志前缀
 * @param color 日志前缀颜色
 * @param notify 是否发送邮件
 */
export function log(
  content: string,
  prefix: string,
  color: Color,
  enable: boolean,
  notify: boolean
): void {
  if (!enable) return;

  // 颜色仅对前缀生效
  const formattedPrefix = prefix ? dyeText(`[${prefix}] `, color, true) : '';
  const formattedContent = `${formattedPrefix}${content}`;
  console.log(formattedContent);
  if (notify) {
    Game.notify(formattedContent, 60);
  }

  return;
}

/**
 * 生成快捷日志方法
 * @param prefix 模块日志前缀
 * @param opt 日志配置
 * @param notifyWhenError 是否在出现错误时发送邮件
 */
export const createLog = (
  prefix: string,
  opt: LogOptions,
  notifyWhenError = false
) => {
  const { debug, warn, error, success, info } = opt;
  const {
    debug: defaultDebug,
    warning: defaultWarning,
    error: defaultError,
    success: defaultSuccess,
    info: defaultInfo,
  } = DEFAULT_LOG_CONFIG;

  return {
    debug: (content: string) =>
      log(content, prefix, Color.Blue, debug ?? defaultDebug, false),
    warn: (content: string) =>
      log(content, prefix, Color.Orange, warn ?? defaultWarning, false),
    error: (content: string) =>
      log(content, prefix, Color.Red, error ?? defaultError, notifyWhenError),
    success: (content: string) =>
      log(content, prefix, Color.Green, success ?? defaultSuccess, false),
    info: (content: string) =>
      log(content, prefix, Color.Cyan, info ?? defaultInfo, false),
  };
};
