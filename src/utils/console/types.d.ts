/**
 * 允许引入 html 文件
 */
declare module '*.html' {
  const content: string;
  export default content;
}

type LogOptions = {
  debug?: boolean;
  warn?: boolean;
  error?: boolean;
  success?: boolean;
  info?: boolean;
};
