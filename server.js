"use strict";

const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

loadDotEnv();

const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const NORMALIZED_DIR = path.join(DATA_DIR, "normalized");
const CHUNK_DIR = path.join(DATA_DIR, "chunks");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 300);
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
const AI_PROVIDER = (process.env.AI_PROVIDER || "mock").toLowerCase();
const ALLOW_EXTERNAL_API_COST = parseBoolean(process.env.ALLOW_EXTERNAL_API_COST);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const MAX_LIVE_AUDIO_MB = Number(process.env.MAX_LIVE_AUDIO_MB || 80);
const MAX_OPENAI_AUDIO_MB = Number(process.env.MAX_OPENAI_AUDIO_MB || 25);
const MAX_AUTO_RETRIES = 3;
const APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || "";
const LOCAL_TRANSCRIBE_PYTHON = process.env.LOCAL_TRANSCRIBE_PYTHON || "python3";
const LOCAL_WHISPER_MODEL = process.env.LOCAL_WHISPER_MODEL || "medium";
const LOCAL_WHISPER_LANGUAGE = process.env.LOCAL_WHISPER_LANGUAGE || "zh";
const LOCAL_WHISPER_BATCH_ENABLED = process.env.LOCAL_WHISPER_BATCH_ENABLED === undefined
  ? true
  : parseBoolean(process.env.LOCAL_WHISPER_BATCH_ENABLED);
const LOCAL_TRANSCRIBE_SCRIPT = path.join(ROOT_DIR, "scripts", "transcribe_local.py");
const LOCAL_DEP_MARKER = path.join(ROOT_DIR, ".pydeps", "faster_whisper");
const LOCAL_LLM_BASE_URL = (process.env.LOCAL_LLM_BASE_URL || "").replace(/\/$/, "");
const LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY || "";
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "";
const DEFAULT_FEEDBACK_GENERATOR = cleanString(process.env.DEFAULT_FEEDBACK_GENERATOR || "local_llm").toLowerCase();
const DEFAULT_FEEDBACK_STYLE = "professional_warm";
const SUMMARY_GROUP_SECTION_COUNT = Math.max(1, Number(process.env.SUMMARY_GROUP_SECTION_COUNT || 2));
const SUMMARY_HIERARCHY_SECTION_THRESHOLD = 6;
const SUMMARY_HIERARCHY_TEXT_THRESHOLD = 12000;
const LOCAL_LLM_REQUEST_TIMEOUT_MS = Math.max(60_000, Number(process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS || 900_000));
const OPENAI_CHAT_REQUEST_TIMEOUT_MS = Math.max(30_000, Number(process.env.OPENAI_CHAT_REQUEST_TIMEOUT_MS || 180_000));
const TOPIC_HINT_RULES = [
  {
    label: "分段函数零点与函数图像",
    keywords: ["分段函数", "零点", "图像", "指数函数", "对勾", "飘带", "函数图像", "交点问题"],
  },
  {
    label: "经验回归方程与样本相关系数",
    keywords: ["回归方程", "经验回归方程", "样本相关系数", "小r", "大r", "斜率", "截距", "平均值"],
  },
  {
    label: "外心重心垂心、欧拉线与直线和圆",
    keywords: ["外心", "重心", "垂心", "欧拉线", "中垂线", "中线", "高线", "圆心", "切线长", "弦长", "纯金定理"],
  },
  {
    label: "奇偶函数与定义域对称",
    keywords: ["奇函数", "偶函数", "定义域", "对称", "绝对值", "x不等于m"],
  },
  {
    label: "古典概型与排列组合",
    keywords: ["古典概型", "概率", "有放回", "取球", "排列", "组合", "不同整数", "分母", "分子"],
  },
  {
    label: "立体几何中的平行证明与面积条件",
    keywords: ["立体几何", "平行", "菱形", "面积", "底高", "正弦", "体积", "棱锥", "柱体", "相似"],
  },
  {
    label: "空间向量建系、线面角与最值",
    keywords: ["空间向量", "建系", "坐标", "动点", "线面角", "数量积", "最值", "二次函数", "lambda", "向量"],
  },
  {
    label: "三角函数与解三角形",
    keywords: ["三角函数", "解三角形", "sin", "cos", "tan"],
  },
];

let db = null;
const activeJobs = new Set();

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  await ensureStorage();
  db = await loadDb();
  if (migrateLegacyFeedbackGenerators()) {
    await saveDb();
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: error.message || "服务器内部错误" });
    });
  });

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const accessInfo = getAccessInfo(address?.port || PORT);
    console.log(`teacher-feedback app listening on ${accessInfo.localUrl}`);
    if (accessInfo.lanUrls.length > 0) {
      console.log(`teacher-feedback LAN access: ${accessInfo.lanUrls.join(", ")}`);
    }
    resumeInterruptedJobs();
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, pathname, url);
    return;
  }

  await serveStatic(req, res, pathname);
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, await buildConfigPayload(req));
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(req);
    if (!APP_ACCESS_TOKEN || tokenMatches(cleanString(body.access_token))) {
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": cookieHeader("teacher_token", APP_ACCESS_TOKEN || "local"),
      });
      return;
    }
    sendJson(res, 401, { error: "访问口令不正确" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": "teacher_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    });
    return;
  }

  if (APP_ACCESS_TOKEN && !isAuthorized(req)) {
    sendJson(res, 401, { error: "需要登录后访问" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/local-llm/models") {
    sendJson(res, 200, await buildLocalLlmModelsPayload());
    return;
  }

  if (req.method === "PUT" && pathname === "/api/settings/local-llm") {
    const body = await readJson(req);
    const model = requiredString(body.model || body.local_llm_model, "本地模型不能为空");
    const runtime = await getLocalLlmRuntimeInfo();
    const availableModels = uniqueStrings(runtime.models);
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      sendJson(res, 409, { error: `模型 ${model} 当前不在本地可用列表中，请先完成下载或刷新模型列表。` });
      return;
    }
    db.settings = db.settings || {};
    db.settings.local_llm_model = model;
    await saveDb();
    sendJson(res, 200, {
      ok: true,
      config: await buildConfigPayload(req),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/students") {
    sendJson(res, 200, { students: db.students });
    return;
  }

  if (req.method === "POST" && pathname === "/api/students") {
    const body = await readJson(req);
    const now = nowIso();
    const student = {
      id: nextId("students"),
      name: requiredString(body.name, "学生姓名不能为空"),
      grade: cleanString(body.grade),
      parent_contact: cleanString(body.parent_contact),
      notes: cleanString(body.notes),
      created_at: now,
      updated_at: now,
    };
    db.students.push(student);
    await saveDb();
    sendJson(res, 201, { student });
    return;
  }

  if (req.method === "DELETE" && matchPath(pathname, "/api/students/:id")) {
    const { id } = matchPath(pathname, "/api/students/:id");
    const studentId = Number(id);
    db.students = db.students.filter((student) => student.id !== studentId);
    const lessons = db.lessons.filter((lesson) => lesson.student_id === studentId);
    for (const lesson of lessons) {
      await deleteLessonFiles(lesson.id);
    }
    db.lessons = db.lessons.filter((lesson) => lesson.student_id !== studentId);
    db.recordings = db.recordings.filter((recording) => recording.student_id !== studentId);
    db.chunks = db.chunks.filter((chunk) => chunk.student_id !== studentId);
    await saveDb();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && matchPath(pathname, "/api/students/:id/lessons")) {
    const { id } = matchPath(pathname, "/api/students/:id/lessons");
    const studentId = Number(id);
    const lessons = db.lessons
      .filter((lesson) => lesson.student_id === studentId)
      .sort((a, b) => String(b.lesson_time || b.created_at).localeCompare(String(a.lesson_time || a.created_at)));
    sendJson(res, 200, { lessons });
    return;
  }

  if (req.method === "POST" && pathname === "/api/lessons") {
    const body = await readJson(req);
    const studentId = Number(body.student_id);
    const student = db.students.find((item) => item.id === studentId);
    if (!student) {
      sendJson(res, 404, { error: "学生不存在" });
      return;
    }
    const now = nowIso();
    const lesson = {
      id: nextId("lessons"),
      student_id: studentId,
      lesson_title: cleanString(body.lesson_title) || `${student.name} 的课堂记录`,
      lesson_time: cleanString(body.lesson_time) || now,
      feedback_generator: validateFeedbackGenerator(body.feedback_generator, false),
      feedback_style: validateFeedbackStyle(body.feedback_style, false),
      duration_sec: null,
      status: "created",
      full_transcript: "",
      structured_summary: null,
      feedback_text: "",
      teacher_edited_feedback: "",
      error_message: "",
      created_at: now,
      updated_at: now,
    };
    db.lessons.push(lesson);
    await saveDb();
    sendJson(res, 201, { lesson });
    return;
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/lessons/:id/preferences")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/preferences");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    const body = await readJson(req);
    if (body.feedback_generator !== undefined) {
      lesson.feedback_generator = validateFeedbackGenerator(body.feedback_generator, true);
    }
    if (body.feedback_style !== undefined) {
      lesson.feedback_style = validateFeedbackStyle(body.feedback_style, true);
    }
    lesson.updated_at = nowIso();
    await saveDb();
    sendJson(res, 200, lessonPayload(lesson));
    return;
  }

  if (req.method === "GET" && matchPath(pathname, "/api/lessons/:id")) {
    const { id } = matchPath(pathname, "/api/lessons/:id");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    sendJson(res, 200, lessonPayload(lesson));
    return;
  }

  if (req.method === "DELETE" && matchPath(pathname, "/api/lessons/:id")) {
    const { id } = matchPath(pathname, "/api/lessons/:id");
    const lessonId = Number(id);
    await deleteLessonFiles(lessonId);
    db.lessons = db.lessons.filter((lesson) => lesson.id !== lessonId);
    db.recordings = db.recordings.filter((recording) => recording.lesson_id !== lessonId);
    db.chunks = db.chunks.filter((chunk) => chunk.lesson_id !== lessonId);
    await saveDb();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && matchPath(pathname, "/api/lessons/:id/recording")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/recording");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    await receiveRecording(req, res, lesson);
    return;
  }

  if (req.method === "GET" && matchPath(pathname, "/api/lessons/:id/status")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/status");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    sendJson(res, 200, statusPayload(lesson.id));
    return;
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/lessons/:id/feedback")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/feedback");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    const body = await readJson(req);
    lesson.teacher_edited_feedback = cleanString(body.teacher_edited_feedback);
    lesson.updated_at = nowIso();
    await saveDb();
    sendJson(res, 200, lessonPayload(lesson));
    return;
  }

  if (req.method === "POST" && matchPath(pathname, "/api/lessons/:id/regenerate-feedback")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/regenerate-feedback");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    const body = await readJson(req);
    if (!lesson.full_transcript) {
      sendJson(res, 409, { error: "还没有完整转写稿，不能重新生成反馈" });
      return;
    }
    lesson.status = "summarizing";
    lesson.error_message = "";
    if (body.feedback_generator !== undefined) {
      lesson.feedback_generator = validateFeedbackGenerator(body.feedback_generator, true);
    }
    if (body.style !== undefined) {
      lesson.feedback_style = validateFeedbackStyle(body.style, true);
    }
    lesson.updated_at = nowIso();
    await saveDb();
    runInBackground(`regenerate:${lesson.id}:${Date.now()}`, async () => {
      await summarizeAndGenerate(lesson.id, {
        style: getLessonFeedbackStyle(lesson),
        length: cleanString(body.length) || "medium",
        generator: lesson.feedback_generator,
      });
    });
    sendJson(res, 202, statusPayload(lesson.id));
    return;
  }

  if (req.method === "POST" && matchPath(pathname, "/api/lessons/:id/complete")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/complete");
    const lesson = findLesson(Number(id));
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    lesson.status = "completed";
    lesson.updated_at = nowIso();
    await saveDb();
    sendJson(res, 200, lessonPayload(lesson));
    return;
  }

  if (req.method === "GET" && matchPath(pathname, "/api/lessons/:id/audio")) {
    const { id } = matchPath(pathname, "/api/lessons/:id/audio");
    const recording = latestRecording(Number(id));
    if (!recording || !recording.original_audio_path) {
      sendJson(res, 404, { error: "录音不存在" });
      return;
    }
    await streamPrivateFile(res, recording.original_audio_path, recording.original_audio_filename);
    return;
  }

  if (req.method === "POST" && matchPath(pathname, "/api/chunks/:id/retry")) {
    const { id } = matchPath(pathname, "/api/chunks/:id/retry");
    const chunk = db.chunks.find((item) => item.id === Number(id));
    if (!chunk) {
      sendJson(res, 404, { error: "切片不存在" });
      return;
    }
    if (chunk.retry_count >= MAX_AUTO_RETRIES) {
      sendJson(res, 409, { error: `该切片已达到 ${MAX_AUTO_RETRIES} 次重试上限` });
      return;
    }
    const lesson = findLesson(chunk.lesson_id);
    if (!lesson) {
      sendJson(res, 404, { error: "课程不存在" });
      return;
    }
    lesson.status = "transcribing";
    lesson.error_message = "";
    chunk.transcription_status = "pending";
    chunk.error_message = "";
    chunk.updated_at = nowIso();
    await saveDb();
    runInBackground(`retry-chunk:${chunk.id}:${Date.now()}`, async () => {
      await processChunkWithRetry(chunk.id, true);
      await finalizeIfChunksComplete(chunk.lesson_id);
    });
    sendJson(res, 202, statusPayload(lesson.id));
    return;
  }

  sendJson(res, 404, { error: "接口不存在" });
}

async function receiveRecording(req, res, lesson) {
  const contentType = req.headers["content-type"] || "";
  const now = nowIso();
  const uploadId = crypto.randomUUID();
  const lessonDir = path.join(UPLOAD_DIR, String(lesson.id));
  await fsp.mkdir(lessonDir, { recursive: true });

  let saved = null;
  if (contentType.startsWith("multipart/form-data")) {
    saved = await receiveMultipartRecording(req, lessonDir, uploadId, contentType);
  } else {
    saved = await receiveRawRecording(req, lessonDir, uploadId);
  }

  await replaceLessonRecording(lesson.id, saved.path);

  lesson.status = "audio_uploaded";
  lesson.duration_sec = saved.durationSec;
  lesson.full_transcript = "";
  lesson.structured_summary = null;
  lesson.feedback_text = "";
  lesson.teacher_edited_feedback = "";
  lesson.error_message = "";
  lesson.updated_at = now;

  const recording = {
    id: nextId("recordings"),
    lesson_id: lesson.id,
    student_id: lesson.student_id,
    original_audio_url: privateUrlFor("audio", lesson.id),
    original_audio_path: saved.path,
    original_audio_filename: saved.filename,
    original_audio_size: saved.size,
    original_audio_duration_sec: saved.durationSec,
    original_audio_format: saved.format,
    normalized_audio_url: "",
    normalized_audio_path: "",
    upload_status: "uploaded",
    transcription_status: "pending",
    created_at: now,
    updated_at: now,
  };
  db.recordings.push(recording);
  await saveDb();

  runInBackground(`recording:${recording.id}`, async () => {
    await processUploadedAudio(recording.id);
  });

  sendJson(res, 201, {
    lesson_id: lesson.id,
    recording_id: recording.id,
    status: "audio_uploaded",
  });
}

async function receiveRawRecording(req, lessonDir, uploadId) {
  const headerFilename = req.headers["x-file-name"] || "class-recording";
  const filename = safeFilename(decodeURIComponent(String(headerFilename)));
  const ext = path.extname(filename) || extFromContentType(req.headers["content-type"] || "") || ".audio";
  const storedName = `${uploadId}${ext}`;
  const targetPath = path.join(lessonDir, storedName);
  await pipeToFile(req, targetPath);
  const stat = await fsp.stat(targetPath);
  return {
    path: targetPath,
    filename,
    size: stat.size,
    format: cleanString(req.headers["x-file-format"]) || ext.replace(".", ""),
    durationSec: positiveNumber(req.headers["x-audio-duration-sec"]),
  };
}

async function receiveMultipartRecording(req, lessonDir, uploadId, contentType) {
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error("缺少 multipart boundary");
  }
  const buffer = await readBuffer(req);
  const parts = parseMultipart(buffer, boundary);
  const audioPart = parts.find((part) => part.filename && part.name === "audio_file") || parts.find((part) => part.filename);
  if (!audioPart) {
    throw new Error("没有找到 audio_file 文件字段");
  }
  const filename = safeFilename(audioPart.filename || "class-recording");
  const ext = path.extname(filename) || extFromContentType(audioPart.contentType) || ".audio";
  const targetPath = path.join(lessonDir, `${uploadId}${ext}`);
  await fsp.writeFile(targetPath, audioPart.body);
  return {
    path: targetPath,
    filename,
    size: audioPart.body.length,
    format: ext.replace(".", ""),
    durationSec: positiveNumber(parts.find((part) => part.name === "duration_sec")?.body.toString("utf8")),
  };
}

async function processUploadedAudio(recordingId) {
  const guardKey = `process-recording:${recordingId}`;
  if (activeJobs.has(guardKey)) {
    return;
  }
  activeJobs.add(guardKey);
  try {
    const recording = db.recordings.find((item) => item.id === recordingId);
    if (!recording) {
      return;
    }
    const lesson = findLesson(recording.lesson_id);
    if (!lesson) {
      return;
    }

    lesson.status = "audio_processing";
    lesson.error_message = "";
    lesson.updated_at = nowIso();
    recording.transcription_status = "processing";
    recording.updated_at = nowIso();
    await saveDb();

    const metadata = await getAudioMetadata(recording.original_audio_path, recording.original_audio_format);
    recording.original_audio_duration_sec = recording.original_audio_duration_sec || metadata.durationSec;
    recording.original_audio_format = recording.original_audio_format || metadata.format;
    lesson.duration_sec = lesson.duration_sec || metadata.durationSec;
    await saveDb();

    await createChunks(recording.id);

    lesson.status = "transcribing";
    lesson.updated_at = nowIso();
    recording.transcription_status = "transcribing";
    await saveDb();

    const chunks = db.chunks
      .filter((chunk) => chunk.recording_id === recording.id)
      .sort((a, b) => a.chunk_index - b.chunk_index);

    const pendingChunks = chunks.filter((chunk) => chunk.transcription_status !== "completed");
    if (getEffectiveAiMode() === "local" && LOCAL_WHISPER_BATCH_ENABLED && pendingChunks.length > 1) {
      await processLocalChunksInBatch(pendingChunks);
    } else {
      for (const chunk of pendingChunks) {
        try {
          await processChunkWithRetry(chunk.id, false);
        } catch (error) {
          console.warn(`切片 ${chunk.id} 转写失败: ${error.message}`);
        }
      }
    }

    await finalizeIfChunksComplete(lesson.id);
  } catch (error) {
    await markLessonFailedByRecording(recordingId, error);
  } finally {
    activeJobs.delete(guardKey);
  }
}

async function createChunks(recordingId) {
  const recording = db.recordings.find((item) => item.id === recordingId);
  if (!recording) {
    throw new Error("录音记录不存在");
  }
  const existing = db.chunks.filter((chunk) => chunk.recording_id === recording.id);
  if (existing.length > 0) {
    return existing;
  }

  const ffmpeg = findOnPath("ffmpeg");
  if (ffmpeg) {
    try {
      return await createFfmpegChunks(recording, ffmpeg);
    } catch (error) {
      if (getEffectiveAiMode() === "openai") {
        throw error;
      }
      console.warn(`ffmpeg 切片失败，mock 模式下改用虚拟切片: ${error.message}`);
    }
  } else if (getEffectiveAiMode() === "openai") {
    const sizeMb = Number(recording.original_audio_size || 0) / 1024 / 1024;
    if (sizeMb > MAX_LIVE_AUDIO_MB) {
      throw new Error("当前环境缺少 ffmpeg，无法安全切片并转写大录音。请安装 ffmpeg 后再启用 live API。");
    }
  }

  if (getEffectiveAiMode() === "openai" || getEffectiveAiMode() === "local") {
    return createPassthroughChunk(recording);
  }

  return createVirtualChunks(recording);
}

async function createFfmpegChunks(recording, ffmpeg) {
  const lessonDir = path.join(CHUNK_DIR, String(recording.lesson_id), String(recording.id));
  const normalizedDir = path.join(NORMALIZED_DIR, String(recording.lesson_id));
  await fsp.mkdir(lessonDir, { recursive: true });
  await fsp.mkdir(normalizedDir, { recursive: true });

  const normalizedPath = path.join(normalizedDir, `${recording.id}.mp3`);
  await runCommand(ffmpeg, [
    "-y",
    "-i",
    recording.original_audio_path,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    normalizedPath,
  ]);

  const chunkPattern = path.join(lessonDir, "chunk_%03d.mp3");
  await runCommand(ffmpeg, [
    "-y",
    "-i",
    normalizedPath,
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-reset_timestamps",
    "1",
    "-c",
    "copy",
    chunkPattern,
  ]);

  const files = (await fsp.readdir(lessonDir))
    .filter((file) => /^chunk_\d+\.mp3$/.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error("ffmpeg 没有生成切片文件");
  }

  const now = nowIso();
  const chunks = [];
  files.forEach((file, index) => {
    const start = index * CHUNK_SECONDS;
    const end = Math.min((index + 1) * CHUNK_SECONDS, recording.original_audio_duration_sec || (index + 1) * CHUNK_SECONDS);
    const chunkPath = path.join(lessonDir, file);
    const chunk = {
      id: nextId("chunks"),
      recording_id: recording.id,
      lesson_id: recording.lesson_id,
      student_id: recording.student_id,
      chunk_index: index + 1,
      start_time_sec: start,
      end_time_sec: end,
      chunk_audio_url: privateUrlFor("chunk", recording.lesson_id, index + 1),
      chunk_audio_path: chunkPath,
      chunk_size: 0,
      transcript_text: "",
      transcription_status: "pending",
      retry_count: 0,
      error_message: "",
      virtual: false,
      created_at: now,
      updated_at: now,
    };
    chunks.push(chunk);
  });

  for (const chunk of chunks) {
    const stat = await fsp.stat(chunk.chunk_audio_path);
    chunk.chunk_size = stat.size;
    db.chunks.push(chunk);
  }

  recording.normalized_audio_path = normalizedPath;
  recording.normalized_audio_url = privateUrlFor("normalized", recording.lesson_id);
  await saveDb();
  return chunks;
}

function createVirtualChunks(recording) {
  const duration = Number(recording.original_audio_duration_sec || 0);
  const count = duration > 0 ? Math.max(1, Math.ceil(duration / CHUNK_SECONDS)) : 1;
  const now = nowIso();
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * CHUNK_SECONDS;
    const end = duration > 0 ? Math.min((index + 1) * CHUNK_SECONDS, duration) : CHUNK_SECONDS;
    const chunk = {
      id: nextId("chunks"),
      recording_id: recording.id,
      lesson_id: recording.lesson_id,
      student_id: recording.student_id,
      chunk_index: index + 1,
      start_time_sec: start,
      end_time_sec: end,
      chunk_audio_url: privateUrlFor("chunk", recording.lesson_id, index + 1),
      chunk_audio_path: recording.original_audio_path,
      chunk_size: recording.original_audio_size,
      transcript_text: "",
      transcription_status: "pending",
      retry_count: 0,
      error_message: "",
      virtual: true,
      created_at: now,
      updated_at: now,
    };
    db.chunks.push(chunk);
    chunks.push(chunk);
  }
  return chunks;
}

function createPassthroughChunk(recording) {
  const duration = Number(recording.original_audio_duration_sec || 0);
  const now = nowIso();
  const chunk = {
    id: nextId("chunks"),
    recording_id: recording.id,
    lesson_id: recording.lesson_id,
    student_id: recording.student_id,
    chunk_index: 1,
    start_time_sec: 0,
    end_time_sec: duration > 0 ? duration : CHUNK_SECONDS,
    chunk_audio_url: privateUrlFor("chunk", recording.lesson_id, 1),
    chunk_audio_path: recording.original_audio_path,
    chunk_size: recording.original_audio_size,
    transcript_text: "",
    transcription_status: "pending",
    retry_count: 0,
    error_message: "",
    virtual: false,
    created_at: now,
    updated_at: now,
  };
  db.chunks.push(chunk);
  return [chunk];
}

async function processChunkWithRetry(chunkId, manualRetry) {
  const chunk = db.chunks.find((item) => item.id === chunkId);
  if (!chunk) {
    throw new Error("切片不存在");
  }
  if (!manualRetry && chunk.retry_count >= MAX_AUTO_RETRIES) {
    throw new Error(`该切片已达到 ${MAX_AUTO_RETRIES} 次重试上限`);
  }

  const maxAttempts = manualRetry ? 1 : Math.max(1, MAX_AUTO_RETRIES - chunk.retry_count);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await transcribeChunk(chunk.id);
      return;
    } catch (error) {
      lastError = error;
      chunk.retry_count += 1;
      chunk.transcription_status = "failed";
      chunk.error_message = error.message || "转写失败";
      chunk.updated_at = nowIso();
      await saveDb();
      if (chunk.retry_count >= MAX_AUTO_RETRIES) {
        break;
      }
    }
  }

  throw lastError || new Error("切片转写失败");
}

async function processLocalChunksInBatch(chunks) {
  let pending = chunks.filter((chunk) => chunk.transcription_status !== "completed" && chunk.retry_count < MAX_AUTO_RETRIES);
  while (pending.length > 0) {
    for (const chunk of pending) {
      chunk.transcription_status = "transcribing";
      chunk.error_message = "";
      chunk.updated_at = nowIso();
    }
    await saveDb();

    let results = [];
    let batchError = null;
    try {
      const output = await runCommand(LOCAL_TRANSCRIBE_PYTHON, [
        LOCAL_TRANSCRIBE_SCRIPT,
        "--batch",
        LOCAL_WHISPER_MODEL,
        LOCAL_WHISPER_LANGUAGE,
        ...pending.map((chunk) => chunk.chunk_audio_path),
      ]);
      results = JSON.parse(output.stdout || "{}").results || [];
    } catch (error) {
      batchError = error;
    }

    const resultByPath = new Map(results.map((result) => [result.path, result]));
    for (const chunk of pending) {
      const result = resultByPath.get(chunk.chunk_audio_path);
      if (!batchError && result && !result.error) {
        chunk.transcript_text = cleanString(result.text);
        chunk.transcription_status = "completed";
        chunk.error_message = "";
      } else {
        chunk.retry_count += 1;
        chunk.transcription_status = "failed";
        chunk.error_message = batchError?.message || result?.error || "转写失败";
      }
      chunk.updated_at = nowIso();
    }
    await saveDb();

    pending = chunks.filter((chunk) => chunk.transcription_status !== "completed" && chunk.retry_count < MAX_AUTO_RETRIES);
  }
}

async function transcribeChunk(chunkId) {
  const chunk = db.chunks.find((item) => item.id === chunkId);
  if (!chunk) {
    throw new Error("切片不存在");
  }
  chunk.transcription_status = "transcribing";
  chunk.error_message = "";
  chunk.updated_at = nowIso();
  await saveDb();

  const mode = getEffectiveAiMode();
  const text = mode === "openai"
    ? await transcribeWithOpenAi(chunk)
    : mode === "local"
      ? await transcribeWithLocal(chunk)
      : await transcribeWithMock(chunk);

  chunk.transcript_text = text;
  chunk.transcription_status = "completed";
  chunk.updated_at = nowIso();
  await saveDb();
}

async function transcribeWithOpenAi(chunk) {
  const recording = db.recordings.find((item) => item.id === chunk.recording_id);
  if (!recording) {
    throw new Error("录音记录不存在");
  }
  const sizeMb = Number(chunk.chunk_size || recording.original_audio_size || 0) / 1024 / 1024;
  if (sizeMb > MAX_OPENAI_AUDIO_MB) {
    throw new Error(`音频大小 ${sizeMb.toFixed(1)}MB 超过 OpenAI 直传上限 ${MAX_OPENAI_AUDIO_MB}MB，请安装 ffmpeg 后再切片转写`);
  }

  const audioBuffer = await fsp.readFile(chunk.chunk_audio_path);
  const ext = path.extname(chunk.chunk_audio_path) || path.extname(recording.original_audio_filename) || ".mp3";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: MIME_BY_EXT[ext] || "application/octet-stream" }), `chunk_${chunk.chunk_index}${ext}`);
  form.append("model", OPENAI_TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("language", "zh");
  form.append("prompt", "高中数学课堂录音，可能包含老师讲解、学生回答、题型名称和数学术语。");

  const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI 转写失败: ${response.status} ${errorText.slice(0, 500)}`);
  }
  const result = await response.json();
  return cleanString(result.text);
}

async function transcribeWithLocal(chunk) {
  if (!isLocalAiEnabled()) {
    throw new Error("本地转写依赖不可用");
  }
  const output = await runCommand(LOCAL_TRANSCRIBE_PYTHON, [
    LOCAL_TRANSCRIBE_SCRIPT,
    chunk.chunk_audio_path,
    LOCAL_WHISPER_MODEL,
    LOCAL_WHISPER_LANGUAGE,
  ]);
  const parsed = JSON.parse(output.stdout || "{}");
  return cleanString(parsed.text);
}

async function transcribeWithMock(chunk) {
  await delay(350);
  const lesson = findLesson(chunk.lesson_id);
  const student = db.students.find((item) => item.id === lesson?.student_id);
  return [
    `[${formatTime(chunk.start_time_sec)}-${formatTime(chunk.end_time_sec)}]`,
    `本段为无费用演示转写。老师围绕${lesson?.lesson_title || "本节课内容"}进行讲解，`,
    `${student?.name || "学生"}能够跟随老师完成主要步骤，基础题反应较快；`,
    "在综合题的条件梳理、分类讨论和计算细节上还需要继续训练。",
  ].join("");
}

async function finalizeIfChunksComplete(lessonId) {
  const lesson = findLesson(lessonId);
  if (!lesson) {
    return;
  }
  const recording = latestRecording(lessonId);
  if (!recording) {
    return;
  }
  const chunks = db.chunks
    .filter((chunk) => chunk.recording_id === recording.id)
    .sort((a, b) => a.chunk_index - b.chunk_index);
  if (chunks.length === 0) {
    return;
  }
  const failed = chunks.filter((chunk) => chunk.transcription_status === "failed");
  if (failed.length > 0) {
    lesson.status = "failed";
    lesson.error_message = `有 ${failed.length} 个切片转写失败，可单独重试失败切片。`;
    lesson.full_transcript = mergeTranscript(chunks);
    lesson.updated_at = nowIso();
    await saveDb();
    return;
  }
  const completed = chunks.every((chunk) => chunk.transcription_status === "completed");
  if (!completed) {
    return;
  }

  lesson.status = "transcribed";
  lesson.full_transcript = mergeTranscript(chunks);
  lesson.updated_at = nowIso();
  recording.transcription_status = "completed";
  recording.updated_at = nowIso();
  await saveDb();
  await summarizeAndGenerate(lesson.id, {
    style: getLessonFeedbackStyle(lesson),
    length: "medium",
    generator: lesson.feedback_generator,
  });
}

async function summarizeAndGenerate(lessonId, options = {}) {
  const lesson = findLesson(lessonId);
  if (!lesson) {
    return;
  }
  lesson.status = "summarizing";
  lesson.error_message = "";
  lesson.updated_at = nowIso();
  await saveDb();

  try {
    const mode = getEffectiveAiMode();
    const generator = validateFeedbackGenerator(options.generator ?? lesson.feedback_generator, true);
    const style = validateFeedbackStyle(options.style ?? lesson.feedback_style, false);
    const recording = latestRecording(lesson.id);
    const summary = mode === "mock"
      ? await summarizeWithMock(lesson)
      : await summarizeWithLlm(lesson.full_transcript, generator);
    lesson.structured_summary = summary;
    lesson.feedback_generator = generator;
    lesson.feedback_style = style;
    lesson.feedback_text = mode === "mock"
      ? await feedbackWithMock(lesson, summary, { ...options, style })
      : await feedbackWithLlm(summary, { ...options, style }, generator);
    lesson.teacher_edited_feedback = lesson.feedback_text;
    lesson.status = "feedback_generated";
    lesson.updated_at = nowIso();
    if (recording) {
      recording.transcription_status = "completed";
      recording.updated_at = nowIso();
    }
    await saveDb();
  } catch (error) {
    lesson.status = "failed";
    lesson.error_message = error.message || "生成反馈失败";
    lesson.updated_at = nowIso();
    await saveDb();
    throw error;
  }
}

async function summarizeWithLlm(transcript, generator) {
  const sections = splitTranscriptSections(transcript);
  const globalHints = buildTranscriptCoverageHints(transcript, sections);
  if (shouldUseHierarchicalSummary(sections, transcript)) {
    const groups = groupItems(sections, SUMMARY_GROUP_SECTION_COUNT);
    const partials = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const partial = await summarizeTranscriptBlockWithLlm(group, index + 1, groups.length, generator);
      partials.push({
        range: buildSectionRangeLabel(group),
        summary: partial,
      });
    }
    return mergePartialSummariesWithLlm(partials, generator, globalHints);
  }
  return summarizeWholeTranscriptWithLlm(transcript, generator, globalHints);
}

async function summarizeWholeTranscriptWithLlm(transcript, generator, globalHints = null) {
  const content = [
    "你是一名经验丰富的高中数学老师，正在整理一整节数学课的结构化总结。",
    "目标：覆盖整节课，不要只盯最后一道题。",
    "要求：",
    "1. 只基于转写稿内容，不要编造。",
    "2. lesson_content 必须概括整节课主线，如果课堂覆盖多个题号或多个知识点，不能只写最后一个题。",
    "3. covered_topics 至少列出 6 个不同知识点或题型；如果课堂实际不足 6 个，再如实少写。",
    "4. lesson_segments 必须按时间顺序覆盖前半段、中段、后半段；中段如果主要是闲聊或过渡，可以明确写“少量闲聊/非核心教学内容”。",
    "5. 忽略寒暄、吃东西、录音测试、约时间等非教学内容，不要让这些内容进入 lesson_content、strengths、weaknesses。",
    "6. weaknesses 优先总结跨多道题反复出现的共性问题，不要只写最后一道题的局部问题。",
    "7. typical_examples 至少来自两个不同阶段，最后一道题最多占一条。",
    "8. student_performance 重点写整节课的课堂状态、理解速度、表达、图像、计算、方法切换等整体表现。",
    "9. correction_suggestions、homework_suggestion、next_lesson_focus 要对应今天课堂里真正暴露出的共性问题。",
    "10. coverage_check 里的 covered_early、covered_middle、covered_late、not_last_problem_only 必须如实填写。",
    "11. question_breakdown 至少写 4 条、至多写 8 条，优先覆盖不同题号或不同知识模块；每条都要写清 problem_ref、topic、teacher_focus、student_issue。",
    "12. feedback_required_mentions.early_topics 至少保留 3 个前半段知识点，late_topics 至少保留 2 个后半段知识点；如果课堂实际不足，再如实少写。",
    "13. feedback_required_mentions.recurring_issues 优先写整节课反复出现的共性问题；avoid_single_focus 固定写明不能只围绕最后一道题展开。",
    "14. 如果系统提示里已经识别到题号或知识点，且它们确实来自转写稿，最终总结应尽量覆盖，不要大面积遗漏前半段内容。",
    "15. 如果某些字段在转写稿中没有明确提及，请写“未明确提及”或留空数组。",
    "16. 只输出合法 JSON，不要额外解释。",
    "",
    "系统从转写稿提取到的覆盖提示：",
    formatCoverageHints(globalHints),
    "",
    "课堂转写稿：",
    transcript,
    "",
    "请按如下 JSON 格式输出：",
    JSON.stringify(structuredSummaryTemplate(), null, 2),
  ].join("\n");

  const text = await chatWithFeedbackGenerator(generator, [
    { role: "developer", content: "你只输出合法 JSON。" },
    { role: "user", content },
  ], {
    responseFormat: { type: "json_object" },
    maxTokens: 2200,
  });
  try {
    return normalizeStructuredSummary(parseJsonObject(text));
  } catch (error) {
    console.error("[DEBUG-json-merge]", JSON.stringify({
      textLength: String(text || "").length,
      preview: String(text || "").slice(0, 4000),
    }));
    throw error;
  }
}

async function summarizeTranscriptBlockWithLlm(group, blockIndex, totalBlocks, generator) {
  const blockTranscript = group
    .map((section) => `${section.label}\n${section.body}`)
    .join("\n\n");
  const blockHints = buildBlockCoverageHints(group);
  const content = [
    `你正在为一整节课做分段摘要。当前只总结第 ${blockIndex}/${totalBlocks} 个时间块，不要总结其他未提供的部分。`,
    "要求：",
    "1. 只基于当前时间块内容，不要脑补整节课。",
    "2. 如果当前时间块主要是闲聊、寒暄、吃东西、录音测试、约时间等非教学内容，teaching_relevance 写 low，并把 covered_topics 留空。",
    "3. 如果当前时间块有教学内容，提取这一段涉及的题号/知识点、学生表现、亮点、问题、典型例子和建议。",
    "4. covered_topics 如果有教学内容，尽量写满 2-4 条不同知识点；question_breakdown 尽量写 2-4 条不同题号或不同模块。",
    "5. 问题优先写这一段里反复出现或被老师明确指出的问题。",
    "6. 如果系统提示里识别到了题号或知识点，且它们确实来自当前时间块，请尽量覆盖，不要只保留最后一句话。",
    "7. 只输出合法 JSON，不要额外解释。",
    "",
    "当前时间块覆盖提示：",
    formatCoverageHints(blockHints),
    "",
    "当前时间块转写稿：",
    blockTranscript,
    "",
    "请按如下 JSON 格式输出：",
    JSON.stringify(transcriptBlockSummaryTemplate(), null, 2),
  ].join("\n");
  const text = await chatWithFeedbackGenerator(generator, [
    { role: "developer", content: "你只输出合法 JSON。" },
    { role: "user", content },
  ], {
    responseFormat: { type: "json_object" },
    maxTokens: 1200,
  });
  return normalizeTranscriptBlockSummary(parseJsonObject(text));
}

async function mergePartialSummariesWithLlm(partials, generator, globalHints = null) {
  void generator;
  return mergePartialSummariesDeterministically(partials, globalHints);
}

async function feedbackWithLlm(summary, options = {}, generator) {
  const style = validateFeedbackStyle(options.style, false);
  const styleSpec = getFeedbackStyleSpec(style);
  const content = [
    "你是一名高中数学老师。请根据下面的课堂结构化信息，生成一段适合发给家长的课后反馈。",
    "要求：",
    "1. 严格使用指定的反馈风格，不要混用。",
    "2. 不要太官方，不要像机器生成。",
    "3. 既要肯定学生，也要指出需要改进的地方。",
    `4. ${styleSpec.lengthRule}`,
    "5. 不要出现“根据转写稿”“AI”“模型”等字样。",
    "6. 不要编造课堂中没有出现的内容。",
    "7. 必须优先使用 feedback_required_mentions、covered_topics、lesson_segments、question_breakdown、recurring_weaknesses 去覆盖整节课，不能只围绕最后一道题展开。",
    "8. 输出结构固定参考老师日常“课后反馈”口吻：",
    "   - 第一部分：先向家长问好，再用一句话概括本节课主线，然后写“主要内容包括：”",
    "   - 第二部分：写“掌握得较好的部分：”",
    "   - 第三部分：写“还需要加强的部分：”",
    "9. 如果课堂明显是在订正一张卷子或集中梳理多道题，第一部分必须明确写出“围绕试卷中的疑问题进行订正和梳理”这类意思，不要误写成只讲一个专题。",
    "10. “主要内容包括”后面写 4-6 条编号内容，每条概括一个知识模块、题型或方法，不按题号顺序复述课堂过程，不要写成逐题流水账。",
    "11. 这 4-6 条里，至少 2 条来自前半段或中段内容，至少 1 条来自后半段内容；如果中段主要是过渡，则以前半段和后半段覆盖为主。",
    "12. 如果 feedback_required_mentions.early_topics 非空，正文里至少要覆盖其中 3 个前半段知识点；如果 late_topics 非空，正文里至少要覆盖其中 2 个后半段知识点。",
    "13. “掌握得较好的部分”写成一个自然段，至少 2 句，先写孩子当前掌握得较好的内容、思路方向、跟随度或在提示后能修正的地方，再写本节课的具体进步或收获。",
    "14. “还需要加强的部分”也写成一个自然段，至少 2 句，先点出 1-3 个整节课反复出现的共性问题，再自然带出课后复盘建议、下节课抽查重点或后续训练方向。",
    "15. 问题部分优先写整节课反复出现的共性问题，例如图像不准、概念记忆不牢、方法切换不灵活、计算表达不稳等，而不是只写最后一道题；措辞尽量使用“还不够熟练”“有些疑惑”“没有马上想起来”“需要再体会一下”这类老师口吻。",
    "16. 避免使用“针对这些问题，我制定了以下改进策略：”“总体表现良好但……”这类报告腔模板；课后建议和下节课重点要自然地融入“还需要加强的部分”结尾，不要单独再起一段。",
    "17. 如果 structured_summary 里已有多题型覆盖，正文必须体现这种广度，不要把“主要内容包括”缩成 2 个专题。",
    "18. 除“主要内容包括”的编号外，其余部分不要再堆砌条目、子标题或步骤清单。",
    `19. 风格代号：${style}；风格名称：${styleSpec.label}；长度：${options.length || "medium"}。`,
    "20. 风格细则：",
    ...styleSpec.instructions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "课堂结构化信息：",
    JSON.stringify(summary, null, 2),
  ].join("\n");
  return chatWithFeedbackGenerator(generator, [
    { role: "developer", content: "你是一名认真负责的高中数学老师，输出适合直接发给家长的中文反馈。" },
    { role: "user", content },
  ]);
}

async function chatWithFeedbackGenerator(generator, messages, options = {}) {
  return generator === "local_llm"
    ? chatWithLocalLlm(messages, options)
    : chatWithOpenAi(messages, options);
}

async function chatWithOpenAi(messages, options = {}) {
  if (!isOpenAiFeedbackEnabled()) {
    throw new Error("OpenAI 兼容反馈接口当前不可用。请先配置 OPENAI_API_KEY，并显式开启 ALLOW_EXTERNAL_API_COST=1。");
  }
  return chatWithOpenAiCompatible({
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    model: OPENAI_CHAT_MODEL,
    label: "OpenAI",
    messages,
    responseFormat: options.responseFormat,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs || OPENAI_CHAT_REQUEST_TIMEOUT_MS,
  });
}

async function chatWithLocalLlm(messages, options = {}) {
  if (!isLocalLlmFeedbackEnabled()) {
    throw new Error("本地 LLM 反馈当前不可用。请先配置 LOCAL_LLM_BASE_URL 和 LOCAL_LLM_MODEL。");
  }
  const model = getSelectedLocalLlmModel();
  return chatWithOpenAiCompatible({
    baseUrl: LOCAL_LLM_BASE_URL,
    apiKey: LOCAL_LLM_API_KEY,
    model,
    label: "本地 LLM",
    messages,
    responseFormat: options.responseFormat,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs || LOCAL_LLM_REQUEST_TIMEOUT_MS,
    extraBody: {
      reasoning_effort: "none",
    },
  });
}

async function chatWithOpenAiCompatible({ baseUrl, apiKey, model, label, messages, responseFormat, maxTokens, timeoutMs, extraBody = null }) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 1200,
    n: 1,
  };
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  if (extraBody && typeof extraBody === "object") {
    Object.assign(body, extraBody);
  }
  const result = await postJsonWithTimeout(`${baseUrl}/chat/completions`, {
    headers,
    body,
    timeoutMs,
    label,
  });
  const choice = result.choices?.[0] || {};
  const content = sanitizeModelText(choice.message?.content);
  if (content) {
    return content;
  }
  const reasoning = sanitizeModelText(choice.message?.reasoning || choice.message?.thinking);
  if (reasoning && choice.finish_reason === "length") {
    throw new Error(`${label} 只返回了思考过程，没有返回最终答案。请关闭 thinking，或提高 max_tokens。`);
  }
  throw new Error(`${label} 没有返回有效内容。`);
}

async function postJsonWithTimeout(targetUrl, { headers = {}, body, timeoutMs = 180_000, label = "请求" } = {}) {
  const url = new URL(targetUrl);
  const transport = url.protocol === "https:" ? https : http;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const requestHeaders = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: requestHeaders,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${label} 文本生成失败: ${res.statusCode} ${raw.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`${label} 返回了非 JSON 响应: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${label} 请求超时，已等待 ${Math.round(timeoutMs / 1000)} 秒。`));
    });
    req.on("error", (error) => {
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}

async function summarizeWithMock(lesson) {
  await delay(250);
  const student = db.students.find((item) => item.id === lesson.student_id);
  return normalizeStructuredSummary({
    lesson_content: lesson.lesson_title || "本节课堂内容",
    student_performance: `${student?.name || "学生"}课堂状态较认真，能够跟随老师完成主要步骤。`,
    strengths: ["基础题反应较快", "愿意根据老师提示修正思路"],
    weaknesses: ["综合题条件梳理还不够稳定", "分类讨论和计算细节需要加强"],
    typical_examples: ["导数综合题", "含参数问题的条件分析"],
    correction_suggestions: ["先标出题目条件和目标", "每一步分类讨论都写清依据", "计算后回代检查符号和定义域"],
    homework_suggestion: ["整理本节课例题", "重做错题并标注易错点"],
    next_lesson_focus: ["继续强化综合题分析", "训练参数讨论和步骤表达"],
    covered_topics: ["导数综合题", "参数分析", "分类讨论", "规范表达"],
    question_breakdown: [
      {
        problem_ref: "课堂前半段例题",
        topic: "导数综合题",
        teacher_focus: "参数分析",
        student_issue: "条件梳理不够稳定",
      },
      {
        problem_ref: "课堂后半段例题",
        topic: "分类讨论",
        teacher_focus: "规范表达",
        student_issue: "计算细节需要加强",
      },
    ],
    feedback_required_mentions: {
      early_topics: ["导数综合题", "参数分析"],
      late_topics: ["分类讨论", "规范表达"],
      recurring_issues: ["条件梳理不够稳定", "分类讨论和计算细节需要加强"],
      avoid_single_focus: "不能只围绕最后一道题展开",
    },
    lesson_segments: [
      {
        phase: "前半段",
        problem_refs: ["课堂前半段例题"],
        knowledge_points: ["导数综合题", "参数分析"],
        student_performance: `${student?.name || "学生"}能跟上主要讲解节奏。`,
        issues: ["条件梳理不够稳定"],
      },
      {
        phase: "后半段",
        problem_refs: ["课堂后半段例题"],
        knowledge_points: ["分类讨论", "规范表达"],
        student_performance: "在老师提醒后能修正部分步骤。",
        issues: ["计算细节需要加强"],
      },
    ],
    recurring_weaknesses: ["条件梳理不够稳定", "分类讨论和计算细节需要加强"],
    coverage_check: {
      covered_early: true,
      covered_middle: false,
      covered_late: true,
      not_last_problem_only: true,
    },
  });
}

async function feedbackWithMock(lesson, summary, options = {}) {
  await delay(250);
  const topics = normalizeStringArray(summary.covered_topics).slice(0, 3);
  const strengths = normalizeStringArray(summary.strengths).slice(0, 2).join("，") || "课堂状态比较认真";
  const weaknesses = normalizeStringArray(summary.weaknesses).slice(0, 2).join("，") || "综合题中的条件梳理和计算细节";
  const advice = normalizeStringArray(summary.homework_suggestion).slice(0, 2).join("，") || "把今天讲过的例题重新整理一遍";
  return `家长您好！
今天这节课我主要带孩子对${summary.lesson_content || lesson.lesson_title || "本节课堂重点"}进行了梳理和练习。主要包括：
1. ${topics[0] || "课堂重点复盘"}
2. ${topics[1] || "核心方法训练"}
3. ${topics[2] || "易错点纠正"}
掌握得较好的部分：${strengths}。
还需要加强的部分：${weaknesses}。课后建议孩子${advice}，下节课会继续强化相关综合题的分析方法和规范表达。`;
}

function structuredSummaryTemplate() {
  return {
    lesson_content: "",
    student_performance: "",
    strengths: [],
    weaknesses: [],
    typical_examples: [],
    correction_suggestions: [],
    homework_suggestion: [],
    next_lesson_focus: [],
    covered_topics: [],
    question_breakdown: [
      {
        problem_ref: "",
        topic: "",
        teacher_focus: "",
        student_issue: "",
      },
    ],
    feedback_required_mentions: {
      early_topics: [],
      late_topics: [],
      recurring_issues: [],
      avoid_single_focus: "",
    },
    lesson_segments: [
      {
        phase: "前半段",
        problem_refs: [],
        knowledge_points: [],
        student_performance: "",
        issues: [],
      },
      {
        phase: "中段",
        problem_refs: [],
        knowledge_points: [],
        student_performance: "",
        issues: [],
      },
      {
        phase: "后半段",
        problem_refs: [],
        knowledge_points: [],
        student_performance: "",
        issues: [],
      },
    ],
    recurring_weaknesses: [],
    coverage_check: {
      covered_early: false,
      covered_middle: false,
      covered_late: false,
      not_last_problem_only: false,
    },
  };
}

function transcriptBlockSummaryTemplate() {
  return {
    teaching_relevance: "high",
    problem_refs: [],
    covered_topics: [],
    question_breakdown: [
      {
        problem_ref: "",
        topic: "",
        teacher_focus: "",
        student_issue: "",
      },
    ],
    student_performance: "",
    strengths: [],
    weaknesses: [],
    typical_examples: [],
    correction_suggestions: [],
    teacher_observations: [],
  };
}

function normalizeStructuredSummary(value) {
  const summary = value && typeof value === "object" ? value : {};
  return {
    lesson_content: cleanString(summary.lesson_content) || "未明确提及",
    student_performance: cleanString(summary.student_performance) || "未明确提及",
    strengths: normalizeStringArray(summary.strengths),
    weaknesses: normalizeStringArray(summary.weaknesses),
    typical_examples: normalizeStringArray(summary.typical_examples),
    correction_suggestions: normalizeStringArray(summary.correction_suggestions),
    homework_suggestion: normalizeStringArray(summary.homework_suggestion),
    next_lesson_focus: normalizeStringArray(summary.next_lesson_focus),
    covered_topics: normalizeStringArray(summary.covered_topics),
    question_breakdown: normalizeQuestionBreakdown(summary.question_breakdown),
    feedback_required_mentions: normalizeFeedbackRequiredMentions(summary.feedback_required_mentions),
    lesson_segments: normalizeLessonSegments(summary.lesson_segments),
    recurring_weaknesses: normalizeRecurringWeaknesses(summary.recurring_weaknesses),
    coverage_check: normalizeCoverageCheck(summary.coverage_check),
  };
}

function normalizeTranscriptBlockSummary(value) {
  const summary = value && typeof value === "object" ? value : {};
  const relevance = cleanString(summary.teaching_relevance).toLowerCase();
  return {
    teaching_relevance: relevance || "medium",
    problem_refs: normalizeStringArray(summary.problem_refs),
    covered_topics: normalizeStringArray(summary.covered_topics),
    question_breakdown: normalizeQuestionBreakdown(summary.question_breakdown),
    student_performance: cleanString(summary.student_performance) || "未明确提及",
    strengths: normalizeStringArray(summary.strengths),
    weaknesses: normalizeStringArray(summary.weaknesses),
    typical_examples: normalizeStringArray(summary.typical_examples),
    correction_suggestions: normalizeStringArray(summary.correction_suggestions),
    teacher_observations: normalizeStringArray(summary.teacher_observations),
  };
}

function normalizeLessonSegments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((segment, index) => {
      const item = segment && typeof segment === "object" ? segment : {};
      return {
        phase: cleanString(item.phase) || `阶段${index + 1}`,
        problem_refs: normalizeStringArray(item.problem_refs),
        knowledge_points: normalizeStringArray(item.knowledge_points),
        student_performance: cleanString(item.student_performance) || "未明确提及",
        issues: normalizeStringArray(item.issues),
      };
    })
    .filter((segment) => segment.phase || segment.problem_refs.length > 0 || segment.knowledge_points.length > 0 || segment.issues.length > 0 || cleanString(segment.student_performance));
}

function normalizeRecurringWeaknesses(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.flatMap((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object") {
      return [item.issue, ...(Array.isArray(item.evidence) ? item.evidence : [])];
    }
    return [];
  }));
}

function normalizeCoverageCheck(value) {
  const check = value && typeof value === "object" ? value : {};
  return {
    covered_early: Boolean(check.covered_early),
    covered_middle: Boolean(check.covered_middle),
    covered_late: Boolean(check.covered_late),
    not_last_problem_only: Boolean(check.not_last_problem_only),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.flatMap((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object") {
      return Object.values(item).flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
    }
    return [];
  }));
}

function normalizeQuestionBreakdown(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const row = item && typeof item === "object" ? item : {};
      return {
        problem_ref: cleanString(row.problem_ref),
        topic: cleanString(row.topic),
        teacher_focus: cleanString(row.teacher_focus),
        student_issue: cleanString(row.student_issue),
      };
    })
    .filter((item) => item.problem_ref || item.topic || item.teacher_focus || item.student_issue);
}

function normalizeFeedbackRequiredMentions(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    early_topics: normalizeStringArray(item.early_topics),
    late_topics: normalizeStringArray(item.late_topics),
    recurring_issues: normalizeStringArray(item.recurring_issues),
    avoid_single_focus: cleanString(item.avoid_single_focus),
  };
}

function buildTranscriptCoverageHints(transcript, sections = null) {
  const source = String(transcript || "");
  const normalizedSections = Array.isArray(sections) ? sections : splitTranscriptSections(source);
  return {
    problemRefs: inferProblemRefsFromText(source),
    topicHints: inferTopicHintsFromText(source),
    phaseHints: buildPhaseTopicHints(normalizedSections),
  };
}

function buildBlockCoverageHints(group) {
  const blockText = (Array.isArray(group) ? group : [])
    .map((section) => `${section.label}\n${section.body}`)
    .join("\n\n");
  return {
    problemRefs: inferProblemRefsFromText(blockText),
    topicHints: inferTopicHintsFromText(blockText),
    phaseHints: [],
  };
}

function formatCoverageHints(hints) {
  const normalized = hints && typeof hints === "object" ? hints : {};
  const rows = [
    `识别到的题号/题段：${(normalized.problemRefs || []).join("、") || "未识别到"}`,
    `识别到的知识点：${(normalized.topicHints || []).join("、") || "未识别到"}`,
  ];
  for (const phase of normalized.phaseHints || []) {
    rows.push(`${phase.phase}可能涉及：${phase.topics.join("、") || "未识别到明显教学知识点"}`);
  }
  return rows.join("\n");
}

function buildPhaseTopicHints(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return [];
  }
  const size = Math.max(1, Math.ceil(sections.length / 3));
  const groups = groupItems(sections, size);
  const phases = ["前半段", "中段", "后半段"];
  return groups.slice(0, 3).map((group, index) => ({
    phase: phases[index] || `阶段${index + 1}`,
    topics: inferTopicHintsFromText(group.map((item) => item.body).join("\n")),
  }));
}

function inferProblemRefsFromText(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(/第[一二三四五六七八九十百零两\d]+题/g)].map((item) => item[0]);
  return uniqueStrings(matches).slice(0, 12);
}

function inferTopicHintsFromText(text) {
  const source = String(text || "");
  return TOPIC_HINT_RULES
    .filter((rule) => rule.keywords.some((keyword) => source.includes(keyword)))
    .map((rule) => rule.label);
}

function mergePartialSummariesDeterministically(partials, globalHints = null) {
  const source = Array.isArray(partials) ? partials : [];
  const teachingPartials = source
    .map((item) => ({
      range: cleanString(item?.range),
      summary: normalizeTranscriptBlockSummary(item?.summary),
    }))
    .filter((item) => item.summary.covered_topics.length > 0 || item.summary.question_breakdown.length > 0 || item.summary.strengths.length > 0 || item.summary.weaknesses.length > 0 || item.summary.teacher_observations.length > 0);
  const phaseSegments = buildLessonSegmentsFromPartials(teachingPartials, globalHints);
  const coveredTopics = uniqueStrings([
    ...(globalHints?.topicHints || []),
    ...teachingPartials.flatMap((item) => item.summary.covered_topics),
    ...phaseSegments.flatMap((segment) => segment.knowledge_points),
  ]).slice(0, 10);
  const questionBreakdown = mergeQuestionBreakdown(teachingPartials.flatMap((item) => item.summary.question_breakdown)).slice(0, 8);
  const strengths = pickTopFrequentStrings(teachingPartials.flatMap((item) => item.summary.strengths), 6);
  const recurringWeaknesses = pickTopFrequentStrings([
    ...teachingPartials.flatMap((item) => item.summary.weaknesses),
    ...teachingPartials.flatMap((item) => item.summary.teacher_observations),
    ...phaseSegments.flatMap((segment) => segment.issues),
  ], 6);
  const weaknesses = uniqueStrings([...recurringWeaknesses, ...teachingPartials.flatMap((item) => item.summary.weaknesses)]).slice(0, 6);
  const typicalExamples = uniqueStrings([
    ...teachingPartials.flatMap((item) => item.summary.typical_examples),
    ...questionBreakdown.map((item) => [item.problem_ref, item.topic].filter(Boolean).join("：")),
  ]).slice(0, 6);
  const correctionSuggestions = uniqueStrings(teachingPartials.flatMap((item) => item.summary.correction_suggestions)).slice(0, 6);
  const feedbackRequiredMentions = buildFeedbackRequiredMentions(phaseSegments, recurringWeaknesses, coveredTopics, globalHints);
  const summary = {
    lesson_content: buildLessonContent(coveredTopics, questionBreakdown),
    student_performance: buildStudentPerformance(teachingPartials, strengths, recurringWeaknesses),
    strengths,
    weaknesses,
    typical_examples: typicalExamples,
    correction_suggestions: correctionSuggestions,
    homework_suggestion: buildHomeworkSuggestions(correctionSuggestions, recurringWeaknesses),
    next_lesson_focus: buildNextLessonFocus(coveredTopics, recurringWeaknesses),
    covered_topics: coveredTopics,
    question_breakdown: questionBreakdown,
    feedback_required_mentions: feedbackRequiredMentions,
    lesson_segments: phaseSegments,
    recurring_weaknesses: recurringWeaknesses,
    coverage_check: {
      covered_early: phaseSegments[0]?.knowledge_points.length > 0,
      covered_middle: phaseSegments[1]?.knowledge_points.length > 0,
      covered_late: phaseSegments[2]?.knowledge_points.length > 0,
      not_last_problem_only: feedbackRequiredMentions.early_topics.length > 0 && feedbackRequiredMentions.late_topics.length > 0,
    },
  };
  return normalizeStructuredSummary(summary);
}

function buildLessonSegmentsFromPartials(partials, globalHints = null) {
  const phases = ["前半段", "中段", "后半段"];
  if (!Array.isArray(partials) || partials.length === 0) {
    return phases.map((phase, index) => ({
      phase,
      problem_refs: [],
      knowledge_points: uniqueStrings(globalHints?.phaseHints?.[index]?.topics || []),
      student_performance: "未明确提及",
      issues: [],
    }));
  }
  const size = Math.max(1, Math.ceil(partials.length / 3));
  return phases.map((phase, index) => {
    const group = partials.slice(index * size, (index + 1) * size);
    const hintedTopics = globalHints?.phaseHints?.[index]?.topics || [];
    return {
      phase,
      problem_refs: uniqueStrings(group.flatMap((item) => item.summary.problem_refs).concat(group.flatMap((item) => item.summary.question_breakdown.map((row) => row.problem_ref)))).slice(0, 8),
      knowledge_points: uniqueStrings([...hintedTopics, ...group.flatMap((item) => item.summary.covered_topics), ...group.flatMap((item) => item.summary.question_breakdown.map((row) => row.topic))]).slice(0, 8),
      student_performance: summarizeSegmentPerformance(group),
      issues: pickTopFrequentStrings([...group.flatMap((item) => item.summary.weaknesses), ...group.flatMap((item) => item.summary.teacher_observations)], 4),
    };
  });
}

function summarizeSegmentPerformance(group) {
  const values = uniqueStrings((group || []).map((item) => item.summary.student_performance).filter((text) => text && text !== "未明确提及"));
  return values.slice(0, 2).join("；") || "未明确提及";
}

function mergeQuestionBreakdown(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const row = item && typeof item === "object" ? item : {};
    const normalized = {
      problem_ref: cleanString(row.problem_ref),
      topic: cleanString(row.topic),
      teacher_focus: cleanString(row.teacher_focus),
      student_issue: cleanString(row.student_issue),
    };
    const key = [normalized.problem_ref, normalized.topic, normalized.teacher_focus, normalized.student_issue].join("|");
    if (!key.replace(/\|/g, "")) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function pickTopFrequentStrings(values, limit = 5) {
  const counts = new Map();
  for (const value of values || []) {
    const text = cleanString(value);
    if (!text || text === "未明确提及") {
      continue;
    }
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"))
    .slice(0, limit)
    .map(([text]) => text);
}

function buildFeedbackRequiredMentions(phaseSegments, recurringWeaknesses, coveredTopics, globalHints = null) {
  const earlyTopics = uniqueStrings([
    ...(phaseSegments[0]?.knowledge_points || []),
    ...(globalHints?.phaseHints?.[0]?.topics || []),
  ]).slice(0, 5);
  const lateTopics = uniqueStrings([
    ...(phaseSegments[2]?.knowledge_points || []),
    ...(globalHints?.phaseHints?.[2]?.topics || []),
    ...coveredTopics.filter((topic) => /立体几何|空间向量|解三角形|三角函数/.test(topic)),
  ]).slice(0, 4);
  return {
    early_topics: earlyTopics,
    late_topics: lateTopics,
    recurring_issues: recurringWeaknesses.slice(0, 5),
    avoid_single_focus: "最后一道题只能作为后半段内容之一，不能成为全文主线",
  };
}

function buildLessonContent(coveredTopics, questionBreakdown) {
  if (questionBreakdown.length >= 4 || coveredTopics.length >= 6) {
    return `本节课主要围绕试卷中的多道疑问题进行了订正和梳理，覆盖了${coveredTopics.slice(0, 6).join("、")}等内容。`;
  }
  if (coveredTopics.length > 0) {
    return `本节课主要梳理了${coveredTopics.slice(0, 5).join("、")}等内容。`;
  }
  return "未明确提及";
}

function buildStudentPerformance(partials, strengths, recurringWeaknesses) {
  const performanceTexts = uniqueStrings((partials || []).map((item) => item.summary.student_performance).filter((text) => text && text !== "未明确提及"));
  const pieces = [];
  if (performanceTexts.length > 0) {
    pieces.push(performanceTexts.slice(0, 2).join("；"));
  }
  if (strengths.length > 0) {
    pieces.push(`整体亮点集中在${strengths.slice(0, 2).join("、")}。`);
  }
  if (recurringWeaknesses.length > 0) {
    pieces.push(`反复暴露的问题主要是${recurringWeaknesses.slice(0, 2).join("、")}。`);
  }
  return pieces.join("") || "未明确提及";
}

function buildHomeworkSuggestions(correctionSuggestions, recurringWeaknesses) {
  const base = uniqueStrings(correctionSuggestions).slice(0, 3);
  if (base.length > 0) {
    return base;
  }
  return recurringWeaknesses.slice(0, 3).map((item) => `围绕“${item}”做针对性订正和整理`);
}

function buildNextLessonFocus(coveredTopics, recurringWeaknesses) {
  const topicFocus = coveredTopics.filter((item) => /立体几何|空间向量|概率|回归方程|函数|圆|欧拉线|解三角形|三角函数/.test(item));
  const values = uniqueStrings([
    ...recurringWeaknesses.map((item) => `继续强化${item}`),
    ...topicFocus.slice(0, 3).map((item) => `继续梳理${item}`),
  ]);
  return values.slice(0, 4);
}

function splitTranscriptSections(transcript) {
  const source = String(transcript || "").replace(/\r/g, "");
  if (!source) {
    return [];
  }
  const matches = [...source.matchAll(/【[^】]+】/g)];
  if (matches.length === 0) {
    return [{ label: "整段转写", body: cleanString(source) }];
  }
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const start = current.index ?? 0;
    const bodyStart = start + current[0].length;
    const bodyEnd = next ? (next.index ?? source.length) : source.length;
    sections.push({
      label: current[0],
      body: cleanString(source.slice(bodyStart, bodyEnd)),
    });
  }
  return sections.filter((section) => section.body);
}

function shouldUseHierarchicalSummary(sections, transcript) {
  return sections.length >= SUMMARY_HIERARCHY_SECTION_THRESHOLD || String(transcript || "").length >= SUMMARY_HIERARCHY_TEXT_THRESHOLD;
}

function groupItems(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function buildSectionRangeLabel(group) {
  if (!Array.isArray(group) || group.length === 0) {
    return "";
  }
  if (group.length === 1) {
    return group[0].label;
  }
  return `${group[0].label} 至 ${group[group.length - 1].label}`;
}

function statusPayload(lessonId) {
  const lesson = findLesson(lessonId);
  const recording = latestRecording(lessonId);
  const chunks = recording
    ? db.chunks.filter((chunk) => chunk.recording_id === recording.id)
    : [];
  const completed = chunks.filter((chunk) => chunk.transcription_status === "completed").length;
  const failed = chunks.filter((chunk) => chunk.transcription_status === "failed").length;
  const total = chunks.length;
  let progress = total > 0 ? completed / total : statusProgress(lesson?.status);
  if (lesson?.status === "summarizing") {
    progress = Math.max(progress, 0.9);
  } else if (["feedback_generated", "completed"].includes(lesson?.status)) {
    progress = 1;
  }
  return {
    lesson_id: lessonId,
    status: lesson?.status || "missing",
    total_chunks: total,
    completed_chunks: completed,
    failed_chunks: failed,
    progress,
    error_message: lesson?.error_message || "",
    chunks: chunks.sort((a, b) => a.chunk_index - b.chunk_index).map(publicChunk),
  };
}

function lessonPayload(lesson) {
  const student = db.students.find((item) => item.id === lesson.student_id) || null;
  const recording = latestRecording(lesson.id);
  return {
    lesson,
    student,
    recording: recording ? publicRecording(recording) : null,
    status: statusPayload(lesson.id),
  };
}

function publicRecording(recording) {
  return {
    id: recording.id,
    lesson_id: recording.lesson_id,
    original_audio_url: recording.original_audio_url,
    original_audio_filename: recording.original_audio_filename,
    original_audio_size: recording.original_audio_size,
    original_audio_duration_sec: recording.original_audio_duration_sec,
    original_audio_format: recording.original_audio_format,
    normalized_audio_url: recording.normalized_audio_url,
    upload_status: recording.upload_status,
    transcription_status: recording.transcription_status,
    created_at: recording.created_at,
    updated_at: recording.updated_at,
  };
}

function publicChunk(chunk) {
  return {
    id: chunk.id,
    chunk_index: chunk.chunk_index,
    start_time_sec: chunk.start_time_sec,
    end_time_sec: chunk.end_time_sec,
    chunk_size: chunk.chunk_size,
    transcript_text: chunk.transcript_text,
    transcription_status: chunk.transcription_status,
    retry_count: chunk.retry_count,
    error_message: chunk.error_message,
    virtual: chunk.virtual,
  };
}

async function buildConfigPayload(req) {
  const effectiveMode = getEffectiveAiMode();
  const localLlmInfo = await getLocalLlmRuntimeInfo();
  const accessInfo = getAccessInfo(PORT);
  return {
    aiProvider: AI_PROVIDER,
    effectiveAiMode: effectiveMode,
    externalApiCostAllowed: ALLOW_EXTERNAL_API_COST,
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    transcribeModel: effectiveMode === "openai"
      ? OPENAI_TRANSCRIBE_MODEL
      : effectiveMode === "local"
        ? LOCAL_WHISPER_MODEL
        : "mock",
    chatModel: getFeedbackModelName(getDefaultFeedbackGenerator()),
    feedbackBackendSummary: getFeedbackBackendSummary(localLlmInfo),
    chunkSeconds: CHUNK_SECONDS,
    ffmpegAvailable: Boolean(findOnPath("ffmpeg")),
    ffprobeAvailable: Boolean(findOnPath("ffprobe")),
    maxLiveAudioMb: MAX_LIVE_AUDIO_MB,
    maxOpenAiAudioMb: MAX_OPENAI_AUDIO_MB,
    localWhisperAvailable: isLocalAiEnabled(),
    localLlmConfigured: localLlmInfo.configured,
    localLlmReachable: localLlmInfo.reachable,
    localLlmFeedbackAvailable: localLlmInfo.available,
    localLlmSelectedModel: localLlmInfo.selectedModel,
    localLlmAvailableModels: localLlmInfo.models,
    localLlmEndpoint: localLlmInfo.baseUrl,
    localLlmError: localLlmInfo.error,
    openAiLlmFeedbackAvailable: isOpenAiFeedbackEnabled(),
    mockFeedbackGeneration: effectiveMode === "mock",
    defaultFeedbackGenerator: getDefaultFeedbackGenerator(),
    listenHost: HOST,
    listenPort: PORT,
    localUrl: accessInfo.localUrl,
    lanUrls: accessInfo.lanUrls,
    authRequired: Boolean(APP_ACCESS_TOKEN),
    authenticated: !APP_ACCESS_TOKEN || isAuthorized(req),
  };
}

async function buildLocalLlmModelsPayload() {
  const localLlmInfo = await getLocalLlmRuntimeInfo();
  return {
    configured: localLlmInfo.configured,
    reachable: localLlmInfo.reachable,
    available: localLlmInfo.available,
    selectedModel: localLlmInfo.selectedModel,
    models: localLlmInfo.models,
    baseUrl: localLlmInfo.baseUrl,
    error: localLlmInfo.error,
  };
}

async function markLessonFailedByRecording(recordingId, error) {
  const recording = db.recordings.find((item) => item.id === recordingId);
  if (!recording) {
    return;
  }
  const lesson = findLesson(recording.lesson_id);
  if (lesson) {
    lesson.status = "failed";
    lesson.error_message = error.message || "处理失败";
    lesson.updated_at = nowIso();
  }
  recording.transcription_status = "failed";
  recording.updated_at = nowIso();
  await saveDb();
}

function mergeTranscript(chunks) {
  return chunks
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((chunk) => {
      const label = chunk.transcription_status === "completed"
        ? `【${formatTime(chunk.start_time_sec)}-${formatTime(chunk.end_time_sec)}】`
        : `【${formatTime(chunk.start_time_sec)}-${formatTime(chunk.end_time_sec)}：缺失片段，状态 ${chunk.transcription_status}】`;
      return `${label}\n${chunk.transcript_text || chunk.error_message || "未生成转写"}`;
    })
    .join("\n\n");
}

async function getAudioMetadata(filePath, fallbackFormat) {
  const ffprobe = findOnPath("ffprobe");
  if (!ffprobe) {
    return {
      durationSec: null,
      format: fallbackFormat || path.extname(filePath).replace(".", ""),
    };
  }

  try {
    const output = await runCommand(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name",
      "-of",
      "json",
      filePath,
    ]);
    const parsed = JSON.parse(output.stdout || "{}");
    const duration = Number(parsed.format?.duration);
    const format = String(parsed.format?.format_name || fallbackFormat || "").split(",")[0];
    return {
      durationSec: Number.isFinite(duration) ? Math.round(duration) : null,
      format,
    };
  } catch (error) {
    console.warn(`ffprobe 获取音频元信息失败，改用上传时回退信息: ${error.message}`);
    return {
      durationSec: null,
      format: fallbackFormat || path.extname(filePath).replace(".", ""),
    };
  }
}

function resumeInterruptedJobs() {
  const resumable = db.recordings.filter((recording) => {
    const lesson = findLesson(recording.lesson_id);
    return lesson
      && ["audio_uploaded", "audio_processing", "transcribing", "transcribed", "summarizing"].includes(lesson.status)
      && fs.existsSync(recording.original_audio_path || "");
  });
  for (const recording of resumable) {
    runInBackground(`resume:${recording.id}`, async () => {
      await processUploadedAudio(recording.id);
    });
  }
}

function runInBackground(key, fn) {
  if (activeJobs.has(key)) {
    return;
  }
  activeJobs.add(key);
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      activeJobs.delete(key);
    });
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(NORMALIZED_DIR, { recursive: true });
  await fsp.mkdir(CHUNK_DIR, { recursive: true });
}

async function loadDb() {
  try {
    const text = await fsp.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(text);
    return {
      students: parsed.students || [],
      lessons: parsed.lessons || [],
      recordings: parsed.recordings || [],
      chunks: parsed.chunks || [],
      feedback_templates: parsed.feedback_templates || [],
      settings: parsed.settings || {},
      seq: {
        students: parsed.seq?.students || 1,
        lessons: parsed.seq?.lessons || 1,
        recordings: parsed.seq?.recordings || 1,
        chunks: parsed.seq?.chunks || 1,
        feedback_templates: parsed.seq?.feedback_templates || 1,
      },
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return {
      students: [],
      lessons: [],
      recordings: [],
      chunks: [],
      feedback_templates: [
        {
          id: 1,
          template_name: "专业温和标准版",
          template_prompt: "语气专业、温和、具体，适合发给家长。",
          style: "professional_warm",
          created_at: nowIso(),
          updated_at: nowIso(),
        },
      ],
      settings: {},
      seq: {
        students: 1,
        lessons: 1,
        recordings: 1,
        chunks: 1,
        feedback_templates: 2,
      },
    };
  }
}

async function saveDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${DB_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tempPath, DB_PATH);
}

function nextId(table) {
  const value = db.seq[table] || 1;
  db.seq[table] = value + 1;
  return value;
}

function findLesson(id) {
  return db.lessons.find((lesson) => lesson.id === Number(id));
}

function latestRecording(lessonId) {
  return db.recordings
    .filter((recording) => recording.lesson_id === lessonId)
    .sort((a, b) => b.id - a.id)[0] || null;
}

async function deleteLessonFiles(lessonId) {
  const dirs = [
    path.join(UPLOAD_DIR, String(lessonId)),
    path.join(CHUNK_DIR, String(lessonId)),
    path.join(NORMALIZED_DIR, String(lessonId)),
  ];
  for (const dir of dirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function replaceLessonRecording(lessonId, keepPath) {
  const recordings = db.recordings.filter((recording) => recording.lesson_id === lessonId);
  for (const recording of recordings) {
    const paths = [
      recording.original_audio_path,
      recording.normalized_audio_path,
    ].filter((item) => item && item !== keepPath);
    for (const filePath of paths) {
      await fsp.rm(filePath, { force: true });
    }
  }
  const chunkPaths = db.chunks
    .filter((chunk) => chunk.lesson_id === lessonId)
    .map((chunk) => chunk.chunk_audio_path)
    .filter((filePath) => filePath && filePath !== keepPath);
  for (const filePath of new Set(chunkPaths)) {
    await fsp.rm(filePath, { force: true });
  }
  db.recordings = db.recordings.filter((recording) => recording.lesson_id !== lessonId);
  db.chunks = db.chunks.filter((chunk) => chunk.lesson_id !== lessonId);
}

async function serveStatic(req, res, pathname) {
  let target = pathname === "/" ? "/index.html" : pathname;
  target = target.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      throw Object.assign(new Error("not file"), { code: "ENOENT" });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
    throw error;
  }
}

async function streamPrivateFile(res, filePath, filename) {
  const stat = await fsp.stat(filePath);
  const ext = path.extname(filename || filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `inline; filename="${encodeURIComponent(filename || path.basename(filePath))}"`,
    "Cache-Control": "private, no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJson(req) {
  const buffer = await readBuffer(req);
  if (buffer.length === 0) {
    return {};
  }
  return JSON.parse(buffer.toString("utf8"));
}

async function readBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function pipeToFile(req, targetPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetPath);
    req.pipe(output);
    req.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
  });
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(boundaryBuffer);
  while (cursor !== -1) {
    const next = buffer.indexOf(boundaryBuffer, cursor + boundaryBuffer.length);
    if (next === -1) {
      break;
    }
    let segment = buffer.subarray(cursor + boundaryBuffer.length, next);
    if (segment.subarray(0, 2).toString() === "--") {
      break;
    }
    if (segment.subarray(0, 2).toString() === "\r\n") {
      segment = segment.subarray(2);
    }
    if (segment.subarray(segment.length - 2).toString() === "\r\n") {
      segment = segment.subarray(0, segment.length - 2);
    }
    const headerEnd = segment.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headersText = segment.subarray(0, headerEnd).toString("utf8");
      const body = segment.subarray(headerEnd + 4);
      const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headersText)?.[1] || "";
      const name = /name="([^"]+)"/.exec(disposition)?.[1] || "";
      const filename = /filename="([^"]*)"/.exec(disposition)?.[1] || "";
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(headersText)?.[1] || "";
      parts.push({ name, filename, contentType, body });
    }
    cursor = next;
  }
  return parts;
}

function getMultipartBoundary(contentType) {
  return /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^"|"$/g, "");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(`${path.basename(command)} 退出码 ${code}: ${result.stderr.slice(0, 1000)}`));
      }
    });
  });
}

function findOnPath(binary) {
  const paths = String(process.env.PATH || "").split(path.delimiter);
  for (const entry of paths) {
    const candidate = path.join(entry, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return "";
}

async function getLocalLlmRuntimeInfo() {
  const selectedModel = getSelectedLocalLlmModel();
  const configured = Boolean(LOCAL_LLM_BASE_URL) && Boolean(selectedModel);
  const fallbackModels = uniqueStrings([selectedModel, cleanString(LOCAL_LLM_MODEL)]);
  if (!configured) {
    return {
      configured: false,
      reachable: false,
      available: false,
      selectedModel,
      models: fallbackModels,
      baseUrl: LOCAL_LLM_BASE_URL,
      error: "",
    };
  }

  try {
    const models = await fetchLocalLlmModels();
    const displayModels = models.length > 0 ? uniqueStrings([...models, ...fallbackModels]) : fallbackModels;
    const selectedAvailable = models.includes(selectedModel);
    return {
      configured: true,
      reachable: true,
      available: selectedAvailable,
      selectedModel,
      models: displayModels,
      baseUrl: LOCAL_LLM_BASE_URL,
      error: selectedAvailable
        ? ""
        : models.length === 0
          ? "本地 LLM 服务已连通，但模型列表还是空的，通常表示模型仍在下载中。"
          : `当前本地接口未发现模型 ${selectedModel}`,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      available: false,
      selectedModel,
      models: fallbackModels,
      baseUrl: LOCAL_LLM_BASE_URL,
      error: error.message || "本地 LLM 接口不可达",
    };
  }
}

async function fetchLocalLlmModels() {
  const headers = {};
  if (LOCAL_LLM_API_KEY) {
    headers.Authorization = `Bearer ${LOCAL_LLM_API_KEY}`;
  }

  const errors = [];
  let responded = false;
  const modelsUrl = `${LOCAL_LLM_BASE_URL}/models`;
  try {
    const result = await fetchJsonWithTimeout(modelsUrl, { headers }, 2000);
    responded = true;
    const models = uniqueStrings((result.data || []).map((item) => item?.id));
    if (models.length > 0) {
      return models;
    }
  } catch (error) {
    errors.push(error);
  }

  const fallbackBaseUrl = LOCAL_LLM_BASE_URL.replace(/\/v1$/, "");
  try {
    const result = await fetchJsonWithTimeout(`${fallbackBaseUrl}/api/tags`, { headers }, 2000);
    responded = true;
    const models = uniqueStrings((result.models || []).flatMap((item) => [item?.model, item?.name]));
    if (models.length > 0) {
      return models;
    }
  } catch (error) {
    errors.push(error);
  }

  if (responded) {
    return [];
  }

  const reason = errors[errors.length - 1];
  throw new Error(reason?.message || "无法读取本地模型列表");
}

async function fetchJsonWithTimeout(targetUrl, options = {}, timeoutMs = 2000) {
  const response = await fetch(targetUrl, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} ${errorText.slice(0, 240)}`.trim());
  }
  return response.json();
}

function getAccessInfo(port) {
  const normalizedHost = cleanString(HOST) || "127.0.0.1";
  const localHost = normalizedHost === "0.0.0.0" || normalizedHost === "::" ? "127.0.0.1" : normalizedHost;
  const lanHosts = normalizedHost === "0.0.0.0" || normalizedHost === "::"
    ? collectPrivateIpv4Hosts()
    : isPrivateIpv4(normalizedHost)
      ? [normalizedHost]
      : [];
  return {
    localUrl: `http://${localHost}:${port}`,
    lanUrls: lanHosts.map((host) => `http://${host}:${port}`),
  };
}

function collectPrivateIpv4Hosts() {
  const interfaces = os.networkInterfaces();
  const hosts = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      if (isPrivateIpv4(entry.address)) {
        hosts.push(entry.address);
      }
    }
  }
  return uniqueStrings(hosts);
}

function isPrivateIpv4(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    return false;
  }
  const [a, b] = address.split(".").map(Number);
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))];
}

function isOpenAiLiveEnabled() {
  return AI_PROVIDER === "openai" && ALLOW_EXTERNAL_API_COST && Boolean(OPENAI_API_KEY);
}

function isOpenAiFeedbackEnabled() {
  return ALLOW_EXTERNAL_API_COST && Boolean(OPENAI_API_KEY);
}

function isLocalLlmFeedbackEnabled() {
  return Boolean(LOCAL_LLM_BASE_URL) && Boolean(getSelectedLocalLlmModel());
}

function isLocalAiEnabled() {
  return AI_PROVIDER === "local"
    && fs.existsSync(LOCAL_TRANSCRIBE_SCRIPT)
    && fs.existsSync(LOCAL_DEP_MARKER);
}

function getEffectiveAiMode() {
  if (isOpenAiLiveEnabled()) {
    return "openai";
  }
  if (isLocalAiEnabled()) {
    return "local";
  }
  return "mock";
}

function isLiveAiEnabled() {
  return isOpenAiLiveEnabled();
}

function getDefaultFeedbackGenerator() {
  return validateFeedbackGenerator(DEFAULT_FEEDBACK_GENERATOR, false);
}

function getLessonFeedbackStyle(lesson) {
  return validateFeedbackStyle(lesson?.feedback_style, false);
}

function getSelectedLocalLlmModel() {
  const fromSettings = cleanString(db?.settings?.local_llm_model);
  return fromSettings || cleanString(LOCAL_LLM_MODEL);
}

function validateFeedbackGenerator(value, strict) {
  const candidate = cleanString(value).toLowerCase();
  const normalized = normalizeFeedbackGeneratorValue(candidate);
  if (strict && candidate && !normalized) {
    throw new Error("不支持的反馈生成方式，只能是 local_llm 或 openai_llm。");
  }
  const resolved = normalized || getSafeDefaultFeedbackGenerator();
  if (getEffectiveAiMode() !== "mock" && !isFeedbackGeneratorAvailable(resolved)) {
    if (strict) {
      throw new Error(feedbackGeneratorUnavailableMessage(resolved));
    }
    return pickAvailableFeedbackGenerator() || resolved;
  }
  return resolved;
}

function getSafeDefaultFeedbackGenerator() {
  return normalizeFeedbackGeneratorValue(DEFAULT_FEEDBACK_GENERATOR)
    || pickAvailableFeedbackGenerator()
    || "local_llm";
}

function normalizeFeedbackGeneratorValue(value) {
  const candidate = cleanString(value).toLowerCase();
  if (candidate === "local_llm" || candidate === "openai_llm") {
    return candidate;
  }
  if (candidate === "local_rule") {
    return "local_llm";
  }
  if (candidate === "llm") {
    return "openai_llm";
  }
  return "";
}

function validateFeedbackStyle(value, strict) {
  const candidate = cleanString(value).toLowerCase();
  const normalized = normalizeFeedbackStyleValue(candidate);
  if (strict && candidate && !normalized) {
    throw new Error("不支持的反馈风格，只能是 professional_warm、concise 或 wechat。");
  }
  return normalized || DEFAULT_FEEDBACK_STYLE;
}

function normalizeFeedbackStyleValue(value) {
  const candidate = cleanString(value).toLowerCase();
  if (candidate === "professional_warm" || candidate === "concise" || candidate === "wechat") {
    return candidate;
  }
  return "";
}

function getFeedbackStyleSpec(style) {
  const normalized = validateFeedbackStyle(style, false);
  const map = {
    professional_warm: {
      label: "专业温和",
      lengthRule: "字数控制在 300-420 字，完整但不要冗长。",
      instructions: [
        "语气要像认真负责的任课老师，克制、稳定、尊重家长，不夸张。",
        "结构贴近老师平时发给家长的课后反馈：先总述本节课内容，再写掌握得较好的部分，最后写还需要加强的部分。",
        "“主要内容包括”后的编号内容要精炼，像题型和方法总结，不要写成课堂逐分钟记录。",
        "亮点和问题都要写得具体，像老师课后复盘，不要写空泛表扬或生硬结论。",
        "指出问题时要温和、具体，多用“还不够熟练”“有些疑惑”“没有马上想起来”这类表达，避免情绪化表达和过度批评。",
        "建议和下节课计划自然落在最后一段，不要单独再起“改进策略”清单。",
      ],
    },
    concise: {
      label: "简洁版",
      lengthRule: "整体控制在 240-320 字，尽量短，但关键信息不能缺。",
      instructions: [
        "整体更短，尽量控制在 240-320 字，信息密度高，不铺陈。",
        "仍保持“总述本节课内容 -> 掌握得较好的部分 -> 还需要加强的部分”的三段结构。",
        "“主要内容包括”控制在 3-4 条，只保留最关键的题型和方法。",
        "每段只保留关键事实和最重要的建议，减少客套话和重复解释。",
        "语气仍要专业清晰，但不要写成长篇说明。",
        "适合老师快速同步课堂情况给家长，但不要因为求短而写成机械提纲。",
      ],
    },
    wechat: {
      label: "微信口吻",
      lengthRule: "字数控制在 280-380 字，读起来像一条自然的微信消息。",
      instructions: [
        "语气更自然、更口语化，像老师在微信里单独发消息，不要生硬公文腔。",
        "保持礼貌和边界感，不要使用网络流行语，不要太随便。",
        "表达要更顺口，可以适度加入“今天这节课”“这边看下来”这类老师微信里常见说法。",
        "仍然保持三段结构，但段落之间要更自然，像老师手动输入的一条消息。",
        "不要写成任务汇报或会议纪要，尤其不要再单独列“改进策略”清单。",
      ],
    },
  };
  return map[normalized];
}

function isFeedbackGeneratorAvailable(generator) {
  return generator === "local_llm"
    ? isLocalLlmFeedbackEnabled()
    : generator === "openai_llm"
      ? isOpenAiFeedbackEnabled()
      : false;
}

function pickAvailableFeedbackGenerator() {
  if (isLocalLlmFeedbackEnabled()) {
    return "local_llm";
  }
  if (isOpenAiFeedbackEnabled()) {
    return "openai_llm";
  }
  return "";
}

function feedbackGeneratorUnavailableMessage(generator) {
  return generator === "local_llm"
    ? "本地 LLM 反馈当前不可用。请先配置 LOCAL_LLM_BASE_URL 和本地模型。"
    : "OpenAI 兼容反馈接口当前不可用。请先配置 OPENAI_API_KEY，并显式开启 ALLOW_EXTERNAL_API_COST=1。";
}

function getFeedbackModelName(generator) {
  return generator === "local_llm"
    ? getSelectedLocalLlmModel() || "未配置"
    : OPENAI_CHAT_MODEL;
}

function getFeedbackBackendSummary(localLlmInfo = null) {
  const values = [];
  const localInfo = localLlmInfo || {
    configured: isLocalLlmFeedbackEnabled(),
    reachable: false,
    available: false,
    selectedModel: getSelectedLocalLlmModel(),
  };
  if (localInfo.configured) {
    const prefix = localInfo.available
      ? "本地 LLM"
      : localInfo.reachable
        ? "本地 LLM（模型未就绪）"
        : "本地 LLM（未连通）";
    values.push(`${prefix}：${localInfo.selectedModel || "未配置"}`);
  }
  if (isOpenAiFeedbackEnabled()) {
    values.push(`OpenAI 兼容：${OPENAI_CHAT_MODEL}`);
  }
  return values.join(" / ") || "未配置反馈 LLM";
}

function migrateLegacyFeedbackGenerators() {
  let changed = false;
  for (const lesson of db.lessons) {
    const normalized = validateFeedbackGenerator(lesson.feedback_generator, false);
    if (lesson.feedback_generator !== normalized) {
      lesson.feedback_generator = normalized;
      lesson.updated_at = lesson.updated_at || nowIso();
      changed = true;
    }
    const style = validateFeedbackStyle(lesson.feedback_style, false);
    if (lesson.feedback_style !== style) {
      lesson.feedback_style = style;
      lesson.updated_at = lesson.updated_at || nowIso();
      changed = true;
    }
  }
  return changed;
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function isAuthorized(req) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const cookieToken = parseCookies(req.headers.cookie || "").teacher_token || "";
  return tokenMatches(bearer) || tokenMatches(cookieToken);
}

function tokenMatches(value) {
  if (!APP_ACCESS_TOKEN) {
    return true;
  }
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(APP_ACCESS_TOKEN);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const item of String(cookieHeader || "").split(";")) {
    const index = item.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = item.slice(0, index).trim();
    const value = decodeURIComponent(item.slice(index + 1).trim());
    result[key] = value;
  }
  return result;
}

function cookieHeader(name, value) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function requiredString(value, message) {
  const text = cleanString(value);
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function cleanString(value) {
  return String(value || "").trim();
}

function sanitizeModelText(value) {
  return cleanString(value)
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function safeFilename(value) {
  const fallback = "class-recording";
  const base = path.basename(cleanString(value) || fallback);
  return base.replace(/[^\w.\-\u4e00-\u9fa5 ]+/g, "_") || fallback;
}

function extFromContentType(contentType) {
  const map = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/m4a": ".m4a",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
  };
  return map[String(contentType).split(";")[0].trim().toLowerCase()] || "";
}

function privateUrlFor(type, lessonId, chunkIndex) {
  if (type === "audio") {
    return `/api/lessons/${lessonId}/audio`;
  }
  if (type === "chunk") {
    return `/api/lessons/${lessonId}/chunks/${chunkIndex}`;
  }
  return `/api/lessons/${lessonId}/${type}`;
}

function matchPath(pathname, pattern) {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) {
    return null;
  }
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function statusProgress(status) {
  const map = {
    created: 0,
    audio_uploaded: 0.05,
    audio_processing: 0.15,
    transcribing: 0.45,
    transcribed: 0.75,
    summarizing: 0.9,
    feedback_generated: 1,
    completed: 1,
    failed: 0,
  };
  return map[status] ?? 0;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const candidate = extractFirstJsonObject(text);
    if (candidate) {
      return JSON.parse(candidate);
    }
    throw new Error("模型没有返回合法 JSON");
  }
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start === -1) {
    return "";
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return "";
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
