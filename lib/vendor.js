// 内联 helper（vendor）：npm 上 dsh 包滞后/受限，无法作依赖安装。
// 行为对齐 dsh@1517a4db 源码：core/tools/src/schema.ts。
// 与 dsh-relationship-heart 里同名文件一致。
/** 参数 DSL → JSON Schema（schema.ts parameterSchemaSpecToJsonSchema 的最小等价） */
function paramsToJsonSchema(params) {
  const properties = {}
  const required = []
  for (const [name, p] of Object.entries(params || {})) {
    properties[name] = { type: p.type, description: p.description || '' }
    if (p.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** defineTool：产出 registry 可用的 ToolDefinition（schema.ts:553-600 最小等价） */
export function defineTool(options) {
  const parameters = paramsToJsonSchema(options.parameters)
  const output = options.output || {}
  // {type:'json'} 是 DSL：转成「任意 JSON」的空 JSON Schema
  const outSchema = output.schema?.type === 'json' ? {} : (output.schema || {})
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outSchema,
      render: (args, value) => (output.render
        ? output.render(args, value)
        : [{ type: 'text', text: JSON.stringify(value) }]),
    },
    async execute(args, exec) {
      const missing = (parameters.required || []).filter((k) => args?.[k] === undefined)
      if (missing.length) throw new Error(`missing required argument(s): ${missing.join(', ')}`)
      return options.execute(args ?? {}, exec)
    },
  }
}
