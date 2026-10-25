import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecordExtraDataController } from "../src/xml_stream_controller";
import type { Message } from "../src/common.js";

/**
 * 回归护栏：在线人数（`<room>`）**只写值发生变化的那一条**。
 *
 * 直接 import 真实 controller：状态（lastOnline）跨 flush 保持是本功能的核心，
 * 只测纯函数无法覆盖。
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeController() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomstats-"));
  dirs.push(dir);
  const savePath = path.join(dir, "r.xml");
  const controller = createRecordExtraDataController(savePath);
  return { controller, savePath, start: controller.data.meta.recordStartTimestamp };
}

/** 在线人数消息；tsOffset 为距录制开始的毫秒偏移 */
function room(start: number, online: string, tsOffset = 0): Message {
  return { type: "room_stats", timestamp: start + tsOffset, online };
}

/** 等待真实的文件 IO 落盘（setTimeout 未被 fake，故这里是真实等待） */
const settleIo = () => new Promise((resolve) => setTimeout(resolve, 50));

/** 读出所有 <room> 节点的 ts / online */
async function readRooms(savePath: string) {
  const xml = await fs.readFile(savePath, "utf8");
  return [...xml.matchAll(/<room ([^>]*)/g)].map((m) => {
    const ts = /ts="([^"]*)"/.exec(m[1])?.[1] ?? "";
    const online = /online="([^"]*)"/.exec(m[1])?.[1] ?? "";
    return { ts: Number(ts), online };
  });
}

describe("在线人数 <room>：只记变化", () => {
  it("首个采样点必写（任何值都算变化）", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    await controller.flush();

    expect(await readRooms(savePath)).toEqual([{ ts: 0, online: "12759" }]);
  });

  it("同一批里连续相同值只写一条", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    controller.addMessage(room(start, "12759", 600));
    controller.addMessage(room(start, "12759", 1200));
    await controller.flush();

    expect(await readRooms(savePath)).toEqual([{ ts: 0, online: "12759" }]);
  });

  it("变化序列完整记录 —— 包括变回旧值（旧值与前一个写入值不同，仍是真实变化）", async () => {
    const { controller, savePath, start } = await makeController();
    for (const [i, v] of ["100", "200", "100", "300"].entries()) {
      controller.addMessage(room(start, v, i * 1000));
    }
    await controller.flush();

    expect(await readRooms(savePath)).toEqual([
      { ts: 0, online: "100" },
      { ts: 1, online: "200" },
      { ts: 2, online: "100" },
      { ts: 3, online: "300" },
    ]);
  });

  it("跨批次保持状态：第二批开头若与第一批末尾相同则不重复写", async () => {
    // ⚠️ 两个前提：
    // 1. 周期性落盘是 controller 内部的 setInterval，必须在创建**之前**开假定时器；
    //    `flush()` 是收尾操作（置 hasCompleted、清定时器），不能用来模拟批次写入。
    // 2. **只 fake setInterval**：落盘是真实 fs IO，若连 setTimeout 也 fake 就等不到它完成，
    //    会出现「第一批还在写、第二批已按旧的 hasPersistedHeader 覆盖」的假象。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { controller, savePath, start } = await makeController();

      controller.addMessage(room(start, "100", 0));
      controller.addMessage(room(start, "200", 1000));
      await vi.advanceTimersByTimeAsync(10_000); // 第一批落盘
      await settleIo();

      // 第二批：首条与上一批末尾相同 → 跳过；变化的那条才写
      controller.addMessage(room(start, "200", 11_000));
      controller.addMessage(room(start, "300", 12_000));
      await vi.advanceTimersByTimeAsync(10_000); // 第二批落盘
      await settleIo();

      await controller.flush(); // 收尾：补闭合标签
      await settleIo();

      expect(await readRooms(savePath)).toEqual([
        { ts: 0, online: "100" },
        { ts: 1, online: "200" },
        { ts: 12, online: "300" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有人数消息时不产生 <room> 节点", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage({
      type: "comment",
      timestamp: start,
      text: "hi",
      color: "#ffffff",
      mode: 1,
      sender: { name: "u", uid: "1" },
    });
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(xml).not.toContain("<room ");
  });

  it("ts 是距录制开始的相对秒数，与礼物等消息同源", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "100", 0));
    controller.addMessage(room(start, "101", 12_500));
    await controller.flush();

    expect(await readRooms(savePath)).toEqual([
      { ts: 0, online: "100" },
      { ts: 12.5, online: "101" },
    ]);
  });

  it("XSL 里有在线人数表格，且只在有采样点时渲染", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(xml).toContain('<h2 id="room">在线人数</h2>');
    expect(xml).toContain('<z:for-each select="/i/room">');
  });

  it("时间列走 fmtTs 模板（HH:MM:SS.mmm），不再是裸秒数", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // 用整段锚点定位，避免与贡献榜同样写 `select="@ts"` 的调用点混淆
    expect(xml).toContain(
      '<z:for-each select="/i/room"><tr><td><z:call-template name="fmtTs">' +
        '<z:with-param name="ts" select="@ts"/></z:call-template></td>',
    );
    expect(xml).not.toContain('<z:for-each select="/i/room"><tr><td><z:value-of select="@ts"/>');
  });

  it("表头声明「变化」语义（这一列是变化时刻，不是采样点）", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(xml).toContain("<th>变化时间</th><th>在线人数</th>");
  });

  it("区块壳与贡献榜统一：变化明细 + 按规模自适应展开", async () => {
    const { controller, savePath, start } = await makeController();
    controller.addMessage(room(start, "12759"));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // 与 <rank> 同一套壳，阈值共用 expandLimit（改一处两边同时生效）
    expect(xml).toContain("<summary>变化明细（");
    expect(xml).toContain('test="count(/i/room) &lt;= $expandLimit"');
    expect(xml).toContain('<z:variable name="expandLimit" select="50"/>');
    // 「采样明细 / N 点」这套说法与「变化时间」自相矛盾，已彻底弃用
    expect(xml).not.toContain("采样明细");
    // 导航计数单位与贡献榜一致
    expect(xml).toContain('共<z:value-of select="count(/i/room)"/>次变化</td>');
  });
});
