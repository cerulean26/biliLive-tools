import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { XMLValidator } from "fast-xml-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecordExtraDataController } from "../src/xml_stream_controller";

/**
 * 贡献榜写入 XML 的护栏 —— 测试 `src/xml_stream_controller.ts` 的真实实现。
 *
 * 核心契约（都由实测数据驱动，而不是想象）：
 * 1. 服务端把这条消息当**状态广播**：30 秒收到 21 条，其中只有 3 个 msgId 且内容逐字相同
 *    ⇒ 必须去重，否则一次半小时录制能塞进上千个一模一样的节点。
 * 2. 键是**保序**的 `(uid, 昵称)` 序列：排序后「名次互换」会与「没变」算成同一个键而被吃掉；
 *    只用 uid 时「两个匿名成员互换」也会被吃掉（匿名占位 uid `111111` 被多个身份共用）。
 * 3. 去重状态必须**跨批持久**（`lastRank`），否则每次 flush 都会重写当前榜。
 *
 * ⚠️ `flush()` 是**收尾**（置 `hasCompleted`、清定时器），调用后 `addMessage` 全部被丢弃。
 * 所以跨批次场景一律用假定时器推进 10 秒周期，不能靠连调 `flush()` ——
 * 那样第二轮消息根本没进 pendingMessages，断言会**真空通过**。
 */
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  restoreWrites();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * 劫持 `fs.promises` 的写入方法，把真实 I/O 的 promise 收起来。
 *
 * 为什么必须这么做：`writeToFile` 由 `setInterval` 触发且**不被 await**，而假定时器只推进时间、
 * 不等真实磁盘 I/O 完成。若靠「等几轮 setImmediate」来同步，断言会读到**上一次**的文件内容 ——
 * 实测就踩过：第三批已 append 83 B，读文件却还是旧内容，于是把「写对了」误判成「没写」。
 */
const realFsPromises = fsSync.promises as unknown as Record<string, unknown>;
let pendingWrites: Promise<unknown>[] = [];
const origAppendFile = realFsPromises.appendFile;
const origWriteFile = realFsPromises.writeFile;

function patchWrites() {
  const wrap =
    (orig: unknown) =>
    (...args: unknown[]) => {
      const p = (orig as (...a: unknown[]) => Promise<unknown>)(...args);
      pendingWrites.push(p);
      return p;
    };
  realFsPromises.appendFile = wrap(origAppendFile);
  realFsPromises.writeFile = wrap(origWriteFile);
}

function restoreWrites() {
  realFsPromises.appendFile = origAppendFile;
  realFsPromises.writeFile = origWriteFile;
}

async function makeController() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xml-rank-"));
  tempDirs.push(tempDir);
  const savePath = path.join(tempDir, "record.xml");
  const controller = createRecordExtraDataController(savePath);
  return { controller, savePath, start: controller.data.meta.recordStartTimestamp };
}

/** 推进一个 10 秒写入周期，并**等它真正落盘**（含 await 之后的 `lastRank` 赋值） */
async function tick() {
  await vi.advanceTimersByTimeAsync(10_000);
  const writes = pendingWrites;
  pendingWrites = [];
  await Promise.all(writes);
  // writeToFile 在 await 之后才写 lastRank / 合并首见表，这里把那段微任务放完
  await Promise.resolve();
  await Promise.resolve();
}

const A = { uid: "97814778350", nick: "米大王", avatarUri: "100x100/aweme-avatar/a" };
const B = { uid: "7630365130980066353", nick: "神秘人•S", avatarUri: "100x100/aweme-avatar/b" };
const C = { uid: "432566925526460", nick: "黎嗲域" };
const D = { uid: "999999999999999", nick: "新面孔", avatarUri: "100x100/aweme-avatar/d" };
/** 匿名占位 uid：实测同一份录制里 3 个互不相干的身份共用它（见 avatarKey 的注释） */
const ANON_UID = "111111";
const N1 = { uid: ANON_UID, nick: "dou7702128", avatarUri: "100x100/aweme-avatar/n1" };
const N2 = { uid: ANON_UID, nick: "神秘人397543", avatarUri: "100x100/aweme-avatar/n2" };
const N3 = { uid: ANON_UID, nick: "dou1669765" };

function rank(users: (typeof A)[], timestamp: number) {
  return { type: "room_rank" as const, timestamp, users };
}

/** `<rank ` 带空格，不会误命中 `<rank_users>` */
const countRank = (xml: string) => (xml.match(/<rank /g) ?? []).length;
const countU = (xml: string) => (xml.match(/<u /g) ?? []).length;
const countRankUser = (xml: string) => (xml.match(/<user /g) ?? []).length;

/** 解析每个 `<rank>` 节点下的 uid 序列（保序） */
const rankSeqs = (xml: string) =>
  [...xml.matchAll(/<rank\s[^>]*>([\s\S]*?)<\/rank>/g)].map((m) =>
    [...m[1].matchAll(/<u\s+uid="([^"]*)"/g)].map((x) => x[1]),
  );

/** 解析每个 `<rank>` 节点下的昵称序列（保序）—— 昵称取自 `<u>` 自身，不查表 */
const rankNicks = (xml: string) =>
  [...xml.matchAll(/<rank\s[^>]*>([\s\S]*?)<\/rank>/g)].map((m) =>
    [...m[1].matchAll(/<u\s+[^>]*?nick="([^"]*)"/g)].map((x) => x[1]),
  );

describe("贡献榜：只记变化（键是保序的 (uid, 昵称) 序列）", () => {
  it("同一条快照重推 21 次，只写出 1 个 <rank>（对应真实产物 21 行 = 1 个状态）", async () => {
    const { controller, savePath, start } = await makeController();

    // 实测：30 秒收到 21 条，只有 3 个 msgId，且这三个 payload 逐字相同
    for (let i = 0; i < 21; i++) {
      controller.addMessage(rank([A, B, C], start + i * 1400));
    }
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(1);
    expect(countU(xml)).toBe(3);
    expect(rankSeqs(xml)).toEqual([[A.uid, B.uid, C.uid]]);
    // 首见声明只写一次，21 次重推不该重复声明
    expect(countRankUser(xml)).toBe(3);
  });

  it("名次互换要写出新节点（把键排序的实现会在这一条上失败）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 1000));
    // 同一批人、只有顺序变了 —— 键若排序过，这里会被判成「没变」
    controller.addMessage(rank([B, A, C], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(2);
    expect(rankSeqs(xml)).toEqual([
      [A.uid, B.uid, C.uid],
      [B.uid, A.uid, C.uid],
    ]);
  });

  it("换人要写出新节点，并只为首见的新面孔补一行 <rank_users>", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 1000));
    controller.addMessage(rank([A, B, D], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(2);
    // A/B 已在表里，只有 D 是新的
    expect(countRankUser(xml)).toBe(4);
    expect(xml).toContain(`uid="${D.uid}"`);
    expect(xml).toContain(`nick="${D.nick}"`);
  });

  it("同一批内重复出现的 uid 只声明一次", async () => {
    const { controller, savePath, start } = await makeController();

    // 两条不同快照但都在同一批里，A/B/C 各出现两次
    controller.addMessage(rank([A, B, C], start + 1000));
    controller.addMessage(rank([B, C, A], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(2);
    expect(countRankUser(xml)).toBe(3);
  });

  it("同一 uid 改名 ⇒ 补一行新定义，历史节点仍显示当时的昵称（不再冻结首见）", async () => {
    const { controller, savePath, start } = await makeController();
    const renamed = { ...C, nick: "黎嗲域（改名后）" };

    controller.addMessage(rank([A, B, C], start + 1000));
    // 名次变了 ⇒ 写第二个节点；昵称也变了 ⇒ `(uid, 昵称)` 是新键，要补声明
    controller.addMessage(rank([A, renamed, B], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRankUser(xml)).toBe(4);
    // 每行显示「该次快照里他叫什么」，而不是被首见值锁死
    expect(rankNicks(xml)).toEqual([
      [A.nick, B.nick, C.nick],
      [A.nick, renamed.nick, B.nick],
    ]);
  });
});

describe("贡献榜：匿名占位 uid `111111` 被多个身份共用", () => {
  it("同一快照里两个匿名成员各写一条定义（只按 uid 去重会串成同一个人）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, N1, N2], start + 1000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // A + 两个匿名身份，各自一行；若键只有 uid，这里会是 2
    expect(countRankUser(xml)).toBe(3);
    expect(xml).toContain(`<user uid="${ANON_UID}" nick="${N1.nick}" a="${N1.avatarUri}">`);
    expect(xml).toContain(`<user uid="${ANON_UID}" nick="${N2.nick}" a="${N2.avatarUri}">`);
    // `<u>` 上必须带昵称，否则 XSL 的 concat 键拼不出来
    expect(xml).toContain(`<u uid="${ANON_UID}" nick="${N1.nick}">`);
  });

  it("两个匿名成员互换名次要写出新节点（键只含 uid 时这次变化会被吞掉）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, N1, N2], start + 1000));
    // 三个人、uid 序列都是「A,111111,111111」—— 只看 uid 的键完全一样
    controller.addMessage(rank([A, N2, N1], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(2);
    expect(rankNicks(xml)).toEqual([
      [A.nick, N1.nick, N2.nick],
      [A.nick, N2.nick, N1.nick],
    ]);
  });

  it("匿名成员先上榜后被同名者顶替（同 uid 同昵称）视为没变", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, N3, N1], start + 1000));
    // 同一组 (uid, 昵称)，只有内部重推 —— 不应写第二个节点
    controller.addMessage(rank([A, N3, N1], start + 2400));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(1);
    expect(countRankUser(xml)).toBe(3);
  });
});

describe("贡献榜：跨批去重与空榜", () => {
  it("去重状态跨批持久：三批「相同/相同/互换」只产出 2 个节点", async () => {
    vi.useFakeTimers();
    patchWrites();
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 1000));
    await tick();
    // 同内容重推：若 `lastRank` 没跨批保留，这里会写出第 2 个节点
    controller.addMessage(rank([A, B, C], start + 11_000));
    await tick();
    // 名次互换：必须写
    controller.addMessage(rank([B, A, C], start + 21_000));
    await tick();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(2);
    expect(rankSeqs(xml)).toEqual([
      [A.uid, B.uid, C.uid],
      [B.uid, A.uid, C.uid],
    ]);
  });

  it("没有任何贡献榜消息时不写节点（老产物 / 未开启时不留空表）", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage({
      type: "comment",
      timestamp: start + 1000,
      text: "hi",
      sender: { uid: "1", name: "u" },
    });
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(countRank(xml)).toBe(0);
    // ⚠️ 不能用 includes("rank_users")：内嵌 XSL 里有 key 的 match="rank_users/user"
    expect(xml).not.toMatch(/<rank_users>/);
  });
});

describe("贡献榜：产物结构", () => {
  it("写入后仍是合法 XML", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 1000));
    controller.addMessage(rank([B, A, C], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it("rank 用相对 ts（相对录制开始），不是绝对时间戳", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 2000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(xml).toMatch(/<rank ts="2(\.0+)?"/);
  });

  it("缺头像的成员照样有名次（头像列整体按 $hasRankUser 条件渲染）", async () => {
    const { controller, savePath, start } = await makeController();

    // C 没有 avatarUri
    controller.addMessage(rank([A, B, C], start + 1000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    expect(rankSeqs(xml)).toEqual([[A.uid, B.uid, C.uid]]);
    // C 那一行只写 uid + nick，不写空 a=""
    expect(xml).not.toMatch(/<user uid="432566925526460"[^>]*a=""/);
  });
});

describe("贡献榜：XSL 模板接线", () => {
  it("模板里有 key / 变量 / 分区锚点，缺一个就渲染不出榜单", async () => {
    const { controller, savePath, start } = await makeController();

    controller.addMessage(rank([A, B, C], start + 1000));
    await controller.flush();

    const xml = await fs.readFile(savePath, "utf8");
    // key：用 `(uid, 昵称)` 复合键把 `<u>` 翻成昵称/头像（匿名 uid 共用的前提）
    expect(xml).toContain(`name="rankUser" match="rank_users/user" use="concat(@uid,'|',@nick)"`);
    // key 定义 + 3 个查表点必须同一个键：只改一侧时 `key()` 返回空集、头像静默全没
    expect(xml.match(/key\('rankUser',concat\(@uid,'\|',@nick\)\)/g) ?? []).toHaveLength(3);
    expect(xml).not.toContain(`key('rankUser',@uid)`);
    // `<u>` 必须自带昵称，否则 XSL 的 concat 拼不出键
    expect(xml).toMatch(/<u uid="[^"]+" nick="[^"]*">/);
    // 变量：条件列只算一次（与 $hasAv/$hasGi 同一理由，避免 for-each 内重扫整份文档）
    expect(xml).toContain(`variable name="hasRankUser"`);
    // 分区与汇总表入口
    expect(xml).toContain(`<h2 id="rank">贡献榜</h2>`);
    expect(xml).toContain(`<a href="#rank">贡献榜</a>`);
    // 最新快照 + 变化记录
    expect(xml).toContain(`<z:for-each select="/i/rank[last()]/u">`);
    expect(xml).toContain(`<z:for-each select="/i/rank">`);
  });
});
