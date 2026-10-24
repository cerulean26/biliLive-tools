import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { XMLValidator } from "fast-xml-parser";
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
  /** 送礼人昵称，默认按 uid 生成；匿名 uid 场景需要显式区分 */
  senderName?: string;
  avatar?: string;
  timestamp: number;
}) {
  const uid = overrides.uid ?? "1001";
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
      uid,
      name: overrides.senderName ?? "user" + uid,
      avatar: overrides.avatar,
    },
  };
}

const countOf = (xml: string, tag: "gi" | "ui") =>
  (xml.match(new RegExp(`<${tag} `, "g")) ?? []).length;

/** 把 `<gi>` 行解析成属性对象。不依赖属性顺序与自闭合写法，断言更稳。 */
const giRows = (xml: string) =>
  [...xml.matchAll(/<gi\s([^>]*)>/g)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    return attrs;
  });

/** 解析所有 `<gift>` 行的属性。 */
const giftRows = (xml: string) =>
  [...xml.matchAll(/<gift\s([^>]*)>/g)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-z_]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    return attrs;
  });

/** 带 `a`（头像）的礼物行 —— 正常情况每个 (uid, 昵称) 只有一条。 */
const avatarRows = (xml: string) => giftRows(xml).filter((r) => r.a);

describe("礼物图标表与头像内联", () => {
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
    // 头像就地写在首条礼物上：5 条礼物里只有 1 条带 a，且不再产出 <ui> 表
    expect(countOf(xml, "ui")).toBe(0);
    expect(avatarRows(xml)).toHaveLength(1);
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

  it("同一 giftId 下不同礼物名各自声明（giftId 也不是唯一标识）", async () => {
    const { controller, savePath, start } = await makeController();

    // 实测：giftId 685 同时下发 粉丝团灯牌 / 点点星光 / 闪烁星河，三者价格一致、时间交错，
    // 不是「改名」（改名会在时间轴上分成前后两段）。
    controller.addMessage(
      gift({ giftId: "685", name: "粉丝团灯牌", imageUri: "webcast/lamp.png", timestamp: start }),
    );
    controller.addMessage(
      gift({ giftId: "685", name: "点点星光", imageUri: "webcast/star.png", timestamp: start + 1 }),
    );
    controller.addMessage(
      gift({
        giftId: "685",
        name: "闪烁星河",
        imageUri: "webcast/river.png",
        timestamp: start + 2,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = giRows(xml);
    // 三个名字 → 三行表项：可见 `i` 在表内并不唯一，键是 (giftId, 礼物名)
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.i}|${r.n}`).sort()).toEqual([
      "685|点点星光",
      "685|粉丝团灯牌",
      "685|闪烁星河",
    ]);
    // 各自保留自己的图标，不会被首见图覆盖
    expect(rows.map((r) => r.u).sort()).toEqual([
      "webcast/lamp.png",
      "webcast/river.png",
      "webcast/star.png",
    ]);
    // 礼物行本身仍是 3 条
    expect((xml.match(/<gift /g) ?? []).length).toBe(3);
  });

  it("同一 (giftId, 礼物名) 仍只取首见图 —— 双键不解决同名同 ID 换图", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({ giftId: "685", name: "点点星光", imageUri: "webcast/first.png", timestamp: start }),
    );
    controller.addMessage(
      gift({
        giftId: "685",
        name: "点点星光",
        imageUri: "webcast/second.png",
        timestamp: start + 1,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = giRows(xml);
    // 键相同时「首见即定」是策略边界，不是 bug；这里锁住它，避免有人以为改了双键就能解决换图
    expect(rows).toHaveLength(1);
    expect(rows[0].u).toBe("webcast/first.png");
  });

  it("XSL 的 key 定义与查询都用复合键（只改一侧会让图标静默全部消失）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({
        giftId: "685",
        name: "点点星光",
        imageUri: "webcast/star.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: start,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // 定义与查询必须同步改：任一侧退回单键，key() 就查不到，图标全部消失且不报错。
    expect(xml).toContain(`<z:key name="giById" match="gi" use="concat(@i,'|',@n)"/>`);
    expect(xml).toContain("key('giById',concat(@giftid,'|',@giftname))/@u");
  });

  it("没有图片时不声明，礼物行也不再逐条写图片属性", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "6937", uid: "1001", timestamp: start }));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countOf(xml, "gi")).toBe(0);
    expect(countOf(xml, "ui")).toBe(0);
    expect(avatarRows(xml)).toHaveLength(0);
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
    expect(countOf(xml, "ui")).toBe(0);
    expect(avatarRows(xml)).toHaveLength(1);
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

  it("所有 img 都带懒加载 —— 上千个图片并发会拖慢首屏", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: start,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // img 只出现在内嵌样式表的模板里，共 5 个分支：头像(webcast / aweme-avatar 缺尺寸 / aweme)
    // + 图标(webcast / aweme)。固定为 5 是有意的：将来新增分支却漏加 lazy 时，这里会红。
    const imgs = xml.match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(5);
    for (const tag of imgs) {
      expect(tag).toContain('loading="lazy"');
      expect(tag).toContain('decoding="async"');
    }
  });

  it("头像列/图标列按文档内容条件渲染 —— th 与 td 必须成对，否则关上开关只剩两列空格", async () => {
    const { controller, savePath, start } = await makeController();

    // 两个开关都关掉的形态：礼物消息既没有 imageUri 也没有 avatar
    controller.addMessage(gift({ giftId: "6937", timestamp: start }));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const section = xml.slice(xml.indexOf('<h2 id="gift">'), xml.indexOf('<h2 id="room">'));
    // 判据落在「文档里到底有没有」上：整场没有 @a、没有 <gi> 时，两列连表头一起消失
    // 判据先算成模板顶部变量，这里锁住完整声明：① 位置必须紧跟 template 开头（前向引用会让 XSLT 报错）；
    // ② `> 0` 这个真值条件写错（例如写成 `= 0`）时全表的列会反过来 —— 静态断言抓不到语义，只能锁文本。
    expect(xml).toContain(
      '<z:template match="/">' +
        '<z:variable name="hasAv" select="count(/i/gift[@a]) &gt; 0"/>' +
        '<z:variable name="hasGi" select="count(/i/gi) &gt; 0"/>',
    );
    const thConds = [...section.matchAll(/<z:if test="([^"]*)"><th>/g)].map((m) => m[1]);
    const tdConds = [...section.matchAll(/<z:if test="([^"]*)"><td>/g)].map((m) => m[1]);
    expect(thConds).toEqual(["$hasAv", "$hasGi"]);
    // 只包 th：表头 7 列、行 9 列，整表错位；只包 td：表头多出两个永远为空的格子
    expect(tdConds).toEqual(thConds);
  });

  it("列判据只求值一次 —— 循环体里写文档级路径会让渲染退化成 O(n²)", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({ giftId: "6937", imageUri: "webcast/aaa.png", avatar: "aweme/a", timestamp: start }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const section = xml.slice(xml.indexOf('<h2 id="gift">'), xml.indexOf('<h2 id="room">'));
    // 实测 3000 条礼物：`test="/i/gift[@a]"` 写在 <td> 上（在 for-each 内）每行重扫全文档，
    // 渲染 11.7 s；提升为变量后 4.1 s，与不加条件持平。⇒ 循环体里不许出现文档级路径。
    const from = section.indexOf('<z:for-each select="/i/gift">');
    const to = section.indexOf("</z:for-each>", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(section.slice(from, to)).not.toContain('test="/i/');
  });

  it("生成的 XML 整体合法 —— 样式表是内嵌嵌套 XML，属性写错会毁掉整个文件", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({
        giftId: "6937",
        imageUri: "webcast/aaa.png",
        uid: "1001",
        avatar: "aweme/a",
        timestamp: start,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const result = XMLValidator.validate(xml);
    // 断言消息里带上具体错误，别只留一个 false
    expect(result === true ? "ok" : JSON.stringify(result)).toBe("ok");
  });

  it("不同 uid 各写一次头像", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "1", uid: "1001", avatar: "aweme/a", timestamp: start }));
    controller.addMessage(
      gift({ giftId: "2", uid: "1002", avatar: "aweme/b", timestamp: start + 1 }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = avatarRows(xml);
    expect(rows.map((r) => r.uid).sort()).toEqual(["1001", "1002"]);
    expect(rows.map((r) => r.a).sort()).toEqual(["aweme/a", "aweme/b"]);
  });

  it("同一用户第二次送礼不再写头像，但 uid 仍在 —— XSL 按 (uid, 昵称) 反查首见", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "1", uid: "1001", avatar: "aweme/a", timestamp: start }));
    controller.addMessage(
      gift({ giftId: "2", uid: "1001", avatar: "aweme/a", timestamp: start + 1 }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = giftRows(xml);
    expect(rows).toHaveLength(2);
    // 只有第一条带头像；第二条靠 (@uid,@user) 在 XSL 里反查，uid 与 user 因此都不能省
    expect(rows[0].a).toBe("aweme/a");
    expect(rows[1].a).toBeUndefined();
    expect(rows[1].uid).toBe("1001");
    // 定义与查询必须同步：match 的属性名与取值、[1] 取文档序首见
    expect(xml).toContain(
      `<z:key name="giftAvatarByUser" match="gift[@a]" use="concat(@uid,'|',@user)"/>`,
    );
    expect(xml).toContain("key('giftAvatarByUser',concat(@uid,'|',@user))[1]/@a");
    expect(xml).not.toContain("uiByUid");
  });

  it("匿名占位 uid 下的不同昵称各写一次头像 —— 键必须是 (uid, 昵称) 而不是 uid", async () => {
    const { controller, savePath, start } = await makeController();

    // 实测：抖音匿名身份共用 uid 111111，同一份录制里 dou7702128 / 神秘人397543 / dou1669765
    // 三个互不相干的昵称都用它。按 uid 去重会让后两个身份的头像被丢弃，再经反查显示成首条那个人。
    controller.addMessage(
      gift({
        giftId: "1",
        uid: "111111",
        senderName: "dou7702128",
        avatar: "aweme/a",
        timestamp: start,
      }),
    );
    controller.addMessage(
      gift({
        giftId: "1",
        uid: "111111",
        senderName: "神秘人397543",
        avatar: "aweme/b",
        timestamp: start + 1,
      }),
    );
    controller.addMessage(
      gift({
        giftId: "1",
        uid: "111111",
        senderName: "神秘人397543",
        avatar: "aweme/b",
        timestamp: start + 2,
      }),
    );
    controller.addMessage(
      gift({
        giftId: "1",
        uid: "111111",
        senderName: "dou1669765",
        avatar: "aweme/c",
        timestamp: start + 3,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = giftRows(xml);
    // 4 条礼物都在，uid 相同不影响消息本身
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.uid)).toEqual(["111111", "111111", "111111", "111111"]);
    // 三个昵称各占首条：a b 空（同昵称第二次） c
    expect(rows.map((r) => r.a)).toEqual(["aweme/a", "aweme/b", undefined, "aweme/c"]);
    expect(rows.map((r) => r.user)).toEqual([
      "dou7702128",
      "神秘人397543",
      "神秘人397543",
      "dou1669765",
    ]);
  });

  it("XSL 对缺尺寸段的头像有兜底分支 —— 匿名头像是 aweme-avatar/ 开头，直接拼会 400", async () => {
    const { controller, savePath, start } = await makeController();

    // 实测：匿名用户（uid 111111）下发的 uri 是 aweme-avatar/mosaic-legacy_…，缺 100x100/ 尺寸段。
    // 直接按 aweme/{uri}.jpeg 拼会得到 400 {"code":2004}，必须补尺寸段走 100x100/ 前缀。
    controller.addMessage(
      gift({
        giftId: "1",
        uid: "111111",
        avatar: "aweme-avatar/mosaic-legacy_3795_1",
        timestamp: start,
      }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(xml).toContain(`<z:when test="starts-with($av,'aweme-avatar/')">`);
    expect(xml).toContain("https://p11.douyinpic.com/aweme/100x100/{$av}.jpeg");
    // 兜底分支必须排在 otherwise 之前，否则永远走不到。注意不能只比「在 webcast 分支之后」——
    // 那样把它挪到 otherwise 之后也照样通过（实测是死断言）。
    const webcastBranch = xml.indexOf(`<z:when test="starts-with($av,'webcast/')">`);
    const backfillBranch = xml.indexOf(`<z:when test="starts-with($av,'aweme-avatar/')">`);
    const otherwiseBranch = xml.indexOf(`https://p11.douyinpic.com/aweme/{$av}.jpeg`);
    expect(webcastBranch).toBeGreaterThan(0);
    expect(otherwiseBranch).toBeGreaterThan(0);
    expect(backfillBranch).toBeGreaterThan(webcastBranch);
    expect(backfillBranch).toBeLessThan(otherwiseBranch);
  });

  it("同一 (uid, 昵称) 换头像仍取首见 —— 复合键不解决改名换图", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(
      gift({ giftId: "1", uid: "1001", avatar: "aweme/first", timestamp: start }),
    );
    controller.addMessage(
      gift({ giftId: "2", uid: "1001", avatar: "aweme/second", timestamp: start + 1 }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // 键相同时「首见即定」是策略边界，锁住它，避免误以为改键就能让头像跟着换
    expect(avatarRows(xml)).toHaveLength(1);
    expect(avatarRows(xml)[0].a).toBe("aweme/first");
  });

  it("首条没下发头像时，头像写在第二条上（首见 = 首个带头像的节点）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(gift({ giftId: "1", uid: "1001", timestamp: start }));
    controller.addMessage(
      gift({ giftId: "2", uid: "1001", avatar: "aweme/late", timestamp: start + 1 }),
    );
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    const rows = avatarRows(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0].a).toBe("aweme/late");
    // 补写的是第二条，不是第一条
    expect(giftRows(xml)[0].a).toBeUndefined();
  });
});
