/**
 * 文件摘要：lib.naming 的单元测试。
 * 覆盖：格式与往返、规范形式（同一组字段只对应一个名称）、校验位与前缀不符、
 * 非规范 base36 与非法字段、保底名称不通过、配置非法、完整 tick 不取模。
 */
import { hashString } from '@/lib/hash';
import { formatName, type NameFields, type NamingKey, verifyName } from '@/lib/naming';

const KEY: NamingKey = { prefix: 'lv', salt: 'pepper' };
const FIELDS: NameFields = { source: 'shard0', purpose: 'hv', target: 'x', tick: 75012345, seq: 2 };

test('格式：字段顺序、base36 与校验位', () => {
  const name = formatName(KEY, FIELDS);
  const body = 'lv-shard0-hv-x-18nrw9.2';
  expect(name).toBe(`${body}-${(hashString(body + 'pepper') % 36).toString(36)}`);
  expect(verifyName(KEY, name)).toEqual(FIELDS);
});

test('往返：随机字段生成的名称都能校验通过并还原字段', () => {
  for (let i = 0; i < 500; i += 1) {
    const fields: NameFields = { source: i % 2 ? 'shardSeason' : 'x', purpose: i % 3 ? 'spn' : 'u1',
      target: i % 5 ? 'x' : 'shard3', tick: i * 7919 + 2 ** 40, seq: i % 40 };
    expect(verifyName(KEY, formatName(KEY, fields))).toEqual(fields);
  }
});

test('校验位、前缀或 salt 不符时不通过', () => {
  const name = formatName(KEY, FIELDS);
  const last = name.at(-1)!;
  const other = last === '0' ? '1' : '0';
  expect(verifyName(KEY, name.slice(0, -1) + other)).toBeUndefined();
  expect(verifyName({ prefix: 'xx', salt: 'pepper' }, name)).toBeUndefined();
  // 换用一个校验位不同的 salt：同一名称不再通过（salt 区分项目，不同 salt 的校验位相同的概率为 1/36）。
  const body = name.slice(0, -2);
  const salt = ['a', 'b', 'c', 'd'].find((s) => (hashString(body + s) % 36).toString(36) !== last)!;
  expect(verifyName({ prefix: 'lv', salt }, name)).toBeUndefined();
  // 改动字段而保留原校验位：校验位按新文本重算后与原值不同时不通过。
  const forgedBody = 'lv-shard0-hv-x-18nrw9.3';
  expect((hashString(forgedBody + 'pepper') % 36).toString(36)).not.toBe(last);
  expect(verifyName(KEY, `${forgedBody}-${last}`)).toBeUndefined();
});

test('规范形式：前导零、大写 base36 与多余分隔符都不通过', () => {
  const tamper = (body: string) => `${body}-${(hashString(body + 'pepper') % 36).toString(36)}`;
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-018nrw9.2'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-18nrw9.02'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-18NRW9.2'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-18nrw9'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-18nrw9.2.1'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard-0-hv-x-18nrw9.2'))).toBeUndefined();
  expect(verifyName(KEY, tamper('lv-shard0-Hv-x-18nrw9.2'))).toBeUndefined();
  // 超出安全整数的 tick 无法精确往返。
  expect(verifyName(KEY, tamper(`lv-x-hv-x-${(2 ** 60).toString(36)}.0`))).toBeUndefined();
  // 合法的规范写法通过，确认 tamper 本身正确。
  expect(verifyName(KEY, tamper('lv-shard0-hv-x-18nrw9.2'))).toEqual(FIELDS);
});

test('保底循环的应急名称与外来名称不通过', () => {
  expect(verifyName(KEY, 'fb-x-18nrw9-0')).toBeUndefined();
  expect(verifyName(KEY, 'Harvester1')).toBeUndefined();
  expect(verifyName(KEY, '')).toBeUndefined();
});

test('格式化时字段非法抛 TypeError；校验时配置非法一律不通过', () => {
  const bad: Partial<NameFields>[] = [{ source: 'sh-0' }, { target: '' }, { purpose: 'harvest' }, { purpose: '1h' },
    { tick: -1 }, { tick: 1.5 }, { seq: Number.NaN }, { tick: 2 ** 53 }];
  for (const patch of bad) expect(() => formatName(KEY, { ...FIELDS, ...patch })).toThrow(TypeError);
  expect(() => formatName({ prefix: 'LV', salt: 'pepper' }, FIELDS)).toThrow(TypeError);
  expect(() => formatName({ prefix: 'lv-x', salt: 'pepper' }, FIELDS)).toThrow(TypeError);
  expect(verifyName({ prefix: 'LV', salt: 'pepper' }, 'LV-x-hv-x-0.0-0')).toBeUndefined();
});

test('出生 tick 完整保留，不取模', () => {
  const fields = { ...FIELDS, tick: 2 ** 52 + 3 };
  expect(verifyName(KEY, formatName(KEY, fields))?.tick).toBe(2 ** 52 + 3);
});
