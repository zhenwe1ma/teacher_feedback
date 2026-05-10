"use strict";

const fs = require("fs/promises");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const AUDIO_PATH = process.argv[2] || "/tmp/teacher-feedback-generated.wav";
const DURATION_SEC = Number(process.env.TEST_AUDIO_SECONDS || 620);
const SAMPLE_RATE = 8000;

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  await generateWav(AUDIO_PATH, DURATION_SEC);
  const stat = await fs.stat(AUDIO_PATH);
  console.log(`生成录音: ${AUDIO_PATH}`);
  console.log(`录音信息: ${formatBytes(stat.size)}, ${DURATION_SEC}s, WAV PCM mono ${SAMPLE_RATE}Hz`);

  const config = await apiGet("/api/config");
  assert(config.effectiveAiMode === "mock", "当前服务不是 mock 模式，测试已停止，避免产生外部 API 费用");
  assert(config.externalApiCostAllowed === false, "ALLOW_EXTERNAL_API_COST 已打开，测试已停止");
  console.log(`费用保护: ${config.effectiveAiMode}, externalApiCostAllowed=${config.externalApiCostAllowed}`);

  const student = (await apiPost("/api/students", {
    name: "生成录音测试学生",
    grade: "高二",
    notes: "自动生成 WAV 端到端测试",
  })).student;

  try {
    const lesson = (await apiPost("/api/lessons", {
      student_id: student.id,
      lesson_title: "自动生成录音测试",
      lesson_time: "2026-05-06T00:00:00",
    })).lesson;

    const audioBuffer = await fs.readFile(AUDIO_PATH);
    const upload = await fetch(`${BASE_URL}/api/lessons/${lesson.id}/recording`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-File-Name": encodeURIComponent(path.basename(AUDIO_PATH)),
        "X-File-Format": "audio/wav",
        "X-Audio-Duration-Sec": String(DURATION_SEC),
      },
      body: audioBuffer,
    });
    assert(upload.status === 201, `上传失败: ${upload.status} ${await upload.text()}`);

    const result = await pollLesson(lesson.id);
    const expectedChunks = Math.ceil(DURATION_SEC / config.chunkSeconds);
    assert(result.lesson.status === "feedback_generated", `课程没有生成反馈: ${result.lesson.status}`);
    assert(result.recording.original_audio_size === stat.size, "原始录音大小没有正确保存");
    assert(result.status.total_chunks === expectedChunks, `切片数量不对: expected=${expectedChunks}, actual=${result.status.total_chunks}`);
    assert(result.status.completed_chunks === expectedChunks, "不是所有切片都完成");
    assert(result.lesson.full_transcript.includes("自动生成录音测试"), "完整转写稿没有合并课程信息");
    assert(result.lesson.feedback_text.includes("今天这节课"), "反馈文本没有生成");

    console.log(`课程状态: ${result.lesson.status}`);
    console.log(`切片结果: ${result.status.completed_chunks}/${result.status.total_chunks}`);
    console.log(`原始录音已保存: ${result.recording.original_audio_filename}, ${formatBytes(result.recording.original_audio_size)}`);
    console.log(`反馈预览: ${result.lesson.feedback_text.slice(0, 90).replace(/\s+/g, " ")}...`);
  } finally {
    if (process.env.KEEP_TEST_DATA !== "1") {
      await apiDelete(`/api/students/${student.id}`);
      console.log("测试数据已清理");
    }
  }
}

async function generateWav(filePath, seconds) {
  const samples = SAMPLE_RATE * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const t = index / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * (220 + (Math.floor(t / 20) % 3) * 55) * t);
    const envelope = Math.floor(t) % 12 < 8 ? 0.22 : 0.04;
    buffer.writeInt16LE(Math.round(tone * envelope * 32767), 44 + index * 2);
  }
  await fs.writeFile(filePath, buffer);
}

async function pollLesson(lessonId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const payload = await apiGet(`/api/lessons/${lessonId}`);
    if (["feedback_generated", "completed", "failed"].includes(payload.lesson.status)) {
      return payload;
    }
    await delay(500);
  }
  throw new Error("等待课程处理超时");
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
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (process.env.TEST_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.TEST_ACCESS_TOKEN}`;
  }
  return headers;
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
