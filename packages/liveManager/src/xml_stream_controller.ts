/**
 * XML流式写入控制器，用于实时写入弹幕、礼物等信息到XML文件
 * 相比原有的json方案，这个实现每隔10秒就会写入数据，减少内存占用和数据丢失风险
 */
import fs from "node:fs";
import { XMLBuilder } from "fast-xml-parser";
import { pick } from "lodash-es";

import { Message } from "./common.js";

const METADATA_PLACEHOLDER = "<!--METADATA_PLACEHOLDER-->";
const XML_FILE_HEADER = `<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xsl" href="#s"?>\n<i>\n${METADATA_PLACEHOLDER}\n<RecorderXmlStyle><z:stylesheet version="1.0" id="s" xml:id="s" xmlns:z="http://www.w3.org/1999/XSL/Transform"><z:output method="html"/><z:key name="pkByBattle" match="pk" use="@battle_id"/><z:key name="giById" match="gi" use="@i"/><z:key name="uiByUid" match="ui" use="@i"/><z:template match="/"><html><meta name="viewport" content="width=device-width"/><title>弹幕文件 <z:value-of select="/i/metadata/user_name/text()"/></title><style>body{margin:0}h1,h2,p,table{margin-left:5px}table{border-spacing:0}td,th{border:1px solid grey;padding:1px 5px}th{position:sticky;top:0;background:#4098de}summary{cursor:pointer;font-weight:bold}tr:hover{background:#d9f4ff}div{overflow:auto;max-height:80vh;max-width:100vw;width:fit-content}img{vertical-align:middle}</style><h1>弹幕XML文件</h1><p>本文件不支持在 IE 浏览器里预览，请使用 Chrome Firefox Edge 等浏览器。</p><p>文件用法参考文档 <a href="https://rec.danmuji.org/user/danmaku/">https://rec.danmuji.org/user/danmaku/</a></p><table><tr><td>房间号</td><td><z:value-of select="/i/metadata/room_id/text()"/></td></tr><tr><td>主播名</td><td><z:value-of select="/i/metadata/user_name/text()"/></td></tr><tr><td><a href="#d">弹幕</a></td><td>共<z:value-of select="count(/i/d)"/>条记录</td></tr><tr><td><a href="#guard">上船</a></td><td>共<z:value-of select="count(/i/guard)"/>条记录</td></tr><tr><td><a href="#sc">SC</a></td><td>共<z:value-of select="count(/i/sc)"/>条记录</td></tr><tr><td><a href="#gift">礼物</a></td><td>共<z:value-of select="count(/i/gift)"/>条记录</td></tr><z:if test="/i/pk"><tr><td><a href="#pk">PK</a></td><td>共<z:value-of select="count(/i/pk)"/>条记录</td></tr></z:if></table><h2 id="d">弹幕</h2><div id="dm"><table><tr><th>用户名</th><th>出现时间</th><th>用户ID</th><th>弹幕</th><th>等级</th><th>粉丝团</th><th>参数</th></tr><z:for-each select="/i/d"><tr><td><z:value-of select="@user"/></td><td></td><td></td><td><z:value-of select="."/></td><td><z:value-of select="@level"/></td><td><z:value-of select="@club_level"/></td><td><z:value-of select="@p"/></td></tr></z:for-each></table></div><script>Array.from(document.querySelectorAll('#dm tr')).slice(1).map(t=>t.querySelectorAll('td')).forEach(t=>{let p=t[6].textContent.split(','),a=p[0];t[1].textContent=\`\u0024{(Math.floor(a/60/60)+'').padStart(2,0)}:\u0024{(Math.floor(a/60%60)+'').padStart(2,0)}:\u0024{(a%60).toFixed(3).padStart(6,0)}\`;t[2].innerHTML=\`&lt;a target=_blank rel="nofollow noreferrer" "&gt;\u0024{p[6]}&lt;/a&gt;\`})</script><h2 id="guard">舰长购买</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>舰长等级</th><th>购买数量</th><th>出现时间</th></tr><z:for-each select="/i/guard"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text></z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="@level"/></td><td><z:value-of select="@count"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div><h2 id="sc">SuperChat 醒目留言</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>内容</th><th>显示时长</th><th>价格</th><th>出现时间</th></tr><z:for-each select="/i/sc"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text></z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="."/></td><td><z:value-of select="@time"/></td><td><z:value-of select="@price"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div><h2 id="gift">礼物</h2><div><table><tr><th>头像</th><th>用户名</th><th>用户ID</th><th>图标</th><th>礼物名</th><th>礼物数量</th><th>出现时间</th><th>等级</th><th>粉丝团</th></tr><z:for-each select="/i/gift"><tr><td><z:variable name="av" select="key('uiByUid',@uid)/@p"/><z:if test="string($av)"><z:choose><z:when test="starts-with($av,'webcast/')"><img height="24" src="https://p3-webcast.douyinpic.com/img/{$av}~tplv-obj.image"/></z:when><z:otherwise><img height="24" src="https://p11.douyinpic.com/aweme/{$av}.jpeg"/></z:otherwise></z:choose></z:if></td><td><z:value-of select="@user"/></td><td><span rel="nofollow noreferrer"><z:attribute name="href"></z:attribute><z:value-of select="@uid"/></span></td><td><z:variable name="gu" select="key('giById',@giftid)/@u"/><z:if test="string($gu)"><z:choose><z:when test="starts-with($gu,'webcast/')"><img height="24" src="https://p3-webcast.douyinpic.com/img/{$gu}~tplv-obj.image"/></z:when><z:otherwise><img height="24" src="https://p11.douyinpic.com/aweme/{$gu}.jpeg"/></z:otherwise></z:choose></z:if></td><td><z:value-of select="@giftname"/></td><td><z:value-of select="@giftcount"/></td><td><z:value-of select="@ts"/></td><td><z:value-of select="@level"/></td><td><z:value-of select="@club_level"/></td></tr></z:for-each></table></div><z:if test="/i/pk"><h2 id="pk">PK分数</h2><z:for-each select="/i/pk[generate-id()=generate-id(key('pkByBattle',@battle_id)[1])]"><details><summary>PK 场次 <z:value-of select="position()"/><z:if test="@battle_id"><z:text>（battle_id </z:text><z:value-of select="@battle_id"/><z:text>）</z:text></z:if></summary><div><table><tr><th>PK时间</th><th>主播</th><th>主播ID</th><th>分数</th><th>排名</th><z:if test="player/@team_rank"><th>团队分数</th><th>团队排名</th></z:if></tr><z:for-each select="key('pkByBattle',@battle_id)"><z:for-each select="player"><z:variable name="pkUid" select="@uid"/><tr><td><z:if test="position()=1"><z:value-of select="../@ts"/></z:if></td><td><z:choose><z:when test="/i/pk_users/user[@uid=$pkUid]"><z:value-of select="/i/pk_users/user[@uid=$pkUid]/@nick"/></z:when><z:otherwise><z:value-of select="@uid"/></z:otherwise></z:choose></td><td><z:value-of select="@uid"/></td><td><z:value-of select="@score"/></td><td><z:value-of select="@rank"/></td><z:if test="../player/@team_rank"><td><z:value-of select="@team_score"/></td><td><z:value-of select="@team_rank"/></td></z:if></tr></z:for-each></z:for-each></table></div></details></z:for-each></z:if><z:if test="/i/pk_users"><h2 id="pk_users">PK选手</h2><div id="pk_users_div"><table><tr><th>主播ID</th><th>主播昵称</th></tr><z:for-each select="/i/pk_users/user"><tr><td><z:value-of select="@uid"/></td><td><z:value-of select="@nick"/></td></tr></z:for-each></table></div></z:if></html></z:template></z:stylesheet></RecorderXmlStyle>\n`;
const DANMA_STATS_INTERVAL = 10;

export interface DanmaStatsPayload {
  danmaTimeline: {
    interval: number;
    data: number[];
  };
}

export interface XmlStreamStats {
  danmaNum: number;
  uniqMember: number;
  scNum: number;
  guardNum: number;
  danmaStats: DanmaStatsPayload;
}

export interface XmlStreamData {
  header: string;
  meta: {
    title?: string;
    recordStartTimestamp: number;
    recordStopTimestamp?: number;
    liveStartTimestamp?: number;
    downloaderArgs?: string[];
    platform?: string;
    user_name?: string;
    room_id?: string;
  };
  /** 缓存的消息，待写入到文件 */
  pendingMessages: Message[];
}

export interface XmlStreamController {
  /** 设计上来说，外部程序不应该能直接修改 data 上的东西 */
  readonly data: XmlStreamData;
  addMessage: (message: Message) => void;
  /**
   * 登记 PK 选手的真实昵称，写入录制结束时追加到 XML 末尾的映射表。
   *
   * **这张映射表是 PK 昵称的唯一权威来源**：`<player>` 节点只输出 `@uid`、不含昵称
   * （PK 分数消息本身也不带昵称），而 XML 单向追加、无法回改，所以 XSL 渲染时统一
   * 查这张表翻译（查不到才退回显示 uid）。
   *
   * 调用方：录制器在拿到 **battle 来源**（`linkMicBattle` / `linkMicBattleFinish` 的
   * `userInfos`）的昵称时调用（见 `DouYinRecorder` 的 `warmPkNicknamesFromUserInfos`）。
   * `addMessage` 不做任何隐式登记。
   *
   * ⚠️ 注意：`flush` 的**批量补齐**路径**不走本方法** —— 那时 `hasCompleted` 已置位，
   * 本方法会直接返回 0；补齐结果由 `flush` 内部直接写入 `pkUserNicknames`
   * （见 `setNicknameProvider`）。
   *
   * @returns 该昵称是否是新信息（已登记过相同昵称返回 0）
   */
  registerPkNickname: (uid: string, nickname: string) => number;
  /**
   * 注入「flush 前批量补齐昵称」的提供者（可选）。
   *
   * 背景：PK 分数消息**只带 uid 与分数、不带昵称**，而录制期**不发起**昵称查询
   * （批式改造）—— 只把出现过的 uid 收集到 `pkUidsSeen`。昵称查询集中到 `flush`
   * 落盘映射表**之前**由本回调一次完成，好处是：有 battle 的场次完全不发请求，
   * 且查询结果必定早于快照，不会被 `hasCompleted` 丢掉。
   *
   * 注入后，`flush` 会在写映射表**之前**调用它并等待，用结果补齐快照。
   * 未注入时行为完全不变（映射表里没有昵称的选手退化为显示 uid）。
   *
   * @param fn 入参为本场出现过、且尚无昵称的 uid；返回 uid → 昵称（仅含已拿到的）
   */
  setNicknameProvider: (fn: ((uids: string[]) => Promise<Map<string, string>>) | null) => void;
  setMeta: (meta: Partial<XmlStreamData["meta"]>) => Promise<void>;
  flush: () => Promise<void>;
  getStats: () => XmlStreamStats;
}

export function createRecordExtraDataController(savePath: string): XmlStreamController {
  const data: XmlStreamData = {
    header: XML_FILE_HEADER,
    meta: {
      recordStartTimestamp: Date.now(),
    },
    pendingMessages: [],
  };
  let hasCompleted = false;
  let hasPersistedHeader = false;
  let danmaNum = 0;
  let scNum = 0;
  let guardNum = 0;
  let maxDanmaBucketStart = -1;
  const interactedUsers = new Set<string>();
  const danmaBucketCountMap = new Map<number, number>();

  const getDanmaStats = (): DanmaStatsPayload => {
    if (maxDanmaBucketStart < 0) {
      return {
        danmaTimeline: {
          interval: DANMA_STATS_INTERVAL,
          data: [],
        },
      };
    }

    const stats: number[] = [];
    for (let start = 0; start <= maxDanmaBucketStart; start += DANMA_STATS_INTERVAL) {
      stats.push(danmaBucketCountMap.get(start) ?? 0);
    }

    return {
      danmaTimeline: {
        interval: DANMA_STATS_INTERVAL,
        data: stats,
      },
    };
  };
  /**
   * 本场 PK 出现过的选手：uid -> 昵称。
   *
   * 抖音的 PK 分数消息（`userScores`）不带昵称，昵称要靠 battle 消息或接口另行获取，
   * 而这两者都不保证早于分数消息到达 —— 于是 `<player nick>` 里会留下 uid 占位值。
   *
   * 由于 XML 是单向追加（`appendFile`），已落盘的 uid 占位无法回改。这里改为在录制
   * 结束、闭合标签之前**追加一张映射表**，由 XSL 在渲染时翻译：
   * 纯追加、不触碰已写内容，因此崩溃中断最多丢失表尾，不会损坏原有数据。
   */
  const pkUserNicknames = new Map<string, string>();
  /**
   * 本场出现过的 PK 选手 uid（含尚未拿到昵称的）。
   *
   * 用于 `flush` 前向 `nicknameProvider` 补齐昵称 —— 这些 uid 可能因为「查询在途」
   * 而没能进入 `pkUserNicknames`（见 `flush` 内的补齐逻辑）。
   */
  const pkUidsSeen = new Set<string>();
  /** flush 前补齐昵称的提供者（由录制器注入，见 `setNicknameProvider`） */
  let nicknameProvider: ((uids: string[]) => Promise<Map<string, string>>) | null = null;

  /**
   * 礼物图标首见表：giftId -> { 名, 图标相对路径 }。
   *
   * 一条礼物消息约 145 字符的图标/头像地址，而全场礼物往往只有几十种，
   * 逐条写会把文件撑大数倍（实测 1017 条礼物：逐条 141 KB，建表后 57 KB）。
   * 故改为「某个 giftId 第一次出现时插入一行 `<gi>` 声明」，XSL 用 `key()` 查回。
   *
   * 与 `<pk_users>` 不同，声明是**就地**写的而非集中到末尾：体积相同，但崩溃中断时
   * 已写部分不会丢，流式解析也不需要读完整文件。
   */
  const giftIcons = new Map<string, { name: string; uri: string }>();
  /** 用户头像首见表：uid -> 相对路径。`uid -> 头像` 实测严格 1:1，uid 天然就是正确的键。 */
  const userAvatars = new Map<string, string>();

  const getStats = (): XmlStreamStats => ({
    danmaNum,
    uniqMember: interactedUsers.size,
    scNum,
    guardNum,
    danmaStats: getDanmaStats(),
  });

  const trackDanmaBucket = (message: Message) => {
    const progressInSeconds = Math.max(
      (message.timestamp - data.meta.recordStartTimestamp) / 1000,
      0,
    );
    const bucketStart = Math.floor(progressInSeconds / DANMA_STATS_INTERVAL) * DANMA_STATS_INTERVAL;
    danmaBucketCountMap.set(bucketStart, (danmaBucketCountMap.get(bucketStart) ?? 0) + 1);
    maxDanmaBucketStart = Math.max(maxDanmaBucketStart, bucketStart);
  };

  const trackInteractedUser = (message: Message) => {
    if (message.type === "pk_score") return;
    const userName = message.sender?.name?.trim();
    if (!userName) return;
    interactedUsers.add(userName);
  };

  const initializeFile = async (content: string) => {
    // 这里有个假设，那就是第一次保存必然存在metatdata信息
    const initialContent = data.header.replace(
      METADATA_PLACEHOLDER,
      generateMetadataXml(data.meta),
    );
    await fs.promises.writeFile(savePath, initialContent + content);
    hasPersistedHeader = true;
  };

  const writeToFile = async (force = false): Promise<void> => {
    if (!force && data.pendingMessages.length === 0) {
      return Promise.resolve();
    }

    const messagesToWrite = [...data.pendingMessages];
    data.pendingMessages = [];

    try {
      const { xml, newGiftIcons, newUserAvatars } = generateXmlContent(
        data.meta,
        messagesToWrite,
        giftIcons,
        userAvatars,
      );
      if (!hasPersistedHeader) {
        await initializeFile(xml);
      } else if (xml) {
        await appendToXmlFile(savePath, xml);
      }
      // 首见表项只在**写盘成功后**提交：写失败时消息会退回 pendingMessages 重试，
      // 若此时已记进表，重试那次就会认为「已声明过」而漏掉声明行。
      for (const [id, entry] of newGiftIcons) giftIcons.set(id, entry);
      for (const [uid, uri] of newUserAvatars) userAvatars.set(uid, uri);
    } catch (error) {
      console.error("写入XML文件失败:", error);
      data.pendingMessages = [...messagesToWrite, ...data.pendingMessages];
    }
  };

  // 每10秒写入一次数据
  const writeTimer = setInterval(() => {
    writeToFile();
  }, 10e3);

  const addMessage: XmlStreamController["addMessage"] = (message) => {
    if (hasCompleted) return;
    if (message.type === "comment") {
      danmaNum += 1;
      trackDanmaBucket(message);
    } else if (message.type === "super_chat") {
      scNum += 1;
    } else if (message.type === "guard") {
      guardNum += 1;
    }
    // PK 分数的选手昵称**不在这里登记**：消息体只带 uid / 分数，
    // 昵称一律由录制器在拿到后调用 `registerPkNickname` 显式登记
    // （来源：battle 消息 / 接口查询 / 昵称缓存命中）。
    // 但这里要记下「本场出现过哪些 uid」，供 flush 前补齐昵称用。
    if (message.type === "pk_score") {
      for (const player of message.players ?? []) {
        if (player?.uid) pkUidsSeen.add(player.uid);
      }
    }
    trackInteractedUser(message);
    data.pendingMessages.push(message);
  };

  /**
   * 登记一个 PK 选手的真实昵称（幂等）。
   *
   * 由录制器在拿到昵称后调用，`flush` 统一追加为 XML 末尾的映射表。
   * **这是 PK 昵称的唯一权威来源** —— XML 单向追加、无法回改，
   * XSL 渲染时统一查这张表翻译。
   */
  const registerPkNickname: XmlStreamController["registerPkNickname"] = (uid, nickname) => {
    if (hasCompleted || !uid || !nickname) return 0;
    const previous = pkUserNicknames.get(uid);
    pkUserNicknames.set(uid, nickname);
    return previous === nickname ? 0 : 1;
  };

  const setNicknameProvider: XmlStreamController["setNicknameProvider"] = (fn) => {
    nicknameProvider = fn;
  };

  const setMeta: XmlStreamController["setMeta"] = async (meta) => {
    if (hasCompleted) return;
    data.meta = {
      ...data.meta,
      ...meta,
    };
  };

  const flush: XmlStreamController["flush"] = async () => {
    if (hasCompleted) return;
    hasCompleted = true;
    writeTimer && clearInterval(writeTimer);

    try {
      await writeToFile(true);
    } catch (error) {
      console.error("完成XML文件写入失败:", error);
    }

    // flush 前补齐昵称：让录制器等待其「在途的昵称查询」并回读缓存结果。
    //
    // ⚠️ 必须**直接写 `pkUserNicknames`**，不能走 `registerPkNickname` —— 后者开头是
    //    `if (hasCompleted) return 0`，而 `hasCompleted` 在本函数第一行已置位，
    //    走那条路会被整体丢弃（这正是本改动要修的竞态）。此处与 `</i>` 各自独立 try，
    //    补齐失败绝不能影响映射表与闭合标签落盘。
    if (nicknameProvider && pkUidsSeen.size > 0) {
      try {
        const missing = [...pkUidsSeen].filter((uid) => !pkUserNicknames.has(uid));
        if (missing.length > 0) {
          const resolved = await nicknameProvider(missing);
          for (const [uid, nickname] of resolved) {
            // 已有值不覆盖：`pkUserNicknames` 里的值同源且更权威（如 battle）
            if (nickname && !pkUserNicknames.has(uid)) pkUserNicknames.set(uid, nickname);
          }
        }
      } catch (error) {
        console.error("flush 前补齐 PK 昵称失败:", error);
      }
    }

    // 映射表必须在闭合标签之前追加，且是纯追加 —— 不修改任何已落盘内容。
    // ⚠️ 与闭合标签**各自独立 try**：映射表写入失败绝不能阻止 `</i>` 落盘，
    // 否则整份 XML 缺闭合标签、XSL 预览全废（且 hasCompleted 已置位、无法重试）。
    try {
      await appendToXmlFile(savePath, buildPkUserMapXml(pkUserNicknames));
    } catch (error) {
      console.error("PK 昵称映射表写入失败:", error);
    }

    try {
      await appendToXmlFile(savePath, "</i>");
    } catch (error) {
      console.error("XML 闭合标签写入失败:", error);
    }

    // 清理内存
    data.pendingMessages = [];
    interactedUsers.clear();
    pkUserNicknames.clear();
    pkUidsSeen.clear();
    giftIcons.clear();
    userAvatars.clear();
    nicknameProvider = null;
    danmaNum = 0;
    scNum = 0;
    guardNum = 0;
  };

  return {
    data,
    addMessage,
    registerPkNickname,
    setNicknameProvider,
    setMeta,
    flush,
    getStats,
  };
}

/**
 * 生成XML内容片段。
 *
 * 除消息节点外，还会为**本批首次出现**的礼物/用户输出一行声明（`<gi>` / `<ui>`），
 * 图片地址因此不必逐条重复。调用方须在写盘成功后把返回的 `new*` 合并进传入的表，
 * 否则写盘失败重试时会漏掉声明行。
 */
function generateXmlContent(
  metadata: XmlStreamData["meta"],
  messages: Message[],
  giftIcons: Map<string, { name: string; uri: string }>,
  userAvatars: Map<string, string>,
): {
  xml: string;
  newGiftIcons: Map<string, { name: string; uri: string }>;
  newUserAvatars: Map<string, string>;
} {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@@",
    format: true,
  });

  const comments = messages
    .filter((item) => item.type === "comment")
    .map((ele) => {
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      const attrs = {
        "@@p": "",
        "@@progress": progress,
        "@@mode": String(ele.mode ?? 1),
        "@@fontsize": String(25),
        "@@color": String(parseInt((ele.color || "#ffffff").replace("#", ""), 16)),
        "@@midHash": String(ele?.sender?.uid),
        "#text": String(ele?.text || ""),
        "@@ctime": String(ele.timestamp),
        "@@pool": String(0),
        "@@weight": String(0),
        "@@user": String(ele.sender?.name),
        "@@uid": String(ele?.sender?.uid),
        "@@timestamp": String(ele.timestamp),
        "@@level": String(ele?.sender?.extra?.level ?? "0"),
        "@@club_level": String(ele?.sender?.extra?.clubLevel ?? "0"),
      };
      attrs["@@p"] = [
        attrs["@@progress"],
        attrs["@@mode"],
        attrs["@@fontsize"],
        attrs["@@color"],
        attrs["@@ctime"],
        attrs["@@pool"],
        attrs["@@midHash"],
        attrs["@@uid"],
        attrs["@@weight"],
      ].join(",");
      return pick(attrs, [
        "@@p",
        "#text",
        "@@user",
        "@@uid",
        "@@timestamp",
        "@@level",
        "@@club_level",
      ]);
    });

  // 本批首次出现的图标/头像声明。礼物图按 giftId 建表（礼物名不唯一），头像按 uid。
  const newGiftIcons = new Map<string, { name: string; uri: string }>();
  const newUserAvatars = new Map<string, string>();

  const gifts = messages
    .filter((item) => item.type === "give_gift")
    .map((ele) => {
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      const giftId = ele.giftId ?? "";
      const uid = String(ele?.sender?.uid ?? "");
      if (giftId && ele.imageUri && !giftIcons.has(giftId)) {
        newGiftIcons.set(giftId, { name: String(ele.name), uri: ele.imageUri });
      }
      if (uid && ele.sender?.avatar && !userAvatars.has(uid)) {
        newUserAvatars.set(uid, ele.sender.avatar);
      }
      return {
        "@@ts": progress,
        "@@giftname": String(ele.name),
        "@@giftcount": String(ele.count),
        "@@price": String(ele.price * 1000),
        "@@user": String(ele.sender?.name),
        "@@uid": uid,
        "@@timestamp": String(ele.timestamp),
        "@@level": String(ele?.sender?.extra?.level ?? "0"),
        "@@club_level": String(ele?.sender?.extra?.clubLevel ?? "0"),
        // 查图标表的键。礼物名不唯一（同名不同 giftId 的图也不同），只能靠 ID 查。
        ...(giftId ? { "@@giftid": giftId } : {}),
      };
    });

  const superChats = messages
    .filter((item) => item.type === "super_chat")
    .map((ele) => {
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      return {
        "@@ts": progress,
        "@@price": String(ele.price * 1000),
        "#text": String(ele.text),
        "@@user": String(ele.sender?.name),
        "@@uid": String(ele?.sender?.uid),
        "@@timestamp": String(ele.timestamp),
      };
    });

  const guardGift = messages
    .filter((item) => item.type === "guard")
    .map((ele) => {
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      return {
        "@@ts": progress,
        "@@price": String(ele.price * 1000),
        "@@giftname": String(ele.name),
        "@@giftcount": String(ele.count),
        "@@level": String(ele.level),
        "@@user": String(ele.sender?.name),
        "@@uid": String(ele?.sender?.uid),
        "@@timestamp": String(ele.timestamp),
      };
    });

  const pkScores = messages
    .filter((item) => item.type === "pk_score")
    .map((ele) => {
      // 与礼物/超赞等保持一致：ts 为距录制开始的相对秒数，便于表格阅读与排序
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      return {
        "@@timestamp": String(ele.timestamp),
        "@@ts": progress,
        // 单场 PK 标识。一场直播可打多场 PK，缺了它这些快照只能靠时间戳猜归属，
        // XSL 会把多场 PK 的比赛串成同一张表（见模板里按 battle_id 分组的那段）。
        // 缺省时不写该属性（与 player 的 team_* 处理一致）。
        ...(ele.battleId ? { "@@battle_id": ele.battleId } : {}),
        // 刻意不输出昵称：PK 分数消息本身不带昵称，`@nick` 只会是 uid 占位。
        // 昵称统一由末尾的 <pk_users> 映射表承载，XSL 渲染时按 @uid 查表翻译。
        player: ele.players.map((p) => ({
          "@@uid": String(p.uid),
          "@@score": String(p.score ?? "0"),
          "@@rank": String(p.rank ?? ""),
          // 仅在团队 PK 时输出 team_* 属性：非团队 PK 的 userScores 不含 team 字段，
          // 原写法会为每个 <player> 写出 team_score="" team_rank=""（约占文件 10-13%）。
          // 缺省时 XSL 会整列隐藏（模板里对应该列头的 z:if 判断），不会留下空列。
          ...(p.teamScore ? { "@@team_score": p.teamScore } : {}),
          ...(p.teamRank ? { "@@team_rank": p.teamRank } : {}),
        })),
      };
    });

  // 构建这一批消息的XML片段。声明行放在最前：同一批里的礼物在其声明之后出现，
  // 便于流式解析（XSL 用 key() 查表，本身不依赖顺序）。
  const fragment: Record<string, unknown> = {};
  if (newGiftIcons.size > 0) {
    fragment.gi = [...newGiftIcons].map(([id, e]) => ({ "@@i": id, "@@n": e.name, "@@u": e.uri }));
  }
  if (newUserAvatars.size > 0) {
    fragment.ui = [...newUserAvatars].map(([uid, uri]) => ({ "@@i": uid, "@@p": uri }));
  }
  Object.assign(fragment, {
    d: comments,
    gift: gifts,
    sc: superChats,
    guard: guardGift,
    pk: pkScores,
  });

  return { xml: builder.build(fragment), newGiftIcons, newUserAvatars };
}

/**
 * 序列化 PK 选手 uid -> 昵称 的映射表。
 *
 * 只输出真正拿到昵称的条目（`nick` 非空且 `nick !== uid`），没有昵称的选手（接口查不到、
 * battle 未送达）不写入，XSL 渲染时会退回显示 uid 本身。
 *
 * 手工拼接而非走 XMLBuilder：这张表位于文件末尾、需要与既有格式完全一致的
 * 缩进风格，且条目数很少（一场 PK 通常 2-8 人）。
 */
function buildPkUserMapXml(pkUserNicknames: Map<string, string>): string {
  const entries = [...pkUserNicknames.entries()].filter(([uid, nick]) => nick && nick !== uid);
  if (entries.length === 0) return "";

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@@",
    format: true,
  });
  return builder.build({
    pk_users: {
      user: entries.map(([uid, nick]) => ({ "@@uid": uid, "@@nick": nick })),
    },
  });
}

/**
 * 追加内容到XML文件
 */
async function appendToXmlFile(filePath: string, content: string): Promise<void> {
  try {
    // 直接追加内容
    await fs.promises.appendFile(filePath, content);
  } catch (error) {
    console.error(`写入XML文件失败: ${filePath}`, error);
    throw error;
  }
}

function generateMetadataXml(metadata: XmlStreamData["meta"]): string {
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@@",
    format: true,
  });

  return builder.build({
    metadata: {
      platform: metadata.platform,
      video_start_time: metadata.recordStartTimestamp,
      live_start_time: metadata.liveStartTimestamp,
      room_title: metadata.title,
      user_name: metadata.user_name,
      room_id: metadata.room_id,
    },
  });
}
