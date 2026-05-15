# 当前进度

更新时间：2026-05-10

## 已完成

### 1. 基础产品链路

- 学生管理、课程管理、删除学生、删除课程已接通
- 上传录音、后台切片、分段转写、合并 transcript、反馈编辑/复制/保存已接通
- 页面可直接显示“录音文字版”

### 2. 本地真实转写

- 默认本地转写模型已切到 `medium`
- 本机 `ffmpeg` / `ffprobe` 已安装
- 本地转写脚本 `scripts/transcribe_local.py` 已接入
- 本地转写默认仍保持 `beam_size=5` / `best_of=5`，不通过降低精度换速度
- 多切片录音启用批量转写模式，复用同一次 Whisper 模型加载来提速

### 3. 反馈生成路线收口

- 已删除 `local_rule`
- 当前反馈生成方式只保留：
  - `local_llm`
  - `openai_llm`
- 老数据里的旧枚举会自动迁移

### 4. 本地 LLM 配置已改成 Ollama 口径

- `.env` 默认值已切到：
  - `LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1`
  - `LOCAL_LLM_MODEL=qwen3.5:4b`
- `Qwen3.5-4B` 仍是默认模型
- `Qwen3.5-9B` 没有被设成默认值
- `qwen3.5:4b` 已下载完成，并已出现在：
  - `GET /v1/models`
  - `GET /api/tags`

### 5. 本地模型切换能力已补齐

- 后端新增：
  - `GET /api/local-llm/models`
  - `PUT /api/settings/local-llm`
- `db.json` 已支持 `settings.local_llm_model`
- 页面已新增：
  - 本地模型下拉框
  - “切换模型”按钮

### 6. 局域网访问能力已补齐

- 服务支持返回：
  - `localUrl`
  - `lanUrls`
  - `listenHost`
  - `listenPort`
- 页面顶部会显示本机和局域网访问地址
- `.env` / `.env.example` 默认监听已改成 `HOST=0.0.0.0`

### 7. 工作台 UI 已按参考图方向重构

- `public/index.html` 已重排为三列工作台：
  - 顶部品牌 / 模式 / 访问地址头部
  - 左侧学生列表
  - 中侧课程列表
  - 右侧上传、设置、进度、转写、反馈、结构化总结
- `public/styles.css` 已重写为浅色、安静的工作台风格
- `public/app.js` 已补齐：
  - 学生 / 课程搜索
  - 数量 badge
  - 结构化总结卡片
  - 顶部访问地址渲染

### 8. 反馈风格现在真正生效

- lesson 新增并持久化 `feedback_style`
- 首次自动生成和重新生成都使用课程当前风格
- `professional_warm / concise / wechat` 已在提示词中拆成明确规则
- 每种风格都有独立长度约束
- 重新生成会直接覆盖当前编辑框内容，避免旧文本把新风格效果盖掉

### 9. 本地 thinking 与 JSON 解析问题已落地修复

- 本地 LLM 调用显式传 `reasoning_effort=none`
- 结构化总结启用 JSON mode
- `parseJsonObject()` 已支持从混合输出里提取第一个完整 JSON 对象
- 旧课次 `Unexpected non-whitespace character after JSON ...` 可通过重新生成恢复成 `feedback_generated`

### 10. 一键启停脚本已补齐

- 新增 `scripts/service.sh`
- 支持：
  - `start`
  - `stop`
  - `restart`
  - `status`
- `start` 会按当前 `.env` 启动 Web 服务
- 当配置命中项目内 Ollama 时，会自动复用或尝试启动本地 LLM
- 如果本地 LLM 不存在或启动失败，脚本会继续启动 Web 服务
- 启动成功或端口已有服务时，会打印本机地址和所有可共享的局域网地址
- `stop` 只会关闭脚本自己托管的进程
- 新增 npm 命令：
  - `npm run service:start`
  - `npm run service:stop`
  - `npm run service:restart`
  - `npm run service:status`
- 运行态 PID 和日志统一落到 `.run/`

### 11. 复制按钮已补回退逻辑

- `反馈复制` 和 `文字版复制` 不再只依赖 `navigator.clipboard.writeText()`
- 当前实现会：
  - 优先使用 Clipboard API
  - 失败时自动回退到 `document.execCommand("copy")`
- 这样在 `http://127.0.0.1` 之外的局域网 HTTP 地址下，复制按钮也更稳定
- 学生列表已新增“复制”按钮，可单独复制学生姓名，不影响点击学生切换课程列表

### 12. 长录音总结偏到最后一道题的问题已开始修复

- `server.js` 的结构化总结链路已改成：
  - 长 transcript 先做分段摘要
  - 再把分段摘要汇总成整节课总结
- transcript 现在会先提取题号 / 知识点覆盖提示，并把这些提示注入 block summary、merge summary 和最终反馈 prompt
- 新 summary schema 在兼容原字段的基础上，新增：
  - `covered_topics`
  - `question_breakdown`
  - `feedback_required_mentions`
  - `lesson_segments`
  - `recurring_weaknesses`
  - `coverage_check`
- 家长反馈 prompt 已改成优先覆盖整节课，不允许只围绕最后一道题展开
- 反馈正文结构已改成更接近老师日常口径：
  - 开头问候
  - `今天这节课主要包括`
  - `掌握得较好的部分`
  - `还需要加强的部分`
- 反馈风格的长度约束已进一步放宽到更适合多题型课堂，避免模型为了压字数继续丢掉前半段内容

### 13. 长录音本地 LLM 稳定性问题继续收口

- 已确认旧失败点之一是：本地小模型在 `merge summary` 阶段不稳定返回大 JSON，导致 `模型没有返回合法 JSON`
- 当前已改成：
  - block summary 仍走 LLM
  - merge summary 改成服务端确定性合并，不再要求本地 4B 模型吐一个超大最终 JSON
- 已确认新的瓶颈之一是：本地 LLM 非流式 `/chat/completions` 请求会撞上默认超时
- 当前已改成：
  - 聊天补全改用显式超时控制的原生 HTTP 请求
  - 新增 `LOCAL_LLM_REQUEST_TIMEOUT_MS`
  - 长 transcript 的默认分块从 `5` 段收紧到 `2` 段，降低单个 block prompt 的体积

## 当前验证结果

### 静态校验

- `node --check server.js` 通过
- `node --check public/app.js` 通过
- `npm run check` 已重新通过，输出 `smoke test passed`
- 本轮超时修复后再次回跑：
  - `node --check server.js` 通过
  - `npm run check` 通过，输出 `smoke test passed`

### 14. 家长反馈提示词已按老师模板口吻收紧

- 已参考老师常用的“课后反馈”模板调整 `feedbackWithLlm()` 提示词
- 当前正文结构明确收口为：
  - 开头问候 + 本节课总述
  - `主要内容包括`
  - `掌握得较好的部分`
  - `还需要加强的部分`
- 已明确要求：
  - 先概括本节课内容，再写亮点和问题
  - 亮点与问题都写成自然段，不写成课堂逐题复述
  - 课后建议和下节课重点自然收在最后一段
  - 避免输出“针对这些问题，我制定了以下改进策略”这类报告腔

### 15. 学生姓名复制与转写提速

- 学生列表每个学生项右侧新增“复制”按钮
- 复制学生姓名复用现有 `copyText()`，在局域网 HTTP 下仍有回退逻辑
- 本地转写新增批量模式：
  - 多个切片由同一个 Python 进程连续转写
  - `faster-whisper medium` 模型只加载一次
  - 默认识别参数不降级，仍为 `beam_size=5` / `best_of=5`

### 当前运行实例

- 已启动当前验收服务：`http://127.0.0.1:5178`
- 同 Wi-Fi 访问：已验证可用
- 浏览器快照已确认页面顶部展示：
  - 本机访问地址
  - 局域网访问提示
  - 本地模型下拉框
  - “切换模型”按钮
  - 新版工作台 UI 布局

### UI / 交互回归

- 浏览器实测：
  - 课程页状态已从旧的 `failed` 恢复为 `feedback_generated`
  - `家长反馈风格=concise` 后重新生成，输出明显更短
  - `家长反馈风格=wechat` 后重新生成，输出口吻明显更像微信消息
- 移动端视口快照已跑通，未看到结构性内容缺失

### 进行中

- Ollama 服务已启动在 `127.0.0.1:11434`
- 已定位并修复本地 LLM 失败根因：
  - 旧实现下 `qwen3.5:4b` 默认开启 thinking
  - OpenAI 兼容返回里 reasoning 吃掉了 `max_tokens`
  - `message.content` 为空，lesson 最终报错 `模型没有返回合法 JSON`
- 修复后：
  - `local_llm` 调用会显式传 `reasoning_effort=none`
  - 结构化总结请求会显式传 `response_format={type:json_object}`
  - 如果模型只返回 reasoning、不返回最终内容，后端会给出更明确的错误提示

## 最终验收结果

1. `npm run check` 已通过，输出 `smoke test passed`
2. `http://127.0.0.1:5178` 已提供新版 UI 验收实例，并支持同 Wi-Fi 访问
3. 旧失败课次在新后端上重新生成后已恢复为 `feedback_generated`
4. `concise` / `wechat` 风格已验证不是摆设，实际输出有差异
5. `npm run test:real-recording -- "<录音文件路径>"` 已通过
6. 真实录音结果：
   - `课程状态: feedback_generated`
   - `切片结果: 3/3`
   - 真实 transcript 已生成
   - 本地 LLM 家长反馈已生成
