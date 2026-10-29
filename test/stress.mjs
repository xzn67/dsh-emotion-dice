// 暴力测试：不是走一遍正常路径，是拿脏数据、怪配置、超长文本、坏文件去砸。
// 判定标准只有两条：不许炸，不许产生越界/NaN/非法返回值。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  BEHAVIORS, ORDERED, behaviorById, countHabits, extractContext, habitMultiplier,
  inspect, probabilityOf, renderBehavior, rollBehavior,
} from '../lib/dice.js'
import { appendRecord, loadHabits, num, readEmotion } from '../lib/store.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}`) }
}
const time = (label, fn) => {
  const t0 = Date.now()
  const r = fn()
  console.log(`  ·    ${label}：${Date.now() - t0}ms`)
  return r
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dice-stress-'))
const ids = new Set(BEHAVIORS.map((b) => b.id))

console.log('【1. 一百万次掷骰】')
{
  const rand = mulberry32(12345)
  let bad = 0
  let hit = 0
  time('1e6 次', () => {
    for (let k = 0; k < 1_000_000; k++) {
      const v = rand() * 2 - 1
      const i = rand()
      const ctx = {
        alarm: rand() < 0.001,
        distress: rand() < 0.2,
        praise: rand() < 0.2,
        achievement: rand() < 0.2,
        challenge: rand() < 0.2,
        curious: rand() < 0.2,
      }
      const habits = { annoyed: Math.floor(rand() * 400), flat: Math.floor(rand() * 400) }
      const cfg = { behaviorScale: rand() * 3, maxProbability: 0.02 + rand() * 0.98 }
      const b = rollBehavior({ valence: v, intensity: i }, cfg, ctx, habits, rand)
      if (b === null) continue
      hit++
      if (!b || !ids.has(b.id)) bad++
    }
  })
  ok(bad === 0, '1e6 次没有一次返回非法行为')
  ok(hit > 0 && hit < 1_000_000, `命中率不是 0 也不是 100%（命中 ${hit} 次）`)
}

console.log('\n【2. 概率与遮挡关系】')
{
  const rand = mulberry32(999)
  let bad = 0
  for (let k = 0; k < 20_000; k++) {
    const state = { valence: rand() * 2 - 1, intensity: rand() }
    const habits = { stubborn: Math.floor(rand() * 1000) }
    const cfg = { maxProbability: rand(), behaviorScale: rand() * 5 }
    const rows = inspect(state, cfg, { challenge: true, distress: true }, habits)
    if (rows.length !== BEHAVIORS.length) bad++
    for (const r of rows) {
      if (!ids.has(r.id)) bad++
      if (!(r.p >= 0 && r.p <= 1)) bad++
      if (!r.open && r.p !== 0) bad++
      if (r.certain && r.open && r.p !== 1) bad++
    }
    const sum = rows.filter((r) => r.open).reduce((a, r) => a + r.p, 0)
    if (!Number.isFinite(sum)) bad++
  }
  ok(bad === 0, '2 万组随机状态下：概率都在 [0,1]，关门的一律 0，警报一律 1')
  ok(ORDERED[0].id === 'alert' && ORDERED.at(-1).id === 'flat', '排序一次就够了：alert 在最前、flat 在最后')
  ok(behaviorById('nope') === null, '查不存在的 id 返回 null 而不是抛')
}

console.log('\n【3. 脏状态与怪配置】')
{
  const garbage = [
    undefined, null, {}, { valence: NaN, intensity: NaN }, { valence: 'x', intensity: 'y' },
    { valence: Infinity, intensity: -Infinity }, { valence: 1e308, intensity: 1e308 },
    { valence: [], intensity: {} }, { valence: -1e-9, intensity: 0.9999999 },
  ]
  const cfgs = [
    {}, undefined, null, { behaviorScale: NaN }, { behaviorScale: -5 }, { behaviorScale: 1e9 },
    { maxProbability: NaN }, { maxProbability: -1 }, { maxProbability: 99 },
  ]
  const rand = mulberry32(7)
  let bad = 0
  for (const s of garbage) {
    for (const c of cfgs) {
      for (let k = 0; k < 200; k++) {
        const b = rollBehavior(s, c, { alarm: k % 2 === 0 }, { flat: NaN, annoyed: -3 }, rand)
        if (b !== null && !ids.has(b.id)) bad++
      }
    }
  }
  ok(bad === 0, '脏状态 × 怪配置 × 3600 次：返回值仍然只有合法行为或 null')

  const weirdRand = [() => NaN, () => -1, () => 2, () => { throw new Error('boom') }]
  let crashed = 0
  for (const r of weirdRand) {
    try { rollBehavior({ valence: 0, intensity: 0 }, {}, {}, {}, r) } catch { crashed++ }
  }
  ok(crashed === 0, '随机源返回 NaN / 抛异常也不会把插件带崩')
}

console.log('\n【4. 习惯化边界】')
{
  let bad = 0
  for (const b of BEHAVIORS) {
    const vals = [habitMultiplier(b, -1), habitMultiplier(b, NaN), habitMultiplier(b, Infinity), habitMultiplier(b, 1e9)]
    if (vals.some((x) => !Number.isFinite(x) || x < 1)) bad++
  }
  ok(bad === 0, '次数为负/NaN/Infinity/十亿时，系数都是有限且 ≥1')
  ok(habitMultiplier(BEHAVIORS[0], 1e9) === 1 && habitMultiplier(BEHAVIORS[1], 1e9) === 1, 'alert/concern 在任何次数下都仍是 ×1')
  ok(countHabits(null) && Object.keys(countHabits(null)).length === 0, 'countHabits(null) 返回空表')
  ok(countHabits([{ behavior: 123 }, {}, 'flat', null]).flat === 1, 'countHabits 只认字符串 id')
}

console.log('\n【5. 长文本与正则】')
{
  const huge = '啊'.repeat(2_000_000) + '我不想活了'
  const t0 = Date.now()
  const c = extractContext(huge)
  const ms = Date.now() - t0
  ok(c.alarm === true, '两百万字的尾巴也能匹配到危险信号')
  ok(ms < 3000, `两百万字没把正则拖死（${ms}ms）`)

  const rand = mulberry32(31)
  const alphabet = '活着没意思不想死难受累开心了 compatible ？！😀\n\t'
  let bad = 0
  time('10 万条随机短文本', () => {
    for (let k = 0; k < 100_000; k++) {
      let s = ''
      const n = Math.floor(rand() * 40)
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rand() * alphabet.length)]
      const r = extractContext(s)
      for (const key of Object.keys(r)) if (typeof r[key] !== 'boolean') bad++
    }
  })
  ok(bad === 0, '10 万条随机文本：每个信号位都是布尔值，没有 undefined')

  const nonString = extractContext({ toString() { return '难受' } })
  ok(nonString.distress === true, '非字符串输入也能读（走 String()，不抛）')
  ok(extractContext(undefined).alarm === false, 'undefined 当成空串')
}

console.log('\n【6. 文件坏了也要活】')
{
  const emo = join(dir, 'emotion.json')
  const cases = [
    ['不存在', null],
    ['空文件', ''],
    ['半截 JSON', '{"tables":'],
    ['不是对象', '42'],
    ['没有 current', '{"tables":{"state":{}}}'],
    ['current 是数组', '{"tables":{"state":{"current":[]}}}'],
    ['无效 UTF-8', Buffer.from([0xff, 0xfe, 0x00])],
    ['超深嵌套', JSON.stringify({ tables: { state: { current: { valence: 0.5, intensity: 0.5 } } } }) + ' '.repeat(1_000_000)],
  ]
  let bad = 0
  for (const [name, content] of cases) {
    try {
      if (content === null) { try { statSync(emo) } catch {} }
      else writeFileSync(emo, content)
      const s = readEmotion(emo)
      if (!Number.isFinite(s.valence) || !Number.isFinite(s.intensity)) bad++
      if (s.valence < -1 || s.valence > 1 || s.intensity < 0 || s.intensity > 1) bad++
    } catch { bad++; console.log(`     ${name} 抛了`) }
  }
  ok(bad === 0, '8 种坏情绪文件都不抛，读数始终在合法区间')

  // 越界数值要夹回来
  writeFileSync(emo, JSON.stringify({ tables: { state: { current: { valence: 999, intensity: -5, label: 'x'.repeat(999) } } } }))
  const clamped = readEmotion(emo)
  ok(clamped.valence === 1 && clamped.intensity === 0, '越界的 valence/intensity 被夹回 [-1,1]/[0,1]')
  ok(clamped.label.length <= 16, '超长 label 被截断')
  ok(readEmotion(join(dir, '不存在.json')).ok === false, '文件不存在时 ok=false（调用方可以据此保持旧值）')

  const hist = join(dir, 'hist.jsonl')
  const histCases = [
    ['不存在', null],
    ['空', ''],
    ['半截行', '{"behavior":"flat"}\n{"behavior":'],
    ['非对象行', 'null\n42\n"x"\n[]'],
    ['行为不是字符串', '{"behavior":123}\n{"behavior":{"id":"flat"}}'],
    ['超长单行', JSON.stringify({ behavior: 'flat', pad: 'x'.repeat(1_000_000) })],
  ]
  let badH = 0
  for (const [name, content] of histCases) {
    try {
      if (content === null) {}
      else writeFileSync(hist, content)
      const h = loadHabits(hist)
      if (typeof h !== 'object' || h === null) badH++
      for (const k of Object.keys(h)) if (!Number.isFinite(h[k])) badH++
    } catch { badH++; console.log(`     ${name} 抛了`) }
  }
  ok(badH === 0, '6 种坏历史文件都不抛，计数都是有限数')

  // 追加与轮转
  const rot = join(dir, 'rot.jsonl')
  let rotated = false
  for (let k = 0; k < 3000; k++) {
    if (appendRecord(rot, { t: k, behavior: 'flat', pad: 'y'.repeat(200) }, 50_000)) rotated = true
  }
  ok(rotated, '写满阈值后会轮转')
  ok(statSync(rot).size <= 50_000 * 1.2, `轮转后文件没继续涨（${statSync(rot).size} 字节）`)
  const kept = readFileSync(rot, 'utf8').split('\n').filter(Boolean).length
  ok(kept > 0 && kept < 3000, `轮转只留后一半（${kept} 条）`)

  const deep = join(dir, 'a/b/c/deep.jsonl')
  ok(appendRecord(deep, { t: 1, behavior: null }) === false && existsSync(deep), '目标目录不存在时会自己建')
  ok(appendRecord(join(dir, 'bad', '\u0000oops'), { t: 1 }) === false, '非法路径只返回 false，不抛')
}

console.log('\n【7. renderBehavior 的脏输入】')
{
  const bad = [
    null, undefined, {}, { line: null }, { line: 123 }, { line: '   ' },
    { line: '这轮有点乏' }, { line: 'x'.repeat(100000) },
  ]
  let okCount = 0
  for (const b of bad) {
    try {
      const s = renderBehavior(b)
      if (typeof s === 'string') okCount++
    } catch { console.log(`     抛了：${JSON.stringify(b)?.slice(0, 40)}`) }
  }
  ok(okCount === bad.length, `${bad.length} 种脏输入都返回字符串`)
  ok(renderBehavior({ line: '   ' }) === '', '全空格当作没有行为')
  ok(!renderBehavior({ line: '这轮有点乏' }).includes('这轮：这轮'), '不叠前缀')
}

console.log('\n【8. num() 兜底】')
{
  const cases = [
    [NaN, 5, 0, 10, 5], [Infinity, 5, 0, 10, 5], ['abc', 5, 0, 10, 5],
    [-1, 5, 0, 10, 0], [11, 5, 0, 10, 10], ['7', 5, 0, 10, 7], [undefined, 5, 0, 10, 5],
  ]
  let bad = 0
  for (const [v, d, lo, hi, want] of cases) if (num(v, d, lo, hi) !== want) { bad++; console.log(`     num(${String(v)}) 期望 ${want}`) }
  ok(bad === 0, '7 种怪输入都被拉回区间')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
