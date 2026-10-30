import { restoreText } from "./restore.js"
import { restoreDeep } from "./deep.js"

/**
 * 可选：在模型响应交给 OpenCode 之前，把响应体里的占位符还原成真实值。
 *
 * 这是 V1 `experimental.text.complete` 在 V2 下最接近的等价物：
 * V2 没有“响应完成”钩子，但 `session.hook("http.response")` 拿到的
 * `input.response` 可以被整体替换。
 *
 * 难点：占位符在 SSE 流里常被拆成多个 `data:` 事件（每个 delta 一个）。
 * 因此这里不是逐事件替换，而是：
 *   1. 按 JSON 路径（如 choices.0.delta.content）把同一段的 delta 拼接起来；
 *   2. 对拼接后的完整文本做占位符还原；
 *   3. 把还原结果写回该路径的第一个事件，后续事件置空。
 * 这样跨事件拆分的占位符也能正确还原，且事件顺序/结构不变。
 *
 * 注意：只要注册了 `http.response`，OpenCode 会先把响应体读完再交给 AI SDK，
 * 流式渲染会退化为一次性返回。因此该能力默认关闭，由 `response_mode: "restore"` 开启。
 */

/** 这些 JSON 字段是“流式文本增量”，需要跨事件拼接。 */
const DELTA_KEYS = new Set([
  "content",
  "text",
  "reasoning",
  "reasoning_content",
  "thinking",
  "arguments",
  "partial_json",
])

function isObject(value) {
  return Boolean(value) && typeof value === "object"
}

/** 收集一个事件里所有字符串叶子，保留可写引用与所在 data 行的下标。 */
function collectDeltaLeaves(node, path, lineIndex, out) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectDeltaLeaves(node[i], `${path}.${i}`, lineIndex, out)
    }
    return
  }
  if (!isObject(node)) return

  for (const key of Object.keys(node)) {
    const value = node[key]
    const childPath = path ? `${path}.${key}` : key
    if (typeof value === "string") {
      if (DELTA_KEYS.has(key)) {
        out.push({ lineIndex, node, key, path: childPath, value })
      }
      continue
    }
    if (value && typeof value === "object") {
      collectDeltaLeaves(value, childPath, lineIndex, out)
    }
  }
}

function restoreWholeJson(body, session) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return body
  }
  const before = JSON.stringify(value)
  restoreDeep(value, session)
  return JSON.stringify(value) === before ? body : JSON.stringify(value)
}

/**
 * @param {string} body
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 * @returns {string}
 */
export function restoreResponseBody(body, session) {
  if (typeof body !== "string" || !body) return body
  // 便宜的短路：响应里根本没有占位符前缀时不做任何解析。
  if (!body.includes(session.prefix)) return body

  if (!/(^|\n)data:/.test(body)) {
    return body.trimStart().startsWith("{") ? restoreWholeJson(body, session) : body
  }

  const lines = body.split("\n")
  const events = []
  const leaves = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]
    const match = raw.match(/^data:[ \t]?([^\r]*)(\r?)$/)
    if (!match) continue

    const payload = match[1]
    if (!payload || payload === "[DONE]") continue

    let json
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }

    const event = { lineIndex, json, changed: false, trailingCR: match[2] }
    events.push(event)
    collectDeltaLeaves(json, "", lineIndex, leaves)
  }

  if (events.length === 0) return body

  // 同一路径的 delta 拼起来；占位符即使被拆到多个事件也能还原。
  const streams = new Map()
  for (const leaf of leaves) {
    let stream = streams.get(leaf.path)
    if (!stream) {
      stream = { text: "", refs: [] }
      streams.set(leaf.path, stream)
    }
    stream.text += leaf.value
    stream.refs.push(leaf)
  }

  const changedLines = new Set()
  for (const stream of streams.values()) {
    if (!stream.text.includes(session.prefix)) continue
    const restored = restoreText(stream.text, session)
    if (restored === stream.text) continue

    // 整段写回第一个事件，后续置空；客户端按顺序拼接仍得到完整文本。
    stream.refs[0].node[stream.refs[0].key] = restored
    for (let i = 1; i < stream.refs.length; i++) {
      stream.refs[i].node[stream.refs[i].key] = ""
    }
    for (const ref of stream.refs) changedLines.add(ref.lineIndex)
  }

  if (changedLines.size === 0) return body

  for (const event of events) {
    if (!changedLines.has(event.lineIndex)) continue
    lines[event.lineIndex] = `data: ${JSON.stringify(event.json)}${event.trailingCR}`
  }

  return lines.join("\n")
}

/**
 * 对 `http.response` 钩子拿到的 Response 做占位符还原。
 * 命中时返回新的 Response；未命中返回 null（原响应未被消费，可直接使用）。
 *
 * 关键：用 clone() 读取，绝不消费原 response.body，
 * 否则返回原对象会触发 `ReadableStream is locked`。
 *
 * @param {Response} response
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export async function restoreResponse(response, session) {
  if (!response || typeof response.clone !== "function") return null
  if (!response.body) return null

  let body
  try {
    body = await response.clone().text()
  } catch {
    return null
  }

  const restored = restoreResponseBody(body, session)
  if (restored === body) return null

  const headers = new Headers(response.headers)
  // 长度会变化；体已由 fetch 解压，编码相关头也一并去掉。
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")

  return new Response(restored, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}