/**
 * XML流式写入控制器，用于实时写入弹幕、礼物等信息到XML文件
 * 相比原有的json方案，这个实现每隔10秒就会写入数据，减少内存占用和数据丢失风险
 */
import fs from "node:fs";
import { XMLBuilder } from "fast-xml-parser";
import { pick } from "lodash-es";

import { Message } from "./common.js";

const METADATA_PLACEHOLDER = "<!--METADATA_PLACEHOLDER-->";
// 礼物表 5 个 <img> 与贡献榜首列头像共用的属性（贡献榜复用它，保持表内图标等高）。
// onerror 只移除自身：单元格仍在（列不会错位），但不留破图，
// 也不会重复发请求。内联 onerror 与下方弹幕表那段 <script> 同属 inline script，
// 因此没有引入新的依赖类别 —— 若哪天被 CSP 拦掉，先崩的是弹幕「出现时间/用户ID」两列。
// 必须用反引号：prettier 的 singleQuote:false 会把单引号改写成双引号，属性里的引号就要转义。
const GIFT_IMG_ATTRS = `height="24" loading="lazy" decoding="async" onerror="this.remove()"`;
// 礼物表的「头像」「图标」两列按文档内容条件渲染：判据 `/i/gift[@a]`（该场是否写过任何头像）与
// `/i/gi`（是否写过任何图标声明）。关掉 saveGiftAvatar / saveGiftIcon 时对应属性/节点整场不存在，
// 两列随之消失，而不是留下两列全空的格子。
// ⚠️ 每个 `<th>` 与它对应的 `<td>` **必须用同一个判据**：只包住 th 会让表头 7 列、行 9 列而错位。
// 判据用文档级路径而不是当前节点（`@a`/`key(...)`），因为 XSLT 在浏览器打开时才对完整文档求值，
// 与录制过程中的批次顺序无关。
// ⚠️ 判据必须先算成模板顶部的 `$hasAv` / `$hasGi` 两个变量：`<td>` 在 `<z:for-each>` 内，
// 若直接写 `test="/i/gift[@a]"`，每渲染一行都要把整份文档的 gift 节点重扫一遍（O(n²)）。
// 实测 3000 条礼物：直接写耗时 11.7 s，提升为变量后 4.1 s，与不加条件（3.9 s）持平。
//
// `webcast/` 前缀**不走** p3-webcast 的 `~tplv-obj.image` —— 那是原图（头像 282×282 38,986 B、
// 礼物图标 168–280 px 16–109 KB，实测一份产物 20 个图标合计 1,008,999 B），而显示区只有 24 px。
// 改拼 p11 的 `aweme/100x100/` 段（uri 自带 `.png`，不再补后缀）：头像 3,483 B（CDN 转 JPEG，11.2×），
// 图标 10,000 B 上下（源带 alpha 时 CDN 返回 PNG，透明保留，合计 116,254 B，8.7×）。二者均实测 200。
// ⚠️ 别把 100x100 段加到已带尺寸段的 uri 前面（`100x100/aweme-avatar/…` 会 403），那是 otherwise 分支的事。
//
// 🎨 **头像**与**图标**的 `webcast/` 分支故意走不同 CDN，原因是透明通道：
// 礼物图标源图 20/20 是 RGBA（透明像素 37%–80%），p11 的 100x100 会把其中 15 个转成 JPEG
// —— JPEG 没有 alpha，透明区被填成**纯黑方块**，在表格里非常显眼。
// 所以图标走 p3 的 `~tplv-obj.webp`：实测 20/20 保留 alpha，合计 174,252 B（比原图 1,008,999 B 小 5.8×）。
// 头像不受影响 —— 源图是调色板且无 tRNS（本来就不透明），用 p11 只要 3,483 B，webp 要 12,666 B。
//
// ⚠️ `~tplv-obj.<ext>` 只决定**输出格式**，不缩放：`.png` 返回的是与 `.image` 字节级相同的原图
// （md5 一致），`.webp` / `.jpeg` 也只是换编码、像素仍是原尺寸。真正能缩的只有路径里的尺寸段。
const XML_FILE_HEADER = `<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xsl" href="#s"?>\n<i>\n${METADATA_PLACEHOLDER}\n<RecorderXmlStyle><z:stylesheet version="1.0" id="s" xml:id="s" xmlns:z="http://www.w3.org/1999/XSL/Transform"><z:output method="html"/><z:key name="pkByBattle" match="pk" use="@battle_id"/><z:key name="giById" match="gi" use="concat(@i,'|',@n)"/><z:key name="giftAvatarByUser" match="gift[@a]" use="concat(@uid,'|',@user)"/><z:key name="rankUser" match="rank_users/user" use="concat(@uid,'|',@nick)"/><z:template match="/"><z:variable name="hasAv" select="count(/i/gift[@a]) &gt; 0"/><z:variable name="hasGi" select="count(/i/gi) &gt; 0"/><z:variable name="hasRankUser" select="count(/i/rank_users) &gt; 0"/><html><meta name="viewport" content="width=device-width"/><title>弹幕文件 <z:value-of select="/i/metadata/user_name/text()"/></title><style>body{margin:0}h1,h2,p,table{margin-left:5px}table{border-spacing:0}td,th{border:1px solid grey;padding:1px 5px}th{position:sticky;top:0;background:#4098de}summary{cursor:pointer;font-weight:bold}tr:hover{background:#d9f4ff}div{overflow:auto;max-height:80vh;max-width:100vw;width:fit-content}</style><h1>弹幕XML文件</h1><p>本文件不支持在 IE 浏览器里预览，请使用 Chrome Firefox Edge 等浏览器。</p><p>文件用法参考文档 <a href="https://rec.danmuji.org/user/danmaku/">https://rec.danmuji.org/user/danmaku/</a></p><table><tr><td>房间号</td><td><z:value-of select="/i/metadata/room_id/text()"/></td></tr><tr><td>主播名</td><td><z:value-of select="/i/metadata/user_name/text()"/></td></tr><tr><td><a href="#d">弹幕</a></td><td>共<z:value-of select="count(/i/d)"/>条记录</td></tr><z:if test="/i/guard"><tr><td><a href="#guard">上船</a></td><td>共<z:value-of select="count(/i/guard)"/>条记录</td></tr></z:if><z:if test="/i/sc"><tr><td><a href="#sc">SC</a></td><td>共<z:value-of select="count(/i/sc)"/>条记录</td></tr></z:if><z:if test="/i/gift"><tr><td><a href="#gift">礼物</a></td><td>共<z:value-of select="count(/i/gift)"/>条记录</td></tr></z:if><z:if test="/i/room"><tr><td><a href="#room">在线人数</a></td><td>共<z:value-of select="count(/i/room)"/>条记录</td></tr></z:if><z:if test="/i/rank"><tr><td><a href="#rank">贡献榜</a></td><td>共<z:value-of select="count(/i/rank)"/>次变化</td></tr></z:if><z:if test="/i/pk"><tr><td><a href="#pk">PK</a></td><td>共<z:value-of select="count(/i/pk)"/>条记录</td></tr></z:if></table><h2 id="d">弹幕</h2><div id="dm"><table><tr><th>用户名</th><th>出现时间</th><th>用户ID</th><th>弹幕</th><th>等级</th><th>粉丝团</th><th>参数</th></tr><z:for-each select="/i/d"><tr><td><z:value-of select="@user"/></td><td></td><td></td><td><z:value-of select="."/></td><td><z:value-of select="@level"/></td><td><z:value-of select="@club_level"/></td><td><z:value-of select="@p"/></td></tr></z:for-each></table></div><script>Array.from(document.querySelectorAll('#dm tr')).slice(1).map(t=>t.querySelectorAll('td')).forEach(t=>{let p=t[6].textContent.split(','),a=p[0];t[1].textContent=\`\u0024{(Math.floor(a/60/60)+'').padStart(2,0)}:\u0024{(Math.floor(a/60%60)+'').padStart(2,0)}:\u0024{(a%60).toFixed(3).padStart(6,0)}\`;t[2].innerHTML=\`&lt;a target=_blank rel="nofollow noreferrer" "&gt;\u0024{p[6]}&lt;/a&gt;\`})</script><z:if test="/i/guard"><h2 id="guard">舰长购买</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>舰长等级</th><th>购买数量</th><th>出现时间</th></tr><z:for-each select="/i/guard"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text></z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="@level"/></td><td><z:value-of select="@count"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div></z:if><z:if test="/i/sc"><h2 id="sc">SuperChat 醒目留言</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>内容</th><th>显示时长</th><th>价格</th><th>出现时间</th></tr><z:for-each select="/i/sc"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text></z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="."/></td><td><z:value-of select="@time"/></td><td><z:value-of select="@price"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div></z:if><z:if test="/i/gift"><h2 id="gift">礼物</h2><div><table><tr><z:if test="$hasAv"><th>头像</th></z:if><th>用户名</th><th>用户ID</th><z:if test="$hasGi"><th>图标</th></z:if><th>礼物名</th><th>礼物数量</th><th>出现时间</th><th>等级</th><th>粉丝团</th></tr><z:for-each select="/i/gift"><tr><z:if test="$hasAv"><td><z:variable name="av" select="key('giftAvatarByUser',concat(@uid,'|',@user))[1]/@a"/><z:if test="string($av)"><z:choose><z:when test="starts-with($av,'webcast/')"><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/100x100/{$av}"/></z:when><z:when test="starts-with($av,'aweme-avatar/')"><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/100x100/{$av}.jpeg"/></z:when><z:otherwise><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/{$av}.jpeg"/></z:otherwise></z:choose></z:if></td></z:if><td><z:value-of select="@user"/></td><td><span rel="nofollow noreferrer"><z:attribute name="href"></z:attribute><z:value-of select="@uid"/></span></td><z:if test="$hasGi"><td><z:variable name="gu" select="key('giById',concat(@giftid,'|',@giftname))/@u"/><z:if test="string($gu)"><z:choose><z:when test="starts-with($gu,'webcast/')"><img ${GIFT_IMG_ATTRS} src="https://p3-webcast.douyinpic.com/img/{$gu}~tplv-obj.webp"/></z:when><z:otherwise><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/{$gu}.jpeg"/></z:otherwise></z:choose></z:if></td></z:if><td><z:value-of select="@giftname"/></td><td><z:value-of select="@giftcount"/></td><td><z:value-of select="@ts"/></td><td><z:value-of select="@level"/></td><td><z:value-of select="@club_level"/></td></tr></z:for-each></table></div></z:if><z:if test="/i/room"><h2 id="room">在线人数</h2><div><details><summary>采样明细（<z:value-of select="count(/i/room)"/> 点，只记变化）</summary><table><tr><th>时间</th><th>在线人数</th></tr><z:for-each select="/i/room"><tr><td><z:value-of select="@ts"/></td><td><z:value-of select="@online"/></td></tr></z:for-each></table></details></div></z:if><z:if test="/i/rank"><h2 id="rank">贡献榜</h2><div><table><tr><th>名次</th><z:if test="$hasRankUser"><th>头像</th></z:if><th>昵称</th></tr><z:for-each select="/i/rank[last()]/u"><tr><td><z:value-of select="position()"/></td><z:if test="$hasRankUser"><td><z:variable name="ra" select="key('rankUser',concat(@uid,'|',@nick))/@a"/><z:if test="string($ra)"><z:choose><z:when test="starts-with($ra,'webcast/')"><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/100x100/{$ra}"/></z:when><z:when test="starts-with($ra,'aweme-avatar/')"><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/100x100/{$ra}.jpeg"/></z:when><z:otherwise><img ${GIFT_IMG_ATTRS} src="https://p11.douyinpic.com/aweme/{$ra}.jpeg"/></z:otherwise></z:choose></z:if></td></z:if><td><z:variable name="rn" select="key('rankUser',concat(@uid,'|',@nick))/@nick"/><z:choose><z:when test="string($rn)"><z:value-of select="$rn"/></z:when><z:otherwise><z:value-of select="@uid"/></z:otherwise></z:choose></td></tr></z:for-each></table></div><div><details><summary>变化记录（<z:value-of select="count(/i/rank)"/> 次，只记换人与名次互换）</summary><table><tr><th>时间</th><th>前三名</th></tr><z:for-each select="/i/rank"><tr><td><z:value-of select="@ts"/></td><td><z:for-each select="u"><z:if test="position() &gt; 1"><z:text> &gt; </z:text></z:if><z:variable name="hn" select="key('rankUser',concat(@uid,'|',@nick))/@nick"/><z:choose><z:when test="string($hn)"><z:value-of select="$hn"/></z:when><z:otherwise><z:value-of select="@uid"/></z:otherwise></z:choose></z:for-each></td></tr></z:for-each></table></details></div></z:if><z:if test="/i/pk"><h2 id="pk">PK分数</h2><z:for-each select="/i/pk[generate-id()=generate-id(key('pkByBattle',@battle_id)[1])]"><details><summary>PK 场次 <z:value-of select="position()"/><z:if test="@battle_id"><z:text>（battle_id </z:text><z:value-of select="@battle_id"/><z:text>）</z:text></z:if></summary><div><table><tr><th>PK时间</th><th>主播</th><th>主播ID</th><th>分数</th><th>排名</th><z:if test="player/@team_rank"><th>团队分数</th><th>团队排名</th></z:if></tr><z:for-each select="key('pkByBattle',@battle_id)"><z:for-each select="player"><z:variable name="pkUid" select="@uid"/><tr><td><z:if test="position()=1"><z:value-of select="../@ts"/></z:if></td><td><z:choose><z:when test="/i/pk_users/user[@uid=$pkUid]"><z:value-of select="/i/pk_users/user[@uid=$pkUid]/@nick"/></z:when><z:otherwise><z:value-of select="@uid"/></z:otherwise></z:choose></td><td><z:value-of select="@uid"/></td><td><z:value-of select="@score"/></td><td><z:value-of select="@rank"/></td><z:if test="../player/@team_rank"><td><z:value-of select="@team_score"/></td><td><z:value-of select="@team_rank"/></td></z:if></tr></z:for-each></z:for-each></table></div></details></z:for-each></z:if><z:if test="/i/pk_users"><h2 id="pk_users">PK选手</h2><div id="pk_users_div"><table><tr><th>主播ID</th><th>主播昵称</th></tr><z:for-each select="/i/pk_users/user"><tr><td><z:value-of select="@uid"/></td><td><z:value-of select="@nick"/></td></tr></z:for-each></table></div></z:if></html></z:template></z:stylesheet></RecorderXmlStyle>\n`;
const DANMA_STATS_INTERVAL = 10;

/** 礼物图标表的一行。键的构成见 {@link giftIconKey}。 */
interface GiftIconEntry {
  /**
   * 键由 `(giftId, name)` 拼成，故 id 必须随 entry 一起存 —— 输出 `<gi i=…>` 时不用再从键里拆。
   * 同一 giftId 可能出现多行（不同礼物名各一行），所以 `i` 在表内**不唯一**。
   */
  giftId: string;
  name: string;
  uri: string;
}

/**
 * 贡献榜成员的首见表项。键是 `(uid, 昵称)`，见 {@link avatarKey}。
 *
 * 只存「这个人是谁」，不存名次 —— 名次是快照属性，由 `<rank>` 里 `<u>` 的先后顺序表达。
 *
 * ⚠️ 键必须含昵称，不能只用 uid：匿名占位 uid `111111` 会被多个互不相干的身份共用
 * （实测同一份录制里 3 个昵称共用它），只用 uid 会让榜上多个匿名成员共用一条定义，
 * 经 `key()` 反查后全部显示成第一个人的头像昵称。与 `giftAvatarByUser` 同一取舍。
 *
 * 代价是「改名」会多一条定义而不是覆盖旧值：历史行仍显示当时的昵称（那次快照里他确实叫那个名字），
 * 新行显示新昵称。这比「冻结首见昵称」更接近事实，也是匿名场景能正确显示的前提。
 */
interface RankUserEntry {
  /** 键是拼出来的串，输出 `<user uid>` 时不用再从键里拆 */
  uid: string;
  nick: string;
  avatarUri?: string;
}

/**
 * 礼物图标表的键 = `(giftId, 礼物名)`。
 *
 * 只用 giftId **不够**，实测两个方向都不是 1:1：
 * - 同一 giftId → 多个礼物名：`685` 同时是 粉丝团灯牌 / 点点星光 / 闪烁星河；
 * - 同一礼物名 → 多个 giftId：`点亮粉丝团` 对应 6937 / 6938 / 6939，且三张图标各不相同。
 *
 * 单用 id 会让前一种情况的取首见图，单用名字会让后一种情况显示错图，所以两个都要。
 *
 * 拼接无歧义：`giftId` 是纯数字（proto 里是整型），不含分隔符 `|`，
 * 故任意两组不同的 `(id, name)` 拼出的键必不相同，`@n` 是否含 `|` 都不影响这一点。
 *
 * `giftId` 为空时键退化成 `|礼物名`，首段仍不含 `|`，与任何数字 id 的键都不相等。
 * 所以**不能**因为「没有 id」就跳过建表 —— 那会让有图却查不到的礼物静默丢掉图标。
 * 这是降级不是等价：空 id 的产物在该礼物名上失去同名区分能力（同名不同 id 共用首见图）。
 * 实测 4 份产物 0 命中 —— 抖音正常都下发该字段，此路只在字段缺失时兜底。
 *
 * ⚠️ XSL 侧用 `concat(@i,'|',@n)` 复现同一个键（见 `XML_FILE_HEADER` 的 `giById`），
 * 两侧必须同步改；只改一侧时 `key()` 返回空集，图标会**静默全部消失**，不报错。
 */
const giftIconKey = (giftId: string, name: string) => `${giftId}|${name}`;

/**
 * 「用户身份」复合键 = `(uid, 昵称)`，礼物头像表与贡献榜成员表共用。
 *
 * 只用 uid **不够**：抖音存在匿名占位 uid `111111`，多个互不相干的匿名身份共用它。
 * 实测一份录制里 `dou7702128` / `神秘人397543` / `dou1669765` 三个昵称共用 `111111`，
 * 若按 uid 去重，只有首条会写 `@a`，其余身份经 XSL 反查后全部显示成同一个人的头像
 * （张冠李戴）。昵称各不相同，故必须并入键。普通用户 uid 唯一，此键与单用 uid 等价，
 * 去重效果与文件体积不变。
 *
 * 拼接无歧义：uid 是纯数字，不含分隔符 `|`，故第一段永远是 uid，昵称里有没有 `|` 都不影响。
 *
 * ⚠️ XSL 侧必须用同名属性复现同一个键，两侧必须同步改；只改一侧时 `key()` 返回空集，
 * 结果**静默消失**（头像全没 / 昵称退回 uid），不报错：
 * - 礼物头像：`<gift @uid @user>` → `concat(@uid,'|',@user)`（`giftAvatarByUser`）；
 * - 贡献榜：`<u @uid @nick>` → `concat(@uid,'|',@nick)`（`rankUser`）。
 */
const avatarKey = (uid: string, name: string) => `${uid}|${name}`;

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
   * 礼物图标首见表：`giftIconKey(giftId, 礼物名)` -> 表项。
   *
   * 一条礼物消息约 145 字符的图标/头像地址，而全场礼物往往只有几十种，
   * 逐条写会把文件撑大数倍（实测 1017 条礼物：逐条 141 KB，建表后 57 KB）。
   * 故改为「某对 (giftId, 礼物名) 第一次出现时插入一行 `<gi>` 声明」，XSL 用 `key()` 查回。
   * 键为什么不是 giftId 单独一个，见 `giftIconKey`。
   *
   * 与 `<pk_users>` 不同，声明是**就地**写的而非集中到末尾：体积相同，但崩溃中断时
   * 已写部分不会丢，流式解析也不需要读完整文件。
   */
  const giftIcons = new Map<string, GiftIconEntry>();
  /** 用户头像首见表：`avatarKey(uid, 昵称)` -> 相对路径。键为什么不是 uid 单独一个，见 `avatarKey`。
   * 只用于判断「本场是否已写过」，头像本身就地写在首见礼物的 `@a` 上，不另建 `<ui>` 表。 */
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
    // PK 分数、在线人数、贡献榜都不是「用户发言」，消息体里没有 sender
    if (
      message.type === "pk_score" ||
      message.type === "room_stats" ||
      message.type === "room_rank"
    )
      return;
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

  /**
   * 最近一次写进 XML 的在线人数。用于「只记变化」：值没变就不写 `<room>` 节点。
   *
   * `roomStats` 约 0.6 秒一条，逐条写会让文件膨胀（折算约 5700 条/小时）；
   * 实测活跃直播间人数约每 2 秒才变一次，去重后降到约 1700 条/小时。
   * 只在**写盘成功后**推进 —— 写失败时消息会退回重试，此时若已更新，
   * 重试那批会因「值没变」而漏掉节点。
   */
  let lastOnline: string | null = null;

  /**
   * 最近一次写进 XML 的贡献榜，键是**保序**的前三名的 `(uid, 昵称)` 序列。
   *
   * 这条消息是「状态广播」而非事件：实测 30 秒收到 21 条，其中只有 3 个不同 msgId，
   * 而这 3 个 payload 逐字相同（只差 `msgId`/`createTime`）；上一轮另一次 68 条全是同一个 msgId。
   * ⇒ 既不能按 `msgId` 去重（内容没变服务端也会换新 id），也不能按到达次数。
   *
   * ⛔ 键必须是**有序**的：排序之后「A>B>C」与「B>A>C」会算成同一个键，
   * **名次互换就被吃掉了** —— 这类错不会报错，只有比对历史才发现少了一条。
   *
   * ⛔ 元素必须是 `(uid, 昵称)` 而不是单个 uid：两个匿名成员共用 `111111` 时，
   * 只看 uid 的键是 `111111|111111`，**他们互换名次也算「没变」**，这次变化被静默吞掉。
   *
   * 与 `lastOnline` 同一约定：只在**写盘成功后**推进。
   */
  let lastRank: string | null = null;
  /**
   * 贡献榜成员首见表：`(uid, 昵称)` -> 昵称/头像。与 `<gi>` 同一思路，只在首次出现时声明一行。
   * 键的口径见 {@link avatarKey}（含昵称是匿名 uid 逼出来的，不是冗余）。
   */
  const rankUsers = new Map<string, RankUserEntry>();

  const writeToFile = async (force = false): Promise<void> => {
    if (!force && data.pendingMessages.length === 0) {
      return Promise.resolve();
    }

    const messagesToWrite = [...data.pendingMessages];
    data.pendingMessages = [];

    try {
      const { xml, newGiftIcons, newUserAvatars, newLastOnline, newLastRank, newRankUsers } =
        generateXmlContent(
          data.meta,
          messagesToWrite,
          giftIcons,
          userAvatars,
          lastOnline,
          lastRank,
          rankUsers,
        );
      if (!hasPersistedHeader) {
        await initializeFile(xml);
      } else if (xml) {
        await appendToXmlFile(savePath, xml);
      }
      lastOnline = newLastOnline;
      lastRank = newLastRank;
      // 首见表项只在**写盘成功后**提交：写失败时消息会退回 pendingMessages 重试，
      // 若此时已记进表，重试那次就会认为「已声明过」而漏掉声明行。
      for (const [iconKey, entry] of newGiftIcons) giftIcons.set(iconKey, entry);
      for (const [userKey, uri] of newUserAvatars) userAvatars.set(userKey, uri);
      for (const [userKey, entry] of newRankUsers) rankUsers.set(userKey, entry);
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
    lastOnline = null;
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
 * 在线人数（`room_stats`）**只写值发生变化的那一条**：`messages` 里每条都与
 * `lastOnline` 比对，相同则跳过。返回值里的 `newLastOnline` 由调用方在写盘
 * 成功后写回控制器状态。
 *
 * 贡献榜（`room_rank`）同理，但键是**保序的 (uid, 昵称) 序列**而不是单个值 —— 详见控制器里 `lastRank` 的注释。
 *
 * 除消息节点外，还会为**本批首次出现**的礼物图标输出一行 `<gi>` 声明、
 * 为贡献榜成员输出一行 `<rank_users>` 声明，地址因此不必逐条重复；
 * 头像是就地写在「该 (uid, 昵称) 首个带头像的礼物」的 `@a` 上。
 * 调用方须在写盘成功后把返回的 `new*` 合并进传入的表，否则写盘失败重试时会漏掉声明。
 */
function generateXmlContent(
  metadata: XmlStreamData["meta"],
  messages: Message[],
  giftIcons: Map<string, GiftIconEntry>,
  userAvatars: Map<string, string>,
  lastOnline: string | null,
  lastRank: string | null,
  rankUsers: Map<string, RankUserEntry>,
): {
  xml: string;
  newGiftIcons: Map<string, GiftIconEntry>;
  newUserAvatars: Map<string, string>;
  newLastOnline: string | null;
  newLastRank: string | null;
  newRankUsers: Map<string, RankUserEntry>;
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

  // 本批首次出现的图标声明与头像首见记录。礼物图按 (giftId, 礼物名) 建表，头像按 (uid, 昵称)。
  const newGiftIcons = new Map<string, GiftIconEntry>();
  const newUserAvatars = new Map<string, string>();

  const gifts = messages
    .filter((item) => item.type === "give_gift")
    .map((ele) => {
      const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
      const giftId = ele.giftId ?? "";
      const giftName = String(ele.name);
      const uid = String(ele?.sender?.uid ?? "");
      // 与 `@@user` 必须同源：XSL 用 `@user` 参与拼键，两边取值不一致就查不到头像。
      const userName = String(ele.sender?.name);
      const iconKey = giftIconKey(giftId, giftName);
      // 「首见」要同时判两张表：`giftIcons` 是跨批已提交的，`newGiftIcons` 是本批的。
      // 只判前者时，同一批（10 秒窗口）内同一键第二次出现会覆盖首见图，
      // 是否取到首见就成了 flush 时机的隐式结果。
      // 不按 giftId 是否为空分流：空 id 的键是 `|礼物名`，天然与数字 id 的键不撞（见 giftIconKey）。
      if (ele.imageUri && !giftIcons.has(iconKey) && !newGiftIcons.has(iconKey)) {
        newGiftIcons.set(iconKey, { giftId, name: giftName, uri: ele.imageUri });
      }
      // 头像就地写在「该 (uid, 昵称) 首个带头像的礼物」上，不另建 `<ui>` 表：表项要把 uid 与
      // `<ui i="" p=""></ui>` 骨架再写一遍（约 39 B/行），而 uid 在这条礼物上本来就有。
      // 实测 2175 条礼物 / 1791 个用户，建表反而比逐条多占 9.9 KB、比就地写多占 49 KB。
      const userKey = uid ? avatarKey(uid, userName) : "";
      // XSL 用 `key('giftAvatarByUser',concat(@uid,'|',@user))[1]` 反查首见，见 `XML_FILE_HEADER`。
      let avatar = "";
      if (
        userKey &&
        ele.sender?.avatar &&
        !userAvatars.has(userKey) &&
        !newUserAvatars.has(userKey)
      ) {
        newUserAvatars.set(userKey, ele.sender.avatar);
        avatar = ele.sender.avatar;
      }
      return {
        "@@ts": progress,
        "@@giftname": giftName,
        "@@giftcount": String(ele.count),
        "@@price": String(ele.price * 1000),
        "@@user": userName,
        "@@uid": uid,
        "@@timestamp": String(ele.timestamp),
        "@@level": String(ele?.sender?.extra?.level ?? "0"),
        "@@club_level": String(ele?.sender?.extra?.clubLevel ?? "0"),
        // 查图标表的键由 giftid 与 giftname 共同拼成（见 giftIconKey），缺 giftid 就退回「只按名字」，
        // 同名不同 id 会串图 —— 所以有值时一定要写。为空（wire 里没这个字段）才省掉这两个字节：
        // XPath 里不存在的属性按空串参与 concat，键仍是 `|礼物名`，与声明行的 `<gi i="">` 对得上。
        ...(giftId ? { "@@giftid": giftId } : {}),
        // 头像只在首见那条上出现，XSL 按 (uid, 昵称) 反查（不是逐条都写）。
        ...(avatar ? { "@@a": avatar } : {}),
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

  // 在线人数：**只保留值发生变化的那一条**（其余丢弃，不进 XML）。
  // 首个采样点总是写（lastOnline 为 null 时任何值都算变化），作为曲线起点。
  const roomStats: Array<{ "@@ts": number; "@@online": string }> = [];
  let newLastOnline = lastOnline;
  const roomMessages = messages.filter((item) => item.type === "room_stats");
  for (const ele of roomMessages) {
    if (ele.online === newLastOnline) continue;
    const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
    roomStats.push({ "@@ts": progress, "@@online": ele.online });
    newLastOnline = ele.online;
  }

  // 贡献榜：**只写「换人」或「名次互换」的那一次**，键是保序的 (uid, 昵称) 序列
  // （见控制器 `lastRank`）。同内容重推（服务端按 ~1.4 s 节拍广播）在这里被吃光；
  // 首个快照总是写（lastRank 为 null）。
  const rankSnapshots: Array<{
    "@@ts": number;
    u: Array<{ "@@uid": string; "@@nick"?: string }>;
  }> = [];
  const newRankUsers = new Map<string, RankUserEntry>();
  let newLastRank = lastRank;
  for (const ele of messages) {
    if (ele.type !== "room_rank") continue;
    // 用 JSON 而不是 `join("|")`：昵称是用户可控的，`|` 既可能出现在昵称里、
    // 又是 `avatarKey` 的内部隔符，拼串会造出「不同快照 = 同一键」的假相等。
    const key = JSON.stringify(ele.users.map((user) => [user.uid, user.nick]));
    if (key === newLastRank) continue;
    newLastRank = key;
    const progress = Math.max((ele.timestamp - metadata.recordStartTimestamp) / 1000, 0);
    rankSnapshots.push({
      "@@ts": progress,
      u: ele.users.map((user) => {
        // 首见才登记进 `<rank_users>`：判据同时要看跨批已提交的 `rankUsers` 与本批的 `newRankUsers`，
        // 只判前者时同一批里同一 (uid, 昵称) 第二次出现会重复声明（与 giftIcons 同一原因）。
        const userKey = avatarKey(user.uid, user.nick);
        if (!rankUsers.has(userKey) && !newRankUsers.has(userKey)) {
          newRankUsers.set(userKey, {
            uid: user.uid,
            nick: user.nick,
            avatarUri: user.avatarUri,
          });
        }
        // ⚠️ `@nick` 是 XSL 侧 `rankUser` 键的组成部分（`concat(@uid,'|',@nick)`），
        // 删掉会让昵称全部退回 uid、头像全部消失 —— 与 `<gi @n>` 同一性质的活字段。
        return { "@@uid": user.uid, ...(user.nick ? { "@@nick": user.nick } : {}) };
      }),
    });
  }

  // 构建这一批消息的XML片段。声明行放在最前：同一批里的礼物在其声明之后出现，
  // 便于流式解析（XSL 用 key() 查表，本身不依赖顺序）。
  const fragment: Record<string, unknown> = {};
  if (newGiftIcons.size > 0) {
    // `i` 取 entry 而非 Map 的键：键是拼出来的，且同一 giftId 可能有多行（不同礼物名各一行）。
    // ⚠️ `n` 是 XSL 侧 key 的组成部分（`concat(@i,'|',@n)`），删掉会让图标全部消失，不是死字段。
    fragment.gi = [...newGiftIcons].map(([, e]) => ({
      "@@i": e.giftId,
      "@@n": e.name,
      "@@u": e.uri,
    }));
  }
  if (newRankUsers.size > 0) {
    // 与 `<gi>` 一样**就地**声明（不学 `<pk_users>` 集中到文件末尾）：崩溃中断时已写的部分不会丢。
    // `uid` 取 entry 而非 Map 的键：键是 `uid|昵称` 拼出来的，不能反解。
    // `nick`/`a` 缺省时整个属性省掉，与 `<u>` 的省略规则**必须一致**（两侧 concat 才拼出同一个键），
    // 昵称缺失时 XSL 退回显示 uid。
    fragment.rank_users = {
      user: [...newRankUsers.values()].map((entry) => ({
        "@@uid": entry.uid,
        ...(entry.nick ? { "@@nick": entry.nick } : {}),
        ...(entry.avatarUri ? { "@@a": entry.avatarUri } : {}),
      })),
    };
  }
  Object.assign(fragment, {
    d: comments,
    gift: gifts,
    sc: superChats,
    guard: guardGift,
    pk: pkScores,
  });
  // 空数组会让 XMLBuilder 写出空的 <room/>，显式只在有采样点时挂上去
  if (roomStats.length > 0) {
    fragment.room = roomStats;
  }
  if (rankSnapshots.length > 0) {
    fragment.rank = rankSnapshots;
  }

  return {
    xml: builder.build(fragment),
    newGiftIcons,
    newUserAvatars,
    newLastOnline,
    newLastRank,
    newRankUsers,
  };
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
