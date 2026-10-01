"use strict";

const state = {
  config: null,
  authenticated: true,
  students: [],
  lessons: [],
  studentQuery: "",
  lessonQuery: "",
  selectedStudentId: null,
  selectedLessonId: null,
  lessonPayload: null,
  selectedFile: null,
  selectedFiles: [],
  selectedFileDuration: null,
  selectedFileDurations: [],
  pollTimer: null,
};

const el = {
  modeBadge: document.getElementById("modeBadge"),
  accessLinks: document.getElementById("accessLinks"),
  refreshButton: document.getElementById("refreshButton"),
  logoutButton: document.getElementById("logoutButton"),
  loginOverlay: document.getElementById("loginOverlay"),
  loginForm: document.getElementById("loginForm"),
  studentForm: document.getElementById("studentForm"),
  studentCount: document.getElementById("studentCount"),
  studentSearchInput: document.getElementById("studentSearchInput"),
  deleteStudentButton: document.getElementById("deleteStudentButton"),
  studentsList: document.getElementById("studentsList"),
  selectedStudentName: document.getElementById("selectedStudentName"),
  lessonForm: document.getElementById("lessonForm"),
  lessonCount: document.getElementById("lessonCount"),
  lessonSearchInput: document.getElementById("lessonSearchInput"),
  lessonsList: document.getElementById("lessonsList"),
  emptyState: document.getElementById("emptyState"),
  lessonDetail: document.getElementById("lessonDetail"),
  lessonStatusPill: document.getElementById("lessonStatusPill"),
  currentLessonTitle: document.getElementById("currentLessonTitle"),
  deleteLessonButton: document.getElementById("deleteLessonButton"),
  audioInput: document.getElementById("audioInput"),
  secondAudioInput: document.getElementById("secondAudioInput"),
  fileMeta: document.getElementById("fileMeta"),
  transcribeBackendSelect: document.getElementById("transcribeBackendSelect"),
  transcribeBackendHint: document.getElementById("transcribeBackendHint"),
  feedbackGeneratorSelect: document.getElementById("feedbackGeneratorSelect"),
  localModelSelect: document.getElementById("localModelSelect"),
  switchLocalModelButton: document.getElementById("switchLocalModelButton"),
  localModelHint: document.getElementById("localModelHint"),
  transcriptOnlyUploadButton: document.getElementById("transcriptOnlyUploadButton"),
  uploadButton: document.getElementById("uploadButton"),
  generateFeedbackButton: document.getElementById("generateFeedbackButton"),
  audioPreview: document.getElementById("audioPreview"),
  progressText: document.getElementById("progressText"),
  chunkText: document.getElementById("chunkText"),
  progressBar: document.getElementById("progressBar"),
  chunkList: document.getElementById("chunkList"),
  errorMessage: document.getElementById("errorMessage"),
  transcriptSection: document.getElementById("transcriptSection"),
  copyTranscriptButton: document.getElementById("copyTranscriptButton"),
  feedbackSection: document.getElementById("feedbackSection"),
  feedbackEditor: document.getElementById("feedbackEditor"),
  styleSelect: document.getElementById("styleSelect"),
  regenerateButton: document.getElementById("regenerateButton"),
  copyButton: document.getElementById("copyButton"),
  saveFeedbackButton: document.getElementById("saveFeedbackButton"),
  summaryView: document.getElementById("summaryView"),
  summaryCards: document.getElementById("summaryCards"),
  transcriptView: document.getElementById("transcriptView"),
  toast: document.getElementById("toast"),
};

const STATUS_LABEL = {
  created: "已创建",
  audio_uploaded: "已上传",
  audio_processing: "处理中",
  transcribing: "转写中",
  transcribed: "转写完成",
  summarizing: "生成中",
  feedback_generated: "已生成",
  completed: "已完成",
  failed: "失败",
};

init();

async function init() {
  bindEvents();
  setDefaultLessonTime();
  await refreshAll();
}

function bindEvents() {
  el.refreshButton.addEventListener("click", refreshAll);
  el.logoutButton.addEventListener("click", onLogout);
  el.loginForm.addEventListener("submit", onLogin);
  el.studentForm.addEventListener("submit", onCreateStudent);
  el.studentSearchInput.addEventListener("input", onStudentSearchChanged);
  el.deleteStudentButton.addEventListener("click", onDeleteStudent);
  el.lessonForm.addEventListener("submit", onCreateLesson);
  el.lessonSearchInput.addEventListener("input", onLessonSearchChanged);
  el.audioInput.addEventListener("change", onFileSelected);
  el.secondAudioInput.addEventListener("change", onFileSelected);
  el.transcribeBackendSelect.addEventListener("change", onChangeTranscribeBackend);
  el.feedbackGeneratorSelect.addEventListener("change", onChangeFeedbackGenerator);
  el.localModelSelect.addEventListener("change", onLocalModelSelectionChanged);
  el.styleSelect.addEventListener("change", onChangeFeedbackStyle);
  el.switchLocalModelButton.addEventListener("click", onSwitchLocalModel);
  el.transcriptOnlyUploadButton.addEventListener("click", () => onUploadRecording("transcript_only"));
  el.uploadButton.addEventListener("click", () => onUploadRecording("with_feedback"));
  el.generateFeedbackButton.addEventListener("click", () => onGenerateFeedbackOnly("generate"));
  el.copyTranscriptButton.addEventListener("click", onCopyTranscript);
  el.saveFeedbackButton.addEventListener("click", onSaveFeedback);
  el.copyButton.addEventListener("click", onCopyFeedback);
  el.regenerateButton.addEventListener("click", onRegenerateFeedback);
  el.deleteLessonButton.addEventListener("click", onDeleteLesson);
}

async function refreshAll() {
  try {
    const config = await apiGet("/api/config");
    state.config = config;
    state.authenticated = !config.authRequired || config.authenticated;
    renderConfig();
    renderAuth();
    if (!state.authenticated) {
      state.students = [];
      state.lessons = [];
      state.selectedStudentId = null;
      state.selectedLessonId = null;
      renderStudents();
      renderLessons();
      renderLessonDetail(null);
      return;
    }
    const students = await apiGet("/api/students");
    state.students = students.students || [];
    renderConfig();
    renderStudents();
    if (state.selectedStudentId && state.students.some((student) => student.id === state.selectedStudentId)) {
      await loadLessons(state.selectedStudentId);
    } else if (state.students.length) {
      await selectStudent(state.students[0].id);
    } else {
      state.selectedStudentId = null;
      state.selectedLessonId = null;
      state.lessons = [];
      renderLessons();
      renderLessonDetail(null);
    }
  } catch (error) {
    toast(error.message);
  }
}

function renderConfig() {
  const config = state.config;
  if (!config) {
    el.modeBadge.textContent = "配置加载中";
    el.accessLinks.classList.add("hidden");
    return;
  }
  const feedbackText = config.feedbackBackendSummary || "未配置反馈 LLM";
  if (config.effectiveAiMode === "openai") {
    el.modeBadge.textContent = `音频转写：${config.transcribeModel}；反馈：${feedbackText}`;
  } else if (config.effectiveAiMode === "local") {
    const ffmpegText = config.ffmpegAvailable ? "ffmpeg 可用" : "未检测到 ffmpeg";
    const transcribeText = config.transcribeBackendSummary || `本地转写：${config.transcribeModel}`;
    el.modeBadge.textContent = `语音转文字：${transcribeText}；反馈：${feedbackText}；${ffmpegText}`;
  } else {
    const ffmpegText = config.ffmpegAvailable ? "ffmpeg 可用" : "未检测到 ffmpeg";
    el.modeBadge.textContent = `无费用演示模式：不会调用外部 API，反馈生成走 mock，${ffmpegText}`;
  }
  renderAccessLinks();
  renderTranscribeBackendControl(state.lessonPayload?.lesson || null);
  renderLocalModelControls(state.lessonPayload?.lesson || null);
}

function renderAuth() {
  const required = Boolean(state.config?.authRequired);
  el.logoutButton.classList.toggle("hidden", !required || !state.authenticated);
  el.loginOverlay.classList.toggle("hidden", state.authenticated);
}

function renderStudents() {
  el.studentsList.innerHTML = "";
  el.studentCount.textContent = String(state.students.length);
  el.deleteStudentButton.classList.toggle("hidden", !state.selectedStudentId);
  if (!state.students.length) {
    el.deleteStudentButton.classList.add("hidden");
    el.studentsList.append(emptyNode("暂无学生"));
    return;
  }
  const filtered = state.students.filter((student) => matchesQuery([
    student.name,
    student.grade,
    student.notes,
  ], state.studentQuery));
  if (!filtered.length) {
    el.studentsList.append(emptyNode("没有匹配的学生"));
    return;
  }
  for (const student of filtered) {
    const item = document.createElement("div");
    item.className = `list-item student-list-item ${student.id === state.selectedStudentId ? "active" : ""}`;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `选择${student.name}`);
    item.innerHTML = `
      <div class="list-card">
        <span class="avatar-chip">${escapeHtml(getAvatarText(student.name))}</span>
        <div class="list-card-main">
          <div class="item-row">
            <button class="inline-edit-button student-name-edit" type="button" title="点击修改学生姓名" aria-label="修改${escapeHtml(student.name)}的姓名">${escapeHtml(student.name)}</button>
            <span class="subtle">${escapeHtml(student.grade || "")}</span>
          </div>
          <span class="subtle">${escapeHtml(student.notes || "无备注")}</span>
        </div>
      </div>
      <div class="student-actions">
        <button class="student-copy-button" type="button" title="复制姓名" aria-label="复制${escapeHtml(student.name)}的姓名">复制</button>
      </div>
    `;
    item.addEventListener("click", () => selectStudent(student.id));
    item.addEventListener("keydown", (event) => {
      if (event.target !== item || !isKeyboardActivation(event)) {
        return;
      }
      event.preventDefault();
      selectStudent(student.id);
    });
    item.querySelector(".student-name-edit").addEventListener("click", (event) => {
      event.stopPropagation();
      onRenameStudent(student.id);
    });
    item.querySelector(".student-copy-button").addEventListener("click", (event) => {
      event.stopPropagation();
      onCopyStudentName(student.name);
    });
    el.studentsList.append(item);
  }
}

async function selectStudent(studentId) {
  state.selectedStudentId = studentId;
  state.selectedLessonId = null;
  state.lessonPayload = null;
  clearPendingFileSelection();
  renderStudents();
  await loadLessons(studentId);
}

async function loadLessons(studentId) {
  const result = await apiGet(`/api/students/${studentId}/lessons`);
  state.lessons = result.lessons || [];
  const student = state.students.find((item) => item.id === studentId);
  el.selectedStudentName.textContent = student ? student.name : "";
  el.lessonForm.classList.toggle("disabled-zone", !student);
  renderLessons();
  if (state.selectedLessonId && state.lessons.some((lesson) => lesson.id === state.selectedLessonId)) {
    await selectLesson(state.selectedLessonId);
  } else if (state.lessons.length) {
    await selectLesson(state.lessons[0].id);
  } else {
    renderLessonDetail(null);
  }
}

function renderLessons() {
  el.lessonsList.innerHTML = "";
  el.lessonCount.textContent = String(state.lessons.length);
  if (!state.selectedStudentId) {
    el.lessonsList.append(emptyNode("先选择学生"));
    return;
  }
  if (!state.lessons.length) {
    el.lessonsList.append(emptyNode("暂无课程"));
    return;
  }
  const filtered = state.lessons.filter((lesson) => matchesQuery([
    lesson.lesson_title,
    lesson.lesson_time,
  ], state.lessonQuery));
  if (!filtered.length) {
    el.lessonsList.append(emptyNode("没有匹配的课程"));
    return;
  }
  for (const lesson of filtered) {
    const item = document.createElement("div");
    item.className = `list-item lesson-list-item ${lesson.id === state.selectedLessonId ? "active" : ""}`;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `选择${lesson.lesson_title}`);
    item.innerHTML = `
      <div class="list-card-main">
        <div class="item-row">
          <button class="inline-edit-button lesson-title-edit" type="button" title="点击修改课程名称" aria-label="修改${escapeHtml(lesson.lesson_title)}的课程名称">${escapeHtml(lesson.lesson_title)}</button>
          <span class="status-pill ${lesson.status === "failed" ? "failed" : ""}">${labelStatus(lesson.status)}</span>
        </div>
        <div class="lesson-meta-row">
          <span class="subtle">${formatDateTime(lesson.lesson_time)}</span>
          <span class="subtle">${lesson.duration_sec ? formatSeconds(lesson.duration_sec) : ""}</span>
        </div>
      </div>
    `;
    item.addEventListener("click", () => selectLesson(lesson.id));
    item.addEventListener("keydown", (event) => {
      if (event.target !== item || !isKeyboardActivation(event)) {
        return;
      }
      event.preventDefault();
      selectLesson(lesson.id);
    });
    item.querySelector(".lesson-title-edit").addEventListener("click", (event) => {
      event.stopPropagation();
      onRenameLesson(lesson.id);
    });
    el.lessonsList.append(item);
  }
}

async function selectLesson(lessonId) {
  state.selectedLessonId = lessonId;
  clearPendingFileSelection();
  const payload = await apiGet(`/api/lessons/${lessonId}`);
  state.lessonPayload = payload;
  renderLessons();
  renderLessonDetail(payload);
  startPollingIfNeeded();
}

function renderLessonDetail(payload) {
  if (!payload) {
    stopPolling();
    el.emptyState.classList.remove("hidden");
    el.lessonDetail.classList.add("hidden");
    el.lessonStatusPill.textContent = "未选择";
    el.lessonStatusPill.classList.remove("failed");
    renderTranscribeBackendControl(null);
    renderFeedbackGenerator(null);
    renderLocalModelControls(null);
    renderTranscript(null);
    renderFeedback(null);
    syncUploadControls();
    return;
  }

  const { lesson, status, recording, recordings } = payload;
  el.emptyState.classList.add("hidden");
  el.lessonDetail.classList.remove("hidden");
  el.currentLessonTitle.textContent = lesson.lesson_title;
  el.lessonStatusPill.textContent = labelStatus(lesson.status);
  el.lessonStatusPill.classList.toggle("failed", lesson.status === "failed");

  const progress = Math.round((status.progress || 0) * 100);
  el.progressText.textContent = `状态：${labelStatus(lesson.status)}，进度 ${progress}%`;
  el.chunkText.textContent = status.total_chunks
    ? `${status.completed_chunks}/${status.total_chunks} 段完成`
    : "";
  el.progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  el.errorMessage.textContent = status.error_message || "";

  renderChunks(status.chunks || []);
  renderRecording(recording, recordings || []);
  renderTranscribeBackendControl(lesson);
  renderFeedbackGenerator(lesson);
  renderLocalModelControls(lesson);
  renderFeedbackStyleControl(lesson);
  renderTranscript(payload);
  renderFeedback(lesson);
  syncUploadControls();
}

function renderTranscribeBackendControl(lesson) {
  const config = state.config || {};
  const localMode = config.effectiveAiMode === "local";
  const localEnabled = localMode && Boolean(config.localWhisperAvailable);
  const remoteEnabled = localMode && Boolean(config.remoteTranscribeConfigured);
  const savedBackend = lesson?.transcribe_backend || config.defaultTranscribeBackend || "local";
  const localOption = el.transcribeBackendSelect.querySelector('option[value="local"]');
  const remoteOption = el.transcribeBackendSelect.querySelector('option[value="remote"]');

  if (localOption) {
    localOption.disabled = !localEnabled;
    localOption.textContent = localEnabled ? "本机转写" : "本机转写（未就绪）";
  }
  if (remoteOption) {
    remoteOption.disabled = !remoteEnabled;
    remoteOption.textContent = remoteEnabled ? "远程转写" : "远程转写（未配置）";
  }

  el.transcribeBackendSelect.disabled = !lesson || !localMode || (!localEnabled && !remoteEnabled);
  el.transcribeBackendSelect.value = savedBackend === "remote" ? "remote" : "local";

  if (!localMode) {
    el.transcribeBackendHint.textContent = config.effectiveAiMode === "openai"
      ? "当前音频转写由 OpenAI 兼容接口完成"
      : "当前是无费用演示模式，不会调用真实语音转文字";
  } else if (el.transcribeBackendSelect.value === "remote") {
    el.transcribeBackendHint.textContent = remoteEnabled
      ? `远程机器：${config.remoteTranscribeSummary || config.remoteTranscribeHost || "已配置"}`
      : "远程转写未配置";
  } else {
    el.transcribeBackendHint.textContent = localEnabled
      ? "本机 faster-whisper：可用"
      : "本机 faster-whisper：未就绪";
  }
}

function renderFeedbackGenerator(lesson) {
  const mockMode = state.config?.effectiveAiMode === "mock";
  const localEnabled = mockMode || Boolean(state.config?.localLlmFeedbackAvailable);
  const openAiEnabled = mockMode || Boolean(state.config?.openAiLlmFeedbackAvailable);
  const hasAnyEnabled = localEnabled || openAiEnabled;
  const fallback = state.config?.defaultFeedbackGenerator
    || (localEnabled ? "local_llm" : openAiEnabled ? "openai_llm" : "local_llm");
  const generator = lesson?.feedback_generator || fallback;
  const localOption = el.feedbackGeneratorSelect.querySelector('option[value="local_llm"]');
  const openAiOption = el.feedbackGeneratorSelect.querySelector('option[value="openai_llm"]');
  if (localOption) {
    localOption.disabled = !localEnabled;
    localOption.textContent = localEnabled ? "本地 LLM" : "本地 LLM（未配置）";
  }
  if (openAiOption) {
    openAiOption.disabled = !openAiEnabled;
    openAiOption.textContent = openAiEnabled ? "OpenAI 兼容 LLM" : "OpenAI 兼容 LLM（未配置）";
  }
  el.feedbackGeneratorSelect.disabled = !lesson || !hasAnyEnabled;
  if (generator === "local_llm") {
    el.feedbackGeneratorSelect.value = "local_llm";
  } else if (generator === "openai_llm") {
    el.feedbackGeneratorSelect.value = "openai_llm";
  } else if (localEnabled) {
    el.feedbackGeneratorSelect.value = "local_llm";
  } else if (openAiEnabled) {
    el.feedbackGeneratorSelect.value = "openai_llm";
  }
  el.regenerateButton.disabled = !lesson || !hasAnyEnabled;
  syncGenerateFeedbackButton();
}

function renderAccessLinks() {
  const config = state.config;
  const links = [];
  if (config?.localUrl) {
    links.push(`<span>本机：<a href="${escapeHtml(config.localUrl)}" target="_blank" rel="noreferrer">${escapeHtml(config.localUrl)}</a></span>`);
  }
  for (const url of config?.lanUrls || []) {
    links.push(`<span>局域网：<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></span>`);
  }
  el.accessLinks.innerHTML = links.join("");
  el.accessLinks.classList.toggle("hidden", links.length === 0);
}

function renderLocalModelControls(lesson) {
  const config = state.config || {};
  const selectedModel = String(config.localLlmSelectedModel || "").trim();
  const models = Array.isArray(config.localLlmAvailableModels)
    ? config.localLlmAvailableModels.filter((item) => String(item || "").trim())
    : [];
  const options = models.length ? models : (selectedModel ? [selectedModel] : []);
  const usingLocalGenerator = (lesson?.feedback_generator === "none"
    ? el.feedbackGeneratorSelect.value
    : lesson?.feedback_generator) === "local_llm";
  el.localModelSelect.innerHTML = "";
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无可切换模型";
    el.localModelSelect.append(option);
  } else {
    for (const model of options) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = formatModelLabel(model);
      el.localModelSelect.append(option);
    }
  }
  if (selectedModel) {
    el.localModelSelect.value = options.includes(selectedModel) ? selectedModel : "";
  }
  const canSwitch = Boolean(config.localLlmConfigured) && options.length > 0;
  el.localModelSelect.disabled = !canSwitch;
  el.switchLocalModelButton.disabled = !canSwitch || !selectedModel || el.localModelSelect.value === selectedModel;

  if (!config.localLlmConfigured) {
    el.localModelHint.textContent = "未配置本地 LLM 接口";
    return;
  }
  if (!config.localLlmReachable) {
    el.localModelHint.textContent = `本地 LLM 接口未连通：${config.localLlmError || config.localLlmEndpoint || "未知原因"}`;
    return;
  }
  const usageText = usingLocalGenerator ? "当前课程将使用这个模型生成反馈" : "切到本地 LLM 后会使用这个模型生成反馈";
  const modelCountText = options.length > 0 ? `，共发现 ${options.length} 个本地模型` : "";
  if (!config.localLlmFeedbackAvailable) {
    el.localModelHint.textContent = `当前选中模型未就绪：${selectedModel || "未配置"}${modelCountText}`;
    return;
  }
  el.localModelHint.textContent = `当前模型：${selectedModel || "未配置"}${modelCountText}；${usageText}`;
}

function renderChunks(chunks) {
  el.chunkList.innerHTML = "";
  if (!chunks.length) {
    return;
  }
  for (const chunk of chunks) {
    const card = document.createElement("div");
    card.className = `chunk-card ${chunk.transcription_status === "failed" ? "failed" : ""}`;
    const retryButton = chunk.transcription_status === "failed" && chunk.retry_count < 3
      ? `<button type="button" data-retry="${chunk.id}">重试</button>`
      : "";
    const chunkLabel = chunks.some((item) => item.recording_order > 1)
      ? `第 ${chunk.recording_order || 1} 段录音 · 第 ${chunk.chunk_index} 个切片`
      : `第 ${chunk.chunk_index} 段`;
    card.innerHTML = `
      <strong>${chunkLabel} · ${labelStatus(chunk.transcription_status)}</strong>
      <span>${formatSeconds(chunk.start_time_sec)} - ${formatSeconds(chunk.end_time_sec)}</span>
      <span class="subtle">失败尝试 ${chunk.retry_count || 0} 次${chunk.virtual ? " · 虚拟切片" : ""}</span>
      ${chunk.error_message ? `<span class="error-text">${escapeHtml(chunk.error_message)}</span>` : ""}
      ${retryButton}
    `;
    const retry = card.querySelector("[data-retry]");
    if (retry) {
      retry.addEventListener("click", () => retryChunk(chunk.id));
    }
    el.chunkList.append(card);
  }
}

function renderRecording(recording, recordings = []) {
  if (!recording) {
    if (state.selectedFiles.length > 0) {
      renderPendingFileMeta();
      return;
    }
    el.fileMeta.textContent = "尚未选择录音文件";
    el.audioPreview.removeAttribute("src");
    el.audioPreview.classList.add("hidden");
    return;
  }
  const ordered = recordings.length > 0 ? recordings : [recording];
  const lines = ordered.map((item, index) => [
    `${ordered.length > 1 ? `第 ${item.recording_order || index + 1} 段` : "已保存"}：${item.original_audio_filename || "录音文件"}`,
    `大小：${formatBytes(item.original_audio_size)}`,
    `时长：${item.original_audio_duration_sec ? formatSeconds(item.original_audio_duration_sec) : "未知"}`,
  ].join(" · "));
  el.fileMeta.innerHTML = lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  if (ordered.length === 1) {
    el.audioPreview.src = recording.original_audio_url;
    el.audioPreview.classList.remove("hidden");
  } else {
    el.audioPreview.removeAttribute("src");
    el.audioPreview.classList.add("hidden");
  }
}

function renderTranscript(payload) {
  if (!payload) {
    el.transcriptSection.classList.add("hidden");
    el.transcriptView.textContent = "";
    return;
  }
  const transcriptText = buildTranscriptText(payload);
  el.transcriptSection.classList.toggle("hidden", !transcriptText);
  el.transcriptView.textContent = transcriptText;
}

function renderFeedback(lesson) {
  if (!lesson) {
    el.feedbackSection.classList.add("hidden");
    el.feedbackEditor.value = "";
    el.styleSelect.value = "professional_warm";
    el.styleSelect.disabled = true;
    el.summaryView.textContent = "";
    renderSummaryCards(null);
    return;
  }
  el.styleSelect.disabled = false;
  el.styleSelect.value = lesson.feedback_style || "professional_warm";
  const ready = ["feedback_generated", "completed", "failed"].includes(lesson.status) && (lesson.feedback_text || lesson.teacher_edited_feedback);
  el.feedbackSection.classList.toggle("hidden", !ready);
  renderSummaryCards(lesson.structured_summary || null);
  el.summaryView.textContent = lesson.structured_summary
    ? JSON.stringify(lesson.structured_summary, null, 2)
    : "暂无结构化总结";
  if (!ready) {
    el.feedbackEditor.value = "";
    return;
  }
  el.feedbackEditor.value = lesson.teacher_edited_feedback || lesson.feedback_text || "";
}

async function onCreateStudent(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  try {
    const result = await apiPost("/api/students", payload);
    formElement.reset();
    await refreshAll();
    await selectStudent(result.student.id);
    toast("学生已创建");
  } catch (error) {
    toast(error.message);
  }
}

async function onLogin(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await apiPost("/api/auth/login", Object.fromEntries(form.entries()));
    formElement.reset();
    await refreshAll();
    toast("已登录");
  } catch (error) {
    toast(error.message);
  }
}

async function onDeleteStudent() {
  if (!state.selectedStudentId) {
    return;
  }
  const student = state.students.find((item) => item.id === state.selectedStudentId);
  if (!confirm(`确认删除学生“${student?.name || ""}”及其全部课程记录？`)) {
    return;
  }
  try {
    await apiDelete(`/api/students/${state.selectedStudentId}`);
    state.selectedStudentId = null;
    state.selectedLessonId = null;
    state.lessonPayload = null;
    await refreshAll();
    toast("学生已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function onRenameStudent(studentId) {
  const student = state.students.find((item) => item.id === studentId);
  if (!student) {
    return;
  }
  const nextName = prompt("请输入新的学生姓名", student.name);
  if (nextName === null) {
    return;
  }
  const name = nextName.trim();
  if (!name) {
    toast("学生姓名不能为空");
    return;
  }
  try {
    const result = await apiPut(`/api/students/${student.id}`, { name });
    Object.assign(student, result.student);
    if (state.lessonPayload?.student?.id === student.id) {
      state.lessonPayload.student = result.student;
    }
    renderStudents();
    await loadLessons(state.selectedStudentId);
    toast("学生姓名已修改");
  } catch (error) {
    toast(error.message);
  }
}

async function onRenameLesson(lessonId) {
  const lesson = state.lessons.find((item) => item.id === lessonId);
  if (!lesson) {
    return;
  }
  const nextTitle = prompt("请输入新的课程名称", lesson.lesson_title);
  if (nextTitle === null) {
    return;
  }
  const lessonTitle = nextTitle.trim();
  if (!lessonTitle) {
    toast("课程名称不能为空");
    return;
  }
  try {
    const payload = await apiPut(`/api/lessons/${lesson.id}`, { lesson_title: lessonTitle });
    Object.assign(lesson, payload.lesson);
    if (state.selectedLessonId === lesson.id) {
      state.lessonPayload = payload;
      renderLessonDetail(payload);
    }
    renderLessons();
    toast("课程名称已修改");
  } catch (error) {
    toast(error.message);
  }
}

async function onLogout() {
  try {
    await apiPost("/api/auth/logout", {});
    await refreshAll();
    toast("已退出");
  } catch (error) {
    toast(error.message);
  }
}

async function onCreateLesson(event) {
  event.preventDefault();
  if (!state.selectedStudentId) {
    toast("先选择学生");
    return;
  }
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  payload.student_id = state.selectedStudentId;
  try {
    const result = await apiPost("/api/lessons", payload);
    formElement.reset();
    setDefaultLessonTime();
    await loadLessons(state.selectedStudentId);
    await selectLesson(result.lesson.id);
    toast("课程已创建");
  } catch (error) {
    toast(error.message);
  }
}

async function onFileSelected() {
  const firstFiles = Array.from(el.audioInput.files || []);
  const secondFiles = Array.from(el.secondAudioInput.files || []);
  const files = [firstFiles[0], secondFiles[0] || firstFiles[1]].filter(Boolean);
  if (firstFiles.length > 2 || secondFiles.length > 1) {
    toast("最多支持两段录音，已保留前两段");
  }
  state.selectedFiles = files;
  state.selectedFile = files[0] || null;
  state.selectedFileDurations = new Array(files.length).fill(null);
  state.selectedFileDuration = null;
  if (files.length === 0) {
    el.fileMeta.textContent = "尚未选择录音文件";
    el.audioPreview.classList.add("hidden");
    syncUploadControls();
    return;
  }

  const objectUrl = URL.createObjectURL(files[0]);
  el.audioPreview.src = objectUrl;
  el.audioPreview.classList.remove("hidden");
  renderPendingFileMeta();
  syncUploadControls();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const durationUrl = index === 0 ? objectUrl : URL.createObjectURL(file);
    const duration = await readAudioDuration(durationUrl).catch(() => null);
    if (state.selectedFiles[index] !== file) {
      return;
    }
    state.selectedFileDurations[index] = duration;
    if (index === 0) {
      state.selectedFileDuration = duration;
    }
    renderPendingFileMeta();
  }
}

async function onUploadRecording(mode = "with_feedback") {
  if (!state.selectedLessonId) {
    toast("先选择课程");
    return;
  }
  if (state.selectedFiles.length === 0) {
    openFilePicker();
    return;
  }
  setUploadButtonsState(true, "上传中");
  try {
    const files = state.selectedFiles.slice(0, 2);
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await apiPut(`/api/lessons/${state.selectedLessonId}/preferences`, {
      feedback_generator: mode === "transcript_only" ? "none" : el.feedbackGeneratorSelect.value,
    });
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const response = await fetch(`/api/lessons/${state.selectedLessonId}/recording`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-File-Format": file.type || extensionOf(file.name),
          "X-Audio-Duration-Sec": state.selectedFileDurations[index] ? String(Math.round(state.selectedFileDurations[index])) : "",
          "X-Recording-Batch-Id": batchId,
          "X-Recording-Order": String(index + 1),
          "X-Recording-Total": String(files.length),
        },
        body: file,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `第 ${index + 1} 段上传失败：${response.status}`);
      }
    }
    clearPendingFileSelection();
    await selectLesson(state.selectedLessonId);
    toast(mode === "transcript_only" ? "录音已上传，将只生成文字版" : "录音已上传，将生成文字与反馈");
  } catch (error) {
    toast(error.message);
  } finally {
    syncUploadControls();
  }
}

async function onChangeFeedbackGenerator(event) {
  if (!state.selectedLessonId) {
    return;
  }
  const feedbackGenerator = event.target.value;
  try {
    const payload = await apiPut(`/api/lessons/${state.selectedLessonId}/preferences`, {
      feedback_generator: feedbackGenerator,
    });
    state.lessonPayload = payload;
    const existing = state.lessons.find((lesson) => lesson.id === payload.lesson.id);
    if (existing) {
      Object.assign(existing, payload.lesson);
    }
    renderLessons();
    renderLessonDetail(payload);
    toast("反馈生成方式已保存");
  } catch (error) {
    renderFeedbackGenerator(state.lessonPayload?.lesson || null);
    toast(error.message);
  }
}

async function onChangeTranscribeBackend(event) {
  if (!state.selectedLessonId) {
    return;
  }
  const transcribeBackend = event.target.value;
  try {
    const payload = await apiPut(`/api/lessons/${state.selectedLessonId}/preferences`, {
      transcribe_backend: transcribeBackend,
    });
    state.lessonPayload = payload;
    const existing = state.lessons.find((lesson) => lesson.id === payload.lesson.id);
    if (existing) {
      Object.assign(existing, payload.lesson);
    }
    renderLessons();
    renderLessonDetail(payload);
    toast("语音转文字位置已保存");
  } catch (error) {
    renderTranscribeBackendControl(state.lessonPayload?.lesson || null);
    toast(error.message);
  }
}

async function onChangeFeedbackStyle(event) {
  if (!state.selectedLessonId) {
    return;
  }
  const feedbackStyle = event.target.value;
  try {
    const payload = await apiPut(`/api/lessons/${state.selectedLessonId}/preferences`, {
      feedback_style: feedbackStyle,
    });
    state.lessonPayload = payload;
    const existing = state.lessons.find((lesson) => lesson.id === payload.lesson.id);
    if (existing) {
      Object.assign(existing, payload.lesson);
    }
    renderLessonDetail(payload);
    toast("反馈风格已保存");
  } catch (error) {
    renderFeedbackStyleControl(state.lessonPayload?.lesson || null);
    toast(error.message);
  }
}

function onLocalModelSelectionChanged() {
  const selectedModel = String(state.config?.localLlmSelectedModel || "").trim();
  el.switchLocalModelButton.disabled = !el.localModelSelect.value || el.localModelSelect.value === selectedModel;
}

async function onSwitchLocalModel() {
  const model = el.localModelSelect.value;
  if (!model) {
    toast("没有可切换的本地模型");
    return;
  }
  el.switchLocalModelButton.disabled = true;
  el.switchLocalModelButton.textContent = "切换中";
  try {
    const result = await apiPut("/api/settings/local-llm", { model });
    state.config = result.config;
    renderConfig();
    renderFeedbackGenerator(state.lessonPayload?.lesson || null);
    syncUploadControls();
    toast("本地模型已切换");
  } catch (error) {
    toast(error.message);
  } finally {
    el.switchLocalModelButton.textContent = "切换模型";
    onLocalModelSelectionChanged();
  }
}

async function onSaveFeedback() {
  if (!state.selectedLessonId) {
    return;
  }
  try {
    const result = await apiPut(`/api/lessons/${state.selectedLessonId}/feedback`, {
      teacher_edited_feedback: el.feedbackEditor.value,
    });
    state.lessonPayload = result;
    toast("反馈已保存");
  } catch (error) {
    toast(error.message);
  }
}

async function onCopyFeedback() {
  const text = el.feedbackEditor.value.trim();
  if (!text) {
    toast("没有可复制的反馈");
    return;
  }
  try {
    const copied = await copyText(text);
    toast(copied ? "反馈已复制" : "复制失败，请手动 Ctrl+C");
  } catch (error) {
    toast(error.message || "复制失败，请手动 Ctrl+C");
  }
}

async function onCopyTranscript() {
  const text = el.transcriptView.textContent.trim();
  if (!text) {
    toast("没有可复制的文字版");
    return;
  }
  try {
    const copied = await copyText(text);
    toast(copied ? "文字版已复制" : "复制失败，请手动 Ctrl+C");
  } catch (error) {
    toast(error.message || "复制失败，请手动 Ctrl+C");
  }
}

async function onCopyStudentName(name) {
  const text = String(name || "").trim();
  if (!text) {
    toast("没有可复制的学生姓名");
    return;
  }
  try {
    const copied = await copyText(text);
    toast(copied ? "学生姓名已复制" : "复制失败，请手动 Ctrl+C");
  } catch (error) {
    toast(error.message || "复制失败，请手动 Ctrl+C");
  }
}

async function onRegenerateFeedback() {
  await onGenerateFeedbackOnly("regenerate");
}

async function onGenerateFeedbackOnly(action = "generate") {
  if (!state.selectedLessonId) {
    return;
  }
  syncGenerateFeedbackButton(true, action === "regenerate" ? "重新生成中" : "生成中");
  try {
    await apiPost(`/api/lessons/${state.selectedLessonId}/regenerate-feedback`, {
      style: el.styleSelect.value,
      length: "medium",
      feedback_generator: el.feedbackGeneratorSelect.value,
    });
    await selectLesson(state.selectedLessonId);
    toast(action === "regenerate" ? "已开始重新生成" : "已开始生成课后反馈");
  } catch (error) {
    toast(error.message);
  } finally {
    syncGenerateFeedbackButton();
  }
}

async function onDeleteLesson() {
  if (!state.selectedLessonId) {
    return;
  }
  if (!confirm("确认删除这条课程记录？")) {
    return;
  }
  try {
    await apiDelete(`/api/lessons/${state.selectedLessonId}`);
    state.selectedLessonId = null;
    await loadLessons(state.selectedStudentId);
    toast("课程已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function retryChunk(chunkId) {
  try {
    await apiPost(`/api/chunks/${chunkId}/retry`, {});
    await selectLesson(state.selectedLessonId);
    toast("已重试该切片");
  } catch (error) {
    toast(error.message);
  }
}

function startPollingIfNeeded() {
  stopPolling();
  const status = state.lessonPayload?.lesson?.status;
  if (["audio_uploaded", "audio_processing", "transcribing", "transcribed", "summarizing"].includes(status)) {
    state.pollTimer = setInterval(pollSelectedLesson, 1500);
  }
  syncUploadControls();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollSelectedLesson() {
  if (!state.selectedLessonId) {
    stopPolling();
    return;
  }
  try {
    const payload = await apiGet(`/api/lessons/${state.selectedLessonId}`);
    state.lessonPayload = payload;
    const existing = state.lessons.find((lesson) => lesson.id === payload.lesson.id);
    if (existing) {
      Object.assign(existing, payload.lesson);
    }
    renderLessons();
    renderLessonDetail(payload);
    if (!["audio_uploaded", "audio_processing", "transcribing", "transcribed", "summarizing"].includes(payload.lesson.status)) {
      stopPolling();
    }
  } catch (error) {
    stopPolling();
    toast(error.message);
  }
}

function syncUploadControls() {
  const lesson = state.lessonPayload?.lesson || null;
  const hasLesson = Boolean(state.selectedLessonId && lesson);
  const busy = Boolean(lesson && ["audio_uploaded", "audio_processing", "transcribing", "transcribed", "summarizing"].includes(lesson.status));
  const transcribeBackend = lesson?.transcribe_backend || state.config?.defaultTranscribeBackend || el.transcribeBackendSelect.value;
  const transcribeConfigured = Boolean(state.config) && (
    state.config.effectiveAiMode !== "local"
    || (transcribeBackend === "remote" && state.config.remoteTranscribeConfigured)
    || (transcribeBackend !== "remote" && state.config.localWhisperAvailable)
  );
  const generator = lesson?.feedback_generator && lesson.feedback_generator !== "none"
    ? lesson.feedback_generator
    : el.feedbackGeneratorSelect.value || state.config?.defaultFeedbackGenerator;
  const feedbackConfigured = Boolean(state.config) && (
    state.config.effectiveAiMode === "mock"
    || (generator === "local_llm" && state.config.localLlmFeedbackAvailable)
    || (generator === "openai_llm" && state.config.openAiLlmFeedbackAvailable)
  );

  setUploadButtonsState(false, "");
  syncGenerateFeedbackButton(false, "");
  if (!hasLesson) {
    setUploadButtonsState(true, "先选择课程");
    syncGenerateFeedbackButton(true, "先选择课程");
    return;
  }
  if (!transcribeConfigured) {
    setUploadButtonsState(true, transcribeBackend === "remote" ? "先配置远程转写" : "先准备本机转写");
    syncGenerateFeedbackButton();
    return;
  }
  if (busy) {
    setUploadButtonsState(true, "处理中");
    syncGenerateFeedbackButton(true, "处理中");
    return;
  }
  if (!feedbackConfigured) {
    el.uploadButton.disabled = true;
    el.uploadButton.title = generator === "local_llm" ? "先准备本地模型" : "先配置反馈LLM";
    syncGenerateFeedbackButton(true, el.uploadButton.title);
  }
}

function setUploadButtonsState(disabled, reason) {
  el.transcriptOnlyUploadButton.textContent = "只生成录音文字版";
  el.uploadButton.textContent = "生成文字与反馈";
  el.transcriptOnlyUploadButton.disabled = disabled;
  el.uploadButton.disabled = disabled;
  el.transcriptOnlyUploadButton.title = reason || (state.selectedFiles.length > 0 ? "" : "先选择录音文件");
  el.uploadButton.title = reason || (state.selectedFiles.length > 0 ? "" : "先选择录音文件");
}

function syncGenerateFeedbackButton(forcedDisabled = false, forcedReason = "") {
  if (!el.generateFeedbackButton) {
    return;
  }
  const lesson = state.lessonPayload?.lesson || null;
  const hasTranscript = Boolean(String(lesson?.full_transcript || "").trim());
  const generator = lesson?.feedback_generator && lesson.feedback_generator !== "none"
    ? lesson.feedback_generator
    : el.feedbackGeneratorSelect.value || state.config?.defaultFeedbackGenerator;
  const feedbackConfigured = Boolean(state.config) && (
    state.config.effectiveAiMode === "mock"
    || (generator === "local_llm" && state.config.localLlmFeedbackAvailable)
    || (generator === "openai_llm" && state.config.openAiLlmFeedbackAvailable)
  );
  const busy = Boolean(lesson && ["audio_uploaded", "audio_processing", "transcribing", "transcribed", "summarizing"].includes(lesson.status));
  let disabled = forcedDisabled || !lesson || busy || !hasTranscript || !feedbackConfigured;
  let reason = forcedReason;
  if (!reason && !lesson) {
    reason = "先选择课程";
  } else if (!reason && busy) {
    reason = "处理中";
  } else if (!reason && !hasTranscript) {
    reason = "先生成录音文字版";
  } else if (!reason && !feedbackConfigured) {
    reason = generator === "local_llm" ? "先准备本地模型" : "先配置反馈LLM";
  }
  el.generateFeedbackButton.textContent = "生成课后反馈";
  el.generateFeedbackButton.disabled = disabled;
  el.generateFeedbackButton.title = reason || "根据已有录音文字版生成课后反馈";
}

function renderPendingFileMeta() {
  if (state.selectedFiles.length === 0) {
    el.fileMeta.textContent = "尚未选择录音文件";
    return;
  }
  el.fileMeta.innerHTML = state.selectedFiles.map((file, index) => [
    state.selectedFiles.length > 1 ? `第 ${index + 1} 段` : "文件",
    file.name,
    formatBytes(file.size),
    file.type || extensionOf(file.name) || "未知",
    state.selectedFileDurations[index] ? formatSeconds(state.selectedFileDurations[index]) : "读取中",
  ].join(" · ")).map((line) => `<span>${escapeHtml(line)}</span>`).join("");
}

function clearPendingFileSelection() {
  state.selectedFile = null;
  state.selectedFiles = [];
  state.selectedFileDuration = null;
  state.selectedFileDurations = [];
  el.audioInput.value = "";
  el.secondAudioInput.value = "";
}

function openFilePicker() {
  if (typeof el.audioInput.showPicker === "function") {
    try {
      el.audioInput.showPicker();
      return;
    } catch {
      // Fallback to click() for browsers/environments that reject showPicker().
    }
  }
  el.audioInput.click();
}

async function copyText(text) {
  const normalized = String(text || "");
  if (!normalized) {
    return false;
  }
  if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(normalized);
      return true;
    } catch {
      // Fallback to document.execCommand("copy") for non-secure contexts or blocked clipboard access.
    }
  }
  return legacyCopyText(normalized);
}

function legacyCopyText(text) {
  if (typeof document.execCommand !== "function") {
    return false;
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.setAttribute("aria-hidden", "true");
  helper.style.position = "fixed";
  helper.style.left = "-9999px";
  helper.style.top = "0";
  helper.style.opacity = "0";
  document.body.append(helper);

  const activeElement = document.activeElement;
  const selection = document.getSelection ? document.getSelection() : null;
  const savedRange = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

  helper.focus();
  helper.select();
  helper.setSelectionRange(0, helper.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  helper.remove();

  if (selection) {
    selection.removeAllRanges();
    if (savedRange) {
      selection.addRange(savedRange);
    }
  }
  if (activeElement && typeof activeElement.focus === "function") {
    activeElement.focus();
  }
  return copied;
}

function renderFeedbackStyleControl(lesson) {
  const value = lesson?.feedback_style || "professional_warm";
  el.styleSelect.value = value;
  el.styleSelect.disabled = !lesson;
}

function buildTranscriptText(payload) {
  const fullTranscript = String(payload.lesson?.full_transcript || "").trim();
  if (fullTranscript) {
    return fullTranscript;
  }
  const chunks = Array.isArray(payload.status?.chunks) ? payload.status.chunks : [];
  const hasMultipleRecordings = chunks.some((chunk) => Number(chunk.recording_order || 1) > 1);
  const partial = chunks
    .filter((chunk) => chunk.transcript_text)
    .sort((a, b) => (Number(a.recording_order || 1) - Number(b.recording_order || 1)) || (a.chunk_index - b.chunk_index))
    .map((chunk) => {
      const prefix = hasMultipleRecordings ? `第${chunk.recording_order || 1}段录音 ` : "";
      return `【${prefix}${formatSeconds(chunk.start_time_sec)}-${formatSeconds(chunk.end_time_sec)}】\n${chunk.transcript_text}`;
    })
    .join("\n\n");
  return partial;
}

async function apiGet(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  return parseApiResponse(response);
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

async function apiPut(path, payload) {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

async function apiDelete(path) {
  const response = await fetch(path, { method: "DELETE", headers: { Accept: "application/json" } });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `请求失败：${response.status}`);
  }
  return result;
}

function readAudioDuration(objectUrl) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = objectUrl;
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => reject(new Error("无法读取音频时长"));
  });
}

function emptyNode(text) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.style.minHeight = "120px";
  div.textContent = text;
  return div;
}

function labelStatus(status) {
  return STATUS_LABEL[status] || status || "未知";
}

function isKeyboardActivation(event) {
  return event.key === "Enter" || event.key === " ";
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function extensionOf(name) {
  const match = /\.([^.]+)$/.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function setDefaultLessonTime() {
  const input = el.lessonForm.elements.lesson_time;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  input.value = now.toISOString().slice(0, 16);
}

function formatModelLabel(model) {
  return String(model || "")
    .replace(/^hf\.co\//, "")
    .replace(/^unsloth\//, "");
}

function renderSummaryCards(summary) {
  el.summaryCards.innerHTML = "";
  if (!summary) {
    el.summaryCards.append(summaryPlaceholder("暂无结构化总结"));
    return;
  }
  const cards = [
    { title: "学习内容", value: summary.lesson_content, type: "text" },
    { title: "课堂表现", value: summary.student_performance, type: "text" },
    { title: "课堂亮点", value: summary.strengths, type: "list" },
    { title: "当前问题", value: summary.weaknesses, type: "list" },
    { title: "典型例子", value: summary.typical_examples, type: "list" },
    { title: "改进建议", value: summary.correction_suggestions, type: "list" },
    { title: "课后建议", value: summary.homework_suggestion, type: "list" },
    { title: "下节重点", value: summary.next_lesson_focus, type: "list" },
  ];
  for (const card of cards) {
    const article = document.createElement("article");
    article.className = "summary-card";
    const items = normalizeSummaryItems(card.value);
    article.innerHTML = `
      <h4>${escapeHtml(card.title)}</h4>
      ${card.type === "text"
        ? `<p>${escapeHtml(items[0] || "未明确提及")}</p>`
        : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`}
    `;
    el.summaryCards.append(article);
  }
}

function normalizeSummaryItems(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || "").trim()).filter(Boolean);
    return items.length ? items : ["未明确提及"];
  }
  const text = String(value || "").trim();
  return text ? [text] : ["未明确提及"];
}

function summaryPlaceholder(text) {
  const article = document.createElement("article");
  article.className = "summary-card summary-placeholder";
  article.innerHTML = `<p>${escapeHtml(text)}</p>`;
  return article;
}

function matchesQuery(values, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return values.some((value) => String(value || "").toLowerCase().includes(needle));
}

function onStudentSearchChanged(event) {
  state.studentQuery = event.target.value || "";
  renderStudents();
}

function onLessonSearchChanged(event) {
  state.lessonQuery = event.target.value || "";
  renderLessons();
}

function getAvatarText(value) {
  return String(value || "").trim().slice(0, 1) || "?";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.classList.add("hidden");
  }, 2600);
}
