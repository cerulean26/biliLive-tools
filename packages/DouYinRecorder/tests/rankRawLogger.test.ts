import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRankRawLogger, createRoomRawLogger } from "../src/index";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归护栏：贡献榜消息转储（`WebcastRoomRankMessage`）的**按输出文件隔离**与**开关**语义。
 *
 * 与 `roomRawLogger.test.ts` 同构：room / rank 两路转储共用 `createJsonlRawLogger`，
 * 差异只有文件名后缀与开关环境变量。测试直接 import 真实实现，不复制逻辑。
 *
 * 额外锁一条：两路转储的后缀不能串（工厂参数化后最容易犯的错）。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rankraw-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 读取 jsonl，返回每行 [tag, payload.n] */
const readRows = async (p: string): Promise<[string, number][]> =>
  (await readFile(p, "utf-8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l);
      return [r.tag, r.payload.n] as [string, number];
    });

describe("createRankRawLogger：按输出文件隔离", () => {
  it("两个会话（两个实例）各自成文件，互不串台", async () => {
    const a = createRankRawLogger(true);
    const b = createRankRawLogger(true);
    const vA = join(dir, "A");
    const vB = join(dir, "B");

    await a(vA, "roomRank", { n: 1 });
    await b(vB, "roomRank", { n: 2 });
    await a(vA, "roomRank", { n: 3 });

    expect(await readRows(`${vA}_rank_raw.jsonl`)).toEqual([
      ["roomRank", 1],
      ["roomRank", 3],
    ]);
    expect(await readRows(`${vB}_rank_raw.jsonl`)).toEqual([["roomRank", 2]]);
  });

  it("同一路径重复写：首条覆盖建文件，后续追加、不丢已写行", async () => {
    const a = createRankRawLogger(true);
    const v = join(dir, "C");
    await a(v, "t", { n: 1 });
    await a(v, "t", { n: 2 });
    await a(v, "t", { n: 3 });
    expect(await readRows(`${v}_rank_raw.jsonl`)).toEqual([
      ["t", 1],
      ["t", 2],
      ["t", 3],
    ]);
  });

  it("同一写入器被复用于新路径：新路径独立成文件，旧文件保留", async () => {
    const a = createRankRawLogger(true);
    const v1 = join(dir, "D1");
    const v2 = join(dir, "D2");
    await a(v1, "t", { n: 1 });
    await a(v2, "t", { n: 2 });
    expect(await readRows(`${v1}_rank_raw.jsonl`)).toEqual([["t", 1]]);
    expect(await readRows(`${v2}_rank_raw.jsonl`)).toEqual([["t", 2]]);
  });

  it("首条消息覆盖写：同路径已有旧数据时被清空（重跑同一场不保留旧数据）", async () => {
    const v = join(dir, "E");
    const target = `${v}_rank_raw.jsonl`;
    // 模拟「上一轮跑过、留下旧数据」
    await writeFile(target, '{"tag":"old","at":0,"payload":{"n":9}}\n', "utf-8");

    const a = createRankRawLogger(true);
    await a(v, "t", { n: 1 });

    expect(await readRows(target)).toEqual([["t", 1]]);
  });

  it("创建失败后可重试（父目录不存在 → 仅告警，不抛）", async () => {
    const a = createRankRawLogger(true);
    const bad = join(dir, "no-such-subdir", "X");
    await expect(a(bad, "t", { n: 1 })).resolves.toBeUndefined();

    const good = join(dir, "Y");
    await a(good, "t", { n: 2 });
    expect(await readRows(`${good}_rank_raw.jsonl`)).toEqual([["t", 2]]);
  });

  it("videoPath 缺失时不创建任何文件", async () => {
    const a = createRankRawLogger(true);
    await a(undefined, "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("与人数转储互不覆盖：同一视频路径下各自成文件、后缀不串", async () => {
    const rank = createRankRawLogger(true);
    const room = createRoomRawLogger(true);
    const v = join(dir, "same");

    await rank(v, "roomRank", { n: 1 });
    await room(v, "roomStats", { n: 2 });

    expect(await readRows(`${v}_rank_raw.jsonl`)).toEqual([["roomRank", 1]]);
    expect(await readRows(`${v}_room_raw.jsonl`)).toEqual([["roomStats", 2]]);
  });

  it("落盘内容是 { tag, at, payload }，19 位 ID 原样以字符串保留（不丢精度）", async () => {
    const a = createRankRawLogger(true);
    const v = join(dir, "shape");
    // 与生产一致：payload 是 protobufjs `toJSON()` 的结果，19 位 ID 已是字符串
    await a(v, "roomRank", {
      common: { method: "WebcastRoomRankMessage" },
      ranks: [{ user: { id: "7694659564742265636" }, scoreStr: "12345", profileHidden: false }],
    });

    const row = JSON.parse((await readFile(`${v}_rank_raw.jsonl`, "utf-8")).trim());
    expect(Object.keys(row).sort()).toEqual(["at", "payload", "tag"]);
    expect(typeof row.at).toBe("number");
    expect(row.payload.ranks[0].user.id).toBe("7694659564742265636");
    expect(row.payload.ranks[0].scoreStr).toBe("12345");
  });
});

/**
 * 开关（默认关闭）：`roomRank` 约 2 秒一条，转储不该默认落在用户视频目录。
 */
describe("createRankRawLogger：开关", () => {
  it('未开启（环境变量非 "1"）→ 连文件都不创建', async () => {
    // 显式置空而非依赖「环境里恰好没设」，使用例与实际运行环境无关、可复现
    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "");
    const a = createRankRawLogger();
    await a(join(dir, "off"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('环境变量为 "0" 等其他值同样不开启（只有精确的 "1" 才算开启）', async () => {
    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "0");
    const a = createRankRawLogger();
    await a(join(dir, "zero"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("BILILIVE_TOOLS_RANK_RAW_LOG=1 → 开启并正常落盘", async () => {
    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "1");
    const a = createRankRawLogger();
    const v = join(dir, "on");
    await a(v, "roomRank", { n: 1 });
    expect(existsSync(`${v}_rank_raw.jsonl`)).toBe(true);
    expect(await readRows(`${v}_rank_raw.jsonl`)).toEqual([["roomRank", 1]]);
  });

  it("开的是人数转储的环境变量时，贡献榜转储仍保持关闭（两个开关互不影响）", async () => {
    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "1");
    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "");
    const a = createRankRawLogger();
    await a(join(dir, "cross"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("环境变量在**创建写入器时**读取：同一进程内先关后开可切换", async () => {
    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "");
    const off = createRankRawLogger();
    await off(join(dir, "first"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);

    vi.stubEnv("BILILIVE_TOOLS_RANK_RAW_LOG", "1");
    const on = createRankRawLogger();
    const v = join(dir, "second");
    await on(v, "t", { n: 2 });
    expect(await readRows(`${v}_rank_raw.jsonl`)).toEqual([["t", 2]]);
  });
});
