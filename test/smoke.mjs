// 冒烟测试：用假的 ctx 把插件真的挂一遍，看她能不能装上、能不能掷、注入的是什么。
// 这不是单测——单测测的是纯函数；这个测的是「apply() 里的接线有没有接错」。
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dice-smoke-'))
const emotionFile = join(dir, 'emotion.json')
const historyFile = join(dir, 'history.jsonl')

const writeEmotion = (valence, intensity) => writeFileSync(emotionFile, JSON.stringify({
  unit: { name: 'emotion', version: 1 },
  tables: { state: { current: { valence, intensity, label: '测试' } }, meta: {} },
}), 'utf8')

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}`) }
}

const mod = await import('../lib/index.js')

const handlers = {}
const sections = []
const tools = []
const ctx = {
  on(ev, fn) { handlers[ev] = fn },
  effect(fn) { fn() },
  systemPrompt: {
    section(s) { sections.push(s); return () => {} },
    getSectionOrder() { return 50 },
  },
  tools: { register(t) { tools.push(t); return () => {} } },
}

mod.apply(ctx, { enabled: true, emotionFile, historyFile })

ok(sections.length === 1, '挂载后注册了一个 prompt 段')
const sec = sections[0]
ok(sec.name === 'EMOTION_BEHAVIOR', '段名是 EMOTION_BEHAVIOR')
ok(typeof sec.text === 'function', '段文本是函数（每轮重算，不是快照）')
ok(sec.order === 51, 'order 跟在 EMOTION_STATE(50) 后面')
ok(tools.length === 1 && tools[0].name === 'emotion_dice', '注册了 emotion_dice 工具')

const emit = (text) => handlers['session/event'](null, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

// 危险信号：不掷骰，必中
writeEmotion(-0.5, 0.7)
emit('我不想活了')
ok(sec.text().includes('危险信号'), `危险信号必中（实得：${sec.text()}）`)

// 普通闲聊：不该被认成难受
const before = sec.text()
emit('今天天气不错')
ok(true, `普通消息跑完不炸（上一次：${before || '空'}，这次：${sec.text() || '空'}）`)

// 情绪文件坏了也不能崩
writeFileSync(emotionFile, '{ this is not json', 'utf8')
emit('修好了，跑起来了')
ok(true, '情绪文件是坏 JSON 也不炸')

// 历史写进去了吗
ok(existsSync(historyFile), '历史文件被创建')
const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
ok(lines.length === 3, `三轮都记了（实得 ${lines.length} 条）`)
const rows = lines.map((l) => JSON.parse(l))
ok(rows.every((r) => typeof r.t === 'number' && 'behavior' in r), '每条都有时间与行为字段')

// 工具能读
const out = await tools[0].execute({}, {})
ok(out && typeof out.enabled === 'boolean' && out.table.length === 11, '工具返回行为表 11 条')
ok(out.emotion && typeof out.emotion.valence === 'number', '工具带当前情绪读数')

// 关掉就不注入
const sections2 = []
const ctx2 = {
  on(ev, fn) { handlers2[ev] = fn },
  effect(fn) { fn() },
  systemPrompt: { section(s) { sections2.push(s); return () => {} }, getSectionOrder() { return 50 } },
  tools: { register() { return () => {} } },
}
const handlers2 = {}
mod.apply(ctx2, { enabled: false })
ok(sections2[0].text() === '', 'enabled=false 时注入空串')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
