import z from "zod"
import * as path from "path"
import { createTwoFilesPatch } from "diff"
import { Tool } from "./tool"
import { Hands, type HandsItem } from "../hands/hands"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import DESCRIPTION from "./hands.txt"
import { assertExternalDirectory } from "./external-directory"
import { FileTime } from "../file/time"
import { trimDiff } from "./edit"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"

const MAX_SIZE = 10 * 1024 * 1024 // 10MB limit per item
const MAX_TOTAL_SIZE = 100 * 1024 * 1024 // 100MB total limit

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function isBinaryContent(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 512)
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i]
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return true
    }
  }
  return false
}

function formatContent(item: HandsItem): string {
  if (item.encoding === "base64") {
    return `<content type="${item.type}" encoding="${item.encoding}" source="${item.source ?? ""}">\n[${item.type === "image" ? "image" : "binary"} content, base64 encoded, ${formatSize(item.size)}]\n</content>`
  }
  return `<content type="${item.type}" encoding="${item.encoding}" source="${item.source ?? ""}">\n${item.content}\n</content>`
}

const ActionSchema = z.enum(["pickup", "place", "show"])

type PickupMetadata = {
  action: "pickup"
  name: string
  type: HandsItem["type"]
  encoding: HandsItem["encoding"]
  size: number
  source?: string
}

type PlaceMetadata = {
  action: "place"
  name: string
  type: HandsItem["type"]
  encoding: HandsItem["encoding"]
  size: number
  source?: string
  kept: boolean
}

type ShowMetadata = {
  action: "show"
  items: Omit<HandsItem, "content">[]
}

type HandsMetadata = PickupMetadata | PlaceMetadata | ShowMetadata

async function askPickup(ctx: Tool.Context, filepath: string) {
  const stat = Filesystem.stat(filepath)
  await assertExternalDirectory(ctx, filepath, {
    bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    kind: stat?.isDirectory() ? "directory" : "file",
  })
  await ctx.ask({
    permission: "read",
    patterns: [filepath],
    always: ["*"],
    metadata: {},
  })
}

async function paste(ctx: Tool.Context, filepath: string, item: HandsItem) {
  await assertExternalDirectory(ctx, filepath)

  const exists = await Filesystem.exists(filepath)
  if (exists) await FileTime.assert(ctx.sessionID, filepath)

  const diff =
    item.encoding !== "utf8"
      ? undefined
      : trimDiff(createTwoFilesPatch(filepath, filepath, exists ? await Filesystem.readText(filepath) : "", item.content))

  await ctx.ask({
    permission: "edit",
    patterns: [path.relative(Instance.worktree, filepath)],
    always: ["*"],
    metadata: {
      filepath,
      diff,
    },
  })

  await Filesystem.write(filepath, item.encoding === "base64" ? Buffer.from(item.content, "base64") : item.content)
  await Bus.publish(File.Event.Edited, {
    file: filepath,
  })
  await Bus.publish(FileWatcher.Event.Updated, {
    file: filepath,
    event: exists ? "change" : "add",
  })
  await FileTime.read(ctx.sessionID, filepath)
}

export const HandsTool = Tool.define<z.ZodObject<{
  action: typeof ActionSchema
  name: z.ZodOptional<z.ZodString>
  content: z.ZodOptional<z.ZodString>
  file: z.ZodOptional<z.ZodString>
  to: z.ZodOptional<z.ZodString>
  keep: z.ZodOptional<z.ZodBoolean>
}>, HandsMetadata>("hands", {
  description: DESCRIPTION,
  parameters: z.object({
    action: ActionSchema.describe("pickup: grab content, place: drop content, show: list all"),
    name: z.string().describe("Unique identifier (required for pickup/place, optional for show to view specific item)").optional(),
    content: z.string().describe("Text content (for pickup, use either content or file)").optional(),
    file: z.string().describe("File path (for pickup, auto-detects type)").optional(),
    to: z.string().describe("Target file path (for place, if omitted the item is discarded)").optional(),
    keep: z.boolean().describe("Keep in hand after writing to file (default false, only used with 'to')").optional(),
  }),
  async execute(params, ctx) {
    switch (params.action) {
      case "pickup":
        return executePickup(params, ctx)
      case "place":
        return executePlace(params, ctx)
      case "show":
        return executeShow(params, ctx)
    }
  },
})

async function executePickup(
  params: { name?: string; content?: string; file?: string },
  ctx: Tool.Context<HandsMetadata>,
) {
  if (!params.name) {
    throw new Error("name is required for pickup action")
  }
  if (!params.content && !params.file) {
    throw new Error("Must provide either content or file parameter")
  }
  if (params.content && params.file) {
    throw new Error("Cannot use both content and file parameters, choose one")
  }

  let type: "text" | "image" | "file" = "text"
  let encoding: "utf8" | "base64" = "utf8"
  let content: string
  let source: string | undefined
  let size: number

  if (params.file) {
    let filepath = params.file
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }

    await askPickup(ctx, filepath)

    const stat = Filesystem.stat(filepath)
    if (!stat) {
      throw new Error(`File not found: ${filepath}`)
    }
    if (stat.isDirectory()) {
      throw new Error(`Cannot pickup a directory: ${filepath}`)
    }
    const fileSize = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
    if (fileSize > MAX_SIZE) {
      throw new Error(`File too large: ${formatSize(fileSize)}, maximum is ${formatSize(MAX_SIZE)}`)
    }

    source = path.relative(Instance.worktree, filepath)

    const bytes = await Filesystem.readBytes(filepath)
    await FileTime.read(ctx.sessionID, filepath)

    const mime = Filesystem.mimeType(filepath)
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml"

    if (isImage) {
      type = "image"
      encoding = "base64"
      content = Buffer.from(bytes).toString("base64")
      size = bytes.length
    } else {
      const isBinary = isBinaryContent(bytes)
      if (isBinary) {
        type = "file"
        encoding = "base64"
        content = Buffer.from(bytes).toString("base64")
        size = bytes.length
      } else {
        type = "file"
        encoding = "utf8"
        content = await Filesystem.readText(filepath)
        size = Buffer.byteLength(content, "utf-8")
      }
    }
  } else {
    content = params.content!
    encoding = "utf8"
    size = Buffer.byteLength(content, "utf-8")
    source = undefined
    if (size > MAX_SIZE) {
      throw new Error(`Content too large: ${formatSize(size)}, maximum is ${formatSize(MAX_SIZE)}`)
    }
  }

  const currentTotal = await Hands.totalSize(ctx.sessionID)
  if (currentTotal + size > MAX_TOTAL_SIZE) {
    throw new Error(
      `Exceeds total size limit: current ${formatSize(currentTotal)}, adding ${formatSize(size)}, max ${formatSize(MAX_TOTAL_SIZE)}`,
    )
  }

  await Hands.put({
    sessionID: ctx.sessionID,
    name: params.name,
    type,
    encoding,
    content,
    source,
    size,
  })

  return {
    title: params.name,
    output: `Picked up: ${params.name} (${type}, ${encoding}, ${formatSize(size)})`,
    metadata: {
      action: "pickup",
      name: params.name,
      type,
      encoding,
      size,
      source,
    } satisfies PickupMetadata,
  }
}

async function executePlace(
  params: { name?: string; to?: string; keep?: boolean },
  ctx: Tool.Context<HandsMetadata>,
) {
  if (!params.name) {
    throw new Error("name is required for place action (use show to list all items)")
  }

  const item = await Hands.get(ctx.sessionID, params.name)
  if (!item) {
    throw new Error(`"${params.name}" not found in hand`)
  }

  let output: string
  let title: string

  if (params.to) {
    let targetPath = params.to
    if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(Instance.directory, targetPath)
    }

    await paste(ctx, targetPath, item)
    title = path.relative(Instance.worktree, targetPath)
    output = `Written to: ${title}`

    if (!params.keep) {
      await Hands.remove(ctx.sessionID, params.name)
    }
  } else {
    // No target path - discard the item
    await Hands.remove(ctx.sessionID, params.name)
    title = item.name
    output = `Discarded: ${item.name}`
  }

  return {
    title,
    output,
    metadata: {
      action: "place",
      name: item.name,
      type: item.type,
      encoding: item.encoding,
      size: item.size,
      source: item.source,
      kept: params.to ? (params.keep ?? false) : false,
    } satisfies PlaceMetadata,
  }
}

async function executeShow(params: { name?: string }, ctx: { sessionID: string }) {
  // If name is provided, show specific item content
  if (params.name) {
    const item = await Hands.get(ctx.sessionID, params.name)
    if (!item) {
      throw new Error(`"${params.name}" not found in hand`)
    }
    const { content: _, ...meta } = item
    return {
      title: item.name,
      output: formatContent(item),
      metadata: {
        action: "show",
        items: [meta],
      } satisfies ShowMetadata,
    }
  }

  // List all items
  const items = await Hands.list(ctx.sessionID)
  if (items.length === 0) {
    return {
      title: "Hand is empty",
      output: "Nothing in hand, use hands action=pickup to grab content",
      metadata: {
        action: "show",
        items: [],
      } satisfies ShowMetadata,
    }
  }

  const lines = items.map((item, i) => {
    const source = item.source ?? "(direct content)"
    return `[${i + 1}] ${item.name} (${item.type}, ${item.encoding}, ${source}, ${formatSize(item.size)})`
  })

  return {
    title: `${items.length} item${items.length > 1 ? "s" : ""}`,
    output: lines.join("\n"),
    metadata: {
      action: "show",
      items,
    } satisfies ShowMetadata,
  }
}
