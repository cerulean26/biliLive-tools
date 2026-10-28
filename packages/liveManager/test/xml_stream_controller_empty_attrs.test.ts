import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createRecordExtraDataController } from "../src/xml_stream_controller";

/**
 * 回归护栏：没收到值时不写空标签、不写字面量 "undefined"。
 *
 * 两处历史问题：
 * 1. `<player rank="">`：录制器把缺失名次归为空串（buildPkScoreMessage 的既定契约），
 *    XML 侧却无条件写 @rank，与相邻 team_* 的条件省略不一致。
 * 2. `String(ele.sender?.name)`：sender 缺失时输出字面量 "undefined"（uid 同理），
 *    而 uid 还参与 XSL 的 key() 拼键。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-empty-"));
  tempDirs.push(tempDir);
  const savePath = path.join(tempDir, "record.xml");
  const controller = createRecordExtraDataController(savePath);
  return { controller, savePath, start: controller.data.meta.recordStartTimestamp };
}

describe("空值不产生空属性", () => {
  it('玩家名次缺失时不写 rank 属性（而非 rank=""）', async () => {
    const { controller, savePath, start } = await setup();

    controller.addMessage({
      type: "pk_score",
      timestamp: start + 1000,
      battleId: "b1",
      players: [
        { uid: "1", score: "100" }, // 名次缺失
        { uid: "2", score: "200", rank: "1" },
      ],
    });

    await controller.flush();
    const xml = await fs.readFile(savePath, "utf8");

    // 整个文件里不应出现空 rank 属性（含 team_* 也走同一条规则）
    expect(xml).not.toContain('rank=""');
    // 缺失名次的那条仍是完整节点，只是没有 rank
    expect(xml).toMatch(/<player [^>]*uid="1"[^>]*>/);
    expect(xml).not.toMatch(/<player [^>]*uid="1"[^>]*rank=/);
    // 有名次的那条保留属性
    expect(xml).toMatch(/<player [^>]*uid="2"[^>]*rank="1"/);
  });

  it("sender 缺失时写空串，而不是字面量 undefined", async () => {
    const { controller, savePath, start } = await setup();

    controller.addMessage({ type: "comment", timestamp: start + 1000, text: "a" });
    controller.addMessage({ type: "super_chat", timestamp: start + 2000, text: "b", price: 1000 });
    controller.addMessage({
      type: "guard",
      timestamp: start + 3000,
      name: "g",
      count: 1,
      price: 100,
      level: 1,
    });
    controller.addMessage({
      type: "give_gift",
      timestamp: start + 4000,
      name: "x",
      count: 1,
      price: 10,
    });

    await controller.flush();
    const xml = await fs.readFile(savePath, "utf8");

    // 核心断言：任何形态的 "undefined" 都不应出现（属性值、文本节点都算）
    expect(xml).not.toContain("undefined");
    // 属性本身保留（结构稳定，XSL 不必为"属性不存在"分叉）
    expect(xml).toMatch(/<d [^>]*user=""/);
    expect(xml).toMatch(/<d [^>]*uid=""/);
  });
});
