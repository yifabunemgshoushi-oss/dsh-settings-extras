/**
 * dsh-settings-extras — Host 半侧。
 *
 * 本插件不拥有执行逻辑，只把用户在「设置 → 通用设置」里选定的两个值推送到
 * 真正生效的位置，并在每次模型请求上做档位安全换档。
 *
 * 一、自动压缩阈值 → 各 Agent 预设内联的 `compaction-basic.config.thresholdRatio`
 *   预设行是 profile 根 Include 的直属条目，configEditor 能唯一寻址并整份重写；
 *   而阈值所在的 compaction-basic 是预设 `plugins` 数组里的**嵌套行**——补丁层
 *   只有 id 寻址、且三个预设的嵌套行同名冲突，所以只能整份重写预设 config。
 *   这里按包名扫描所有 `@deepseek-ai/dsh-agent-preset` 行，因此将来新增的预设
 *   会被自动纳入，无需改代码。
 *
 * 二、默认思考等级 → 两处
 *   a) `agent/request` 换档：pi-ai 路由的「模型默认档」来自 provider 级 `reasoning`，
 *      而它是 route 级，无法表达「按模型升高/降档」。故在请求的最终配置上按该模型
 *      实际支持的档位集合重选一档（取 ≥ 目标的最小档，没有更高档则取最高档）。
 *   b) 各 provider 的 `reasoning`：让输入框旁的档位显示不再落到 Default。
 *
 * 写入纪律：只在**确实不同**时才调用 configEditor.edit —— edit 在 next 与 inherited
 * 深等时会删除该行的 config，盲目写入会抹掉用户自己固定的预设配置。
 */

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/**
 * 诊断日志：只保留最近若干行，写在本插件目录下。
 * 用途是让「推流是否发生、哪一条写入失败」可被外部观察——此前只能靠猜。
 */
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile.log')
const LOG_MAX_LINES = 120
let logLines = []
let logChain = Promise.resolve()

function trace(message) {
  logLines = [...logLines, `${new Date().toISOString()} ${message}`].slice(-LOG_MAX_LINES)
  const snapshot = logLines.join('\n') + '\n'
  logChain = logChain.then(() => writeFile(LOG_PATH, snapshot, 'utf8')).catch(() => {})
}

export const name = 'dsh-settings-extras'

/** configEditor 用于把偏好写入 preset/provider 行；llm 用于查单个模型支持的档位。 */
export const inject = ['configEditor', 'llm']

/** 设置命名空间 = 本插件在 profile 里的 Loader 行 id。 */
const NS = 'dsh-settings-extras'

const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const DEFAULT_MODEL_ENTRY = 'agent-default-model'

/** 适配器自有的档位名空间（pi-ai 的 ModelThinkingLevel，由低到高）。 */
const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 两个偏好都存在本插件自己的配置里，字段必须是 volatile 才能被设置页写入。 */
export const Config = z.object({
  // 上限 0.95：取 1.0 时触发点等于压力预算上限，容易先撞上 provider 上下文上限。
  // 下限 0.2：必须高于 retainRatio（compaction-basic 要求 retainRatio < thresholdRatio，
  // 其默认值为 0.16），否则预设会在加载期拒绝。
  compactionThreshold: z.number().min(0.2).max(0.95).default(0.5).volatile(),
  defaultReasoningEffort: z.string().default('high').volatile(),
})

/**
 * 把目标档位映射到某模型实际支持的档位集合。
 * @param target 用户设定的默认档位名。
 * @param supported 该模型支持的有序档位名（由低到高）。
 * @returns 要使用的档位名；无法安全映射时返回 undefined（保持原状）。
 */
function remapEffort(target, supported) {
  if (!Array.isArray(supported) || supported.length === 0) return undefined
  if (supported.includes(target)) return target
  const rank = LEVEL_ORDER.indexOf(target)
  // 目标是 off 时不往上抬：不支持 off 就交给 provider 自己的默认，而不是反而拉满。
  if (target === 'off' || rank < 0) return undefined
  let best
  for (const id of supported) {
    const candidate = LEVEL_ORDER.indexOf(id)
    if (candidate > rank && (best === undefined || candidate < best.rank)) best = { rank: candidate, id }
  }
  return best === undefined ? supported[supported.length - 1] : best.id
}

/** 取某预设 config 的 compaction-basic 阈值；非预设或结构不符时返回 undefined。 */
function presetThreshold(raw) {
  if (!raw || !Array.isArray(raw.plugins)) return undefined
  for (const row of raw.plugins) {
    if (!row || row.id !== 'compaction' || !Array.isArray(row.config)) continue
    for (const inner of row.config) {
      if (inner && inner.id === 'compaction-basic') return inner.config?.thresholdRatio
    }
  }
  return undefined
}

/** 返回写入阈值后的新预设 config；已经相等时返回 undefined（不要写）。 */
function withThreshold(raw, ratio) {
  if (!raw || !Array.isArray(raw.plugins)) return undefined
  let changed = false
  const plugins = raw.plugins.map((row) => {
    if (!row || row.id !== 'compaction' || !Array.isArray(row.config)) return row
    let rowChanged = false
    const config = row.config.map((inner) => {
      if (!inner || inner.id !== 'compaction-basic') return inner
      if (inner.config?.thresholdRatio === ratio) return inner
      rowChanged = true
      return { ...inner, config: { ...(inner.config ?? {}), thresholdRatio: ratio } }
    })
    if (!rowChanged) return row
    changed = true
    return { ...row, config }
  })
  return changed ? { ...raw, plugins } : undefined
}

/** 返回给各 provider 写入 reasoning 后的新 config；无 providers 或已相等时返回 undefined。 */
function withProviderReasoning(raw, effort) {
  if (!raw || effort === '' || typeof raw.providers !== 'object' || raw.providers === null) return undefined
  let changed = false
  const providers = Object.fromEntries(Object.entries(raw.providers).map(([route, profile]) => {
    if (!profile || typeof profile !== 'object' || profile.reasoning === effort) return [route, profile]
    changed = true
    return [route, { ...profile, reasoning: effort }]
  }))
  return changed ? { ...raw, providers } : undefined
}

/**
 * 找出本轮还需要写的一条目标，并把计算结果交给调用方。
 * entries() 在每次 edit 后可能整体更换，因此每轮都重新读取；skip 里的 id 表示
 * 本批已失败过的行，跳过它们以免在同一失败上打转。
 */
function nextWrite(editor, threshold, effort, skip) {
  for (const entry of editor.entries()) {
    if (skip.has(entry.options.id)) continue
    if (entry.options.name === PRESET_MODULE) {
      const next = withThreshold(entry.options.config, threshold)
      if (next !== undefined) return { entry, next }
      continue
    }
    if (entry.options.id === DEFAULT_MODEL_ENTRY) {
      const current = entry.options.config ?? {}
      if (effort !== '' && current.reasoningEffort !== effort) {
        return { entry, next: { ...current, reasoningEffort: effort } }
      }
      continue
    }
    const next = withProviderReasoning(entry.options.config, effort)
    if (next !== undefined) return { entry, next }
  }
  return undefined
}

/** 把两个偏好推送到所有生效位置；每轮只写一条，直到没有差异。 */
async function reconcile(ctx, config) {
  const threshold = Number(config.compactionThreshold.get())
  const effort = String(config.defaultReasoningEffort.get() ?? '')
  if (!Number.isFinite(threshold) || effort === '') return
  const editor = ctx.configEditor
  if (editor === undefined) { trace('跳过：configEditor 不可用'); return }
  const skip = new Set()
  let wrote = 0
  for (let pass = 0; pass < 12; pass++) {
    const pending = nextWrite(editor, threshold, effort, skip)
    if (pending === undefined) break
    try {
      await editor.edit(pending.entry, () => pending.next)
      wrote++
      trace(`已写 ${pending.entry.options.id}（阈值 ${threshold} / 档位 ${effort}）`)
    } catch (error) {
      skip.add(pending.entry.options.id)
      trace(`写 ${pending.entry.options.id} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (wrote === 0) trace(`无需写入（阈值 ${threshold} / 档位 ${effort}）`)
}

/**
 * 在每条请求的最终配置上按模型精确换档，并让各 provider 的显示默认档跟随设置。
 * @param ctx Host 根上下文。
 * @param config 本插件已解析的配置。
 */
export function apply(ctx, config) {
  // 只能改「没有显式档位」的请求：用户在输入框里手选过档位的会话保持其选择。
  // prepend 让我们位于链的最外层，await next() 才能拿到 installModelSelection
  // 应用过 provider/model 之后的最终配置。
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      if (resolved.reasoningEffort !== undefined) return resolved
      const target = String(config.defaultReasoningEffort.get() ?? '')
      if (target === '') return resolved
      let info
      try {
        info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model)
      } catch {
        return resolved
      }
      const supported = info?.reasoning?.efforts?.map((effort) => effort.id) ?? []
      const level = remapEffort(target, supported)
      return level === undefined ? resolved : { ...resolved, reasoningEffort: level }
    }, { prepend: true })
  })

  // 触发方式：以轮询 volatile 值为准。
  // 原因：settings/document-updated 只在 describe() 检测到原始值变化时发出。Host 的
  // 写入路径（settings.update → configEditor.edit → describe()）理论上会发出它，但
  // 实测拖动滑块后并没有推流，这条链路不够可靠。轮询读 volatile 引用不依赖任何事件，
  // 是确定性的触发；值未变时既不写入也不产生副作用。
  let appliedKey
  let running = false
  let consecutiveFailures = 0
  const check = () => {
    const key = `${config.compactionThreshold.get()}|${config.defaultReasoningEffort.get()}`
    if (key === appliedKey || running) return
    running = true
    void reconcile(ctx, config).then(() => {
      appliedKey = key
      consecutiveFailures = 0
    }).catch((error) => {
      consecutiveFailures++
      trace(`推送异常（第 ${consecutiveFailures} 次）: ${error instanceof Error ? error.message : String(error)}`)
      // 连续失败到上限后，本轮不再重试，避免以 1.5 秒周期反复打 Loader。
      if (consecutiveFailures >= 5) appliedKey = key
    }).finally(() => { running = false })
  }
  ctx.on('settings/document-updated', (ns) => { if (ns === NS) check() })
  ctx.effect(() => {
    const interval = setInterval(check, 1500)
    return () => { clearInterval(interval) }
  })
}
