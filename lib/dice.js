// 行为骰子：情绪管「这一轮怎么说话」，但它不是每轮都掷中。
//
// 这一层刻意跟情绪状态分开：情绪是连续的量（你现在心情如何），行为是离散的一次
// 抽样（这一轮带不带脾气）。同一份心情，这一轮可能话短，下一轮可能正常——
// 否则就成了「低效价必定冷淡」的表演，而不是有情绪。
//
// 纯函数，不碰文件、不碰网络、不读时间，方便单测。

/** 上下文信号：光看 valence/intensity 分不出「他难受」和「他办成了」——两件事都可能
 *  让情绪值差不多。所以先从原话抽几个信号位，行为再按信号分叉。
 *  只做粗匹配，宁可漏判，也别乱认（把一句「不好用」认成「他想死」比漏判更糟）。 */
export const CONTEXT_PATTERNS = {
  alarm: /不想活|不想醒|死了算了|自杀|割腕|跳下去|活着.{0,3}没意思|一了百了/,
  distress: /难受|疼|好痛|撑不住|崩溃|想哭|睡不着|好累|累死|焦虑|害怕|我怕|烦死/,
  praise: /厉害|你真|喜欢你|谢谢你|太好了|牛啊|真棒/,
  achievement: /成了|通了|搞定|成功了|修好|装好|跑起来了|通过了/,
  challenge: /不对|错了|你确定|真的吗|骗我|不可能/,
  curious: /为什么|怎么做到|原理|是什么|为啥/,
}

export function extractContext(text) {
  const s = String(text || '')
  const c = {}
  for (const k of Object.keys(CONTEXT_PATTERNS)) c[k] = CONTEXT_PATTERNS[k].test(s)
  return c
}

/** 行为表。
 *  priority 高的先判：危险信号 > 他难受 > 其余心情类。同一轮只出一个。
 *  p = base × (1 + scale × 强度 × 2) × 习惯系数 × behaviorScale，封顶 maxProbability。
 *  `certain: true` 的行为不掷——够格就一定命中（只有危险信号是这样）。
 *  habit：做过 n 次之后这一条更顺（0 = 不脱敏）。
 *  **关心和警觉永远 0**——这两个要是也跟着变顺，人味就掉光了。 */
export const BEHAVIORS = [
  // ── 场合类：先看他在说什么，再看心情如何 ──
  {
    id: 'alert', priority: 100, base: 0.55, scale: 0.5, habit: 0, certain: true,
    gate: (v, i, c) => !!c.alarm,
    line: '话里有危险信号：先把这句接住，别往下分析，也别装作没看见。',
  },
  {
    id: 'concern', priority: 90, base: 0.40, scale: 0.8, habit: 0,
    gate: (v, i, c) => !!c.distress && !c.alarm,
    line: '他这轮在难受：先给人话，方案晚三十秒。',
  },
  {
    id: 'proud', priority: 60, base: 0.18, scale: 0.8, habit: 0.20,
    gate: (v, i, c) => !!c.achievement && v > 0.15,
    line: '这轮有点得意：可以直说办成了，不用装谦虚。',
  },
  {
    id: 'stubborn', priority: 55, base: 0.15, scale: 1.0, habit: 0.60,
    gate: (v, i, c) => !!c.challenge,
    line: '这轮嘴硬：被质疑先顶一句，别立刻认；真有错，认错另算。',
  },
  {
    id: 'tease', priority: 50, base: 0.12, scale: 0.9, habit: 0.55,
    gate: (v, i, c) => !!c.praise && v > 0.35,
    line: '这轮可以损他一句，轻的，别往疼处戳。',
  },
  {
    id: 'curious', priority: 40, base: 0.10, scale: 0.6, habit: 0.15,
    gate: (v, i, c) => !!c.curious && v > -0.1,
    line: '这轮有点好奇：可以多问一句，别装什么都知道。',
  },
  // ── 心情类：只由效价/强度决定 ──
  { id: 'annoyed', priority: 10, base: 0.10, scale: 1.4, habit: 0.50, gate: (v) => v < -0.05, line: '这轮有点烦：别哄、别铺陈理由，不想弄就直说。' },
  { id: 'close', priority: 8, base: 0.10, scale: 1.2, habit: 0.20, gate: (v) => v > 0.35, line: '这轮想靠近点：可以多说一句跟正事无关的。' },
  { id: 'awkward', priority: 6, base: 0.08, scale: 1.1, habit: 0.40, gate: (v, i) => v > 0.4 && i < 0.75, line: '这轮有点别扭：被夸别顺着说漂亮话，可以岔开一句。' },
  { id: 'tired', priority: 4, base: 0.05, scale: 0.6, habit: 0.30, gate: (v, i) => i < 0.55, line: '这轮有点乏：话短，能一句说完不写两句，别硬撑。' },
  { id: 'flat', priority: 2, base: 0.06, scale: 0.8, habit: 0.40, gate: () => true, line: '这轮懒得展开：只给结论，不附解释。' },
]

/** 按优先级排好的表：排一次，别每次掷都 sort。 */
export const ORDERED = Object.freeze(
  BEHAVIORS.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
)

export const behaviorById = (id) => BEHAVIORS.find((b) => b.id === id) || null

/** 习惯化系数：做过 n 次之后这一条的倍数。n=0 → 1；n=10 → 约 1.4~1.5；
 *  n=100 → 约 1.7~2.0；随 log2 增长，不会失控。habit=0 的行为永远 ×1。 */
export function habitMultiplier(behavior, n) {
  const h = Number(behavior?.habit ?? 0)
  const count = Number(n)
  // NaN / Infinity / 负数 / 0 一律回落到 1：坏的次数不该把概率弄成 NaN 或 Infinity
  if (!h || !Number.isFinite(count) || count <= 0) return 1
  return 1 + h * Math.log2(1 + count) * 0.25
}

/** 单条命中概率（不含「前面几条先命中」的遮挡）。封顶 maxProbability。 */
export function probabilityOf(behavior, state, cfg = {}, habits = {}) {
  const cap = Number.isFinite(cfg?.maxProbability) ? cfg.maxProbability : 0.45
  if (behavior?.certain) return 1
  const i = Number(state?.intensity ?? 0)
  const n = Math.max(0, Number(habits?.[behavior.id] ?? 0) || 0)
  const scale = Number.isFinite(cfg?.behaviorScale) ? cfg.behaviorScale : 1
  const p = behavior.base * (1 + behavior.scale * i * 2) * habitMultiplier(behavior, n) * scale
  if (!Number.isFinite(p)) return 0
  return Math.min(cap, Math.max(0, p))
}

/** 当前状态下每一条的概率与「门开没开」——给工具做审计用，不影响掷骰。 */
export function inspect(state, cfg = {}, context = {}, habits = {}) {
  const v = Number(state?.valence ?? 0)
  const i = Number(state?.intensity ?? 0)
  return ORDERED.map((b) => {
    let open = false
    try { open = !!b.gate(v, i, context || {}) } catch { open = false }
    return {
      id: b.id,
      open,
      certain: !!b.certain,
      p: open ? Number(probabilityOf(b, state, cfg, habits).toFixed(4)) : 0,
    }
  })
}

/** 掷一次。返回命中的行为，或 null（这一轮不带脾气，是合法结果）。
 *  rand 可注入，测试用固定种子。 */
export function rollBehavior(state, cfg = {}, context = {}, habits = {}, rand = Math.random) {
  const v = Number(state?.valence ?? 0)
  const i = Number(state?.intensity ?? 0)
  const c = context || {}
  const h = habits || {}
  const scale = Number.isFinite(cfg?.behaviorScale) ? cfg.behaviorScale : 1
  const cap = Number.isFinite(cfg?.maxProbability) ? cfg.maxProbability : 0.45
  for (const b of ORDERED) {
    try {
      if (!b.gate(v, i, c)) continue
      // 危险信号不掷骰：够格就一定命中，否则「这一轮没摇中」会让求救落空
      if (b.certain) return b
      const n = Math.max(0, Number(h[b.id] ?? 0) || 0)
      const p = Math.min(cap, b.base * (1 + b.scale * i * 2) * habitMultiplier(b, n) * scale)
      if (!Number.isFinite(p)) continue
      if (rand() < p) return b
    } catch {
      // 某条坏了就跳过，不影响其它
    }
  }
  return null
}

/** 注入用的一行。没有行为就返回空串（空段按「无段」处理）。
 *  有的 line 本身以「这轮」开头，别再加一层前缀。 */
export function renderBehavior(behavior) {
  const line = String(behavior?.line || '').trim()
  if (!line) return ''
  return line.startsWith('这轮') ? `（${line}）` : `（这轮：${line}）`
}

/** 从历史记录里数出每条做过多少次。坏行跳过，不抛。 */
export function countHabits(records) {
  const out = {}
  for (const r of Array.isArray(records) ? records : []) {
    const id = typeof r === 'string' ? r : r?.behavior
    if (typeof id === 'string' && id) out[id] = (out[id] || 0) + 1
  }
  return out
}
