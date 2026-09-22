# 控制台工具使用说明

控制台工具生成可以直接打印到 Screeps 控制台的 HTML 文本：着色、链接、模板替换、交互表单与帮助面板。它们只返回字符串，打印由调用方完成。设计见 [控制台工具设计](../../design/utils/console.md)。

## 导入

```ts
// 文本工具经入口导出（也可从 '@/utils' 导入）。
import { dyeRed, createRoomLink, replaceHtml, fixRetraction } from '@/utils/console';
// 表单与帮助渲染器尚未经入口导出，从实现文件导入。
import { createForm } from '@/utils/console/form/createForm';
import { createHelp } from '@/utils/console/help/createHelp';
```

## 着色与链接

```ts
console.log(dyeRed('能量不足', true) + ' ' + createRoomLink('W1N1'));
```

| 函数 | 说明 |
| --- | --- |
| `dyeText(content, color?, bold?)` | 返回带内联样式的 `<span>`；`color` 取 `Color` 枚举，缺省不着色 |
| `dyeGreen`、`dyeRed`、`dyeBlue`、`dyeYellow`、`dyeCyan`、`dyeMagenta`、`dyeViolet`、`dyeOrange` | `dyeText` 的固定颜色版本，第二个参数为是否加粗 |
| `createLink(content, url, newTab = true)` | 返回 `<a>` 链接，默认在新标签页打开 |
| `createRoomLink(roomName)` | 链接到官方服务器（screeps.com）上当前 shard 的该房间，在当前标签页打开；调用时读取 `Game.shard.name` |

## 模板工具

- `replaceHtml(html, { key: value })`：把模板中的 `{key}` 替换为 `value`。键与值都按字面量处理，`$&` 等替换模式不生效；映射中没有的占位符原样保留；按键的顺序逐个替换，某个值中含有后续键的占位符时会继续被替换。
- `fixRetraction(html)`：删除全部 `\n`。控制台会把多行输出拆成多条消息，面板类输出打印前需要折叠为单行。

## 表单

```ts
const html = createForm(
  'spawnConfig',
  [
    { name: 'room', label: '房间', type: 'input', placeholder: 'W1N1' },
    {
      name: 'role',
      label: '角色',
      type: 'select',
      options: [
        { value: 'harvester', label: '采集' },
        { value: 'upgrader', label: '升级' },
      ],
    },
    {
      name: 'flags',
      label: '选项',
      type: 'checkbox',
      options: [
        { value: 'boost', label: '强化' },
        { value: 'urgent', label: '加急' },
      ],
    },
  ],
  { content: '提交', command: 'setSpawnConfig' }
);
console.log(html);
```

在输入框填入 W1N1、保持默认选项并勾选“强化”后点击按钮，控制台执行 `(setSpawnConfig)({"room":"W1N1","role":"harvester","flags":["boost"]})`。`command` 必须是在控制台中求值为函数的表达式，例如一个全局函数名。参数对象以字段名为键；checkbox 的值是选中项的数组，其余控件是字符串。

控件类型为 `input`、`select`、`checkbox`、`radio`；`select`、`checkbox`、`radio` 需要 `options`。

## 帮助面板

```ts
console.log(
  createHelp({
    name: 'Spawn 工具',
    describe: '管理孵化队列',
    api: [
      {
        title: '查看队列',
        describe: '打印指定房间的孵化队列',
        params: [{ name: 'roomName', desc: '房间名' }],
        functionName: 'showSpawnQueue',
      },
      { title: '清空全部队列', functionName: 'clearSpawnQueues', commandType: true },
    ],
  })
);
```

`createHelp` 接受任意数量的模块描述。每个 API 显示为可展开的面板，末行是调用形式：普通函数显示为 `showSpawnQueue(roomName)`，`commandType: true` 显示为不带括号的 `clearSpawnQueues`。

## 注意事项

- **文本不做任何转义**。标签、选项、描述、占位文本会作为 HTML 插入，只传入可信文本；需要显示 `<`、`&` 等字符时由调用方自行转义。
- 表单名与字段名会进入 HTML 属性和脚本中的单引号字符串，只能使用不含引号、反斜杠和换行的文本。`command` 会进入脚本中的模板字符串，不能含双引号、反引号、反斜杠、换行或 `${`。
- checkbox 与 radio 至少提供两个选项。只有一个选项时，浏览器不把它当作分组，提交的是该选项的值，与是否选中无关。
- 表单名与帮助面板的折叠 id 都拼接了 `Game.time`：同一 tick 内打印两个同名表单，或两个同名函数的帮助，会相互干扰。
- `createForm`、`createHelp` 读取 `Game.time`，`createRoomLink` 读取 `Game.shard.name`；在测试中调用时需要注入相应的 `Game`。
- 表单按钮依赖游戏网页客户端的内部接口，只能在网页客户端的控制台中使用。
- 这些工具用于人工交互，不要在每 tick 的热路径中调用。
