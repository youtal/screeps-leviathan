/**
 * 文件摘要：lib.layout 的单元测试。
 * 覆盖：matchHub 的四个条件与返回元素；四种朝向的核心模板都满足 matchHub（架构 7.4 的共享定义）、
 * 模板形状（8 个核心建筑在 3×3、12 格道路为 5×5 去四角的外圈、枢纽格为空）、旋转关系与冻结。
 */
import { CORE_TEMPLATES, HUB_PARTNER_TYPES, matchHub } from '@/lib/layout';
import type { CoreOrientation } from '@/lib/layout';

/** 测试用的建筑快照。 */
interface Fake {
  readonly structureType: string;
  readonly id: string;
}

const s = (structureType: string, id = structureType): Fake => ({ structureType, id });

test('matchHub 要求格子可用、spawn、storage 与至少一个伙伴', () => {
  const full = [s('spawn', 'a'), s('storage'), s('link'), s('road'), s('spawn', 'b'), s('link', 'link2')];
  const hub = matchHub(true, full);
  expect(hub?.spawns.map((x) => x.id)).toEqual(['a', 'b']);
  expect(hub?.storage.id).toBe('storage');
  // 每类伙伴取第一个，并原样返回输入元素。
  expect(hub?.partners).toEqual({ link: full[2] });
  expect(hub?.partners.link).toBe(full[2]);
  expect(matchHub(false, full)).toBeNull();
  expect(matchHub(true, [s('storage'), s('link')])).toBeNull();
  expect(matchHub(true, [s('spawn'), s('link')])).toBeNull();
  expect(matchHub(true, [s('spawn'), s('storage'), s('extension'), s('tower')])).toBeNull();
  for (const partner of HUB_PARTNER_TYPES) expect(matchHub(true, [s('spawn'), s('storage'), s(partner)])?.partners[partner]?.id).toBe(partner);
});

test('每种朝向的核心模板都满足 matchHub，并包含全部伙伴', () => {
  for (const orientation of [0, 1, 2, 3] as CoreOrientation[]) {
    const slots = CORE_TEMPLATES[orientation];
    const adjacent = slots.filter((x) => Math.max(Math.abs(x.dx), Math.abs(x.dy)) === 1).map((x) => s(x.structure, `${x.dx},${x.dy}`));
    const hub = matchHub(!slots.some((x) => x.dx === 0 && x.dy === 0), adjacent);
    expect(hub?.spawns).toHaveLength(2);
    expect(Object.keys(hub?.partners ?? {}).sort()).toEqual([...HUB_PARTNER_TYPES].sort());
  }
});

test('模板形状：3×3 内 8 个核心建筑，外圈 12 格道路，枢纽格为空', () => {
  for (const slots of CORE_TEMPLATES) {
    expect(slots).toHaveLength(20);
    const keys = new Set(slots.map((x) => `${x.dx},${x.dy}`));
    expect(keys.size).toBe(20);
    expect(keys.has('0,0')).toBe(false);
    const inner = slots.filter((x) => Math.max(Math.abs(x.dx), Math.abs(x.dy)) === 1);
    expect(inner.map((x) => x.structure).sort()).toEqual(['factory', 'link', 'nuker', 'powerSpawn', 'spawn', 'spawn', 'storage', 'terminal']);
    const ring = slots.filter((x) => Math.max(Math.abs(x.dx), Math.abs(x.dy)) === 2);
    expect(ring).toHaveLength(12);
    expect(ring.every((x) => x.structure === 'road' && !(Math.abs(x.dx) === 2 && Math.abs(x.dy) === 2))).toBe(true);
    expect(Object.isFrozen(slots) && Object.isFrozen(slots[0])).toBe(true);
  }
});

test('朝向依次顺时针旋转 90°：storage 位于上、右、下、左', () => {
  const storage = CORE_TEMPLATES.map((slots) => slots.find((x) => x.structure === 'storage'));
  expect(storage.map((x) => [x?.dx, x?.dy])).toEqual([[0, -1], [1, 0], [0, 1], [-1, 0]]);
  for (let o = 1; o < 4; o += 1) {
    CORE_TEMPLATES[o].forEach((slot, k) => {
      const prev = CORE_TEMPLATES[o - 1][k];
      expect([slot.dx, slot.dy, slot.structure]).toEqual([-prev.dy + 0, prev.dx + 0, prev.structure]);
    });
  }
  expect(Object.isFrozen(CORE_TEMPLATES)).toBe(true);
});
