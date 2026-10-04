import type { Plugin } from "@opencode-ai/plugin"
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

// Test seams: OPENCODE_9ROUTER_SYNC_DISABLE=1 disables this plugin;
// OPENCODE_9ROUTER_SYNC_BASEURL overrides only the catalog fetch URL.

const CACHE_PATH = "/home/vxwwx/.cache/opencode/9router-models.json"
const CACHE_DIRECTORY = "/home/vxwwx/.cache/opencode"
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// 5.52s measured p100 for /v1/models on 2026-09-26; retain ample headroom.
const FETCH_TIMEOUT_MS = 8_000
const FAILURE_BACKOFF_MS = 15 * 60 * 1000

// These configured defaults must survive a truncated, but otherwise valid, catalog.
const REQUIRED_MODEL_IDS = ["cc/claude-opus-5", "cx/gpt-5.6-terra"] as const

type GeneratedModel = {
  name: string
  limit: { context: number; output: number }
  tool_call: boolean
  reasoning: boolean
  attachment: boolean
  modalities: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">
    output: Array<"text" | "audio" | "image" | "video" | "pdf">
  }
}

type GeneratedModels = Record<string, GeneratedModel>
type CacheEntry = { fetchedAt?: unknown; failedAt?: unknown; models?: unknown }
type ParsedCache = { models?: GeneratedModels; fresh: boolean; backedOff: boolean }

class PinnedModelGuardError extends Error {}
class InvalidCatalogError extends Error {}

function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function humanize(id: string) {
  const withoutPrefix = id.replace(/^(?:cc|ag|cx|ninfer)\//, "")
  return withoutPrefix.split("-").map((part) => {
    if (part === "gpt") return "GPT"
    if (part === "oss") return "OSS"
    if (/^\d+b$/.test(part)) return `${part.slice(0, -1)}B`
    return part ? `${part[0].toUpperCase()}${part.slice(1)}` : part
  }).join(" ")
}

function isGeneratedModels(value: unknown): value is GeneratedModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const models = value as Record<string, unknown>
  if (Object.keys(models).length === 0) return false
  return Object.values(models).every((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return false
    const value = model as { name?: unknown; limit?: unknown; modalities?: unknown }
    if (typeof value.name !== "string" || !value.limit || typeof value.limit !== "object") return false
    const limit = value.limit as { context?: unknown; output?: unknown }
    return validLimit(limit.context) && validLimit(limit.output) && !!value.modalities && typeof value.modalities === "object"
  })
}

async function readCache(): Promise<ParsedCache | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CACHE_PATH, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const cache = parsed as CacheEntry
    const models = isGeneratedModels(cache.models) ? cache.models : undefined
    const fetchedAt = typeof cache.fetchedAt === "number" && Number.isFinite(cache.fetchedAt) ? cache.fetchedAt : undefined
    const failedAt = typeof cache.failedAt === "number" && Number.isFinite(cache.failedAt) ? cache.failedAt : undefined
    if (!models && !failedAt) return undefined
    return {
      models,
      fresh: !!models && !!fetchedAt && Date.now() - fetchedAt <= CACHE_TTL_MS,
      backedOff: !!failedAt && Date.now() - failedAt <= FAILURE_BACKOFF_MS,
    }
  } catch {
    return undefined
  }
}

async function writeCache(entry: { models?: GeneratedModels; failedAt?: number }) {
  let temporaryPath: string | undefined
  try {
    await mkdir(CACHE_DIRECTORY, { recursive: true })
    temporaryPath = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`
    const payload = entry.models
      ? { fetchedAt: Date.now(), ...(entry.failedAt ? { failedAt: entry.failedAt } : {}), models: entry.models }
      : { fetchedAt: Date.now(), failedAt: entry.failedAt ?? Date.now() }
    await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, CACHE_PATH)
  } catch {
    if (temporaryPath) await unlink(temporaryPath).catch(() => {})
  }
}

async function fetchCatalog(baseURL: string, apiKey: unknown, curatedNames: Record<string, unknown>): Promise<GeneratedModels> {
  const endpoint = `${baseURL.replace(/\/+$/, "")}/models`
  let signal: AbortSignal
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (typeof AbortSignal.timeout === "function") {
    signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  } else {
    controller = new AbortController()
    signal = controller.signal
    timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS)
  }

  try {
    const headers: Record<string, string> = {}
    if (typeof apiKey === "string" && apiKey) headers.Authorization = `Bearer ${apiKey}`
    const response = await fetch(endpoint, { headers, signal })
    if (!response.ok) throw new InvalidCatalogError()
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidCatalogError()
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data)) throw new InvalidCatalogError()

    const generated: GeneratedModels = {}
    for (const entry of data) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const upstream = entry as { id?: unknown; capabilities?: unknown; context_length?: unknown; max_completion_tokens?: unknown }
      if (typeof upstream.id !== "string" || !upstream.id) continue
      const capabilities = upstream.capabilities && typeof upstream.capabilities === "object" && !Array.isArray(upstream.capabilities)
        ? upstream.capabilities as Record<string, unknown> : {}
      const context = capabilities.contextWindow ?? upstream.context_length
      const output = capabilities.maxOutput ?? upstream.max_completion_tokens
      if (!validLimit(context) || !validLimit(output) || generated[upstream.id]) continue
      const vision = capabilities.vision === true
      const pdf = capabilities.pdf === true
      const audioInput = capabilities.audioInput === true
      const videoInput = capabilities.videoInput === true
      const original = curatedNames[upstream.id]
      const originalName = original && typeof original === "object" ? (original as { name?: unknown }).name : undefined
      generated[upstream.id] = {
        name: typeof originalName === "string" ? originalName : humanize(upstream.id),
        limit: { context, output },
        tool_call: capabilities.tools === true,
        reasoning: capabilities.reasoning === true,
        attachment: vision || pdf || audioInput || videoInput,
        modalities: {
          input: ["text", ...(vision ? ["image"] as const : []), ...(pdf ? ["pdf"] as const : []), ...(audioInput ? ["audio"] as const : []), ...(videoInput ? ["video"] as const : [])],
          output: ["text", ...(capabilities.imageOutput === true ? ["image"] as const : []), ...(capabilities.audioOutput === true ? ["audio"] as const : [])],
        },
      }
    }

    const sorted = Object.fromEntries(Object.keys(generated).sort().map((id) => [id, generated[id]])) as GeneratedModels
    if (!REQUIRED_MODEL_IDS.every((id) => id in sorted)) throw new PinnedModelGuardError()
    if (!isGeneratedModels(sorted)) throw new InvalidCatalogError()
    return sorted
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function logFailure(error: unknown, background = false) {
  if (error instanceof PinnedModelGuardError) {
    console.error("[9router-model-sync] catalog missing required models")
  } else {
    console.error(background ? "[9router-model-sync] background refresh failed" : "[9router-model-sync] catalog refresh failed")
  }
}

export default (async () => ({
  config: async (cfg) => {
    try {
      if (process.env.OPENCODE_9ROUTER_SYNC_DISABLE === "1") return
      const provider = cfg.provider?.["9router"]
      if (!provider || typeof provider.options?.baseURL !== "string") return
      const curatedNames = { ...(provider.models ?? {}) }
      const cached = await readCache()
      const baseURL = process.env.OPENCODE_9ROUTER_SYNC_BASEURL || provider.options.baseURL
      const refresh = async (existingModels?: GeneratedModels, background = false) => {
        try {
          const models = await fetchCatalog(baseURL, provider.options?.apiKey, curatedNames)
          await writeCache({ models })
          return models
        } catch (error) {
          await writeCache({ models: existingModels, failedAt: Date.now() })
          logFailure(error, background)
          return undefined
        }
      }

      if (cached?.models) {
        provider.models = cached.models
        if (!cached.fresh && !cached.backedOff) void refresh(cached.models, true).catch(() => {})
        return
      }
      if (cached?.backedOff) return

      const models = await refresh()
      if (models) provider.models = models
    } catch (error) {
      logFailure(error)
    }
  },
})) satisfies Plugin
