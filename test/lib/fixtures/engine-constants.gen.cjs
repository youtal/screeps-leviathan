/**
 * 文件摘要：生成 engine-constants.json 的采样脚本，在场景测试镜像中运行，不进入构建产物，也不被 Jest 收集。
 *
 * 用途：lib.tables、lib.body、lib.combat 把 @screeps/common 的常量抄为冻结表，并以引擎公式实现能力与伤害计算；
 * 单元测试以本脚本的输出逐项比对，常量或引擎行为变化时重新生成即可发现差异。
 * 数据来源：镜像 /opt/runner/node_modules 中的 @screeps/common 2.16.1 与 @screeps/engine 4.3.2。
 *   - 常量：common/lib/constants.js 原样输出；
 *   - _applyDamage（creeps/tick.js）、calcResourcesWeight（movement.js）、calcBodyEffectiveness（utils.js）：
 *     从引擎源码中摘出函数原文求值，只为其提供引擎自带的 lodash 3 与常量 C；
 *   - tower 衰减：towers/attack.js、heal.js、repair.js 中的公式（无 power 效果）位于模块导出的处理函数内部，
 *     不能单独摘出，此处按原文逐句转写。
 * 随机身体由固定种子的 mulberry32 生成，后一半样本前段集中放 TOUGH，以覆盖 boost 减伤路径。
 * 运行方式（输出写到标准输出）：
 *   docker run --rm -v "$PWD/test/lib/fixtures:/gen:ro" --entrypoint node leviathan-scenarios:local \
 *     /gen/engine-constants.gen.cjs > test/lib/fixtures/engine-constants.json
 */
const fs = require('fs');
const path = require('path');

/** 镜像中场景运行器的依赖目录。 */
const root = '/opt/runner/node_modules';
const C = require(path.join(root, '@screeps/common/lib/constants.js'));
// 引擎依赖 lodash 3（_.any 等），镜像顶层的 lodash 版本更新，须按引擎的解析路径取得。
const _ = require(require.resolve('lodash', { paths: [path.join(root, '@screeps/engine')] }));
const engine = path.join(root, '@screeps/engine/src');

/**
 * @description 从引擎源码中摘出一个顶层函数的原文：从函数头起，到其后第一个位于行首的右花括号为止。
 * @param {string} file 相对 engine/src 的源码路径。
 * @param {string} header 函数头的开头文本。
 * @returns {string} 函数原文。
 * @throws {Error} 源码中找不到该函数头。
 */
const extract = (file, header) => {
  const text = fs.readFileSync(path.join(engine, file), 'utf8');
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`missing ${header} in ${file}`);
  const end = text.indexOf('\n}', start);
  return text.slice(start, end + 2);
};

const applyDamageSrc = extract('processor/intents/creeps/tick.js', 'function _applyDamage(');
const weightSrc = extract('processor/intents/movement.js', 'function calcResourcesWeight(');
const effSrc = extract('utils.js', 'exports.calcBodyEffectiveness = function')
  .replace('exports.calcBodyEffectiveness = function', 'function calcBodyEffectiveness');
const fns = new Function('_', 'C', `${applyDamageSrc}\n${weightSrc}\n${effSrc}\nreturn { _applyDamage, calcResourcesWeight, calcBodyEffectiveness };`)(_, C);

/**
 * @description tower 动作随距离衰减后的数值，逐句转写自 towers/attack.js、heal.js、repair.js（无 power 效果）。
 * @param {number} base 基础值。
 * @param {number} range 距离。
 * @returns {number} 向下取整后的数值。
 */
const tower = (base, range) => {
  let amount = base;
  if (range > C.TOWER_OPTIMAL_RANGE) {
    if (range > C.TOWER_FALLOFF_RANGE) range = C.TOWER_FALLOFF_RANGE;
    amount -= amount * C.TOWER_FALLOFF * (range - C.TOWER_OPTIMAL_RANGE) / (C.TOWER_FALLOFF_RANGE - C.TOWER_OPTIMAL_RANGE);
  }
  return Math.floor(amount);
};
const towerSamples = [];
for (let r = 0; r <= 50; r += 1) towerSamples.push([r, tower(C.TOWER_POWER_ATTACK, r), tower(C.TOWER_POWER_HEAL, r), tower(C.TOWER_POWER_REPAIR, r)]);

/** 随机数状态，固定种子使输出可复现。 */
let seed = 20261022;

/**
 * @description mulberry32 伪随机整数：低位分布均匀，取小模数也不会出现短周期。
 * @param {number} n 上界（不含）。
 * @returns {number} 0 到 n − 1 的整数。
 */
const rnd = (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};

const types = C.BODYPARTS_ALL;
const bodies = [];
for (let k = 0; k < 300; k += 1) {
  const len = 1 + rnd(50);
  const body = [];
  const toughFront = k >= 150 ? rnd(Math.min(len, 12) + 1) : 0;
  for (let i = 0; i < len; i += 1) {
    const type = i < toughFront ? 'tough' : types[rnd(types.length)];
    const boosts = Object.keys(C.BOOSTS[type] || {});
    const boost = boosts.length && rnd(3) === 0 ? boosts[rnd(boosts.length)] : undefined;
    const hits = rnd(4) === 0 ? rnd(101) : 100;
    body.push(boost ? { type, hits, boost } : { type, hits });
  }
  const capacity = body.reduce((s, p) => s + (p.type === C.CARRY && p.hits ? C.CARRY_CAPACITY * (p.boost ? C.BOOSTS.carry[p.boost].capacity : 1) : 0), 0);
  const carried = capacity ? rnd(capacity + 1) : 0;
  const damage = rnd(3000);
  const creep = { body: body.map((p) => ({ ...p })), hits: body.reduce((s, p) => s + p.hits, 0) };
  fns._applyDamage(creep, damage);
  const effect = {};
  for (const [type, methods] of [
    ['work', ['harvest', 'build', 'repair', 'dismantle', 'upgradeController']],
    ['attack', ['attack']], ['ranged_attack', ['rangedAttack', 'rangedMassAttack']],
    ['heal', ['heal', 'rangedHeal']], ['carry', ['capacity']], ['move', ['fatigue']],
  ]) for (const m of methods) effect[`${type}.${m}`] = fns.calcBodyEffectiveness(body, type, m, 1, true);
  const weight = fns.calcResourcesWeight({ body, store: { energy: carried } });
  const nonMove = body.filter((i) => i.type !== C.MOVE && i.type !== C.CARRY).length;
  bodies.push({ body, carried, damage, hitsLost: creep.hits === undefined ? null : body.reduce((s, p) => s + p.hits, 0) - creep.hits, effect, weight, nonMove });
}

const out = {
  source: '@screeps/common 2.16.1, @screeps/engine 4.3.2',
  constants: {
    BODYPART_COST: C.BODYPART_COST, BODYPARTS_ALL: C.BODYPARTS_ALL, CONTROLLER_STRUCTURES: C.CONTROLLER_STRUCTURES,
    EXTENSION_ENERGY_CAPACITY: C.EXTENSION_ENERGY_CAPACITY, SPAWN_ENERGY_CAPACITY: C.SPAWN_ENERGY_CAPACITY,
    RAMPART_HITS_MAX: C.RAMPART_HITS_MAX, CONTROLLER_LEVELS: C.CONTROLLER_LEVELS, CONTROLLER_DOWNGRADE: C.CONTROLLER_DOWNGRADE,
    BOOSTS: C.BOOSTS, CREEP_SPAWN_TIME: C.CREEP_SPAWN_TIME, MAX_CREEP_SIZE: C.MAX_CREEP_SIZE, CARRY_CAPACITY: C.CARRY_CAPACITY,
    CREEP_LIFE_TIME: C.CREEP_LIFE_TIME, CREEP_CLAIM_LIFE_TIME: C.CREEP_CLAIM_LIFE_TIME,
    HARVEST_POWER: C.HARVEST_POWER, BUILD_POWER: C.BUILD_POWER, REPAIR_POWER: C.REPAIR_POWER, DISMANTLE_POWER: C.DISMANTLE_POWER,
    UPGRADE_CONTROLLER_POWER: C.UPGRADE_CONTROLLER_POWER, ATTACK_POWER: C.ATTACK_POWER, RANGED_ATTACK_POWER: C.RANGED_ATTACK_POWER,
    HEAL_POWER: C.HEAL_POWER, RANGED_HEAL_POWER: C.RANGED_HEAL_POWER,
    TOWER_POWER_ATTACK: C.TOWER_POWER_ATTACK, TOWER_POWER_HEAL: C.TOWER_POWER_HEAL, TOWER_POWER_REPAIR: C.TOWER_POWER_REPAIR,
    TOWER_OPTIMAL_RANGE: C.TOWER_OPTIMAL_RANGE, TOWER_FALLOFF_RANGE: C.TOWER_FALLOFF_RANGE, TOWER_FALLOFF: C.TOWER_FALLOFF,
    TOWER_ENERGY_COST: C.TOWER_ENERGY_COST,
  },
  tower: towerSamples,
  bodies,
};
process.stdout.write(JSON.stringify(out));
