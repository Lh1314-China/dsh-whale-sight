# Changelog

## 0.10.1（2026-11-17）

声音事件不再被转写开关连带关掉。

- `transcript: false` 时，音轨照样抽出来跑 AudioSet 标注；以前这条分支在 `wantTranscript`
  里，关转写就等于关耳朵。
- 抽成 `tagAudioEvents()` 复用两处（转写开/关），临时目录与 TMPDIR 处理保持一致。
- 真机：`BV1t34y1Q71T`（3:45 的短片）`transcript: false` 下输出
  `<audio_events ...>0.0-10.0s: Whale …`——模型第一耳朵就听出「鲸」。

## 0.10.0（2026-11-17）

登录态 + 下载完整性，两条一起补。

- **`bilibiliCookie` / `bilibiliCookieFile`**：可直接给 Cookie 字符串，或指向本机凭据 JSON
  （`sessdata`/`bili_jct`/`buvid3`/`dedeuserid` 小写键），运行时读成 Cookie 头，不落进配置明文。
  有登录态时请求 `bilibiliQuality`（默认 80 = 1080P），无登录态自动降到 64（720P）。
- `bilibiliMaxHeight`（默认 1080）控制选流高度上限。
- **Content-Length 比对**：curl 用 `-D` 存响应头，下载后比对服务器声明大小与实际字节数，
  不一致直接报 `download truncated`；`.headers` 临时文件在 finally 删除。
- 测试 50 条（新增 cookie 解析 4 条、Content-Length 解析 2 条）。
- 真机：凭据文件指向 `bili-duty\bili_credential.json`，`BV1t34y1Q71T` 下载 **149.14 MB /
  1920x1080 / 224s**，`watch_video` 读出 6 帧、grid/frames 两布局都过。

## 0.9.2（2026-11-17）

真会话抓到的坑：`No usable temporary directory found`。

- 原因：宿主进程里 python 子进程沿用的 TEMP/TMP 不可写，`tempfile` 找不到目录；
  smoke 当时 TEMP 指向 workspace，所以没暴露。
- 修：spawn tagger 前显式把 `TMPDIR`/`TEMP`/`TMP` 指到 `audioTagTmpDir`
  （默认 `hfHome\tmp`，没有 hfHome 时用系统临时目录），并 `mkdir -p`。
- 真会话复现：`speech-clip.mp4` 的两帧与 whisper 转写正常，`audio_events` 报上面那条错；
  修完待 0.9.2 发布后在同一会话复验。

## 0.9.1（2026-11-17）

打包修复：0.9.0 的 `files` 白名单漏了 `scripts/`，装进 `node_modules` 后没有 `audio-tag.py`，
耳朵的事件层只能挂在源目录上。现在 `files` 显式包含 `scripts/audio-tag.py`，
打包后用 `tar -tzf` 核对存在。

## 0.9.0（2026-11-17）

耳朵开始听见「文字以外」的声音——可选、离线、可关。

- 新增 AudioSet 事件标注：AST 模型（527 类，Speech / Laughter / Music / Applause …），
  在抽出的 WAV 上按时间窗跑，结果写进 `<audio_events>`：
  `0.0-10.0s: Speech 0.87, Laughter 0.62`。
- 推理完全在本机：Python 助手 `scripts/audio-tag.py` + 独立 venv，音频不出机器；
  模型权重走 HF 镜像（`hfEndpoint`，默认 `https://hf-mirror.com`），缓存由 `hfHome` 指定。
- 未配置 `pythonPath`/`audioTaggerPath` 时整段逻辑不启用，行为与 0.8 相同；
  标注失败只写一条 `unavailable` 注记，不影响转写和看片。
- 输出 schema 增加 `audioEvents` / `audioEventsNote`；解析与渲染进 `lib/audio-events.js`。
- 测试 45 条（新增解析/渲染 4 条）。
- 真机：`speech-clip.mp4` → `<audio_events ...>0.0-6.0s: Speech 0.87`；
  单独脚本在 `speech.wav` 上也复现同一结果。

## 0.8.0（2026-11-17）

下载缓存不再「半截也算数」。

- 缓存命中不再只看 `existsSync`：先用 ffprobe 验一遍（有视频流、时长 > 0.5s），
  不合格就删掉重下——中断留下的半截 mp4 不会再被永久复用。
- B 站下载改为写 `*.part`，ffmpeg 成功后才 `rename` 成正式文件；失败时 `finally`
  统一清理 `.v.m4s` / `.a.m4s` / `.flv` / `.part`，缓存目录不留渣。
- 合并步骤加整体超时 `mergeTimeoutMs`（默认 5 分钟），不再无限等。
- ffmpeg 输出显式 `-f mp4`，`.part` 这种扩展名也能正确封装。
- 措辞更正：不再说「OpenSSL 永久不可用」，改为「避开指纹风控与间歇 RST，schannel 更稳」。
- 测试 41 条（新增缓存判定与 `.part` 路径）。
- 真机验证：放一个 14 字节假 mp4 冒充缓存 → 被识别为不可用、删除、重新下载；
  下载失败后目录为空（临时文件已清理）。

## 0.7.0（2026-11-17）

Bilibili 链接改走 **curl + WBI**，不再依赖 Python 下载器。

- 背景：本机到 B 站的 TLS 对 OpenSSL 客户端会被重置（curl/schannel 正常，Python 握手超时），
  yt-dlp 是 Python 实现，所以 0.6 的 URL 路径在这台机器上必然失败。
- 新增 `lib/bilibili.js`：WBI mixin key、参数签名（含 `wts`/`w_rid`）、view/playurl 解析、
  码率选流（按高度上限挑视频 + 最高带宽音频）、BV 号提取。
- 下载流程：BV/短链 → view → nav 取 WBI keys → 签名 playurl → curl 下载视频/音频
  → ffmpeg `-c copy` 合并 → 按 `bvid` 缓存复用；临时 `.m4s/.flv` 合并后删除。
- 非 B 站域名继续走 yt-dlp；`curlPath` 可配（默认 `curl.exe`）。
- 测试 39 条（新增 bvid 提取、签名、选流、API 错误）。
- 真机：`BV13L411T74Z` 下载 4.59 MB → `watch_video` 读出 4 帧，`source.url` 正确；
  临时 m4s 已清理。

## 0.6.0（2026-11-17）

URL 输入：丢一个链接就能看。

- `path` 现在同时接受本地路径和 `http(s)` 链接；链接先交给 yt-dlp 下到缓存，再走同一套拆帧流程，
  结果里带 `source.url`。
- 域名白名单 `allowedDomains`（默认 bilibili.com / b23.tv / youtube.com / youtu.be），
  白名单外的链接直接拒绝，避免被随手当成下载器。
- 下载策略可配：`ytdlpPath`、`downloadDir`（默认空 = 用户缓存目录）、
  `maxDownloadHeight`（720）、`maxDownloadMB`（2048）、`downloadTimeoutMs`（10 分钟）、
  `proxy`（空 = 关闭环境代理）、`cookiesFromBrowser`（需要 1080P 登录态时填 `edge` 等）。
- 参数一律数组传递，链接里的 `&`、空格、中文路径不会被二次切分。
- 测试 31 条（新增 URL 判定、子域名白名单、参数拼装、下载路径解析）。
- 真机验证：`BV1uasu6zE4X` 720P 下载 106.4 MB、三窗拆帧（0–9/9–18/18–21:42）全部通过；
  B 站直连会被断 TLS，`proxy: ''` 后恢复。

## 0.5.0（2026-11-17）

三处性能/诚实性问题，都来自 60 秒片实测。

- **镜头预算不再偏前**：镜头数多过帧数时按等距挑镜头（以前直接取前 N 个，
  12 镜头 / 8 帧只看到前 42 秒）。现在 60 秒 12 场景片取样 5.0s–57.5s。
- **覆盖率算头尾**：`coverage` 现在同时给窗口 `start/end` 与 `firstSample/lastSample`，
  `maxGapSeconds` 把「窗口开头到第一帧」「最后一帧到窗口结尾」都算进去；
  文字回报同步改成「sampled A-B of the X-Y window」。
- **抓帧并发**：新增 `frameConcurrency`（默认 4），8 帧 60 秒片整次读取
  2.9 s → **1.5 s**。
- **转写预算收紧**：`maxAudioSeconds` 默认 600→**120**；窗口更长时截断并写
  warning，避免 10 分钟音频在 CPU 上跑约 15 分钟。
- 测试 25 条（新增并发保序、等距挑镜头、单帧取中）；bench 脚本 `scripts/bench.mjs`
  现在会打印 coverage 与每个采样时刻。

## 0.4.2（2026-11-17）

两处修正，都来自真机验收。

- **兜底判据修正**：以前只有「provider 未挂载」才会走 whisper；但 provider 挂着却
  `prepare` 未完成时 `transcribe()` 会抛错，于是整条耳朵哑掉。现在按**结果**兜底：
  provider 抛错/返回空 → 若配置了 whisper 就转本地，`transcriptNote` 同时记下
  「provider 为什么失败」与「这次是 whisper.cpp 转的」。两者都失败才报不可用。
- **SRT 加固**：旁挂字幕漏掉 cue 之间的空行时，纯数字行不再被并进台词
  （「红色 2」→「红色」）。
- 测试 22 条；smoke 新增假 provider 抛错场景：mock 抛
  `Prepare the local speech provider before recording` → 本地 whisper 返回「紅色藍色綠色」。

## 0.4.1（2026-11-17）

修 P0：没有音轨的视频会让整份结果被宿主判成 `value is not lossless JSON`。

- `probeVideo` 不再返回值为 `undefined` 的字段（`audioCodec` / `fps` / `durationSeconds` /
  字幕轨 `language`），缺失即省略；宿主对「无损 JSON 往返」是硬校验，`undefined` 会被拒。
- `scripts/smoke.mjs` 增加无损 JSON 体检：递归找出任何 `undefined` 路径并抛错，和真宿主同口径。
- 复现与验证：2 秒纯色无声片 → 旧版报 `value is not lossless JSON`；修复后 smoke 通过
  （schema 体检 + 无损体检都过）。

## 0.4.0（2026-11-17）

M3b：耳朵的兜底——本地 whisper.cpp。

- 新增 `whisperCppPath` / `whisperModelPath` / `whisperThreads`：宿主没有
  `speechToText` provider 时，把抽出的 16kHz WAV 交给本地 `whisper-cli` 转写，
  结果标注 `source: whisper.cpp`。
- whisper 失败或没听到语音时保留「不可用」原因，绝不把空转写包装成成功。
- 实测：中文语音片（SAPI 合成「红色。蓝色。绿色。」）→ `whisper.cpp` 返回
  `紅色藍色綠色`，6 秒音频约 8 秒（CPU，ggml-small）。
- 坑：纯正弦音轨会被听成无关短句（小模型幻听），所以 whisper 只在显式配置后启用，
  且仅作为 provider 的兜底。

## 0.3.0（2026-11-17）

M3a：耳朵的文本面——字幕轨与音轨转写。

- 新增字幕读取：优先同目录 `.srt`/`.vtt` 旁挂文件，其次容器内**文本**字幕轨（subrip/ass/
  webvtt/mov_text）；解析成带时间标记的台词，字符预算 `maxSubtitleChars`。
- 新增音轨转写：抽 16kHz 单声道 WAV，交给宿主 `speechToText` 服务（`resolve` +
  `transcribe`）；未挂载 provider 时把 WAV 存到 `audioDir` 并把路径写进结果，绝不假称转写过。
- 新增参数 `subtitles` / `transcript` / `language`；新增配置 `maxAudioSeconds` /
  `maxSubtitleChars` / `audioDir`。
- `probeVideo` 现在回传字幕轨清单（文本/图形、语言、编码）。
- 测试 21 条（新增 SRT/VTT 解析、时间标签、预算截断）。
- 本地验证：3 段纯色片 + 旁挂 `cuts.srt` → `<subtitles source="sidecar:cuts.srt" cues="3">`
  含 `[0:00.5-0:02.0] 红色` 等三条；无 provider 时返回 `<transcript unavailable="…wav 路径…"/>`。

## 0.2.0（2026-11-17）

M2：从「均匀采样」升级为「镜头感知 + 去重」。

- 新增低分辨率代理扫描（64×36 灰度、6fps），用逐帧差分画出变化曲线。
- 新增切分检测：变化 ≥ `shotRatio × 中位数` 且 ≥ `shotFloor`、间距 ≥ `minShotSeconds`
  → 每镜头取一个中间时刻；没有切分时退回均匀采样并写明原因。
- 新增缩略图去重：相邻候选的 64×36 灰度差低于 `minCellNovelty` 就丢掉，静止镜头不再
  占预算；结果里回传 `shots` 与 `dropped`。
- 新增配置：`sampling` / `motionFps` / `motionScanMaxSeconds` / `shotRatio` /
  `shotFloor` / `minShotSeconds` / `minCellNovelty`。
- 测试 15 条（新增中位数、切分、镜头取点、缩略图距离与去重）。
- 本地验证：3 段纯色（红/蓝/绿各 2 秒）成片 → `strategy=shots`、`shots=3`、
  三个时刻 1s/3s/5s，正好每镜头一帧。

## 0.1.0（2026-11-17）

首个可用版本（M1）。

- 新增 `watch_video` 工具：`ffprobe` 读时长/分辨率/帧率/编码，`ffmpeg` 均匀采样，
  经 `attachments.saveImage` 落盘为原生图片附件。
- 两种交付：接触表（`grid`，每格烧入 `#n <秒>s` 标签）或逐帧图（`frames`）。
- 结果回传覆盖率与**最大未采样间隔**，不掩盖缺口。
- `timestamps` 支持按秒单点重读；`carry` 支持分段续读。
- 配置项：`ffmpegPath`/`ffprobePath`/`defaultFrames`/`maxFrames`/`cellWidth`/
  `frameWidth`/`jpegQuality`/`gridWhenAtLeast`/`maxSeconds`。
- 单元测试 7 条（采样点、布局选择、接触表形状、帧率解析、clamp）。
- 本地实跑验证：6 秒 640×360 合成片 → 8 格 4×2 接触表 69,039 B，标签与画面可读。

### 已知限制

- 音轨与字幕尚未接入。

