import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { vibeguardSetup } from "../src/index.js"

const EMAIL = "alice@example.test"

let dir
let cleanup
let contextHook
let toolHook
let responseHook
let sessionID
let placeholder

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "opencode-vibeguard-"))
  const configPath = path.join(dir, "vibeguard.config.json")
  await writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      debug: false,
      placeholder_prefix: "__VG_",
      placeholder_style: "short",
      restore_response: true,
      patterns: { builtin: ["email"], keywords: [], regex: [], exclude: [] },
    }),
  )

  process.env.OPENCODE_VIBEGUARD_CONFIG = configPath
  delete process.env.OPENCODE_VIBEGUARD_DEBUG

  const hooks = { context: [], tool: [], response: [] }
  const ctx = {
    location: { directory: dir },
    session: {
      hook: async (name, callback) => {
        hooks[name === "context" ? "context" : "response"].push(callback)
        return { dispose: async () => {} }
      },
    },
    tool: {
      hook: async (_name, callback) => {
        hooks.tool.push(callback)
        return { dispose: async () => {} }
      },
    },
  }

  cleanup = await vibeguardSetup(ctx)
  assert.equal(hooks.context.length, 1)
  assert.equal(hooks.tool.length, 1)
  assert.equal(hooks.response.length, 1)

  contextHook = hooks.context[0]
  toolHook = hooks.tool[0]
  responseHook = hooks.response[0]
  sessionID = "ses_test"
})

after(async () => {
  await cleanup()
  delete process.env.OPENCODE_VIBEGUARD_CONFIG
  await rm(dir, { recursive: true, force: true })
})

test("redacts system, messages, tool calls and tool results", () => {
  const input = {
    sessionID,
    system: [{ text: `Support contact is ${EMAIL}` }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `my email is ${EMAIL}` },
          { type: "tool-call", id: "t1", name: "read", input: { path: ".env", note: EMAIL } },
          { type: "tool-result", id: "t1", name: "read", result: { type: "text", value: `EMAIL=${EMAIL}` } },
        ],
      },
    ],
  }

  contextHook(input)

  const serialized = JSON.stringify(input)
  assert.ok(!serialized.includes(EMAIL), "plaintext email must be redacted")
  placeholder = serialized.match(/__VG_EMAIL_\d+__/)?.[0]
  assert.match(placeholder ?? "", /^__VG_EMAIL_\d+__$/)
})

test("restores placeholders in tool arguments before execution", () => {
  const input = { sessionID, input: { path: ".env", note: placeholder } }
  toolHook(input)
  assert.equal(input.input.note, EMAIL)
})

test("restores a placeholder split across SSE events", async () => {
  const id = placeholder.match(/_(\d+)__$/)[1]
  const chunks = ["__VG_EMAIL", "_", id, "__"]
  const body =
    `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
    chunks.map((content) => `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`).join("") +
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
    `data: [DONE]\n\n`

  const request = {
    sessionID,
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
  }
  const original = request.response

  await responseHook(request)
  assert.notEqual(request.response, original, "response must be replaced")

  const restored = await request.response.text()
  const assembled = restored
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .map((event) => event.choices?.[0]?.delta?.content)
    .filter((value) => typeof value === "string")
    .join("")

  assert.equal(assembled, EMAIL)
})

test("restores a non-streaming JSON response", async () => {
  const body = JSON.stringify({ content: [{ type: "text", text: `mail: ${placeholder}` }] })
  const request = {
    sessionID,
    response: new Response(body, { headers: { "content-type": "application/json" } }),
  }

  await responseHook(request)
  assert.deepEqual(JSON.parse(await request.response.text()), {
    content: [{ type: "text", text: `mail: ${EMAIL}` }],
  })
})

test("leaves untouched bodies and their stream intact", async () => {
  const body = "no secrets here"
  const original = new Response(body, { headers: { "content-type": "text/plain" } })
  const request = { sessionID, response: original }

  await responseHook(request)

  assert.equal(request.response, original)
  assert.equal(await request.response.text(), body)
})

test("stream mode keeps streaming and registers no response hook", async () => {
  const previous = process.env.OPENCODE_VIBEGUARD_CONFIG
  const streamDir = await mkdtemp(path.join(os.tmpdir(), "opencode-vibeguard-stream-"))
  const streamConfig = path.join(streamDir, "vibeguard.config.json")
  await writeFile(
    streamConfig,
    JSON.stringify({
      enabled: true,
      response_mode: "stream",
      patterns: { builtin: ["email"], keywords: [], regex: [], exclude: [] },
    }),
  )

  let responseHooks = 0
  const ctx = {
    location: { directory: streamDir },
    session: {
      hook: async (name) => {
        if (name === "http.response") responseHooks++
        return { dispose: async () => {} }
      },
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
  }

  process.env.OPENCODE_VIBEGUARD_CONFIG = streamConfig
  try {
    const dispose = await vibeguardSetup(ctx)
    assert.equal(responseHooks, 0, "stream mode must not intercept responses")
    await dispose()
  } finally {
    process.env.OPENCODE_VIBEGUARD_CONFIG = previous
    await rm(streamDir, { recursive: true, force: true })
  }
})