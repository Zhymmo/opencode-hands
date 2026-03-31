import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Hands, type HandsItem } from "../../src/hands/hands"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("Hands", () => {
  test("put and get text content with utf8 encoding", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        const item: HandsItem = {
          sessionID: session.id,
          name: "test-content",
          type: "text",
          encoding: "utf8",
          content: "Hello, World!",
          description: "greeting",
          size: 13,
        }

        await Hands.put(item)

        const retrieved = await Hands.get(session.id, "test-content")
        expect(retrieved).not.toBeNull()
        expect(retrieved?.name).toBe("test-content")
        expect(retrieved?.type).toBe("text")
        expect(retrieved?.encoding).toBe("utf8")
        expect(retrieved?.content).toBe("Hello, World!")
        expect(retrieved?.description).toBe("greeting")
        expect(retrieved?.size).toBe(13)
      },
    })
  })

  test("put and get file content with utf8 encoding", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        const item: HandsItem = {
          sessionID: session.id,
          name: "file",
          type: "file",
          encoding: "utf8",
          content: "foo: bar\n",
          description: "",
          source: "config.yaml",
          size: 9,
        }

        await Hands.put(item)

        const retrieved = await Hands.get(session.id, "file")
        expect(retrieved?.type).toBe("file")
        expect(retrieved?.encoding).toBe("utf8")
        expect(retrieved?.content).toBe("foo: bar\n")
        expect(retrieved?.description).toBe("")
        expect(retrieved?.source).toBe("config.yaml")
      },
    })
  })

  test("put with duplicate name fails", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        await Hands.put({
          sessionID: session.id,
          name: "duplicate",
          type: "text",
          encoding: "utf8",
          content: "First",
          description: "",
          size: 5,
        })

        await expect(
          Hands.put({
            sessionID: session.id,
            name: "duplicate",
            type: "text",
            encoding: "utf8",
            content: "Second",
            description: "",
            size: 6,
          }),
        ).rejects.toThrow()
      },
    })
  })

  test("get non-existent item returns null", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const result = await Hands.get(session.id, "non-existent")
        expect(result).toBeNull()
      },
    })
  })

  test("remove item", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        await Hands.put({
          sessionID: session.id,
          name: "to-remove",
          type: "text",
          encoding: "utf8",
          content: "Remove me",
          description: "",
          size: 9,
        })

        expect(await Hands.get(session.id, "to-remove")).not.toBeNull()

        const removed = await Hands.remove(session.id, "to-remove")
        expect(removed).toBe(true)
        expect(await Hands.get(session.id, "to-remove")).toBeNull()
      },
    })
  })

  test("list items returns all items for session", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        await Hands.put({
          sessionID: session.id,
          name: "item1",
          type: "text",
          encoding: "utf8",
          content: "Content 1",
          description: "first",
          size: 9,
        })

        await Hands.put({
          sessionID: session.id,
          name: "item2",
          type: "file",
          encoding: "utf8",
          content: "a: b\n",
          description: "",
          source: "item2.yaml",
          size: 5,
        })

        const items = await Hands.list(session.id)
        expect(items.length).toBe(2)
        expect(items[0].name).toBe("item1")
        expect(items[0].description).toBe("first")
        expect(items[1].name).toBe("item2")
        expect(items[1].description).toBe("")
      },
    })
  })

  test("totalSize calculates correctly", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        await Hands.put({
          sessionID: session.id,
          name: "size1",
          type: "text",
          encoding: "utf8",
          content: "12345",
          description: "",
          size: 5,
        })

        await Hands.put({
          sessionID: session.id,
          name: "size2",
          type: "text",
          encoding: "utf8",
          content: "1234567890",
          description: "",
          size: 10,
        })

        const total = await Hands.totalSize(session.id)
        expect(total).toBe(15)
      },
    })
  })

  test("items are isolated by session", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session1 = await Session.create({})
        const session2 = await Session.create({})

        await Hands.put({
          sessionID: session1.id,
          name: "session1-item",
          type: "text",
          encoding: "utf8",
          content: "Session 1",
          description: "",
          size: 9,
        })

        await Hands.put({
          sessionID: session2.id,
          name: "session2-item",
          type: "text",
          encoding: "utf8",
          content: "Session 2",
          description: "",
          size: 9,
        })

        const items1 = await Hands.list(session1.id)
        const items2 = await Hands.list(session2.id)

        expect(items1.length).toBe(1)
        expect(items1[0].name).toBe("session1-item")

        expect(items2.length).toBe(1)
        expect(items2[0].name).toBe("session2-item")
      },
    })
  })
})
