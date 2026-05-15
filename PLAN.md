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
   - 命中本机 Ollama 配置时尝试启动本地 LLM
   - 本地 LLM 不存在或启动失败时仍继续启动 Web 服务
   - 一键关闭脚本托管进程
8. 修复复制按钮在局域网 HTTP 场景下不稳定的问题：
   - 优先走 Clipboard API
   - 失败时回退到 `document.execCommand("copy")`
9. 修复长录音反馈只总结最后一道题的问题：
   - 长 transcript 改成分段摘要再汇总
   - transcript 先提取题号 / 知识点覆盖提示，再约束 summary 和反馈生成
   - summary 增加 `question_breakdown`
   - summary 增加 `feedback_required_mentions`
   - 反馈结构改成老师常用的“主要包括 / 掌握得较好的部分 / 还需要加强的部分”
10. 修复本地 LLM 在长录音总结时的稳定性问题：
   - merge summary 改成服务端确定性合并
   - 本地 LLM 请求改成显式超时控制
   - 长 transcript 的 block summary 默认改成更细分块
11. 继续优化家长反馈提示词口吻：
   - 按老师常用“课后反馈”模板输出
   - 先概括本节课内容，再写掌握得较好的部分和需要加强的部分
   - 避免写成逐题流水账或单独的“改进策略”报告
12. 新增学生姓名复制和转写提速：
   - 学生列表每个学生增加独立“复制”按钮
   - 转写提速只复用本地 Whisper 模型加载，不降低默认识别精度
   - 默认仍保持 `beam_size=5` / `best_of=5`

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
8. 学生列表“复制”按钮可复制学生姓名，且不会误切换学生。

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
  - 长录音总结链路已切到“分段 LLM + 服务端确定性 merge”
  - 本地转写批量模式已启用，默认不降识别精度
