import { describe, it, expect } from "vitest";
import { pickGiftAssets } from "../src/index";

/**
 * 「保存礼物图片」/「保存送礼用户头像」两个开关的护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 抽纯函数的理由与 `buildRoomStatsMessage` 相同：开关判断原本埋在 `client.on("gift")`
 * 回调里，无法单测。抽出来后，「关掉的那项不带属性」才成为可断言的不变量。
 *
 * ⚠️ 覆盖边界：本文件只覆盖纯函数。调用点里
 * `{ saveIcon: this.saveGiftIcon, saveAvatar: this.saveGiftAvatar }` 这一行（开关接入）
 * 仍是未覆盖的，与 `saveRoomStats` 的接法相同，只能人工验。
 *
 * 断言刻意用 `"imageUri" in out` 而不是 `toBeUndefined()`：`{ imageUri: undefined }`
 * 也能通过后者，但那会在消息上留下一个空键，`JSON.stringify` 之后是 `{}` 与
 * 真不存在的区别在转储与下游 `in` 判断里都能被观察到。
 */

const IMG = "webcast/3d2367ee.png";
const AVATAR = "100x100/aweme-avatar/tos-cn-i-0813_abc";

describe("pickGiftAssets:: 两个开关", () => {
  it("都开启时两项都带上", () => {
    const out = pickGiftAssets(IMG, AVATAR, { saveIcon: true, saveAvatar: true });

    expect(out).toEqual({ imageUri: IMG, avatar: AVATAR });
  });

  it("关闭「礼物图片」时不带 imageUri，头像照旧", () => {
    const out = pickGiftAssets(IMG, AVATAR, { saveIcon: false, saveAvatar: true });

    expect("imageUri" in out).toBe(false);
    expect(out.avatar).toBe(AVATAR);
  });

  it("关闭「送礼用户头像」时不带 avatar，图片照旧", () => {
    const out = pickGiftAssets(IMG, AVATAR, { saveIcon: true, saveAvatar: false });

    expect("avatar" in out).toBe(false);
    expect(out.imageUri).toBe(IMG);
  });

  it("两项都关闭时返回空对象（XML 里既无 <gi> 也无 @a）", () => {
    const out = pickGiftAssets(IMG, AVATAR, { saveIcon: false, saveAvatar: false });

    expect(out).toEqual({});
  });

  it("开关缺省（老配置没有这两个键）视为开启", () => {
    const out = pickGiftAssets(IMG, AVATAR, {});

    expect(out).toEqual({ imageUri: IMG, avatar: AVATAR });
  });

  it("上游未下发 uri 时不产生空属性", () => {
    const out = pickGiftAssets(undefined, undefined, { saveIcon: true, saveAvatar: true });

    expect(out).toEqual({});
  });

  it("uri 为空字符串时同样不产生属性", () => {
    const out = pickGiftAssets("", "", { saveIcon: true, saveAvatar: true });

    expect(out).toEqual({});
  });

  it("两项互不影响：图片缺、头像有", () => {
    const out = pickGiftAssets(undefined, AVATAR, { saveIcon: true, saveAvatar: true });

    expect(out).toEqual({ avatar: AVATAR });
  });
});
