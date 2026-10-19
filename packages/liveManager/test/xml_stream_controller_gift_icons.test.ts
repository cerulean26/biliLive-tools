import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecordExtraDataController } from "../src/xml_stream_controller";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeController() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-gift-icons-"));
  tempDirs.push(tempDir);
  const savePath = path.join(tempDir, "record.xml");
  const controller = createRecordExtraDataController(savePath);
  return { controller, savePath, start: controller.data.meta.recordStartTimestamp };
}

/** 礼物消息的必填字段较多，这里集中构造，测试里只写关心的部分 */
function gift(overrides: {
  giftId?: string;
  name?: string;
  imageUri?: string;
  uid?: string;
  avatar?: string;
  timestamp: number;
}) {
  return {
    type: "give_gift" as const,
    timestamp: overrides.timestamp,
    name: overrides.name ?? "棒棒糖",
    count: 1,
    price: 1,
    color: "#ffffff",
    imageUri: overrides.imageUri,
    giftId: overrides.giftId,
    sender: {
      uid: overrides.uid ?? "1001",
      name: "user" + (overrides.uid ?? "1001"),
      avatar: overrides.avatar,
    },
  };
}

const countOf = (xml: string, tag: "gi" | "ui") =>
  (xml.match(new RegExp(`<${tag} `, "g")) ?? []).length;

describe("礼物图标 / 头像映射表", () => {
  it("同一 giftId、同一 uid 只声明一次", async () => {
    const { controller, savePath, start } = await makeController();

    for (let i = 0; i < 5; i++) {
      controller.addMessage(
        gift({
          giftId: "6937",
          name: "点亮粉丝团",
          imageUri: "webcast/aaa.png",
          uid: "1001",
          avatar: "100x100/aweme-avatar/aaa",
          timestamp: start + i * 1000,
        }),
      );
    }
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "gi")).toBe(1);
    expect(countOf(xml, "ui")).toBe(1);
    // 礼物行仍然是 5 条，不因建表而丢消息
    expect((xml.match(/<gift /g) ?? []).length).toBe(5);
  });

  it("礼物名相同但 giftId 不同时分别声明（礼物名不是唯一标识）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({ giftId: "6937", name: "点亮粉丝团", imageUri: "webcast/aaa.png", timestamp: start }),
    );
    controller.addMessage(
      gift({
        giftId: "6938",
        name: "点亮粉丝团",
        imageUri: "webcast/bbb.png",
        timestamp: start + 1,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "gi")).toBe(2);
    expect(xml).toContain('i="6937"');
    expect(xml).toContain('i="6938"');
  });

  it("没有图片时不声明，礼物行也不再逐条写图片属性", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "6937", uid: "1001", timestamp: start }));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "gi")).toBe(0);
    expect(countOf(xml, "ui")).toBe(0);
    expect(xml).not.toContain("image_uri");
    expect(xml).not.toContain("avatar_uri");
  });

  it("跨批次写入不会重复声明（10 秒定时落盘）", async () => {
    // 只假造 setInterval：控制器内部的落盘定时器。其余（含本测试用来让出事件循环的
    // setTimeout、以及 fs 的 I/O 回调）保持真实，否则写盘 promise 无法推进，读取会时快时慢。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { controller, savePath, start } = await makeController();
    // appendFile 是 open+append+close 三步真实 I/O，一次 setTimeout(0) 未必够它跑完，
    // 少让一次就会读到「少一批」的文件（实测会稳定复现）。这里多让几轮macrotask。
    const yieldToIo = async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    };

    controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: start,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await yieldToIo();

    controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: start + 11_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await yieldToIo();
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "gi")).toBe(1);
    expect(countOf(xml, "ui")).toBe(1);
    // 两批共 2 条礼物都落盘了，去重没有把消息本身吞掉
    expect((xml.match(/<gift /g) ?? []).length).toBe(2);
  });

  it("新分段（新控制器）各自声明一次 —— 表不跨文件复用", async () => {
    const first = await makeController();
    first.controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: first.start,
      }),
    );
    await first.controller.flush();

    const second = await makeController();
    second.controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: second.start,
      }),
    );
    await second.controller.flush();

    expect(countOf(await fs.readFile(first.savePath, "utf8"), "gi")).toBe(1);
    expect(countOf(await fs.readFile(second.savePath, "utf8"), "gi")).toBe(1);
  });

  it("不同 uid 各声明一次头像", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "1", uid: "1001", avatar: "aweme/a", timestamp: start }));
    controller.addMessage(
      gift({ giftId: "2", uid: "1002", avatar: "aweme/b", timestamp: start + 1 }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "ui")).toBe(2);
    expect(xml).toContain('i="1001"');
    expect(xml).toContain('i="1002"');
  });
});
