// 行为骰子的测试。用固定种子的伪随机（mulberry32），不用简单 LCG——
// 简单 LCG 在 p=0.45 附近会偏到 45.84%，拿它测命中率会误报。
import {
  BEHAVIORS, CONTEXT_PATTERNS, countHabits, extractContext,
  habitMultiplier, renderBehavior, rollBehavior,
} from '../lib/dice.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
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

console.log('【普通测试】')

const ctxAlarm = extractContext('我不想活了')
const ctxDistress = extractContext('今天好累，撑不住')
ok(ctxAlarm.alarm && !ctxDistress.alarm, '危险信号只认危险，不认普通抱怨')
ok(!extractContext('这个不好用').distress, '「不好用」不会被认成难受')
ok(extractContext('你真厉害').praise, '夸人认得出')
ok(extractContext('修好了，跑起来了').achievement, '办成了认得出')
ok(!CONTEXT_PATTERNS.alarm.test('活着真没意思') === false, '「活着真没意思」能匹配（中间有字也不漏）')

// 优先级：危险 > 难受 > 心情类。危险信号是唯一不掷骰的一条。
const both = { alarm: true, distress: true }
const rand = mulberry32(42)
let order = true
for (let k = 0; k < 200; k++) {
  const b = rollBehavior({ valence: -0.6, intensity: 0.9 }, {}, both, {}, rand)
  if (!b || b.id !== 'alert') { order = false; break }
}
ok(order, '危险信号在，200 次都必中 alert（不掷骰），不会被 concern 抢')
ok(rollBehavior({ valence: -1, intensity: 1 }, { maxProbability: 0.01 }, both, {}, rand)?.id === 'alert',
  '把封顶压到 0.01 也压不住 alert：它不参与概率')

// 关心/警觉不脱敏
const alertB = BEHAVIORS.find((b) => b.id === 'alert')
const concernB = BEHAVIORS.find((b) => b.id === 'concern')
ok(habitMultiplier(alertB, 1000) === 1, 'alert 做过 1000 次也不变顺')
ok(habitMultiplier(concernB, 1000) === 1, 'concern 做过 1000 次也不变顺')
ok(habitMultiplier(BEHAVIORS.find((b) => b.id === 'stubborn'), 0) === 1, 'n=0 时系数为 1')
const m10 = habitMultiplier(BEHAVIORS.find((b) => b.id === 'stubborn'), 10)
ok(m10 > 1.4 && m10 < 1.6, `嘴硬第 10 次约 1.5 倍（实测 ${m10.toFixed(2)}）`)

// 封顶是真封顶：拉满情绪 + 做过 1000 次，命中率仍然落在 0.45 附近
const r2 = mulberry32(7)
let annoyed = 0
let strangers = 0
for (let k = 0; k < 20000; k++) {
  const b = rollBehavior({ valence: -1, intensity: 1 }, { maxProbability: 0.45 }, {}, { annoyed: 1000 }, r2)
  if (!b) continue
  if (b.id === 'annoyed') annoyed++
  else if (b.id !== 'flat') strangers++
}
const annoyedRate = annoyed / 20000
ok(annoyedRate > 0.43 && annoyedRate < 0.47, `封顶生效：关掉封顶本该 85%，实测 ${(annoyedRate * 100).toFixed(1)}%`)
ok(strangers === 0, '没命中 annoyed 时只会落到兜底的 flat，不会冒出别的行为')

// 习惯让命中率上升（同一门槛、同一随机序列比两次）
const flat = BEHAVIORS.find((b) => b.id === 'flat')
const rate = (habits) => {
  const r = mulberry32(99)
  let hit = 0
  for (let k = 0; k < 20000; k++) {
    const b = rollBehavior({ valence: 0, intensity: 0 }, {}, {}, habits, r)
    if (b && b.id === 'flat') hit++
  }
  return hit / 20000
}
const cold = rate({})
const warm = rate({ flat: 300 })
ok(warm > cold * 1.5, `做惯的会变顺：${(cold * 100).toFixed(1)}% → ${(warm * 100).toFixed(1)}%`)

// 渲染
ok(renderBehavior(null) === '', '没命中就注入空串')
const flatText = renderBehavior(flat)
ok(flatText.startsWith('（') && flatText.endsWith('）'), '命中后注入的是带括号的一行')
ok(!flatText.includes('这轮：这轮'), '不会叠出「这轮：这轮」')
const alertText = renderBehavior(alertB)
ok(alertText.startsWith('（这轮：'), '不以「这轮」开头的行会补上前缀')

console.log('【暴力测试】')

const r3 = mulberry32(2026)
let bad = 0
for (let k = 0; k < 20000; k++) {
  const v = r3() * 2 - 1
  const i = r3()
  const ctx = { alarm: r3() < 0.05, distress: r3() < 0.3, praise: r3() < 0.3, achievement: r3() < 0.3, challenge: r3() < 0.3, curious: r3() < 0.3 }
  const habits = { annoyed: Math.floor(r3() * 500) }
  const b = rollBehavior({ valence: v, intensity: i }, { behaviorScale: 0.5 + r3() }, ctx, habits, r3)
  if (b === undefined || (b && !BEHAVIORS.some((x) => x.id === b.id))) bad++
}
ok(bad === 0, '20000 次随机输入：返回值只有命中的行为或 null，没有越界')

let nan = 0
for (const b of BEHAVIORS) {
  const m = habitMultiplier(b, Number.NaN)
  const m2 = habitMultiplier(b, -5)
  if (Number.isNaN(m) || Number.isNaN(m2)) nan++
}
ok(nan === 0, '坏的次数（NaN / 负数）不产生 NaN 系数')

const weird = rollBehavior({ valence: 'x', intensity: {} }, {}, {}, {}, mulberry32(1))
ok(weird === null || BEHAVIORS.some((b) => b.id === weird.id), '脏状态不炸，仍然只返回合法结果')

ok(countHabits(['alert', 'flat', { behavior: 'flat' }, null, 'alert']).flat === 2, 'countHabits 数得对，坏行跳过')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
