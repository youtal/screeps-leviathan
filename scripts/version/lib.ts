/**
 * 文件摘要：版本号规则的纯函数实现，供 cli.ts 与单元测试使用。
 *
 * 所属位置：scripts/version/，开发工具，不进入游戏构建产物。
 * 规则（见 README 的"Git 分支与版本"）：版本号为 a.b.c。
 * - c：每个改变构建产物的任务合并进 dev 时加 1；hotfix 取全局最大的 c 再加 1；
 * - b：取当前里程碑编号，进入下一个里程碑时加 1，c 归零；
 * - a：M1–M7 期间为 0。
 * 任务分支上的普通提交、发布到 master 的合并、不改变构建产物的合并都不改版本号。
 * 合并按方向区分规则（审计 PA-14）：发布（dev 合并进 master）保持 dev 的版本；集成（合并进 dev 的任务、
 * 合并进 master 的热修复）按上述递增规则；同步（合并进其他分支）取两个父提交中较大的版本。
 * 本文件不读写文件、不调用 Git，所有输入由调用方提供。
 */

/** 解析后的版本号。 */
export interface Version {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** 计算下一个版本号的方式：普通任务、进入下一个里程碑、紧急修复。 */
export type BumpKind = 'task' | 'milestone' | 'hotfix';

/** 校验结果：ok 为 false 时 message 说明违反了哪条规则。 */
export interface CheckResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * 被视为"影响构建产物"的路径。以 `/` 结尾的表示目录前缀，其余为完整文件路径。
 * package-lock.json 不在其中：升级版本号本身就会改动它；依赖变化改由 dependencyChanged 判断。
 */
export const BUILD_PATHS: readonly string[] = ['src/', 'rollup.config.mjs', 'tsconfig.json'];

/**
 * @description 解析 a.b.c 形式的版本号；不接受预发布或构建元数据后缀。
 * @param text 版本号文本。
 * @returns 解析后的版本号。
 * @throws {Error} 文本不是 a.b.c 形式。
 */
export const parseVersion = (text: string): Version => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) {
    throw new Error(`版本号格式应为 a.b.c：${text}`);
  }
  return { a: Number(match[1]), b: Number(match[2]), c: Number(match[3]) };
};

/**
 * @description 把版本号格式化为 a.b.c 文本。
 * @param v 版本号。
 * @returns a.b.c 形式的文本。
 */
export const formatVersion = (v: Version): string => `${v.a}.${v.b}.${v.c}`;

/**
 * @description 按 a、b、c 的顺序比较两个版本号。
 * @param x 左侧版本号。
 * @param y 右侧版本号。
 * @returns 负数表示 x 较小，0 表示相等，正数表示 x 较大。
 */
export const compareVersion = (x: Version, y: Version): number => x.a - y.a || x.b - y.b || x.c - y.c;

/**
 * @description 按规则计算下一个版本号。
 * hotfix 需要传入其他分支（dev、master）的版本号：c 取同一 a.b 下所有已知版本的最大值再加 1，
 * 避免与 dev 上已经用过、但内容不同的版本号重名。
 * @param kind 计算方式：task 使 c 加 1；milestone 使 b 加 1、c 归零；hotfix 如上。
 * @param current 当前版本号。
 * @param others 其他分支的版本号，只有 hotfix 使用，默认为空。
 * @returns 下一个版本号。
 */
export const nextVersion = (kind: BumpKind, current: Version, others: readonly Version[] = []): Version => {
  switch (kind) {
    case 'task':
      return { a: current.a, b: current.b, c: current.c + 1 };
    case 'milestone':
      return { a: current.a, b: current.b + 1, c: 0 };
    case 'hotfix': {
      let maxC = current.c;
      for (const other of others) {
        if (other.a === current.a && other.b === current.b && other.c > maxC) {
          maxC = other.c;
        }
      }
      return { a: current.a, b: current.b, c: maxC + 1 };
    }
  }
};

/**
 * @description 判断改动的文件中是否有影响构建产物的路径。
 * @param changedFiles 改动文件列表，路径相对于仓库根目录、使用 `/` 分隔。
 * @returns 任一文件命中 BUILD_PATHS 时为 true。
 */
export const touchesBuildPaths = (changedFiles: readonly string[]): boolean =>
  changedFiles.some((file) =>
    BUILD_PATHS.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
  );

/**
 * package.json 中的依赖声明：dependencies、devDependencies 与 overrides。overrides 改变实际安装的依赖版本，
 * 同样视为依赖声明（README"构建产物"，审计 PA-18）；它的值可以是嵌套对象，按 JSON 文本比较。
 */
export interface DependencyFields {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, unknown>>;
}

/**
 * @description 判断两份 package.json 的依赖声明是否不同。依赖变化会改变构建工具或打包内容，按影响构建产物处理。
 * @param before 基准的依赖声明。
 * @param after 当前的依赖声明。
 * @returns dependencies、devDependencies 或 overrides 任一不同时为 true。
 */
export const dependencyChanged = (before: DependencyFields, after: DependencyFields): boolean => {
  /**
   * @description 比较两个依赖表的键集合与版本是否完全相同；缺失视为空表。
   * @param x 一个依赖表。
   * @param y 另一个依赖表。
   * @returns 完全相同时为 true。
   */
  const same = (x?: Readonly<Record<string, string>>, y?: Readonly<Record<string, string>>): boolean => {
    const xKeys = Object.keys(x ?? {});
    const yKeys = Object.keys(y ?? {});
    return xKeys.length === yKeys.length && xKeys.every((key) => (x ?? {})[key] === (y ?? {})[key]);
  };
  return !same(before.dependencies, after.dependencies) || !same(before.devDependencies, after.devDependencies)
    || JSON.stringify(before.overrides ?? {}) !== JSON.stringify(after.overrides ?? {});
};

/** 合并的方向：发布（dev → master）、集成（任务 → dev，热修复 → master）、同步（合并进其他分支）。 */
export type MergeKind = 'release' | 'integrate' | 'sync';

/**
 * @description 按目标分支与被合并的提交判断合并方向（README"Git 分支与版本"的分支模型）。
 * @param input 判断依据。
 * @param input.branch 当前分支名，即合并目标。
 * @param input.mergeHead 被合并的提交（MERGE_HEAD）。
 * @param input.devHead dev 分支当前指向的提交；仓库没有 dev 分支时为 null。
 * @returns 合并方向。
 */
export const classifyMerge = (input: { readonly branch: string; readonly mergeHead: string; readonly devHead: string | null }): MergeKind => {
  if (input.branch === 'master' && input.devHead !== null && input.mergeHead === input.devHead) return 'release';
  if (input.branch === 'master' || input.branch === 'dev') return 'integrate';
  return 'sync';
};

/**
 * @description 校验一次提交中的版本号是否符合规则：普通提交与不改变构建产物的集成合并保持版本号；
 * 改变构建产物的集成合并须在同一里程碑内增大 c，或进入下一里程碑时 b 加 1、c 归零；a 的变化须人工确认。
 * 发布合并保持被合并的 dev 的版本；同步合并取两个父提交中较大的版本。
 * @param input 校验依据。
 * @param input.merging 是否正在完成一次合并（存在 MERGE_HEAD）。
 * @param input.base 合并目标分支（即 HEAD）上的版本号。
 * @param input.current 工作区中的版本号。
 * @param input.buildChanged 相对 HEAD 是否改变了构建产物。
 * @param input.kind 合并方向，默认 integrate；不在合并时忽略。
 * @param input.incoming 被合并提交（MERGE_HEAD）上的版本号；发布与同步合并必须给出。
 * @returns ok 表示是否符合规则，message 说明结论或违反的规则。
 * @throws {Error} 发布或同步合并缺少 incoming。
 */
export const checkVersion = (input: {
  readonly merging: boolean;
  readonly base: Version;
  readonly current: Version;
  readonly buildChanged: boolean;
  readonly kind?: MergeKind;
  readonly incoming?: Version;
}): CheckResult => {
  const { merging, base, current, buildChanged } = input;
  const order = compareVersion(current, base);
  const from = formatVersion(base);
  const to = formatVersion(current);

  if (!merging) {
    return order === 0
      ? { ok: true, message: `普通提交，版本号保持 ${to}` }
      : { ok: false, message: `普通提交不改版本号：应保持 ${from}，当前为 ${to}` };
  }
  const kind = input.kind ?? 'integrate';
  if (kind !== 'integrate') {
    if (!input.incoming) throw new Error('发布或同步合并须给出被合并提交的版本号');
    // 发布保持 dev 的版本（README：发布到 master 的合并不改版本号）；同步取两边较大者，避免版本号倒退。
    const expected = kind === 'release' || compareVersion(input.incoming, base) > 0 ? input.incoming : base;
    const label = kind === 'release' ? '发布合并' : '同步合并';
    return compareVersion(current, expected) === 0
      ? { ok: true, message: `${label}，版本号为 ${to}` }
      : { ok: false, message: `${label}的版本号应为 ${formatVersion(expected)}，当前为 ${to}` };
  }
  if (!buildChanged) {
    return order === 0
      ? { ok: true, message: `合并未改变构建产物，版本号保持 ${to}` }
      : { ok: false, message: `合并未改变构建产物，版本号应保持 ${from}，当前为 ${to}` };
  }
  if (order <= 0) {
    return { ok: false, message: `合并改变了构建产物，版本号必须增大：当前 ${to}，基准 ${from}` };
  }
  if (current.a !== base.a) {
    return { ok: false, message: `a 只在全部里程碑完成或出现不兼容变更时调整，请人工确认：${from} → ${to}` };
  }
  const sameMilestone = current.b === base.b && current.c > base.c;
  const nextMilestone = current.b === base.b + 1 && current.c === 0;
  return sameMilestone || nextMilestone
    ? { ok: true, message: `版本号 ${from} → ${to}` }
    : { ok: false, message: `版本号跳变不符合规则：${from} → ${to}（同一里程碑内 c 增大，或进入下一里程碑时 b 加 1、c 归零）` };
};
