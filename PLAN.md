# 当前计划

更新时间：2026-05-10

## 当前阶段目标

在“本地 LLM + 本地转写 + 同 Wi-Fi 访问”已打通的基础上，把工作台 UI 收口到参考图方向，并确保反馈风格选项真正生效。

## 当前执行项

1. 默认本地转写继续使用 `faster-whisper medium`。
2. 默认本地反馈模型固定为 `Qwen3.5-4B`：
   - Ollama 路线默认模型：`qwen3.5:4b`
   - 不把 `Qwen3.5-9B` 作为首版默认模型
3. 页面 UI 按用户确认过的参考图收口：
   - 顶部工作台头部
   - 左侧学生 / 课程双列表
   - 中右侧上传、设置、进度、转写、反馈、结构化总结工作区
4. 反馈风格选项改成真实影响生成结果：
   - 首次自动生成使用课程已保存风格
   - 重新生成覆盖当前编辑框文本
   - `professional_warm / concise / wechat` 使用不同长度和语气规则
5. 服务默认监听 `0.0.0.0`，页面展示本机 / 局域网访问地址
6. 用真实课程数据回归：
   - 新 JSON 解析逻辑能恢复旧失败课次
   - `concise` / `wechat` 风格输出有可见差异
7. 补一套项目内一键启停脚本：
   - 一键启动 Web 服务
   - 命中本机 Ollama 配置时自动启动本地 LLM
   - 一键关闭脚本托管进程
8. 修复复制按钮在局域网 HTTP 场景下不稳定的问题：
   - 优先走 Clipboard API
   - 失败时回退到 `document.execCommand("copy")`
9. 修复长录音反馈只总结最后一道题的问题：
   - 长 transcript 改成分段摘要再汇总
   - 反馈结构改成老师常用的“主要包括 / 掌握得较好的部分 / 还需要加强的部分”

## 验收清单

1. `server.js` / 前端页面支持本地模型切换。
2. `/api/config` 能返回：
   - 当前选中本地模型
   - 可用本地模型列表
   - 本机访问地址
   - 局域网访问地址
3. UI 结构和视觉方向与参考图一致，不再是旧版表单页面。
4. `professional_warm / concise / wechat` 不是摆设，重新生成后肉眼可见文案风格差异。
5. `.env` / `.env.example` / README 已切到 Ollama 默认口径。
6. `npm run check` 通过。
7. `npm run test:real-recording -- "<录音文件路径>"` 通过，且明确命中：
   - `effectiveAiMode=local`
   - `feedback_generator=local_llm`
   - `Qwen3.5-4B` / `qwen3.5:4b`

## 当前运行态

- 当前验收实例改跑在 `5178`
- 当前支持：
  - 本机访问
  - 同一局域网访问
- 当前本地 LLM 已完成：
  - `qwen3.5:4b` 下载完成并已被 Ollama 注册
  - 后端对本地 LLM 显式关闭 thinking：`reasoning_effort=none`
  - 结构化总结请求启用 JSON mode
  - 旧 lesson 的 JSON 解析失败已可通过重新生成恢复
