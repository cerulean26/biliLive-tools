import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nodeFs from "node:fs";
import { createRecordExtraDataController, XmlStreamController } from "../src/xml_stream_controller";
import type { PkScore } from "../src/common";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

// 用系统临时目录（与 shared 测试的惯例一致），避免污染仓库
let tempDir: string;
let savePath: string;

/**
 * PK 分数消息只带 uid 与分数 —— **昵称不进消息体**。
 * 昵称统一由录制器在拿到后调用 `registerPkNickname` 登记到末尾映射表。
 */
const pkMessage = (timestamp: number, uids: string[]): PkScore => ({
  type: "pk_score",
  timestamp,
  players: uids.map((uid) => ({
    uid,
    score: "10",
    rank: "1",
    teamScore: "10",
    teamRank: "1",
  })),
});

describe("xml_stream_controller:: 末尾 PK 昵称映射表", () => {
  let ctrl: XmlStreamController;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pk-map-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(tempDir);
    savePath = path.join(tempDir, "rec.xml");
    ctrl = createRecordExtraDataController(savePath);
  });

  afterEach(async () => {
    await fs.remove(tempDir).catch(() => {});
  });

  it("flush 时在 </i> 之前追加 pk_users 映射表", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["65305021017"]));
    ctrl.registerPkNickname("65305021017", "迪士尼在逃公主👸");
    await ctrl.flush();

    const content = await fs.readFile(savePath, "utf-8");
    expect(content).toContain("<pk_users>");
    expect(content).toContain('uid="65305021017"');
    expect(content).toContain('nick="迪士尼在逃公主👸"');
    // 关键: 映射表必须在闭合标签之前
    expect(content.indexOf("<pk_users>")).toBeLessThan(content.lastIndexOf("</i>"));
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
  });

  it("player 节点只输出 uid，昵称完全交给映射表（由 XSL 层翻译）", async () => {
    const t = Date.now();
    // 模拟中途接入：入队时昵称未知
    ctrl.addMessage(pkMessage(t, ["631566008585120"]));
    ctrl.registerPkNickname("631566008585120", "金砖⁵⁰²");
    await ctrl.flush();

    const content = await fs.readFile(savePath, "utf-8");
    // 映射表里有真名，供 XSL 翻译
    expect(content).toContain('nick="金砖⁵⁰²"');
    // player 节点不带 nick —— 昵称信息只存在于映射表
    const player = content.match(/<player\b[^>]*>/)?.[0] ?? "";
    expect(player).not.toContain("nick=");
    expect(player).toContain('uid="631566008585120"');
  });

  it("只有经 registerPkNickname 登记的选手才进表", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1", "u2"]));
    ctrl.registerPkNickname("u1", "主播甲");
    // u2 从未登记（没拿到昵称），不应进表
    await ctrl.flush();

    const content = await fs.readFile(savePath, "utf-8");
    expect(content).toContain('uid="u1"');
    expect(content).toContain('nick="主播甲"');
    // u2 仍会出现在 player 节点里（预期），但不该进映射表
    const mapSection = content.slice(content.indexOf("<pk_users>"), content.indexOf("</pk_users>"));
    expect(mapSection).not.toContain('uid="u2"');
  });

  it("无 PK 昵称时不产生空的 pk_users 节点（addMessage 不做隐式登记）", async () => {
    // 回归护栏：早先 addMessage 会读 player.name（值可能是 uid 占位）自动进表，
    // 现改为「昵称只认 registerPkNickname」，消息体里也不再携带 name。
    ctrl.addMessage(pkMessage(Date.now(), ["u1"]));
    await ctrl.flush();

    const content = await fs.readFile(savePath, "utf-8");
    expect(content).not.toContain("<pk_users>");
    // player 节点本身仍正常输出
    expect(content).toContain('uid="u1"');
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
  });

  it("昵称含 XML 特殊字符时被正确转义", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1"]));
    ctrl.registerPkNickname("u1", 'A&B<C>"D"\'');
    await ctrl.flush();

    const content = await fs.readFile(savePath, "utf-8");
    expect(content).toContain("&amp;");
    expect(content).toContain("&lt;");
    expect(content).toContain("&quot;");
    expect(content).toContain("&apos;");
  });

  it("registerPkNickname 幂等: 重复登记同一昵称返回 0", () => {
    expect(ctrl.registerPkNickname("u1", "主播甲")).toBe(1);
    expect(ctrl.registerPkNickname("u1", "主播甲")).toBe(0);
  });

  it("空昵称或空 uid 不登记", async () => {
    expect(ctrl.registerPkNickname("u1", "")).toBe(0);
    expect(ctrl.registerPkNickname("", "昵称")).toBe(0);

    await ctrl.flush();
    const content = await fs.readFile(savePath, "utf-8");
    expect(content).not.toContain("<pk_users>");
  });

  it("即使该 uid 从未出现在 PK 分数消息里也能登记（场景 2：中途接入）", async () => {
    // 中途接入时，结束事件里的选手可能一条 pk_score 都没产生过
    expect(ctrl.registerPkNickname("never-seen-uid", "主播甲")).toBe(1);

    await ctrl.flush();
    const content = await fs.readFile(savePath, "utf-8");
    expect(content).toContain('<user uid="never-seen-uid" nick="主播甲">');
  });

  it("flush 之后 registerPkNickname 不再生效（hasCompleted）", async () => {
    await ctrl.flush();
    expect(ctrl.registerPkNickname("u1", "主播甲")).toBe(0);
  });
});

describe("xml_stream_controller:: PK 团队字段空属性处理", () => {
  let ctrl: XmlStreamController;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `pk-team-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(dir);
    file = path.join(dir, "rec.xml");
    ctrl = createRecordExtraDataController(file);
  });

  afterEach(async () => {
    await fs.remove(dir).catch(() => {});
  });

  it("非团队 PK：不输出空的 team_score / team_rank 属性", async () => {
    // 非团队 PK 的 userScores 不含 team 字段，序列化层应省略这两个属性，
    // 避免每帧每选手白写 team_score="" team_rank=""（约占文件 10-13%）。
    ctrl.addMessage({
      type: "pk_score",
      timestamp: Date.now(),
      players: [
        { uid: "111", score: "10", rank: "1" },
        { uid: "222", score: "5", rank: "2" },
      ],
    });
    await ctrl.flush();

    const content = await fs.readFile(file, "utf-8");
    expect(content).not.toContain("team_score=");
    expect(content).not.toContain("team_rank=");
    // 普通字段照常输出
    expect(content).toContain('uid="111"');
    expect(content).toContain('rank="1"');
  });

  it("团队 PK：正常输出 team_score / team_rank 属性", async () => {
    ctrl.addMessage({
      type: "pk_score",
      timestamp: Date.now(),
      players: [
        { uid: "111", score: "10", rank: "1", teamScore: "20", teamRank: "1" },
        { uid: "222", score: "5", rank: "2", teamScore: "8", teamRank: "2" },
      ],
    });
    await ctrl.flush();

    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('team_score="20"');
    expect(content).toContain('team_rank="1"');
    expect(content).toContain('team_score="8"');
    expect(content).toContain('team_rank="2"');
  });
});

describe("xml_stream_controller:: P2-1 闭合标签必须落盘", () => {
  let ctrl: XmlStreamController;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `pk-close-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(dir);
    file = path.join(dir, "rec.xml");
    ctrl = createRecordExtraDataController(file);
  });

  afterEach(async () => {
    await fs.remove(dir).catch(() => {});
  });

  it("映射表写入失败时，</i> 仍会被写入（不因中间步骤失败而损坏整份 XML）", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1"]));
    ctrl.registerPkNickname("u1", "主播甲");

    // 让第 1 次 append（PK 昵称映射表）抛错，第 2 次（</i>）正常
    const real = nodeFs.promises.appendFile.bind(nodeFs.promises);
    let calls = 0;
    const spy = vi.spyOn(nodeFs.promises, "appendFile").mockImplementation(((
      ...args: Parameters<typeof nodeFs.promises.appendFile>
    ) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("模拟「映射表」写入失败"));
      return real(...args);
    }) as typeof nodeFs.promises.appendFile);

    try {
      await ctrl.flush();
    } finally {
      spy.mockRestore();
    }

    const content = await fs.readFile(file, "utf-8");
    // 关键：闭合标签仍在（旧实现会因映射表抛错而整段跳过，导致 XML 缺 </i>）
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2); // 说明第 2 次（</i>）确实被尝试
  });
});

describe("xml_stream_controller:: flush 前补齐 PK 昵称（竞态修复）", () => {
  let dir: string;
  let file: string;
  let ctrl: XmlStreamController;

  beforeEach(async () => {
    dir = path.join(
      os.tmpdir(),
      `pk-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.ensureDir(dir);
    file = path.join(dir, "rec.xml");
    ctrl = createRecordExtraDataController(file);
  });

  afterEach(async () => {
    await fs.remove(dir).catch(() => {});
  });

  it("provider 的结果会在映射表落盘前写入（修复「查询在途 → 结果被 hasCompleted 丢弃」）", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1", "u2"]));
    // 模拟：u1 的查询在 flush 时才拿到结果。旧实现下该结果会被 hasCompleted 挡掉，
    // 映射表里 u1 永远只有 uid。
    const provider = vi.fn(async (uids: string[]) => {
      const m = new Map<string, string>();
      if (uids.includes("u1")) m.set("u1", "迟到的主播");
      return m;
    });
    ctrl.setNicknameProvider(provider);

    await ctrl.flush();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(["u1", "u2"]);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('nick="迟到的主播"');
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
  });

  it("已有昵称的 uid 不会传给 provider（不重复查）", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1", "u2"]));
    ctrl.registerPkNickname("u1", "已经有名");
    const provider = vi.fn(async () => new Map<string, string>());
    ctrl.setNicknameProvider(provider);

    await ctrl.flush();

    expect(provider).toHaveBeenCalledWith(["u2"]);
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('nick="已经有名"');
  });

  it("provider 抛错不影响已登记昵称与 </i> 落盘", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1"]));
    ctrl.registerPkNickname("u1", "主播甲");
    ctrl.addMessage(pkMessage(Date.now(), ["u2"]));
    ctrl.setNicknameProvider(async () => {
      throw new Error("模拟补齐失败");
    });

    await ctrl.flush();

    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('nick="主播甲"');
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
  });

  it("未注入 provider 时行为不变", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["u1"]));
    ctrl.registerPkNickname("u1", "主播甲");
    await ctrl.flush();
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('nick="主播甲"');
    expect(content.trimEnd().endsWith("</i>")).toBe(true);
  });
});

/**
 * 场次标识 `battle_id`：一场直播可打多场 PK，XSL 原先把所有 `<pk>` 拍平成**一张**表，
 * 多场 PK 的比赛会串在一起（选手集合突变但无任何分隔）。带上 battle_id 后按它分组。
 */
describe("xml_stream_controller:: PK 场次标识 battle_id", () => {
  let ctrl: XmlStreamController;
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `pk-battle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.ensureDir(dir);
    file = path.join(dir, "rec.xml");
    ctrl = createRecordExtraDataController(file);
  });

  afterEach(async () => {
    await fs.remove(dir).catch(() => {});
  });

  it("带 battleId 时输出 battle_id 属性", async () => {
    ctrl.addMessage({ ...pkMessage(Date.now(), ["111"]), battleId: "7694677542370301000" });
    await ctrl.flush();
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('battle_id="7694677542370301000"');
  });

  it("缺 battleId 时该属性不出现（与 team_* 的省略行为一致）", async () => {
    ctrl.addMessage(pkMessage(Date.now(), ["111"]));
    await ctrl.flush();
    const content = await fs.readFile(file, "utf-8");
    expect(content).not.toContain("battle_id=");
    expect(content).toContain('uid="111"'); // 其余字段照常
  });

  it("同一次开播的多场 PK：两条记录的 battle_id 各不相同（数据层可归属）", async () => {
    const first = pkMessage(Date.now(), ["111"]);
    const second = pkMessage(Date.now() + 1000, ["222"]);
    ctrl.addMessage({ ...first, battleId: "7694677542370301000" });
    ctrl.addMessage({ ...second, battleId: "7694700747398059000" });
    await ctrl.flush();

    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('battle_id="7694677542370301000"');
    expect(content).toContain('battle_id="7694700747398059000"');
  });

  /**
   * 样式表护栏：分组渲染发生在 XSL 层（本仓库无 XSLT 处理器可用，无法执行验证），
   * 所以这里断言**产出的样式表里确实带着分组定义**。
   * 局限：只能证明分组未被删掉，不能证明渲染结果正确 —— 后者靠人工在浏览器里核对。
   */
  it("产出的样式表含按 battle_id 分组的定义（防误删）", async () => {
    ctrl.addMessage({ ...pkMessage(Date.now(), ["111"]), battleId: "b-1" });
    await ctrl.flush();
    const content = await fs.readFile(file, "utf-8");

    const start = content.indexOf("<RecorderXmlStyle>");
    const end = content.indexOf("</RecorderXmlStyle>") + "</RecorderXmlStyle>".length;
    const style = content.slice(start, end);

    expect(style).toContain('key name="pkByBattle" match="pk" use="@battle_id"');
    expect(style).toContain("key('pkByBattle',@battle_id)");
  });
});
