import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecordExtraDataController } from "../src/xml_stream_controller";

/**
 * 回归护栏：flush 时写入失败的那批消息不能被静默丢弃。
 *
 * 历史隐患：`performWrite` 的 catch 把消息退回 `pendingMessages`（不抛出），而 `flush` 末尾
 * 无条件 `pendingMessages = []` —— 写盘失败的那批既不落盘、也不再重试，且 XML 闭合完整、
 * 没有任何标记，事后只能发现「少了几条弹幕」。
 *
 * 测试手法：只让**第二次**批次写入失败（第一次是首写初始化，走 writeFile），观察 flush 是否
 * 重试并最终落盘；修复前 `written` 里永远不会有第二条消息的内容。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function flushMicrotasks() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("flush 不静默丢弃未落盘的消息", () => {
  it("批次写入失败后重试，消息最终落盘", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-flush-retry-"));
    tempDirs.push(tempDir);
    const savePath = path.join(tempDir, "record.xml");

    vi.useFakeTimers();

    const written: string[] = [];
    let batchWrites = 0;
    const record = (data: unknown) => {
      const text = String(data);
      // 只关心承载弹幕的批次写入（含 `<d ...`）
      if (text.includes("<d ")) {
        batchWrites++;
        if (batchWrites === 2) return Promise.reject(new Error("模拟磁盘写入失败"));
      }
      written.push(text);
      return Promise.resolve();
    };
    vi.spyOn(nodeFs.promises, "writeFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);
    vi.spyOn(nodeFs.promises, "appendFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);

    const controller = createRecordExtraDataController(savePath);
    const start = controller.data.meta.recordStartTimestamp;

    controller.addMessage({
      type: "comment",
      timestamp: start + 1000,
      text: "first",
      sender: { uid: "1", name: "u" },
    });
    // 首批由 10s 定时器写入（首写走 writeFile，成功）
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();

    controller.addMessage({
      type: "comment",
      timestamp: start + 2000,
      text: "second",
      sender: { uid: "2", name: "v" },
    });

    // flush 的首次写入会失败（batchWrites === 2），应当重试一次
    await controller.flush();
    await flushMicrotasks();

    expect(written.some((content) => content.includes("second"))).toBe(true);
  });

  it("重试后仍失败时，明确记录未落盘的消息条数", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-flush-fail-"));
    tempDirs.push(tempDir);
    const savePath = path.join(tempDir, "record.xml");

    vi.useFakeTimers();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let batchWrites = 0;
    const record = (data: unknown) => {
      const text = String(data);
      if (text.includes("<d ")) {
        batchWrites++;
        // 从第二次批次写入起全部失败（首写初始化那次放行）
        if (batchWrites >= 2) return Promise.reject(new Error("模拟磁盘写入失败"));
      }
      return Promise.resolve();
    };
    vi.spyOn(nodeFs.promises, "writeFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);
    vi.spyOn(nodeFs.promises, "appendFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);

    const controller = createRecordExtraDataController(savePath);
    const start = controller.data.meta.recordStartTimestamp;

    controller.addMessage({
      type: "comment",
      timestamp: start + 1000,
      text: "first",
      sender: { uid: "1", name: "u" },
    });
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();

    controller.addMessage({
      type: "comment",
      timestamp: start + 2000,
      text: "lost",
      sender: { uid: "2", name: "v" },
    });
    await controller.flush();
    await flushMicrotasks();

    const messages = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
    expect(messages.some((line) => line.includes("未落盘"))).toBe(true);
  });
});
