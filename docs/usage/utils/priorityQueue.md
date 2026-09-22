# PriorityQueue 使用说明

二叉堆优先队列。设计见 [PriorityQueue 设计](../../design/utils/priorityQueue.md)。

```ts
import { PriorityQueue } from '@/utils';

interface Node {
  pos: string;
  cost: number;
}

// 比较器返回 true 表示第一个参数更优先：这里 cost 小者先出队（最小堆）。
const open = new PriorityQueue<Node>(
  [{ pos: 'a', cost: 5 }, { pos: 'b', cost: 2 }],
  (pre, nxt) => pre.cost < nxt.cost
);

open.push({ pos: 'c', cost: 1 });
open.peek; // { pos: 'c', cost: 1 }，不出队
open.pop(); // { pos: 'c', cost: 1 }
open.size; // 2
```

## 接口

| 成员 | 说明 |
| --- | --- |
| `new PriorityQueue<T>(items, comparator)` | `items` 为初始元素，可以是 `undefined`；构造时复制该数组。`comparator(pre, nxt)` 返回 true 表示 `pre` 优先，不是函数时抛错 |
| `push(item)` | 入队 |
| `pop()` | 取出并返回最高优先级元素；队列为空时返回 `undefined` |
| `clear()` | 清空，保留内部数组以便复用 |
| `peek` | 只读属性：最高优先级元素，不出队；空队列为 `undefined` |
| `size` | 只读属性：元素数量 |
| `isEmpty` | 只读属性：是否为空 |

`peek`、`size`、`isEmpty` 是 getter，读取时不加括号。

## 注意事项

- 优先级相同的元素出队顺序不确定。需要确定性顺序时，在比较器中加入次级比较，例如 `pre.cost < nxt.cost || (pre.cost === nxt.cost && pre.pos < nxt.pos)`。
- 入队后不要修改元素中参与比较的字段，否则堆序失效。需要更新某个元素的优先级时，以新优先级再入队一份，出队时跳过已处理过的旧条目。
- 队列只保存在 heap 中。可以跨 tick 复用（用 `clear()` 清空），global reset 后需要重新创建；元素中不要保存跨 tick 失效的游戏对象。
