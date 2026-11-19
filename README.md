# dsh-whale-sight

给 DeepSeek Harness 的一双「看视频」的眼睛：用 ffmpeg 把一段视频拆成带时间戳的图，
作为原生图片附件交回给会看图的模型。

> 0.5.0：镜头感知采样（小预算也等距覆盖整段）、接触表/逐帧、字幕（旁挂/文本轨）、
> 音轨转写（宿主 provider 优先，本地 whisper.cpp 兜底）；句子锚定留到下一版。

## 安装要求

- 本机 `ffmpeg` / `ffprobe`（建议 6.1+，编译时带 `libfreetype`，接触表标签才能画）
- 可通过配置 `ffmpegPath` / `ffprobePath`、环境变量 `DSH_FFMPEG` / `DSH_FFPROBE`，
  或 PATH 找到
- 当前 profile 挂载了 `attachments` 服务（DSH 默认挂载）

## 安装

```powershell
# npm
dsh plugin --profile desktop add dsh-whale-sight

# 或直接装 GitHub 仓库
dsh plugin --profile desktop add github:Lh1314-China/dsh-whale-sight
```

装完重启 DSH，`watch_video` 会出现在模型可用的工具里。只做本地视频取帧时，
除了 ffmpeg/ffprobe 不需要任何其它外部程序；B 站链接用 Windows 自带的
`curl.exe`（Win10 1803+），YouTube 等其它域名才需要 `ytdlpPath`。

## 工具：`watch_video`

| 参数 | 说明 |
|---|---|
| `path` | 视频路径；相对路径按会话工作目录解析；也接受 `http(s)` 链接（走 yt-dlp 下载） |
| `frames` | 采样数（默认 8，上限 `maxFrames`） |
| `timestamps` | 显式秒数列表，覆盖 `frames`，超过上限会截断 |
| `start` / `end` | 采样窗口，默认整段 |
| `layout` | `auto` / `grid` / `frames`；`auto` 达到 `gridWhenAtLeast` 就出接触表 |
| `width` | 单图长边；接触表用 `cellWidth`，逐帧用 `frameWidth` |
| `carry` | 上一段的摘要，读长视频续读时带上 |
| `subtitles` | 是否读字幕（旁挂 `.srt`/`.vtt` 或容器内文本字幕轨） |
| `transcript` | 是否转写音轨（宿主 `speechToText`；没有 provider 时只存 WAV 并报路径） |
| `language` | 转写与字幕轨的语言提示 |

结果包含：时长/分辨率/fps/编码、采样策略、每个时间点、覆盖率（窗口 `start/end`、
首末采样 `firstSample/lastSample`、含头尾缺口的 `maxGapSeconds`），以及一张接触表或若干逐帧图。

**成本口径**：单图封顶约 1024 vision tokens（与格数无关），所以接触表是省 token 的
默认；逐帧的边际成本约是接触表的 12 倍（12 帧 ≈ 12k vs 1 张 ≈ 1k）。

## 配置（`cordis.patch.yml` 可覆盖）

| 键 | 默认 | 含义 |
|---|---|---|
| `ffmpegPath` / `ffprobePath` | `''` | 空 = 环境变量/PATH |
| `defaultFrames` | 8 | 未指定 `frames` 时的采样数 |
| `maxFrames` | 20 | 单次采样硬上限 |
| `cellWidth` | 320 | 接触表单格长边 |
| `frameWidth` | 768 | 逐帧图长边 |
| `jpegQuality` | 4 | ffmpeg `-q:v`（2 最好，31 最差） |
| `gridWhenAtLeast` | 5 | `auto` 出接触表的帧数阈值 |
| `maxSeconds` | 1200 | 未指定 `end` 时单次最多读多少秒 |
| `sampling` | `auto` | `auto` = 代理扫描 + 镜头切分 + 去重；`even` = 均匀采样 |
| `motionFps` / `motionScanMaxSeconds` | 6 / 600 | 代理扫描的采样率与最长扫描窗口 |
| `shotRatio` / `shotFloor` / `minShotSeconds` | 3 / 0.05 / 0.5 | 切分判据：相对中位数的倍数、绝对下限、最小间距 |
| `minCellNovelty` | 0.02 | 归一化缩略图距离低于它就视为重复 |
| `subtitles` | `true` | 默认读字幕 |
| `transcript` | `true` | 默认尝试转写 |
| `language` | `zh` | 转写/字幕语言提示 |
| `maxAudioSeconds` / `maxSubtitleChars` | 120 / 6000 | 音频与字幕的预算（whisper 在 CPU 上约为音频时长的 1.5 倍，别开太长） |
| `frameConcurrency` | 4 | 拼故事板时并行解码的 ffmpeg 进程数 |
| `audioDir` | `''` | 无 provider 时 WAV 存放目录；空 = 系统临时目录 |
| `ytdlpPath` | `''` | yt-dlp 可执行文件；留空 = 只收本地文件 |
| `downloadDir` | `%LOCALAPPDATA%\dsh-whale-sight\cache`（空 = 自动） | URL 下载缓存目录 |
| `maxDownloadHeight` / `maxDownloadMB` | 720 / 2048 | 下载分辨率与体积上限 |
| `downloadTimeoutMs` | 600000 | 单次下载超时 |
| `proxy` | `''` | 空 = 关闭环境代理（B 站 TLS 重置时需要） |
| `cookiesFromBrowser` | `''` | 需要登录态时填浏览器名（如 `edge`） |
| `curlPath` | `curl.exe` | B 站下载用的 curl（走 schannel TLS） |
| `mergeTimeoutMs` | 300000 | 音视频合并的整体超时 |
| `pythonPath` | `''` | 音频事件标注用的 Python（独立 venv）；留空 = 不启用 |
| `audioTaggerPath` | `''` | `scripts/audio-tag.py` 的路径；留空 = 不启用 |
| `audioTagWindows` / `audioTagTopK` | 4 / 3 | 标注窗口数 / 每窗保留标签数 |
| `bilibiliCookieFile` | `''` | 本机凭据 JSON 路径（小写键）；优先于 cookie 字符串 |
| `bilibiliCookie` | `''` | 直接给 Cookie 头（一般用文件即可） |
| `bilibiliQuality` / `bilibiliMaxHeight` | 80 / 1080 | 登录后请求的画质 / 选流高度上限 |
| `hfEndpoint` | `https://hf-mirror.com` | 模型权重的 HF 镜像 |
| `hfHome` | `''` | 模型缓存目录（需可写） |
| `whisperCppPath` / `whisperModelPath` | `''` | 本地 whisper.cpp 兜底（两者都填才启用） |
| `whisperThreads` | 4 | 兜底转写的 CPU 线程数 |

## 用链接看片

`watch_video` 的 `path` 既可以是本地文件，也可以是 `http(s)` 链接，分两条下载路：

- **B 站**（bilibili.com / b23.tv）：走 **curl + WBI 签名**，不依赖 Python。流程是
  BV/短链 → view → nav 取 WBI keys → 签名 playurl → 选高度上限内的视频流 + 最佳音频
  → curl 下载 → ffmpeg 合并，按 bvid 缓存复用。这样避开指纹风控与间歇 RST，schannel 比 OpenSSL 稳。
- 缓存命中会先用 ffprobe 验一遍（有视频流、时长 > 0.5s）；合并写 `*.part`，成功才改名，
  失败统一清理临时文件。
- **其它白名单域名**：走 yt-dlp（需要 `ytdlpPath`）。

域名必须在 `allowedDomains` 里；下载落在 `downloadDir`（空 = `%LOCALAPPDATA%\dsh-whale-sight\cache`），
随后照常拆帧，结果里 `source.url` 记下来源，`source.path` 是缓存文件。

整理约定：想留的片子从「缓存」挪到「收藏」或「看过」，不喜欢的直接删——缓存目录不自动清理。

## 耳朵：声音事件（可选）

配好 `pythonPath` 与 `audioTaggerPath` 后，每次读片会顺手给音轨打 AudioSet 标签：

```
<audio_events model="MIT/ast-finetuned-audioset-10-10-0.4593">
0.0-10.0s: Speech 0.87, Laughter 0.62
</audio_events>
```

- 模型跑在本机独立 venv（`tools\venv-audio`），音频不出机器；
- 权重从 `hfEndpoint`（默认 hf-mirror）取，缓存在 `hfHome`；
- 只对读片窗口的前 `maxAudioSeconds` 秒标注，窗口数由 `audioTagWindows` 控制；
- 标注失败只留一条 `unavailable` 注记，不影响转写。

## 本地自检

```shell
node --test test/unit/*.test.js
node scripts/local-check.mjs <clip.mp4> <outDir>   # 产出 cell-XX.jpg 与 sheet.jpg
```

`local-check` 不依赖 DSH，用来验证 ffmpeg 路径、取帧与拼图。

## 边界与已知限制

- `auto` 采样按**镜头切分**取帧：静止镜头只占一帧，快速剪辑不会被均匀网格漏掉；
  但镜头内的细微变化可能被去重丢掉，需要细节时用 `timestamps` 单点重读。
- 代理扫描只看前 `motionScanMaxSeconds`（默认 600 秒）；更长的窗口会写明「未比较」。
- 接触表单格过小会丢细节；需要细节时提高 `width` 或改用逐帧。
- 字幕优先用文件自带文字（旁挂或文本轨）；音轨转写先走宿主 `speechToText`，没有 provider
  且配置了 `whisperCppPath`/`whisperModelPath` 时才用本地 whisper.cpp 兜底；两者都不可用
  时只保存 WAV 并给出路径，不会假装转写过。whisper 对纯音乐/静音可能幻听，所以默认不启用。
- 不自动删除附件：抽出的帧和接触表与其它图片附件一样持久保存在 `DSH_HOME`。

## 致谢

图片附件与 ffmpeg 取帧的接法参考了 [dsh-video-vision](https://github.com/listendh/dsh-video-vision)
（MIT，作者 listendh）。本包是独立实现，工具名、缓存与配置都不与它共享。

## 许可与声明

- 本包以 **MIT** 许可发布，见 [LICENSE](LICENSE)。
- **不捆绑 ffmpeg**：请自行安装 `ffmpeg` / `ffprobe`，并遵守你所用那份构建的许可
  （Windows 常见构建有 GPL / LGPL 之分）。
- **不下载模型**：whisper.cpp 模型、语音转写 provider 都由使用者自行准备；
  音频事件标注需要你自己的 Python 环境。
- **网络边界**：只有你显式给出 `http(s)` 链接时才会出站（B 站走 `curl.exe`，
  其它白名单域名走 yt-dlp）；本地文件不会上传。下载内容仅供自己有权访问的用途，
  请遵守相应平台条款。
- 抽出的帧、接触表和缓存的视频都留在本机（`DSH_HOME` 与 `downloadDir`），
  插件不自动删除。
