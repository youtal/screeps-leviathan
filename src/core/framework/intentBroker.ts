/**
 * 文件摘要
 *
 * 模块角色：core/framework 的单 tick 动作仲裁组件，由主循环创建并通过上下文接收意图。
 *
 * 主要功能：校验和收集意图，解决动作冲突，执行胜出的回调并提供回执副本。
 *
 * 实现过程：先按优先级降序、提交序号升序排列候选，以对象加通道和附加锁确定全部胜者，
 * 再逐项检查插件可用性与 CPU 预算，通过注入的 execute 执行并记录结果。
 *
 * 技术要点：仲裁后不因执行失败重新选人；commit 封闭队列，禁止再次提交或重复执行。
 * 队列仅供本 tick 使用，不直接访问 Game 或存储；回执表示调用结果，下一 tick 的实际效果由业务核验。
 */
import type { ExecutionResult, GameIntent, IntentReceipt } from '@/contracts';
/**
 * 每个 loop 新建 broker，旧队列不继承；deferred 也不会自动重试，下一 tick 由业务重规划。
 * 收集与提交分离后才有机会在调用游戏 API 前统一裁决，不能撤销已交给引擎的指令。
 * tick 只写入回执，标记这批意图属于哪个 tick：id 从 0 开始逐 tick 重置，跨 tick 识别
 * 必须同时使用 tick 与 id，业务据此避免把旧回执当成紧邻上一 tick 的结果。
 */
export const createIntentBroker = (tick: number) => {
  // queue 用数组而非 Map：下标即 id，可 O(1) 定位回执；排序只作用于副本。
  // 复制元数据与锁数组防止提交者事后修改改变裁决结果；execute 保持原引用，
  // 因此其中的业务闭包（可能捕获 Game 对象）只能在本 tick 内使用。
  /** 提交顺序即本 tick 唯一 id；元数据与锁数组复制，执行函数仍引用原业务闭包。 */
  const queue: { id: number; pluginId: string; intent: GameIntent }[] = [];
  // 回执按 id 稀疏写入，但每个候选在仲裁阶段都会被赋值，提交完成后即为稠密数组。
  const receipts: IntentReceipt[] = [];
  /** commit 一开始就封口，防止执行回调递归提交或二次提交同批候选。 */
  let sealed = false;
  /**
   * 验证本地意图描述；不预查游戏对象存在性、库存或 API 成功条件。
   * 那些是业务方的世界事实：热路径上预查要重复扫描 Game，且结果到 commit 时可能已失效，
   * 因此内核只保证结构合法，动作是否成立由 apiResult 与下一 tick 的事实核验负责。
   * subjectId/channel 用真值判断拒绝空串；priority 缺省 0 且必须有限（排序依赖它）；
   * execute 必须是同步函数，返回 Promise 的插件由 Kernel 的错误边界另行拒绝。
   */
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
   * 四个依赖全部注入而不是 import：broker 不依赖 Kernel、Profiler 或 Game，测试可直接驱动
   * 裁决逻辑；measure 缺省为直通，等价于未接观测，因此不传参也能在测试中使用。
   * measure 的两个固定标签与 docs/design/core/framework.md 的 Profiler 标签表保持一致。
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
    // 先置位再干活：即使仲裁/提交中途抛错，也不会出现第二次 commit 覆盖回执。
    sealed = true;
    const locks = new Set<string>();
    // typeof queue 复用队列条目类型，避免为这一处内部结构再声明类型别名。
    const winners: typeof queue = [];
    measure('framework.tickExecute.arbitrate', () => {
      // slice 复制后再排序：queue 的插入顺序就是 id 依据，不能被就地打乱。
      // 比较器用 id 显式破平，不依赖 Array.prototype.sort 的稳定性；priority 缺省按 0 比较。
      for (const entry of queue
        .slice()
        .sort(
          (a, b) =>
            (b.intent.priority ?? 0) - (a.intent.priority ?? 0) || a.id - b.id
        )) {
        const { id, pluginId, intent } = entry;
        // JSON 元组编码避免对象/通道拼接歧义；显式 lock: 前缀与对象通道键隔离。
        // 代价是每个候选一次 JSON.stringify 与若干次 Set 查询，相对错误动作的代价可接受。
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
        // 落败候选同样登记回执，保证 receipts 按下标稠密且诊断能看到被拒原因。
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
          // 推迟只影响本 tick：闭包不落 Memory，锁集合也随实例丢弃，不予回滚或重排。
          receipt.status = 'deferred';
          receipt.reason = 'cpu';
          continue;
        }
        const result = execute(pluginId, () => intent.execute());
        // 显式与 true 比较用于收窄 ExecutionResult 判别联合，之后才能安全读取 result.value。
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
  // 回执字段全是字符串/数字，浅复制即完整隔离；receipts() 每次调用都生成新数组。
  return { submit, commit, receipts: () => receipts.map((r) => ({ ...r })) };
};
