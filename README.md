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
LOCAL_WHISPER_BATCH_ENABLED=1
LOCAL_WHISPER_BEAM_SIZE=5
LOCAL_WHISPER_BEST_OF=5
DEFAULT_FEEDBACK_GENERATOR=local_llm
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
LOCAL_LLM_MODEL=qwen3.5:4b
HOST=0.0.0.0
```

这个模式会调用 `scripts/transcribe_local.py` 和 `faster-whisper` 完成本地中文转写；反馈生成默认走本机 Ollama 的 OpenAI 兼容接口，默认模型是 `qwen3.5:4b`。这台 `RTX 3050 Ti 4GB` 机器不把 `Qwen3.5-9B` 作为默认值；如果你后续自己拉好了 9B，它会出现在页面“本地模型”下拉框里，可以手动切换。

语音转文字速度优化不通过降低识别精度实现：默认仍使用 `beam_size=5` 和 `best_of=5`。当一条录音被切成多段时，后端会用批量转写模式让多个切片复用同一次 `medium` 模型加载，减少重复初始化开销。

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

注意：

- 反馈生成方式只控制“总结和反馈生成”，不控制“语音转文字”
- 页面里有单独的“本地模型”下拉框和“切换模型”按钮，只对 `local_llm` 生效
- 只有当前本地接口实际能看到的模型，才会出现在可切换列表里
- 页面里还有单独的“家长反馈风格”选项：
  - `professional_warm`：专业温和，默认风格
  - `concise`：更短、更密
  - `wechat`：更像老师在微信里单独发消息
- 首次自动生成和“重新生成”都会使用课程当前保存的风格；重新生成会直接刷新当前编辑框文本
- 当前反馈正文默认会优先采用老师常用的三段结构：
  - 开头问候 + “今天这节课主要包括”
  - `掌握得较好的部分`
  - `还需要加强的部分` + 课后建议
- 当前提示词已经按老师常用的“课后反馈”口吻收紧：
  - 先概括本节课主线，再列 `主要内容包括`
  - 亮点和问题都写成自然段，不写成课堂流水账
  - 课后建议和下节课重点收在最后一段，不再单独起“改进策略”清单
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
DELETE /api/students/:id
GET  /api/students/:id/lessons
POST /api/lessons
GET  /api/lessons/:id
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
