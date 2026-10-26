import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { collectSubmittedFiles } from "../../src/task/bili.js";
import type { BiliVideoTask } from "../../src/task/task.js";

/**
 * 只造出 collectSubmittedFiles 真正关心的字段（taskList[i].completedPart.filePath）
 */
const makeTask = (filePaths: (string | null)[]) =>
  ({
    taskList: filePaths.map((filePath) => ({
      completedPart: filePath ? { cid: 1, filename: "x.mp4", title: "x", filePath } : null,
    })),
  }) as unknown as BiliVideoTask;

describe("collectSubmittedFiles", () => {
  it("没有追加分P时就是本次提交的 videos", () => {
    const pTask = makeTask(["/v/a.mp4"]);
    expect(collectSubmittedFiles(pTask, [{ path: "/v/a.mp4" }])).toEqual(["/v/a.mp4"]);
  });

  // 队列里「+ 添加视频」追加的分P不在 videos 里，但会并入同一次提交
  it("追加的分P也要纳入，否则永远删不到", () => {
    const pTask = makeTask(["/v/a.mp4", "/v/b.mp4"]);
    const files = collectSubmittedFiles(pTask, [{ path: "/v/a.mp4" }]);
    expect(files).toContain("/v/b.mp4");
    expect(files).toHaveLength(2);
  });

  it("videos 与分P指向同一文件时不重复", () => {
    const pTask = makeTask(["/v/a.mp4", "/v/a.mp4"]);
    expect(collectSubmittedFiles(pTask, [{ path: "/v/a.mp4" }])).toEqual(["/v/a.mp4"]);
  });

  // 没上传完（completedPart 为 null）的分P没有真正进稿件，不该被删
  it("跳过没有上传成功的分P", () => {
    const pTask = makeTask([null, "/v/b.mp4"]);
    expect(collectSubmittedFiles(pTask, [{ path: "/v/a.mp4" }])).toEqual(["/v/a.mp4", "/v/b.mp4"]);
  });
});

// 源码级护栏：函数本身测不到「有没有被调用、以及何时被调用」。
// 历史坑：onEnd 里曾直接写 videos.map(...)（追加分P 永远进不了删除名单），
// 修复后又踩过「审核回调惰性重算 collectSubmittedFiles」——submit() 的 finally 已清空 taskList，
// 回调在数分钟后才触发，重算会丢掉队列「+」追加的分P。正确做法是 onEnd 同步阶段快照一次，回调复用。
describe("addMedia / editMedia 的删除名单调用点", () => {
  const src = fs.readFileSync(new URL("../../src/task/bili.ts", import.meta.url), "utf8");

  // addMedia / editMedia 各一处快照：在 onEnd 同步阶段、taskList 被 releasePartTasks 清空前采集
  it("两处 onEnd 都在同步阶段快照 collectSubmittedFiles", () => {
    expect(
      src.match(/const submittedFiles = collectSubmittedFiles\(pTask, videos\)/g) ?? [],
    ).toHaveLength(2);
  });

  it("审核回调与删除循环都复用快照 submittedFiles，不再惰性重算", () => {
    // 延迟回调里的 files 必须是快照，绝不能重新惰性调用 collectSubmittedFiles（taskList 已空会丢追加分P）
    expect(src).not.toContain("files: collectSubmittedFiles(pTask, videos)");
    expect(src).toContain("files: submittedFiles");
    // 删除循环同样用快照
    expect(src).toContain("for (const file of submittedFiles)");
  });

  it("不再有直接按 videos 拼删除名单的写法", () => {
    expect(src).not.toContain("files: videos.map((video) => video.path)");
    expect(src).not.toContain("for (const video of videos)");
  });
});
