import { describe, it, expect } from "vitest";
import { sortPkPlayers } from "../src/index";

// 真实样本（三斤 22:31，8 人团队 PK）的 uid 与 rank 取值。
// rank=8 出现 3 次（三人 score 均为 None，并列垫底），其余 1..5 各一人。
const U = {
  r1: "8574547175",
  r2: "1241868704",
  r3: "6279153908",
  r4: "2366961549",
  r5: "3119166296",
  r8a: "0560590300",
  r8b: "2674507563",
  r8c: "4239627120",
} as const;

const withRank = (uid: string, rank: string) => ({ uid, rank });

describe("sortPkPlayers", () => {
  it("按 battleRank 升序（=名次）排列", () => {
    const out = sortPkPlayers([
      withRank(U.r5, "5"),
      withRank(U.r1, "1"),
      withRank(U.r3, "3"),
      withRank(U.r2, "2"),
      withRank(U.r4, "4"),
    ]);
    expect(out.map((p) => p.uid)).toEqual([U.r1, U.r2, U.r3, U.r4, U.r5]);
  });

  it("真实轮转样本：乱序输入 → 稳定名次输出", () => {
    // 抖音推送的逐帧轮转顺序之一（环形缓冲读偏移在变）
    const rotated = [
      withRank(U.r8b, "8"),
      withRank(U.r8a, "8"),
      withRank(U.r8c, "8"),
      withRank(U.r1, "1"),
      withRank(U.r2, "2"),
      withRank(U.r3, "3"),
      withRank(U.r4, "4"),
      withRank(U.r5, "5"),
    ];
    const out = sortPkPlayers(rotated);
    // 前 5 名按 rank 升序；后 3 名并列 rank=8 按 uid 升序稳定
    expect(out.map((p) => p.uid)).toEqual([U.r1, U.r2, U.r3, U.r4, U.r5, U.r8a, U.r8b, U.r8c]);
  });

  it("rank 相同（多人并列垫底）按 uid 升序稳定排序", () => {
    const out = sortPkPlayers([withRank(U.r8c, "8"), withRank(U.r8b, "8"), withRank(U.r8a, "8")]);
    expect(out.map((p) => p.uid)).toEqual([U.r8a, U.r8b, U.r8c]);
  });

  it("rank 缺失视为垫底，且不抛错", () => {
    const out = sortPkPlayers([withRank(U.r1, "1"), withRank("999", ""), withRank(U.r2, "2")]);
    expect(out.map((p) => p.uid)).toEqual([U.r1, U.r2, "999"]);
  });

  it("已是顺序则保持不变", () => {
    const ordered = [withRank(U.r1, "1"), withRank(U.r2, "2"), withRank(U.r3, "3")];
    expect(sortPkPlayers(ordered).map((p) => p.uid)).toEqual([U.r1, U.r2, U.r3]);
  });

  it("保留 players 的全部字段（仅排序，不丢数据）", () => {
    const out = sortPkPlayers([
      { uid: U.r2, rank: "2", score: "5", teamScore: "8", teamRank: "2" },
      { uid: U.r1, rank: "1", score: "10", teamScore: "20", teamRank: "1" },
    ]);
    expect(out[0]).toEqual({ uid: U.r1, rank: "1", score: "10", teamScore: "20", teamRank: "1" });
    expect(out[1]).toEqual({ uid: U.r2, rank: "2", score: "5", teamScore: "8", teamRank: "2" });
  });

  it("团队 PK：先按 teamRank 升序，团队内再按个人 rank 升序", () => {
    // 故意让团队顺序与个人名次顺序【背离】：同一团队内混有高/低个人名次，
    // 这样删掉团队主键后结果会变，才能区分"团队优先"与"仅个人名次"。
    const out = sortPkPlayers([
      { uid: U.r4, rank: "9", teamRank: "1" }, // 队 A，个人名次最高
      { uid: U.r1, rank: "1", teamRank: "1" }, // 队 A，个人名次最低
      { uid: U.r3, rank: "8", teamRank: "2" }, // 队 B
      { uid: U.r2, rank: "2", teamRank: "2" }, // 队 B
    ]);
    // 团队优先 → 队 A 整体在前 [r1(1), r4(9)]，队 B 在后 [r2(2), r3(8)]
    expect(out.map((p) => p.uid)).toEqual([U.r1, U.r4, U.r2, U.r3]);
  });

  it("团队内个人 rank 跨团队不串序（同队聚拢）", () => {
    // 队 A(teamRank=1) 的选手个人名次【靠后】，队 B(teamRank=2) 的选手个人名次【靠前】。
    // 团队优先时队 A 应整体排在队 B 之前，即便其个人名次更大。
    const out = sortPkPlayers([
      { uid: U.r5, rank: "9", teamRank: "1" }, // 队 A，个人垫底
      { uid: U.r1, rank: "1", teamRank: "2" }, // 队 B，个人第一
      { uid: U.r4, rank: "8", teamRank: "1" }, // 队 A
    ]);
    // 团队优先 → 队 A 在前 [r4, r5]，队 B 在后 [r1]
    expect(out.map((p) => p.uid)).toEqual([U.r4, U.r5, U.r1]);
  });

  it("非团队 PK（无 teamRank）行为不变：按个人 rank 升序", () => {
    const out = sortPkPlayers([withRank(U.r3, "3"), withRank(U.r1, "1"), withRank(U.r2, "2")]);
    expect(out.map((p) => p.uid)).toEqual([U.r1, U.r2, U.r3]);
  });

  it("团队内个人 rank 相同：按 uid 升序兜底（稳定）", () => {
    const out = sortPkPlayers([
      { uid: U.r8b, rank: "8", teamRank: "1" },
      { uid: U.r8a, rank: "8", teamRank: "1" },
    ]);
    expect(out.map((p) => p.uid)).toEqual([U.r8a, U.r8b]);
  });
});
