import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreResponse } from "./response.js"

/**
 * OpenCode V2 适配层（>= 2.0.x）。
 *
 * V2 通过插件的 **默认导出** 加载插件，且要求默认导出是对象：
 *
 *   export default { id, setup }   // setup 或 effect 二选一
 *
 * 上游 0.1.0 只导出了命名函数 `VibeGuardPrivacy`，V2 加载会失败：
 *   Plugin must export a default definition with an id and an effect or setup function.
 *
 * 本文件把上游脱敏引擎接到 V2 的钩子面上：
 * - `session.hook("context")`      请求前脱敏（对应 V1 `experimental.chat.messages.transform`）
 * - `tool.hook("execute.before")`  工具执行前还原占位符（对应 V1 `tool.execute.before`）
 * - `session.hook("http.response")` 可选：响应体占位符还原（对应 V1 `experimental.text.complete`，
 *   默认关闭，见 response.js 中的说明）
 */
export const PLUGIN_ID = "opencode-vibeguard"

function isObject(value) {
  return Boolean(value) && typeof value === "object"
}

/**
 * 对 V2 消息内容分片做原地脱敏。
 *
 * V2 的 message.content 是 tagged union：
 * text | media | tool-call | tool-result | reasoning | compaction | effort。
 *
 * @returns {number} 修改的文本/参数片段数
 */
function redactContentPart(part, patterns, session) {
  if (!isObject(part)) return 0

  switch (part.type) {
    case "text":
    case "reasoning":
    case "compaction": {
      if (typeof part.text !== "string" || !part.text) return 0
      const result = redactText(part.text, patterns, session)
      part.text = result.text
      return result.matches.length > 0 ? 1 : 0
    }
    case "tool-call": {
      // 工具入参是最常见的泄漏来源（例如读取 .env）。
      if (!isObject(part.input)) return 0
      return redactDeep(part.input, patterns, session)
    }
    case "tool-result": {
      // 历史工具输出会在后续回合重新发给模型。
      if (!isObject(part.result)) return 0
      return redactDeep(part.result, patterns, session)
    }
    default:
      return 0
  }
}

/**
 * V2 setup 入口，行为与 V1 保持一致：找不到配置或 enabled=false 时为 no-op。
 *
 * @param {import("@opencode/plugin").Context} ctx
 */
export async function vibeguardSetup(ctx) {
  const directory = ctx?.location?.directory ?? process.cwd()
  const config = await loadConfig(directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "未找到（插件将 no-op）"
    console.log(`[opencode-vibeguard] 配置：${from} enabled=${config.enabled} response_mode=${config.responseMode}`)
  }

  if (!config.enabled) return

  const patterns = buildPatternSet(config.patterns)
  const sessions = new Map()

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    const existing = sessions.get(key)
    if (existing) return existing
    const created = new PlaceholderSession({
      prefix: config.prefix,
      style: config.placeholderStyle,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, created)
    return created
  }

  const registrations = []

  // 请求前脱敏：system + 全部消息分片。
  registrations.push(
    await ctx.session.hook("context", (input) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()

      let changed = 0

      if (Array.isArray(input.system)) {
        for (const part of input.system) {
          if (!isObject(part) || typeof part.text !== "string" || !part.text) continue
          const result = redactText(part.text, patterns, session)
          if (result.matches.length === 0) continue
          part.text = result.text
          changed++
        }
      }

      if (Array.isArray(input.messages)) {
        for (const message of input.messages) {
          if (!isObject(message) || !Array.isArray(message.content)) continue
          for (const part of message.content) {
            changed += redactContentPart(part, patterns, session)
          }
        }
      }

      if (debug && changed > 0) {
        console.log(`[opencode-vibeguard] 本次请求前脱敏：已修改 ${changed} 处片段`)
      }
    }),
  )

  // 工具执行前还原：保证本机拿到真实值。
  registrations.push(
    await ctx.tool.hook("execute.before", (input) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      restoreDeep(input?.input, session)
    }),
  )

  // 响应模式：stream（默认，保留流式）或 restore（缓冲后还原占位符）。
  if (config.responseMode === "restore") {
    registrations.push(
      await ctx.session.hook("http.response", async (input) => {
        const session = getSession(input?.sessionID)
        if (!session) return
        session.cleanup()

        try {
          const replacement = await restoreResponse(input.response, session)
          if (!replacement) return
          input.response = replacement
          if (debug) console.log("[opencode-vibeguard] 响应体已还原占位符")
        } catch (error) {
          if (debug) console.log(`[opencode-vibeguard] 响应体还原失败：${error}`)
        }
      }),
    )
  }

  // V2 在卸载/销毁时调用返回的 cleanup。
  return async () => {
    for (const registration of registrations) {
      try {
        await registration?.dispose?.()
      } catch {
        // 尽力而为
      }
    }
  }
}

/** V2 插件定义（默认导出契约）。 */
export const vibeguardV2 = {
  id: PLUGIN_ID,
  setup: vibeguardSetup,
}