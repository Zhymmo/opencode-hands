import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Hands } from "../../src/hands/hands"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { HandsTool } from "../../src/tool/hands"
import { tmpdir } from "../fixture/fixture"

const MAX_SIZE = 10 * 1024 * 1024
const MAX_TOTAL_SIZE = 100 * 1024 * 1024

afterEach(async () => {
  await Instance.disposeAll()
})

function ctx(sid: SessionID) {
  return {
    sessionID: sid,
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("tool.hands", () => {
  test("pickup stores direct text content", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const out = await tool.execute(
          {
            action: "pickup",
            name: "note",
            content: "hello world",
          },
          ctx(session.id),
        )

        expect(out.title).toBe("note")
        expect(out.output).toContain("Picked up: note")
        expect(out.metadata).toMatchObject({
          action: "pickup",
          name: "note",
          type: "text",
          encoding: "utf8",
          size: 11,
          source: undefined,
        })
        expect(await Hands.get(session.id, "note")).toEqual({
          sessionID: session.id,
          name: "note",
          type: "text",
          encoding: "utf8",
          content: "hello world",
          source: undefined,
          size: 11,
        })
      },
    })
  })

  test("pickup stores file content from a relative path", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await Bun.write(path.join(dir, "docs", "note.txt"), "from file")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const out = await tool.execute(
          {
            action: "pickup",
            name: "note",
            file: "docs/note.txt",
          },
          ctx(session.id),
        )

        expect(out.output).toContain("Picked up: note")
        expect(out.metadata).toMatchObject({
          action: "pickup",
          name: "note",
          type: "file",
          encoding: "utf8",
          size: 9,
          source: "docs/note.txt",
        })
        expect(await Hands.get(session.id, "note")).toEqual({
          sessionID: session.id,
          name: "note",
          type: "file",
          encoding: "utf8",
          content: "from file",
          source: "docs/note.txt",
          size: 9,
        })
      },
    })
  })

  test("pickup rejects duplicate names at the tool level", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const testCtx = ctx(session.id)

        await tool.execute(
          {
            action: "pickup",
            name: "note",
            content: "first",
          },
          testCtx,
        )

        await expect(
          tool.execute(
            {
              action: "pickup",
              name: "note",
              content: "second",
            },
            testCtx,
          ),
        ).rejects.toThrow('"note" already in hand')
      },
    })
  })

  test("pickup rejects files above the per-item size limit", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "huge.bin"), Buffer.alloc(MAX_SIZE + 1, 1))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()

        await expect(
          tool.execute(
            {
              action: "pickup",
              name: "huge",
              file: "huge.bin",
            },
            ctx(session.id),
          ),
        ).rejects.toThrow("File too large:")
      },
    })
  })

  test("pickup rejects direct content above the per-item size limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()

        await expect(
          tool.execute(
            {
              action: "pickup",
              name: "huge",
              content: "x".repeat(MAX_SIZE + 1),
            },
            ctx(session.id),
          ),
        ).rejects.toThrow("Content too large:")
      },
    })
  })

  test("pickup rejects when total stored size would exceed the limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Hands.put({
          sessionID: session.id,
          name: "full",
          type: "text",
          encoding: "utf8",
          content: "x",
          size: MAX_TOTAL_SIZE,
        })

        const tool = await HandsTool.init()
        await expect(
          tool.execute(
            {
              action: "pickup",
              name: "extra",
              content: "y",
            },
            ctx(session.id),
          ),
        ).rejects.toThrow("Exceeds total size limit:")
      },
    })
  })

  test("place writes a file and removes the item by default", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const testCtx = ctx(session.id)

        await tool.execute(
          {
            action: "pickup",
            name: "note",
            content: "placed text",
          },
          testCtx,
        )

        const out = await tool.execute(
          {
            action: "place",
            name: "note",
            to: "out/note.txt",
          },
          testCtx,
        )

        expect(out.title).toBe(path.join("out", "note.txt"))
        expect(out.output).toContain("Written to: out/note.txt")
        expect(out.metadata).toMatchObject({
          action: "place",
          name: "note",
          encoding: "utf8",
          kept: false,
        })
        expect(await Bun.file(path.join(tmp.path, "out", "note.txt")).text()).toBe("placed text")
        expect(await Hands.get(session.id, "note")).toBeNull()
      },
    })
  })

  test("place writes a file and keeps the item when keep=true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const testCtx = ctx(session.id)

        await tool.execute(
          {
            action: "pickup",
            name: "note",
            content: "kept text",
          },
          testCtx,
        )

        const out = await tool.execute(
          {
            action: "place",
            name: "note",
            to: "out/keep.txt",
            keep: true,
          },
          testCtx,
        )

        expect(out.output).toContain("Written to: out/keep.txt")
        expect(out.metadata).toMatchObject({
          action: "place",
          name: "note",
          encoding: "utf8",
          kept: true,
        })
        expect(await Bun.file(path.join(tmp.path, "out", "keep.txt")).text()).toBe("kept text")
        expect(await Hands.get(session.id, "note")).toMatchObject({
          name: "note",
          content: "kept text",
        })
      },
    })
  })

  test("show lists stored items", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "docs"), { recursive: true })
        await Bun.write(path.join(dir, "docs", "note.txt"), "from file")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const testCtx = ctx(session.id)

        await tool.execute(
          {
            action: "pickup",
            name: "text-note",
            content: "hello",
          },
          testCtx,
        )
        await tool.execute(
          {
            action: "pickup",
            name: "file-note",
            file: "docs/note.txt",
          },
          testCtx,
        )

        const out = await tool.execute({ action: "show" }, testCtx)
        if (out.metadata.action !== "show") throw new Error("expected show metadata")

        expect(out.title).toBe("2 items")
        expect(out.output).toContain("text-note (text, utf8, (direct content), 5 bytes)")
        expect(out.output).toContain("file-note (file, utf8, docs/note.txt, 9 bytes)")
        expect(out.metadata.items).toHaveLength(2)
      },
    })
  })

  test("show returns formatted content for a named item", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tool = await HandsTool.init()
        const testCtx = ctx(session.id)

        await tool.execute(
          {
            action: "pickup",
            name: "note",
            content: "hello world",
          },
          testCtx,
        )

        const out = await tool.execute(
          {
            action: "show",
            name: "note",
          },
          testCtx,
        )
        if (out.metadata.action !== "show") throw new Error("expected show metadata")

        expect(out.title).toBe("note")
        expect(out.output).toContain('<content type="text" encoding="utf8" source="">')
        expect(out.output).toContain("hello world")
        expect(out.metadata.items).toEqual([
          {
            sessionID: session.id,
            name: "note",
            type: "text",
            encoding: "utf8",
            source: undefined,
            size: 11,
          },
        ])
      },
    })
  })
})
