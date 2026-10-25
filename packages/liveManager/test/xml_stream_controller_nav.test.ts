import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { XMLValidator } from "fast-xml-parser";
import { afterEach, describe, expect, it } from "vitest";

import type { Message } from "../src/common.js";
import { createRecordExtraDataController } from "../src/xml_stream_controller";

/**
 * 回归护栏：内嵌 XSL 的**表头导航**与**空区块抑制**。
 *
 * 背景：`上船`（舰长）与 `SC` 是 B站专属消息类型，抖音录制永远为 0 条。
 * 若表头与正文无条件渲染，抖音产物会多出两行永远为 0 的入口和两张空表。
 *
 * 这批断言验证的是 XSL 模板的**结构**（条件包裹 + 表头入口），
 * 而不是渲染结果 —— vitest 里没有 XSLT 引擎，渲染由人工用 Chrome 验证。
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** 生成一份最小产物 XML（含内嵌 XSL 与 metadata） */
async function writeXml(messages: Message[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xmlnav-"));
  dirs.push(dir);
  const savePath = path.join(dir, "r.xml");
  const controller = createRecordExtraDataController(savePath);
  const start = controller.data.meta.recordStartTimestamp;

  const full: Message[] = [
    { type: "comment", timestamp: start, text: "hi", sender: { uid: "1", name: "u" } },
    ...messages,
  ];
  for (const m of full) controller.addMessage(m);
  await controller.flush();

  return fs.readFile(savePath, "utf8");
}

describe("表头导航", () => {
  it("含「在线人数」入口，指向 #room", async () => {
    const xml = await writeXml([{ type: "room_stats", timestamp: Date.now(), online: "100" }]);

    expect(xml).toContain('<a href="#room">在线人数</a>');
  });

  it("表头入口顺序与正文区块顺序一致", async () => {
    const xml = await writeXml();

    const navOrders = [...xml.matchAll(/<a href="#([a-z_]+)">/g)].map((m) => m[1]);
    expect(navOrders).toEqual(["d", "guard", "sc", "gift", "room", "rank", "pk"]);
  });

  it("含「贡献榜」入口，指向 #rank", async () => {
    const xml = await writeXml([
      {
        type: "room_rank",
        timestamp: Date.now(),
        users: [{ uid: "1", nick: "a" }],
      },
    ]);

    expect(xml).toContain('<a href="#rank">贡献榜</a>');
  });
});

describe("空区块抑制：上船 / SC / 礼物按数据条件渲染", () => {
  it("上船区块被 /i/guard 条件包裹", async () => {
    const xml = await writeXml();

    expect(xml).toContain('<z:if test="/i/guard"><h2 id="guard">');
    // 收尾的 z:if 必须紧邻 SC 区块的开口，否则会吞掉后面的区块
    expect(xml).toContain('</z:for-each></table></div></z:if><z:if test="/i/sc"><h2 id="sc">');
  });

  it("SC 区块被 /i/sc 条件包裹", async () => {
    const xml = await writeXml();

    expect(xml).toContain('<z:if test="/i/sc"><h2 id="sc">');
    expect(xml).toContain('</z:for-each></table></div></z:if><z:if test="/i/gift"><h2 id="gift">');
  });

  it("礼物区块被 /i/gift 条件包裹", async () => {
    const xml = await writeXml();

    expect(xml).toContain('<z:if test="/i/gift"><h2 id="gift">');
    expect(xml).toContain('</z:for-each></table></div></z:if><z:if test="/i/room"><h2 id="room">');
  });

  it("表头里的上船 / SC / 礼物入口同样按数据条件渲染", async () => {
    const xml = await writeXml();

    expect(xml).toContain('<z:if test="/i/guard"><tr><td><a href="#guard">上船</a></td>');
    expect(xml).toContain('<z:if test="/i/sc"><tr><td><a href="#sc">SC</a></td>');
    expect(xml).toContain('<z:if test="/i/gift"><tr><td><a href="#gift">礼物</a></td>');
  });

  it("弹幕是主内容，不挂条件 —— 即使 0 条也保留区块", async () => {
    const xml = await writeXml();

    // 表头：弹幕行紧跟在「主播名」之后，中间不该出现 z:if
    expect(xml).toContain(
      '<tr><td>主播名</td><td><z:value-of select="/i/metadata/user_name/text()"/></td></tr><tr><td><a href="#d">弹幕</a></td>',
    );
    // 正文：表头结束时直接进入 <h2 id="d">，没有条件包裹
    expect(xml).toContain('</table><h2 id="d">弹幕</h2>');
  });

  it("PK / PK选手沿用既有的 /i/pk、/i/pk_users 条件（抖音产物不渲染）", async () => {
    const xml = await writeXml();

    expect(xml).toContain('<z:if test="/i/pk"><tr><td><a href="#pk">PK</a></td>');
    expect(xml).toContain('<z:if test="/i/pk"><h2 id="pk">PK分数</h2>');
    expect(xml).toContain('<z:if test="/i/pk_users"><h2 id="pk_users">PK选手</h2>');
  });
});

describe("内嵌 XSL 良构性", () => {
  it("整份产物（含样式表）通过 XML 校验 —— 条件包裹的嵌套必须闭合", async () => {
    const xml = await writeXml([{ type: "room_stats", timestamp: Date.now(), online: "100" }]);

    expect(XMLValidator.validate(xml)).toBe(true);
  });
});
