/**
 * 文件摘要：为一个 tick 收集意图，按优先级与互斥锁仲裁后同步提交。
 * 所有候选先完成仲裁再执行，避免提交异常改变胜者；同优先级按提交顺序决胜。
 * 闭包仅保存在本 tick，持久化回执只包含 JSON 元数据，下一 tick 由业务插件核验事实。
 */
import type { ExecutionResult, GameIntent, IntentReceipt } from './types';
/**
 * 每个 loop 新建 broker，旧队列不继承；deferred 也不会自动重试，下一 tick 由业务重规划。
 * 收集与提交分离后才有机会在调用游戏 API 前统一裁决，不能撤销已交给引擎的指令。
 */
export const createIntentBroker = (tick: number) => {
  /** 提交顺序即本 tick 唯一 id；元数据与锁数组复制，执行函数仍引用原业务闭包。 */
  const queue: { id: number; pluginId: string; intent: GameIntent }[] = [];
  const receipts: IntentReceipt[] = [];
  /** commit 一开始就封口，防止执行回调递归提交或二次提交同批候选。 */
  let sealed = false;
  /** 验证本地意图描述；不预查游戏对象存在性、库存或 API 成功条件。 */
  const submit = (pluginId: string, intent: GameIntent) => {
    if (sealed) throw new Error('Intent submission is closed');
    if (
      !intent.subjectId ||
      !intent.channel ||
      !Number.isFinite(intent.priority ?? 0) ||
      typeof intent.execute !== 'function' ||
      intent.locks?.some((lock) => typeof lock !== 'string' || !lock)
    ) {
      throw new Error('Invalid intent');
    }
    const id = queue.length;
    queue.push({
      id,
      pluginId,
      intent: { ...intent, locks: [...(intent.locks ?? [])] },
    });
    return id;
  };
  /**
   * eligible 检查插件及其依赖，budget 检查硬预算，execute 注入错误边界，measure 注入观测。
   * N 个意图排序 O(N log N)，锁遍历随锁总数增长；依赖与 CPU 检查成本由注入端决定。
   * 回执以提交 id 存放，不随优先级排序改变关联；尚未提交时 receipts 是空列表。
   */
  const commit = (
    eligible: (id: string) => boolean,
    budget: () => boolean,
    execute: (
      id: string,
      callback: () => ScreepsReturnCode
    ) => ExecutionResult<ScreepsReturnCode>,
    measure: <T>(label: string, fn: () => T) => T = (_label, fn) => fn()
  ) => {
    if (sealed) throw new Error('Intents already committed');
    sealed = true;
    const locks = new Set<string>();
    const winners: typeof queue = [];
    measure('framework.tickExecute.arbitrate', () => {
      for (const entry of queue
        .slice()
        .sort(
          (a, b) =>
            (b.intent.priority ?? 0) - (a.intent.priority ?? 0) || a.id - b.id
        )) {
        const { id, pluginId, intent } = entry;
        // JSON 元组编码避免对象/通道拼接歧义；显式 lock: 前缀与对象通道键隔离。
        const required = [
          JSON.stringify([intent.subjectId, intent.channel]),
          ...(intent.locks ?? []).map((key) => 'lock:' + key),
        ];
        const receipt: IntentReceipt = {
          id,
          tick,
          pluginId,
          subjectId: intent.subjectId,
          channel: intent.channel,
          status: 'rejected',
        };
        receipts[id] = receipt;
        if (!eligible(pluginId)) {
          receipt.reason = 'plugin-unavailable';
          continue;
        }
        if (required.some((key) => locks.has(key))) {
          receipt.reason = 'conflict';
          continue;
        }
        // 全部无冲突后一次占用，失败候选不会占部分锁；胜者之后抛错也不让败者补位。
        required.forEach((key) => locks.add(key));
        winners.push(entry);
      }
    });
    measure('framework.tickExecute.commit', () => {
      for (const { id, pluginId, intent } of winners) {
        const receipt = receipts[id];
        // 前一个胜者可能已使插件或依赖失败，因此执行前再次验证，不能只依赖仲裁结果。
        if (!eligible(pluginId)) {
          receipt.reason = 'plugin-failed';
          continue;
        }
        if (!budget()) {
          receipt.status = 'deferred';
          receipt.reason = 'cpu';
          continue;
        }
        const result = execute(pluginId, () => intent.execute());
        if (result.ok === true) {
          // accepted 仅表示同步调用正常返回；ERR_* 仍记录在 apiResult，事实由后续 tick 核验。
          receipt.status = 'accepted';
          receipt.apiResult = result.value;
        } else {
          receipt.status = 'failed';
          receipt.reason = 'exception';
        }
      }
    });
  };
  // 对外复制标量回执，防止使用者改写内部状态；不导出包含 execute 的队列。
  return { submit, commit, receipts: () => receipts.map((r) => ({ ...r })) };
};
