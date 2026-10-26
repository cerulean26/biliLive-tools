import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecordExtraDataController } from "../src/xml_stream_controller";

/**
 * 回归护栏：`</i>` 收尾必须与批次字段写入**串行**。
 *
 * 历史隐患（上游同款）：`setInterval` 触发的批次写入不被 await，若它还在 `await appendFile`
 * 时 `flush` 就写 `</i>`，两次 append 会并发在途、先后顺序无保证 —— `</i>` 若先落盘，
 * 批次内容就跑到根节点之后，整份 XML 损坏。
 *
 * 测试手法：只 gate **第一个**写入（批次首写），其余写入立即 resolve。据此可区分修复前后：
 * - 修复前：flush 不等待在途批次，会径直走到 `</i>` ⇒ `invoked` 在读断言点已含 "</i>" ⇒ 红。
 * - 修复后：flush 复用串行链、被首个批次挡住 ⇒ 断言点不含 "</i>" ⇒ 绿。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 推进若干微任务（不依赖真实计时器），让链上的 await 依次展开 */
async function flushMicrotasks() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("xml_stream_controller:: 写入串行化（</i> 不与批次并发）", () => {
  it("批次写入未完成时，flush 不会抢写 </i>；放行后 </i> 是最后一次写入", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-serial-"));
    tempDirs.push(tempDir);
    const savePath = path.join(tempDir, "record.xml");

    vi.useFakeTimers();

    const invoked: string[] = [];
    let releaseBatch: () => void = () => {};
    let gateConsumed = false;
    const record = (data: unknown) => {
      invoked.push(String(data));
      // 只 gate「第一次写入」（即 10s 批次首写 = initializeFile 的 writeFile）
      if (!gateConsumed) {
        gateConsumed = true;
        return new Promise<void>((resolve) => {
          releaseBatch = () => resolve();
        });
      }
      return Promise.resolve();
    };

    vi.spyOn(nodeFs.promises, "writeFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);
    vi.spyOn(nodeFs.promises, "appendFile").mockImplementation(((p: unknown, d: unknown) =>
      record(d)) as never);

    const controller = createRecordExtraDataController(savePath);
    controller.addMessage({
      type: "comment",
      timestamp: controller.data.meta.recordStartTimestamp + 1000,
      text: "hi",
      sender: { uid: "1", name: "u" },
    });

    // 触发一次 10s 批次写入（首写），它此刻卡在 gate 上
    vi.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(invoked.some((c) => c.includes("<d"))).toBe(true); // 批次已发起

    // 批次尚未释放即开启收尾
    const flushP = controller.flush();
    await flushMicrotasks();

    // 关键断言：批次写未完成，`</i>` 绝不能被写（修复前这里会取到 "</i>"）
    expect(invoked).not.toContain("</i>");

    // 放行首写，flush 才能继续
    releaseBatch();
    await flushP;
    await flushMicrotasks();

    // 顺序：`</i>` 必须是最后一次写入
    expect(invoked[invoked.length - 1]).toBe("</i>");
  });
});
