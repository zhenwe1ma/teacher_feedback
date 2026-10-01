"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 6197;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `teacher-feedback-smoke-${process.pid}-${Date.now()}`);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await runMainFlow();
  await runAuthFlow();
  console.log("smoke test passed");
}

async function runMainFlow() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      DATA_DIR,
      AI_PROVIDER: "mock",
      ALLOW_EXTERNAL_API_COST: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(server);
    const config = await apiGet("/api/config");
    assert(config.effectiveAiMode === "mock", "冒烟测试必须运行在 mock 模式");
    assert(config.localUrl === `${BASE_URL}`, `本机访问地址不正确: ${config.localUrl}`);
    assert(Array.isArray(config.lanUrls), "局域网地址字段缺失");

    const studentResult = await apiPost("/api/students", {
      name: "测试学生",
      grade: "高二",
      notes: "冒烟测试",
    });
    assert(studentResult.student.id, "学生创建失败");
    const renamedStudent = await apiPut(`/api/students/${studentResult.student.id}`, {
      name: "测试学生改名",
    });
    assert(renamedStudent.student.name === "测试学生改名", "学生改名失败");

    const lessonResult = await apiPost("/api/lessons", {
      student_id: studentResult.student.id,
      lesson_title: "导数综合题训练",
      lesson_time: "2026-05-05T19:00:00",
    });
    assert(lessonResult.lesson.id, "课程创建失败");
    assert(lessonResult.lesson.feedback_generator === "local_llm", "默认反馈生成方式不正确");
    const renamedLesson = await apiPut(`/api/lessons/${lessonResult.lesson.id}`, {
      lesson_title: "导数综合题训练改名",
    });
    assert(renamedLesson.lesson.lesson_title === "导数综合题训练改名", "课程改名失败");

    const preferences = await apiPut(`/api/lessons/${lessonResult.lesson.id}/preferences`, {
      feedback_generator: "local_llm",
    });
    assert(preferences.lesson.feedback_generator === "local_llm", "反馈生成方式保存失败");

    const audio = Buffer.from("mock audio bytes for smoke test");
    const uploadResponse = await fetch(`${BASE_URL}/api/lessons/${lessonResult.lesson.id}/recording`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-File-Name": encodeURIComponent("smoke.wav"),
        "X-File-Format": "audio/wav",
        "X-Audio-Duration-Sec": "620",
      },
      body: audio,
    });
    assert(uploadResponse.status === 201, `上传失败: ${uploadResponse.status} ${await uploadResponse.text()}`);

    const payload = await pollLesson(lessonResult.lesson.id);
    assert(payload.lesson.status === "feedback_generated", `课程没有完成: ${payload.lesson.status}`);
    assert(payload.status.total_chunks === 3, `应按 5 分钟虚拟切为 3 段，实际 ${payload.status.total_chunks}`);
    assert(payload.lesson.full_transcript.includes("导数综合题训练改名"), "转写稿没有合并课程信息");
    assert(payload.lesson.feedback_text.includes("今天这节课"), "反馈生成失败");

    const saved = await apiPut(`/api/lessons/${lessonResult.lesson.id}/feedback`, {
      teacher_edited_feedback: `${payload.lesson.feedback_text}\n老师已审核。`,
    });
    assert(saved.lesson.teacher_edited_feedback.includes("老师已审核"), "反馈保存失败");

    const transcriptOnlyLesson = await apiPost("/api/lessons", {
      student_id: studentResult.student.id,
      lesson_title: "只生成文字版测试",
      lesson_time: "2026-05-06T19:00:00",
    });
    const transcriptOnlyPreferences = await apiPut(`/api/lessons/${transcriptOnlyLesson.lesson.id}/preferences`, {
      feedback_generator: "none",
    });
    assert(transcriptOnlyPreferences.lesson.feedback_generator === "none", "只生成文字版偏好保存失败");

    const transcriptOnlyUpload = await fetch(`${BASE_URL}/api/lessons/${transcriptOnlyLesson.lesson.id}/recording`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-File-Name": encodeURIComponent("transcript-only.wav"),
        "X-File-Format": "audio/wav",
        "X-Audio-Duration-Sec": "120",
      },
      body: Buffer.from("mock audio bytes for transcript only"),
    });
    assert(transcriptOnlyUpload.status === 201, `只生成文字版上传失败: ${transcriptOnlyUpload.status} ${await transcriptOnlyUpload.text()}`);

    const transcriptOnlyPayload = await pollLesson(transcriptOnlyLesson.lesson.id);
    assert(transcriptOnlyPayload.lesson.status === "completed", `只生成文字版没有完成: ${transcriptOnlyPayload.lesson.status}`);
    assert(transcriptOnlyPayload.lesson.full_transcript.includes("只生成文字版测试"), "只生成文字版没有保留转写稿");
    assert(!transcriptOnlyPayload.lesson.feedback_text, "只生成文字版不应生成反馈");

    const feedbackOnlyStart = await apiPost(`/api/lessons/${transcriptOnlyLesson.lesson.id}/regenerate-feedback`, {
      style: "professional_warm",
      length: "medium",
      feedback_generator: "local_llm",
    });
    assert(feedbackOnlyStart.status === "summarizing", "只生成课后反馈没有进入生成状态");
    const feedbackOnlyPayload = await pollLesson(transcriptOnlyLesson.lesson.id);
    assert(feedbackOnlyPayload.lesson.status === "feedback_generated", `只生成课后反馈没有完成: ${feedbackOnlyPayload.lesson.status}`);
    assert(feedbackOnlyPayload.lesson.feedback_text.includes("妈妈您好"), "只生成课后反馈没有使用家长反馈结构");
    assert(feedbackOnlyPayload.lesson.full_transcript.includes("只生成文字版测试"), "只生成课后反馈不应清空录音文字版");

    const twoPartLesson = await apiPost("/api/lessons", {
      student_id: studentResult.student.id,
      lesson_title: "两段录音测试",
      lesson_time: "2026-05-07T19:00:00",
    });
    const batchId = `smoke-${Date.now()}`;
    for (const part of [1, 2]) {
      const response = await fetch(`${BASE_URL}/api/lessons/${twoPartLesson.lesson.id}/recording`, {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-File-Name": encodeURIComponent(`two-part-${part}.wav`),
          "X-File-Format": "audio/wav",
          "X-Audio-Duration-Sec": "120",
          "X-Recording-Batch-Id": batchId,
          "X-Recording-Order": String(part),
          "X-Recording-Total": "2",
        },
        body: Buffer.from(`mock audio bytes for part ${part}`),
      });
      assert(response.status === 201, `第 ${part} 段上传失败: ${response.status} ${await response.text()}`);
    }
    const twoPartPayload = await pollLesson(twoPartLesson.lesson.id);
    assert(twoPartPayload.lesson.status === "feedback_generated", `两段录音没有完成: ${twoPartPayload.lesson.status}`);
    assert(twoPartPayload.status.total_chunks === 2, `两段录音应产生 2 个虚拟切片，实际 ${twoPartPayload.status.total_chunks}`);
    assert(twoPartPayload.lesson.full_transcript.includes("第1段录音"), "合并转写稿缺少第一段录音标记");
    assert(twoPartPayload.lesson.full_transcript.includes("第2段录音"), "合并转写稿缺少第二段录音标记");

  } finally {
    server.kill("SIGTERM");
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  }
}

async function runAuthFlow() {
  const authPort = PORT + 1;
  const authBaseUrl = `http://${HOST}:${authPort}`;
  const authDataDir = path.join(os.tmpdir(), `teacher-feedback-auth-${process.pid}-${Date.now()}`);
  await fs.mkdir(authDataDir, { recursive: true });
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOST,
      PORT: String(authPort),
      DATA_DIR: authDataDir,
      AI_PROVIDER: "mock",
      ALLOW_EXTERNAL_API_COST: "0",
      APP_ACCESS_TOKEN: "secret-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(server);
    const denied = await fetch(`${authBaseUrl}/api/students`);
    assert(denied.status === 401, `未登录访问应被拒绝，实际 ${denied.status}`);

    const badLogin = await fetch(`${authBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "wrong" }),
    });
    assert(badLogin.status === 401, `错误口令应被拒绝，实际 ${badLogin.status}`);

    const goodLogin = await fetch(`${authBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "secret-token" }),
    });
    assert(goodLogin.status === 200, `正确口令登录失败，实际 ${goodLogin.status}`);
    const cookie = goodLogin.headers.get("set-cookie") || "";
    assert(cookie.includes("teacher_token="), "登录没有返回鉴权 Cookie");

    const allowed = await fetch(`${authBaseUrl}/api/students`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert(allowed.status === 200, `携带 Cookie 访问失败，实际 ${allowed.status}`);
  } finally {
    server.kill("SIGTERM");
    await fs.rm(authDataDir, { recursive: true, force: true });
  }
}

async function pollLesson(lessonId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const payload = await apiGet(`/api/lessons/${lessonId}`);
    if (["feedback_generated", "completed", "failed"].includes(payload.lesson.status)) {
      return payload;
    }
    await delay(350);
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

  const deadline = Date.now() + 8000;
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

async function apiGet(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { Accept: "application/json" },
  });
  return parseResponse(response);
}

async function apiPost(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return parseResponse(response);
}

async function apiPut(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
