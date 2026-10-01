# 课堂录音转客户反馈 Web MVP

这个项目实现了需求文档里的第一版主流程：

```text
上传已有课堂录音 -> 保存原始文件 -> 后台切片 -> 分段转写 -> 合并转写稿 -> 生成课堂总结 -> 生成家长反馈 -> 老师编辑和复制
```

## 运行

```bash
npm start
```

如果你想用一套固定命令一键启动 / 关闭服务，直接用项目内脚本：

```bash
npm run service:start
npm run service:status
npm run service:stop
```

等价命令：

```bash
bash scripts/service.sh start
bash scripts/service.sh status
bash scripts/service.sh stop
```

说明：

- `start` 会按当前 `.env` 启动 Web 服务
- 当配置命中本机 Ollama 时，会尝试一并启动本地 LLM
- 如果本地 LLM 不存在或启动失败，Web 服务仍会继续启动
- 启动成功或端口已有服务时，会打印本机地址和所有可共享的局域网地址
- `stop` 只会关闭当前脚本托管的进程，不会误杀你自己另外起的服务
- 日志和 PID 文件保存在 `.run/`

默认地址：

```text
http://127.0.0.1:5173
```

项目不需要安装第三方 npm 依赖，要求 Node.js 20 或以上。

默认监听 `0.0.0.0:5173`。如果你和其他设备在同一 Wi-Fi，下列地址都可访问：

```text
本机:    http://127.0.0.1:5173
局域网:  http://你的局域网IP:5173
```

页面顶部会自动显示当前可访问的局域网地址。

## 费用保护

默认配置是：

```text
AI_PROVIDER=mock
ALLOW_EXTERNAL_API_COST=0
```

这个模式不会调用外部 API，不会产生 API 费用。页面顶部会显示“无费用演示模式”。

如果要真实调用当前账号的 OpenAI 兼容 API，需要复制 `.env.example` 为 `.env`，并显式设置：

```text
AI_PROVIDER=openai
ALLOW_EXTERNAL_API_COST=1
OPENAI_API_KEY=你的账号 API Key
OPENAI_BASE_URL=https://api.openai.com/v1
```

live 模式会发送音频转写和文本生成请求，是否产生费用由对应账号和 API 服务商计费规则决定。代码层面的保护是：不开 `ALLOW_EXTERNAL_API_COST=1` 就不会调用外部 API。

## 本地真实转写

如果要在本机直接完成真实转写和反馈生成，不走外部 API，可以复制 `.env.example` 为 `.env` 后设置：

```text
AI_PROVIDER=local
ALLOW_EXTERNAL_API_COST=0
LOCAL_WHISPER_MODEL=medium
LOCAL_WHISPER_LANGUAGE=zh
LOCAL_WHISPER_DEVICE=cuda
LOCAL_WHISPER_COMPUTE_TYPE=float16
LOCAL_WHISPER_LIBRARY_PATH=/path/to/cuda/lib64
LOCAL_WHISPER_BATCH_ENABLED=1
LOCAL_WHISPER_BEAM_SIZE=5
LOCAL_WHISPER_BEST_OF=5
LOCAL_WHISPER_NUM_WORKERS=1
DEFAULT_TRANSCRIBE_BACKEND=remote
DEFAULT_FEEDBACK_GENERATOR=local_llm
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen3.5:4b
HOST=0.0.0.0
```

这个模式会调用 `scripts/transcribe_local.py` 和 `faster-whisper` 完成本地中文转写；反馈生成默认走本机 Ollama 的 OpenAI 兼容接口，默认模型是 `qwen3.5:4b`。这台 `RTX 3050 Ti 4GB` 机器不把 `Qwen3.5-9B` 作为默认值；如果你后续自己拉好了 9B，它会出现在页面“本地模型”下拉框里，可以手动切换。

语音转文字速度优化不通过降低识别精度实现：默认仍使用 `medium` 模型、`beam_size=5` 和 `best_of=5`。本机和远端都可通过 `LOCAL_WHISPER_DEVICE=cuda`、`LOCAL_WHISPER_COMPUTE_TYPE=float16` 使用 GPU 加速；`float16` 不做 int8 量化，不降低默认识别精度。如果 CUDA 运行库不在系统默认路径，需要同时设置 `LOCAL_WHISPER_LIBRARY_PATH` 或 `REMOTE_WHISPER_LIBRARY_PATH`。当一条录音被切成多段时，后端会用批量转写模式让多个切片复用同一次模型加载，减少重复初始化开销。

默认语音转文字会优先走远程机器；如果远程转写未配置或不可用，后端会回退到本机可用的转写方式。远程转写配置如下：

```text
REMOTE_TRANSCRIBE_ENABLED=1
REMOTE_TRANSCRIBE_HOST=10.196.20.23
REMOTE_TRANSCRIBE_USER=plusai
REMOTE_TRANSCRIBE_PASSWORD=plusai
REMOTE_TRANSCRIBE_PORT=22
REMOTE_TRANSCRIBE_DIR=/home/plusai/teacher_remote_transcribe
REMOTE_TRANSCRIBE_PYTHON=python3
REMOTE_WHISPER_LIBRARY_PATH=/path/to/remote/cuda/lib64
REMOTE_TRANSCRIBE_SYNC_DEPS=1
```

页面“语音转文字位置”可以按课程选择“本机转写”或“远程转写”。首次远程转写时，服务会把本项目的 `.pydeps` 和 `scripts/transcribe_local.py` 同步到远端目录，再通过 SSH 上传切片并在远端批量转写；识别参数仍沿用本地配置，不会为了提速降低默认精度。如果本机没有 `.pydeps/faster_whisper`，但远端转写已配置，Web 服务仍可以启动并使用远程转写。

如果某节课保存为“本机转写”，但本机 CUDA 不可用，例如 `CUDA failed with error out of memory`、`forward compatibility was attempted on non supported HW` 或 `Driver/library version mismatch`，后端会先自动切换到远程转写并继续处理；如果远程机器也暂时不可用，会改用本机 CPU/float32 继续转写。CPU 兜底不会降低识别参数和模型精度，只是速度会明显慢一些。

如果远程机器的 NVIDIA 驱动不可用，例如 `nvidia-smi` 报 `Driver/library version mismatch` 或远端 CUDA 报 `forward compatibility was attempted on non supported HW`，后端会自动回退到本机转写；本机 CUDA 再失败时继续回退到本机 CPU/float32。

当前后端会对本地 Qwen thinking 模型显式关闭 reasoning，并在结构化总结请求上启用 JSON mode，避免模型把 token 全耗在思考过程里，导致没有最终 JSON 输出。

针对长录音，当前总结链路会先做分段摘要，再汇总成整节课总结；同时会先从 transcript 中提取题号和知识点提示，作为覆盖约束喂给本地 LLM，尽量避免本地小模型只抓住最后一道题，导致家长反馈只覆盖课堂尾段内容。汇总结果里还会显式产出 `feedback_required_mentions`，把“前半段必须提哪些知识点、后半段必须提哪些知识点、哪些共性问题必须进反馈”固定下来。

针对长录音的稳定性，当前还有两层额外保护：

- `merge summary` 已改成服务端确定性合并，不再要求本地 4B 模型在最后一步吐出一个超大的最终 JSON
- 本地 LLM 的聊天补全改成显式超时控制的原生 HTTP 请求，并把长 transcript 的默认分块收紧到 `SUMMARY_GROUP_SECTION_COUNT=2`

如果这台机器后续更快，或者你想自己权衡质量和耗时，可以在 `.env` 里继续调整：

```text
LOCAL_LLM_REQUEST_TIMEOUT_MS=900000
SUMMARY_GROUP_SECTION_COUNT=2
```

页面里可以单独选择“反馈生成方式”：

- `local_llm`：使用本机 OpenAI 兼容接口生成结构化总结和家长反馈。当前默认接的是 Ollama，模型为 `qwen3.5:4b`
- `openai_llm`：使用外部 OpenAI 兼容聊天接口生成结构化总结和家长反馈

上传录音时有两个动作按钮：

- `只生成录音文字版`：只完成音频切片和语音转文字，不生成结构化总结和家长反馈
- `生成文字与反馈`：完成语音转文字后继续生成结构化总结和家长反馈
- `生成课后反馈`：基于当前已有录音文字版只生成课后反馈，不重新上传录音，也不重新转写

同一节课可以选择 1-2 段录音上传。Linux 下可以分别点击“第 1 段录音”和“第 2 段录音”选择文件；选择两段时，系统会按这两个位置的顺序处理并拼接完整转写稿，再按拼接后的转写稿生成反馈。

学生列表支持复制学生姓名；点击学生姓名可直接修改姓名，点击课程名称可直接修改课程名称。

注意：

- “语音转文字位置”控制音频切片是在本机还是远程机器转写
- 反馈生成方式只控制“生成文字与反馈”按钮后续使用哪个 LLM，不控制“语音转文字位置”
- 页面里有单独的“本地模型”下拉框和“切换模型”按钮，只对 `local_llm` 生效
- 只有当前本地接口实际能看到的模型，才会出现在可切换列表里
- 页面里还有单独的“家长反馈风格”选项：
  - `professional_warm`：专业温和，默认风格
  - `concise`：更短、更密
  - `wechat`：更像老师在微信里单独发消息
- 首次自动生成和“重新生成”都会使用课程当前保存的风格；重新生成会直接刷新当前编辑框文本
- 当前反馈正文默认会优先采用老师常用的固定结构：
  - `XX妈妈您好！` + “今天这节课我主要带XX……主要内容包括：”
  - `掌握得较好的部分`
  - `还需要加强的部分`
  - `整体来看`
- 当前提示词已经按老师常用的“课后反馈”口吻收紧：
  - 只基于课堂转写和由转写整理出的结构化信息，不加入课堂没有讲到的内容
  - 不代入其他学生的内容
  - 只有 `主要内容包括` 使用序号，其余部分都写成自然段
  - 重点写具体课堂内容和学生表现，避免空泛总结、表格、emoji 和报告式表达
  - 正文字数控制在 500-700 字，适合直接复制发给家长
  - 禁止出现 `课堂整体概况`、`核心知识点覆盖`、`薄弱领域`、`高频问题`、`教学策略`、`逻辑闭环`、`复杂情境`、`几何直觉严谨化` 等报告式表达
  - 避免 `能力较弱`、`理解障碍`、`明显短板`、`逻辑跳跃严重` 等过重负面评价，改成 `还需要继续加强`、`目前还不够熟练`、`后续需要注意`
- 当前结构化总结里还会额外保留 `question_breakdown` 和 `feedback_required_mentions`，用来显式覆盖不同题号或不同知识模块，减少前半段内容被漏掉的情况

## ffmpeg

安装了 `ffmpeg` 和 `ffprobe` 时，后台会把录音标准化并按 5 分钟生成真实音频切片。

当前环境没有 `ffmpeg` 时：

- mock 模式会创建 5 分钟虚拟切片，便于完整验证页面和流程。
- local / openai 模式会退化为整段文件直转；浏览器上传时会带上真实时长，页面仍能看到完整转写结果。
- openai 模式只允许小文件走保护路径；长录音会失败并提示安装 `ffmpeg`，避免把大录音直接发给转写接口。

当前这台机器已经安装好 `ffmpeg` / `ffprobe`，所以真实录音会按 5 分钟做切片。

## 数据位置

默认本地保存：

```text
data/db.json
data/uploads/
data/normalized/
data/chunks/
```

这些文件已放入 `.gitignore`。需求文档已同步到：

```text
docs/课堂录音转客户反馈_最终需求文档.md
```

## 登录保护

本地开发默认不要求登录。需要给页面和 API 加单口令保护时，在 `.env` 中设置：

```text
APP_ACCESS_TOKEN=自定义访问口令
```

设置后，浏览器会先显示登录框，API 也会校验同源 Cookie 或 `Authorization: Bearer <口令>`。

## API

已实现的接口：

```text
GET  /api/config
GET  /api/local-llm/models
GET  /api/students
POST /api/students
PUT  /api/students/:id
DELETE /api/students/:id
GET  /api/students/:id/lessons
POST /api/lessons
GET  /api/lessons/:id
PUT  /api/lessons/:id
DELETE /api/lessons/:id
POST /api/lessons/:id/recording
GET  /api/lessons/:id/status
GET  /api/lessons/:id/audio
PUT  /api/lessons/:id/preferences
PUT  /api/lessons/:id/feedback
POST /api/lessons/:id/regenerate-feedback
POST /api/lessons/:id/complete
POST /api/chunks/:id/retry
PUT  /api/settings/local-llm
```

前端上传使用原始文件流，避免大文件 multipart 解析占用过多内存；后端也兼容小文件 multipart 的 `audio_file` 字段。

## 验证

```bash
npm run check
```

启动本地 Ollama 服务：

```bash
npm run start:local-llm
```

拉取默认本地模型：

```bash
npm run pull:qwen3.5-4b
```

生成一段 10 分 20 秒的本地 WAV 录音，并上传到当前服务做端到端测试：

```bash
npm run test:generated-recording
```

使用指定真实录音文件做一次本地真实转写端到端测试：

```bash
npm run test:real-recording -- "/path/to/recording.m4a"
```

这个真实测试现在会强制要求：

- `effectiveAiMode=local`
- `feedback_generator=local_llm`
- 当前本地模型名匹配 `Qwen3.5-4B` / `qwen3.5:4b`
- 反馈不是 mock，也不是外部 OpenAI 路线

检查内容：

```text
node --check server.js
node --check public/app.js
node --check scripts/smoke-test.js
无费用 mock 冒烟测试
```
