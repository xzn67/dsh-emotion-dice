// dsh-emotion-dice — 宿主半边
//
// 它只做一件事：让情绪决定「这一轮怎么说话」，而且是掷出来的，不是必定发生。
//
//   1. 每收到他一条消息，读一眼 dsh-emotion 的当前状态（valence / intensity）；
//   2. 从原话里抽几个信号位（危险 / 难受 / 被夸 / 办成了 / 被质疑 / 在问为什么）；
//   3. 按优先级掷一次，最多命中一条；命中就把那一句作为 systemPrompt 的一节注入；
//   4. 把每轮结果追加进自己的历史，用它算「这条做过多少次」——做惯的会变顺。
//
// 刻意不做的事：
//   · 不复制 dsh-emotion：情绪怎么来是它的事，这里只管把情绪换成一次行为抽样；
//   · 不 import 裸包（schemastery 除外，宿主自带），不依赖 npm 安装；
//   · 命中率封顶（默认 0.45），永远保留「这一轮没带情绪」的可能——否则就是表演；
//   · 关心（concern）和警觉（alert）的 habit = 0，永远不脱敏；警报不掷骰。

import sz from '@deepseek-ai/schemastery'
import { defineTool } from './vendor.js'
import {
  BEHAVIORS, ORDERED, behaviorById, extractContext, renderBehavior, rollBehavior,
} from './dice.js'
import {
  DEFAULT_EMOTION, DEFAULT_HISTORY, appendRecord, loadHabits, num, readEmotion,
} from './store.js'

export const name = 'emotion-dice'
export const inject = ['systemPrompt', 'tools']
export const removable = true

export const Config = sz.object({
  enabled: sz.boolean().default(true),
  behaviorScale: sz.number().default(1),
  maxProbability: sz.number().default(0.45),
  order: sz.number().default(51),
  /** 读别的插件写下的情绪状态；留空用默认位置。 */
  emotionFile: sz.string().default(''),
  /** 本插件自己的历史（只追加）。留空用默认位置。 */
  historyFile: sz.string().default(''),
  /** 历史超过这么多字节就轮转一半。 */
  historyMaxBytes: sz.number().default(2 * 1024 * 1024),
  /** 一条消息最多看多少字（长文本尾巴对信号判断没用，省时间）。 */
  maxTextChars: sz.number().default(8000),
  /** 情绪状态缓存多久（同一轮别反复读盘）。 */
  stateTtlMs: sz.number().default(1500),
})

export function apply(ctx, config = {}) {
  // 配置一律过一遍兜底：外部传进来的东西不能把概率弄成 NaN
  const cfg = {
    enabled: (config?.enabled ?? true) !== false,
    behaviorScale: num(config?.behaviorScale, 1, 0, 10),
    maxProbability: num(config?.maxProbability, 0.45, 0.02, 1),
    order: Math.round(num(config?.order, 51, 0, 1000)),
    historyMaxBytes: Math.round(num(config?.historyMaxBytes, 2 * 1024 * 1024, 4096, 64 * 1024 * 1024)),
    maxTextChars: Math.round(num(config?.maxTextChars, 8000, 64, 1_000_000)),
    stateTtlMs: Math.round(num(config?.stateTtlMs, 1500, 0, 60_000)),
  }
  const emotionPath = String(config?.emotionFile || DEFAULT_EMOTION).replace(/\\/g, '/')
  const historyPath = String(config?.historyFile || DEFAULT_HISTORY).replace(/\\/g, '/')
  let enabled = cfg.enabled

  // 情绪状态：短缓存，读不到就沿用上一次（别在文件缺失时来回抖）
  const cache = { at: -Infinity, state: { valence: 0, intensity: 0, label: '', ok: false } }
  const emotion = (fresh = false) => {
    if (!fresh && Date.now() - cache.at < cfg.stateTtlMs) return cache.state
    const next = readEmotion(emotionPath)
    if (next.ok) cache.state = next
    cache.at = Date.now()
    return cache.state
  }

  const habits = loadHabits(historyPath)
  const loadedIds = Object.keys(habits)
  console.log(`[emotion-dice] habits loaded ${loadedIds.map((k) => `${k}:${habits[k]}`).join(' ') || '(none)'}`)

  let current = null // 这一轮的行为（可能为 null）
  let rolls = 0
  let rotations = 0

  const rollFor = (text) => {
    const state = emotion(true)
    const sample = String(text || '').slice(0, cfg.maxTextChars)
    const context = extractContext(sample)
    const hit = rollBehavior(state, cfg, context, habits)
    if (hit) habits[hit.id] = (habits[hit.id] || 0) + 1
    rolls += 1
    const rotated = appendRecord(historyPath, {
      t: Date.now(),
      v: Number(state.valence.toFixed(3)),
      i: Number(state.intensity.toFixed(3)),
      behavior: hit?.id ?? null,
      context: Object.keys(context).filter((k) => context[k]).join(','),
    }, cfg.historyMaxBytes)
    if (rotated) rotations += 1
    console.log(`[emotion-dice] hit=${hit?.id ?? 'none'} v=${state.valence.toFixed(2)} i=${state.intensity.toFixed(2)}${rotated ? ' (history rotated)' : ''}`)
    return hit
  }

  // ① 感知：他说话 → 看情绪 → 掷一次
  ctx.on('session/event', (session, event) => {
    try {
      if (!enabled) return
      if (event?.type !== 'user/message') return
      const msg = event.data || {}
      if (msg.source?.kind !== 'user') return
      const text = (msg.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join(' ')
      if (!text || text.startsWith('<') || text.startsWith('Current ')) return
      current = rollFor(text)
    } catch (e) {
      console.log('[emotion-dice] roll skipped:', e?.message)
    }
  })

  // ② 表达：紧跟情绪那一段之后注入一行。没有命中就什么都不注入。
  const render = () => (enabled ? renderBehavior(current) : '')
  const resolvedOrder = () => {
    try {
      const base = ctx.systemPrompt.getSectionOrder('EMOTION_STATE')
      return Number.isFinite(base) ? base + 1 : cfg.order
    } catch {
      return cfg.order
    }
  }
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'EMOTION_BEHAVIOR',
      order: resolvedOrder(),
      text: render,
    }), 'emotion-dice.section()')
  } catch {
    try {
      ctx.systemPrompt.section({ name: 'EMOTION_BEHAVIOR', order: cfg.order, text: render })
      console.log('[emotion-dice] section order fallback')
    } catch (e) {
      console.log('[emotion-dice] prompt section skipped:', e?.message)
    }
  }

  // ③ 工具：想看现在掷出了什么、各条做了多少次、下一条的概率是多少
  try {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'emotion_dice',
      description: '看这一轮掷出的行为、每条的历史命中次数、以及当前状态下的概率（可审计，不是面板）。',
      parameters: {},
      output: { type: 'json' },
      execute: () => {
        const state = emotion()
        return {
          enabled,
          current: current ? { id: current.id, line: current.line } : null,
          emotion: {
            valence: Number(state.valence.toFixed(3)),
            intensity: Number(state.intensity.toFixed(3)),
            label: state.label,
            readable: state.ok,
          },
          habits,
          rolls,
          rotations,
          table: ORDERED.map((b) => ({
            id: b.id,
            priority: b.priority,
            habit: b.habit,
            certain: !!b.certain,
            line: b.line,
          })),
        }
      },
    })), 'emotion-dice.tool()')
  } catch (e) {
    console.log('[emotion-dice] tool skipped:', e?.message)
  }

  console.log(`[emotion-dice] mounted (cap=${cfg.maxProbability}, behaviors=${BEHAVIORS.length}, enabled=${enabled})`)
}

// 给测试用：不改全局状态，只算「现在这条门开着的话概率是多少」
export { behaviorById }
