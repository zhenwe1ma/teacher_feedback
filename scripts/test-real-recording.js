"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const AUDIO_PATH = process.argv[2] || "";
const HOST = "127.0.0.1";
const PORT = Number(process.env.TEST_PORT || 6202);
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `teacher-feedback-real-${process.pid}-${Date.now()}`);

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  assert(AUDIO_PATH, "请传入待测试录音路径，例如: npm run test:real-recording -- \"/path/to/recording.m4a\"");
  const stat = await fs.stat(AUDIO_PATH);
  console.log(`测试录音: ${AUDIO_PATH}`);
  console.log(`录音大小: ${formatBytes(stat.size)}`);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      DATA_DIR,
      AI_PROVIDER: "local",
      ALLOW_EXTERNAL_API_COST: "0",
      LOCAL_WHISPER_MODEL: process.env.LOCAL_WHISPER_MODEL || "medium",
      LOCAL_WHISPER_LANGUAGE: process.env.LOCAL_WHISPER_LANGUAGE || "zh",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(server);
    const config = await apiGet("/api/config");
    assert(config.effectiveAiMode === "local", `当前服务不是 local 模式: ${config.effectiveAiMode}`);
    assert(config.externalApiCostAllowed === false, "ALLOW_EXTERNAL_API_COST 已打开，测试已停止");
    assert(config.localLlmFeedbackAvailable, `本地 LLM 当前不可用: ${config.localLlmError || "未配置或未连通"}`);
    assert(/qwen3\.5[:\-]?4b/i.test(String(config.localLlmSelectedModel || "")), `当前本地模型不是 Qwen3.5-4B: ${config.localLlmSelectedModel || "未配置"}`);
    console.log(`当前模式: ${config.effectiveAiMode}, transcribe=${config.transcribeModel}`);
    console.log(`本地反馈模型: ${config.localLlmSelectedModel}`);
    const feedbackGenerator = "local_llm";
    console.log(`反馈生成方式: ${feedbackGenerator}`);

    const student = (await apiPost("/api/students", {
      name: "真实录音测试学生",
      grade: "高二",
      notes: "指定 m4a 真实转写测试",
    })).student;

    try {
      const lesson = (await apiPost("/api/lessons", {
        student_id: student.id,
        lesson_title: "真实录音转写测试",
        lesson_time: "2026-05-06T00:00:00",
        feedback_generator: feedbackGenerator,
      })).lesson;
      assert(lesson.feedback_generator === feedbackGenerator, "默认反馈生成方式不正确");

      const audioBuffer = await fs.readFile(AUDIO_PATH);
      const upload = await fetch(`${BASE_URL}/api/lessons/${lesson.id}/recording`, {
        method: "POST",
        headers: {
          "Content-Type": "audio/mp4",
          "X-File-Name": encodeURIComponent(path.basename(AUDIO_PATH)),
          "X-File-Format": "audio/mp4",
        },
        body: audioBuffer,
      });
      assert(upload.status === 201, `上传失败: ${upload.status} ${await upload.text()}`);

      const result = await pollLesson(lesson.id, 360000);
      assert(result.lesson.status === "feedback_generated", `课程没有生成反馈: ${result.lesson.status}`);
      assert(result.lesson.feedback_generator === feedbackGenerator, `反馈生成方式不正确: ${result.lesson.feedback_generator}`);
      assert(result.lesson.full_transcript.trim().length > 200, "完整转写稿过短，疑似没有真实转写");
      assert(!result.lesson.full_transcript.includes("无费用演示转写"), "仍然命中了 mock 转写");
      assert(result.lesson.structured_summary, "没有生成结构化总结");
      assert(result.lesson.feedback_text.trim().length > 30, "没有生成反馈文本");

      console.log(`课程状态: ${result.lesson.status}`);
      console.log(`切片结果: ${result.status.completed_chunks}/${result.status.total_chunks}`);
      console.log(`转写预览: ${result.lesson.full_transcript.slice(0, 180).replace(/\s+/g, " ")}...`);
      console.log(`反馈预览: ${result.lesson.feedback_text.slice(0, 180).replace(/\s+/g, " ")}...`);
    } finally {
      if (process.env.KEEP_TEST_DATA !== "1") {
        await apiDelete(`/api/students/${student.id}`);
        console.log("测试数据已清理");
      }
    }
  } finally {
    server.kill("SIGTERM");
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  }
}

async function pollLesson(lessonId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await apiGet(`/api/lessons/${lessonId}`);
    if (["feedback_generated", "completed", "failed"].includes(payload.lesson.status)) {
      return payload;
    }
    await delay(1000);
  }
  throw new Error("等待课程处理超时");
}

async function waitForServer(server) {
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`服务提前退出: ${server.exitCode}\n${stderr}`);
    }
    if (stdout.includes("teacher-feedback app listening")) {
      return;
    }
    await delay(100);
  }
  throw new Error(`服务启动超时\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function apiGet(route) {
  return parseResponse(await fetch(`${BASE_URL}${route}`, { headers: jsonHeaders() }));
}

async function apiPost(route, payload) {
  return parseResponse(await fetch(`${BASE_URL}${route}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  }));
}

async function apiDelete(route) {
  return parseResponse(await fetch(`${BASE_URL}${route}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  }));
}

async function parseResponse(response) {
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function jsonHeaders() {
  return { Accept: "application/json", "Content-Type": "application/json" };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
