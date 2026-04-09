"use strict";

const STORAGE_KEYS = {
  library: "sharoushi.offline.library",
  queue: "sharoushi.offline.queue",
  doneByDate: "sharoushi.offline.doneByDate",
  memos: "sharoushi.offline.memos",
  appUsageByDate: "sharoushi.offline.appUsageByDate",
  appUsageSession: "sharoushi.offline.appUsageSession",
  studyTimeByDate: "sharoushi.offline.studyTimeByDate",
  studySession: "sharoushi.offline.studySession",
  selectedType: "sharoushi.offline.selectedType",
  selectedMaterial: "sharoushi.offline.selectedMaterial",
  selectedSubject: "sharoushi.offline.selectedSubject",
  query: "sharoushi.offline.query",
  installGuideDismissed: "sharoushi.offline.installGuideDismissed",
  nativeMap: "sharoushi.offline.nativeMap"
};

const DB_NAME = "sharoushi-offline-db";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const ROOT_HANDLE_KEY = "study-root";

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];
const SKIP_DIRECTORIES = new Set([".git", "offline-study-app", "node_modules"]);
const MAX_RENDER_ITEMS = 350;
const VIEWER_PLACEHOLDER_DEFAULT_TITLE = "教材を選択してください";
const VIEWER_PLACEHOLDER_DEFAULT_TEXT = "PDFは右側で閲覧、音声はそのまま再生できます。今日のキューに追加すると進捗管理しやすくなります。";
const STUDY_TICK_MS = 1000;
const SESSION_HEARTBEAT_MS = 5000;
const SESSION_RESUME_GRACE_MS = 15000;

const state = {
  library: [],
  libraryMap: new Map(),
  nativeFileMap: new Map(),
  filtered: [],
  subjectCounts: new Map(),
  queue: [],
  doneByDate: {},
  memos: {},
  appUsageByDate: {},
  appUsageSession: createEmptyAppUsageSession(),
  studyTimeByDate: {},
  studySession: createEmptyStudySession(),
  selectedType: "all",
  selectedMaterial: "all",
  selectedSubject: "all",
  query: "",
  rootHandle: null,
  filePool: null,
  currentPath: null,
  currentObjectUrl: null,
  deferredPrompt: null,
  scanning: false,
  installGuideDismissed: false,
  androidAppForeground: true
};

let pendingNativeFolderResolve = null;
let pendingNativeFolderTimer = null;
const NATIVE_PICK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
let studyTickTimer = 0;

const el = {};

document.addEventListener("DOMContentLoaded", init);
window.__onNativeFolderPicked = onNativeFolderPicked;
window.__onAndroidAppStateChanged = onAndroidAppStateChanged;

async function init() {
  cacheElements();
  bindEvents();
  hydrateState();
  syncAppUsageTracking();
  applyFilters();
  renderQueue();
  updateMemoAvailability();
  updateStudyPanel();
  updateAppUsagePanel();
  syncStudyTicker();

  const nativeFolderSupported = supportsNativeFolderPicker();
  if (!nativeFolderSupported && !supportsDirectoryPicker() && !supportsDirectoryUpload()) {
    el.connectBtn.textContent = "教材ファイル追加";
  } else if (!nativeFolderSupported && !supportsDirectoryPicker()) {
    el.connectBtn.textContent = "学習フォルダ選択";
  }

  await registerServiceWorker();
  await restoreRootHandle();
  setStatusFromState();
  requestNativeRestore();
  refreshInstallGuide();
}

function cacheElements() {
  el.statusText = document.getElementById("statusText");
  el.connectBtn = document.getElementById("connectBtn");
  el.addFilesBtn = document.getElementById("addFilesBtn");
  el.refreshBtn = document.getElementById("refreshBtn");
  el.installBtn = document.getElementById("installBtn");
  el.installGuide = document.getElementById("installGuide");
  el.installGuideText = document.getElementById("installGuideText");
  el.dismissInstallGuideBtn = document.getElementById("dismissInstallGuideBtn");
  el.searchInput = document.getElementById("searchInput");
  el.clearSearchBtn = document.getElementById("clearSearchBtn");
  el.resetFiltersBtn = document.getElementById("resetFiltersBtn");
  el.typeFilter = document.getElementById("typeFilter");
  el.materialFilter = document.getElementById("materialFilter");
  el.subjectList = document.getElementById("subjectList");
  el.itemList = document.getElementById("itemList");
  el.itemCount = document.getElementById("itemCount");
  el.queueStats = document.getElementById("queueStats");
  el.queueList = document.getElementById("queueList");
  el.clearDoneBtn = document.getElementById("clearDoneBtn");
  el.viewerPlaceholder = document.getElementById("viewerPlaceholder");
  el.pdfViewer = document.getElementById("pdfViewer");
  el.audioWrap = document.getElementById("audioWrap");
  el.audioTitle = document.getElementById("audioTitle");
  el.audioPlayer = document.getElementById("audioPlayer");
  el.appUsageTodayTotal = document.getElementById("appUsageTodayTotal");
  el.appUsageSessionTime = document.getElementById("appUsageSessionTime");
  el.appUsageState = document.getElementById("appUsageState");
  el.appUsageRecentList = document.getElementById("appUsageRecentList");
  el.studyTodayTotal = document.getElementById("studyTodayTotal");
  el.studySessionTime = document.getElementById("studySessionTime");
  el.studyCurrentItemTotal = document.getElementById("studyCurrentItemTotal");
  el.studyTarget = document.getElementById("studyTarget");
  el.toggleStudyBtn = document.getElementById("toggleStudyBtn");
  el.resetStudyTodayBtn = document.getElementById("resetStudyTodayBtn");
  el.studyRecentList = document.getElementById("studyRecentList");
  el.memoInput = document.getElementById("memoInput");
  el.saveMemoBtn = document.getElementById("saveMemoBtn");
  el.folderInput = document.getElementById("folderInput");
  el.fileInput = document.getElementById("fileInput");
}

function bindEvents() {
  el.connectBtn.addEventListener("click", connectFolder);
  el.addFilesBtn.addEventListener("click", addFiles);
  el.refreshBtn.addEventListener("click", refreshScan);
  el.searchInput.addEventListener("input", onSearchInput);
  if (el.clearSearchBtn) {
    el.clearSearchBtn.addEventListener("click", clearSearch);
  }
  if (el.resetFiltersBtn) {
    el.resetFiltersBtn.addEventListener("click", resetFilters);
  }
  el.typeFilter.addEventListener("change", onTypeChange);
  if (el.materialFilter) {
    el.materialFilter.addEventListener("change", onMaterialChange);
  }
  el.subjectList.addEventListener("click", onSubjectSelect);
  el.itemList.addEventListener("click", onItemListClick);
  el.queueList.addEventListener("click", onQueueClick);
  el.clearDoneBtn.addEventListener("click", clearTodayDone);
  el.toggleStudyBtn.addEventListener("click", toggleStudyTimer);
  el.resetStudyTodayBtn.addEventListener("click", resetTodayStudyTime);
  el.saveMemoBtn.addEventListener("click", () => saveCurrentMemo(true));
  el.memoInput.addEventListener("blur", () => saveCurrentMemo(false));
  el.folderInput.addEventListener("change", onFolderChosen);
  el.fileInput.addEventListener("change", onFilesChosen);
  el.installBtn.addEventListener("click", installPwa);
  el.dismissInstallGuideBtn.addEventListener("click", dismissInstallGuide);
  document.addEventListener("visibilitychange", handleAppVisibilityChange);
  window.addEventListener("focus", handleAppVisibilityChange);
  window.addEventListener("blur", handleAppVisibilityChange);
  window.addEventListener("pageshow", handleAppVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("beforeunload", handleBeforeUnload);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    el.installBtn.hidden = false;
    refreshInstallGuide();
  });

  window.addEventListener("appinstalled", () => {
    state.deferredPrompt = null;
    el.installBtn.hidden = true;
    refreshInstallGuide();
  });

  const media = window.matchMedia("(display-mode: standalone)");
  if (media && typeof media.addEventListener === "function") {
    media.addEventListener("change", refreshInstallGuide);
  }
}

function hydrateState() {
  state.queue = loadJson(STORAGE_KEYS.queue, []);
  if (!Array.isArray(state.queue)) {
    state.queue = [];
  }

  state.doneByDate = loadJson(STORAGE_KEYS.doneByDate, {});
  if (!isPlainObject(state.doneByDate)) {
    state.doneByDate = {};
  }
  ensureTodayDoneMap();

  state.memos = loadJson(STORAGE_KEYS.memos, {});
  if (!isPlainObject(state.memos)) {
    state.memos = {};
  }

  state.appUsageByDate = normalizeAppUsageByDate(loadJson(STORAGE_KEYS.appUsageByDate, {}));
  state.appUsageSession = normalizeAppUsageSession(loadJson(STORAGE_KEYS.appUsageSession, createEmptyAppUsageSession()));
  state.studyTimeByDate = normalizeStudyTimeByDate(loadJson(STORAGE_KEYS.studyTimeByDate, {}));
  state.studySession = normalizeStudySession(loadJson(STORAGE_KEYS.studySession, createEmptyStudySession()));

  state.selectedType = loadText(STORAGE_KEYS.selectedType, "all");
  if (!["all", "pdf", "audio"].includes(state.selectedType)) {
    state.selectedType = "all";
  }

  state.selectedMaterial = loadText(STORAGE_KEYS.selectedMaterial, "all");
  if (!state.selectedMaterial) {
    state.selectedMaterial = "all";
  }

  state.selectedSubject = loadText(STORAGE_KEYS.selectedSubject, "all");
  state.query = loadText(STORAGE_KEYS.query, "");
  state.installGuideDismissed = loadText(STORAGE_KEYS.installGuideDismissed, "") === "1";

  const cachedLibrary = loadJson(STORAGE_KEYS.library, []);
  if (Array.isArray(cachedLibrary)) {
    state.library = cachedLibrary
      .map(normalizeItem)
      .filter(Boolean);
  }
  rebuildLibraryMap();
  hydrateNativeMap();
  syncNativeMapToLibrary();
  if (state.studySession.active && state.libraryMap.size && !state.libraryMap.has(state.studySession.path)) {
    state.studySession = createEmptyStudySession();
    saveJson(STORAGE_KEYS.studySession, state.studySession);
  }
  reviveStoredAppUsageSession();
  reviveStoredStudySession();

  el.typeFilter.value = state.selectedType;
  if (el.materialFilter) {
    const allowed = new Set(Array.from(el.materialFilter.options || []).map((opt) => String(opt.value || "")));
    if (!allowed.has(state.selectedMaterial)) {
      state.selectedMaterial = "all";
    }
    el.materialFilter.value = state.selectedMaterial;
  }
  el.searchInput.value = state.query;
  updateFilterButtons();
}

function hydrateNativeMap() {
  if (!supportsNativeFolderPicker()) {
    clearNativeMapStorage();
    return;
  }
  const stored = loadJson(STORAGE_KEYS.nativeMap, []);
  if (!Array.isArray(stored)) {
    clearNativeMapStorage();
    return;
  }

  const map = new Map();
  for (const row of stored) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const path = String(row.path || "").trim();
    const url = String(row.url || "").trim();
    const type = row.type === "audio" ? "audio" : row.type === "pdf" ? "pdf" : null;
    if (!path || !url || !type) {
      continue;
    }
    map.set(path, { url, type });
  }

  state.nativeFileMap = map;
}

function syncNativeMapToLibrary() {
  if (!state.nativeFileMap.size) {
    return;
  }
  const nextNativeMap = new Map();
  for (const [path, entry] of state.nativeFileMap.entries()) {
    if (state.libraryMap.has(path)) {
      nextNativeMap.set(path, entry);
    }
  }
  state.nativeFileMap = nextNativeMap;
  saveNativeMap();
}

function serializeNativeMap(map) {
  const output = [];
  for (const [path, entry] of map.entries()) {
    if (!entry || !entry.url || !entry.type) {
      continue;
    }
    output.push({ path, url: entry.url, type: entry.type });
  }
  return output;
}

function saveNativeMap() {
  if (!supportsNativeFolderPicker()) {
    clearNativeMapStorage();
    return;
  }
  saveJson(STORAGE_KEYS.nativeMap, serializeNativeMap(state.nativeFileMap));
}

function clearNativeMapStorage() {
  saveJson(STORAGE_KEYS.nativeMap, []);
}

function onSearchInput() {
  state.query = el.searchInput.value;
  saveText(STORAGE_KEYS.query, state.query);
  updateFilterButtons();
  applyFilters();
}

function clearSearch() {
  state.query = "";
  saveText(STORAGE_KEYS.query, "");
  el.searchInput.value = "";
  updateFilterButtons();
  applyFilters();
  el.searchInput.focus();
}

function resetFilters() {
  state.query = "";
  state.selectedType = "all";
  state.selectedMaterial = "all";
  state.selectedSubject = "all";
  saveText(STORAGE_KEYS.query, "");
  saveText(STORAGE_KEYS.selectedType, "all");
  saveText(STORAGE_KEYS.selectedMaterial, "all");
  saveText(STORAGE_KEYS.selectedSubject, "all");

  el.searchInput.value = "";
  el.typeFilter.value = "all";
  if (el.materialFilter) {
    el.materialFilter.value = "all";
  }
  updateFilterButtons();
  applyFilters();
}

function onTypeChange() {
  state.selectedType = el.typeFilter.value;
  saveText(STORAGE_KEYS.selectedType, state.selectedType);
  updateFilterButtons();
  applyFilters();
}

function onMaterialChange() {
  if (!el.materialFilter) {
    return;
  }
  state.selectedMaterial = el.materialFilter.value || "all";
  saveText(STORAGE_KEYS.selectedMaterial, state.selectedMaterial);
  updateFilterButtons();
  applyFilters();
}

function onSubjectSelect(event) {
  const target = event.target.closest("button[data-subject]");
  if (!target) {
    return;
  }

  state.selectedSubject = target.dataset.subject || "all";
  saveText(STORAGE_KEYS.selectedSubject, state.selectedSubject);
  updateFilterButtons();
  applyFilters();
}

async function onItemListClick(event) {
  const target = event.target.closest("button[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  const path = target.dataset.path;
  if (!path) {
    return;
  }

  if (action === "open") {
    await openItem(path);
    return;
  }
  if (action === "queue") {
    toggleQueue(path);
    return;
  }
  if (action === "done") {
    toggleDone(path);
  }
}

async function onQueueClick(event) {
  const target = event.target.closest("button[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  const path = target.dataset.path;
  if (!path) {
    return;
  }

  if (action === "open") {
    await openItem(path);
    return;
  }
  if (action === "done") {
    toggleDone(path);
    return;
  }
  if (action === "remove") {
    removeFromQueue(path);
  }
}

async function connectFolder() {
  if (state.scanning) {
    return;
  }

  if (supportsNativeFolderPicker()) {
    await connectNativeFolder();
    return;
  }

  if (supportsDirectoryPicker()) {
    try {
      const handle = await window.showDirectoryPicker({ id: "sharoushi-study" });
      const granted = await ensureReadPermission(handle, true);
      if (!granted) {
        setStatus("フォルダ読み取り権限が必要です。", "warn");
        return;
      }

      state.rootHandle = handle;
      state.filePool = null;
      await saveRootHandle(handle);
      el.refreshBtn.disabled = false;

      await rescanFromRoot("フォルダ接続完了。スキャン中...");
      return;
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
      console.error(error);
      setStatus("フォルダ接続に失敗しました。", "error");
      return;
    }
  }

  if (supportsDirectoryUpload()) {
    el.folderInput.click();
  } else {
    el.fileInput.click();
  }
}

function addFiles() {
  el.fileInput.click();
}

async function connectNativeFolder() {
  state.scanning = true;
  setStatus("教材データ選択を開いています...");

  try {
    const payload = await requestNativeFolderPick();
    if (!payload || payload.ok !== true) {
      if (payload && payload.error === "canceled") {
        setStatus("データ選択をキャンセルしました。", "warn");
        return;
      }
      if (payload && payload.error === "no_supported_files") {
        setStatus("選択フォルダ内にPDF/音声が見つかりません。Google Drive内の教材フォルダを選択してください。", "warn");
        return;
      }
      if (payload && payload.error === "picker_unavailable") {
        setStatus("データ選択画面を開けませんでした。", "error");
        return;
      }
      if (payload && payload.error === "folder_unavailable") {
        setStatus("このフォルダは読み込めませんでした。別のフォルダを選ぶか「フォルダ丸ごと選択（このフォルダを使用 / 標準）」を試してください。", "warn");
        return;
      }
      if (payload && payload.error === "zip_unavailable") {
        setStatus("ZIPの読み込みに失敗しました。PCで作成し直して再選択してください。", "warn");
        return;
      }
      if (payload && payload.error === "timeout") {
        setStatus("取り込みに時間がかかっています。大容量ZIPは時間がかかるため、しばらく待つかZIPを分割してください。", "warn");
        return;
      }
      setStatus("Androidフォルダ接続に失敗しました。", "error");
      return;
    }

    const files = Array.isArray(payload.files) ? payload.files : [];
    const nextItems = [];
    const nativeMap = new Map();
    const usedPaths = new Set();

    for (const row of files) {
      const rawPath = String(row && row.path ? row.path : "").replace(/\\/g, "/").trim();
      const type = row && (row.type === "pdf" || row.type === "audio")
        ? row.type
        : detectType(rawPath);
      const url = String(row && row.url ? row.url : "").trim();
      if (!rawPath || !type || !url) {
        continue;
      }

      const uniquePath = createUniquePath(rawPath, usedPaths);
      usedPaths.add(uniquePath);
      nextItems.push(buildItem(uniquePath, type));
      nativeMap.set(uniquePath, { url, type });
    }

    nextItems.sort(compareItems);
    state.nativeFileMap = nativeMap;
    state.filePool = null;
    state.rootHandle = null;
    await clearRootHandle();
    el.refreshBtn.disabled = false;
    saveNativeMap();
    setLibrary(nextItems, true);
    setStatus(`フォルダ読み込み完了: ${nextItems.length}件`);
  } catch (error) {
    console.error(error);
    setStatus("Androidフォルダ接続に失敗しました。", "error");
  } finally {
    state.scanning = false;
  }
}

function requestNativeFolderPick() {
  if (!supportsNativeFolderPicker()) {
    return Promise.resolve({ ok: false, error: "not_supported" });
  }

  if (pendingNativeFolderResolve) {
    return Promise.resolve({ ok: false, error: "busy" });
  }

  return new Promise((resolve) => {
    pendingNativeFolderResolve = resolve;
    pendingNativeFolderTimer = window.setTimeout(() => {
      if (!pendingNativeFolderResolve) {
        return;
      }
      const done = pendingNativeFolderResolve;
      pendingNativeFolderResolve = null;
      pendingNativeFolderTimer = null;
      done({ ok: false, error: "timeout" });
    }, NATIVE_PICK_TIMEOUT_MS);

    try {
      if (typeof window.AndroidBridge.pickStudySource === "function") {
        window.AndroidBridge.pickStudySource();
      } else {
        window.AndroidBridge.pickStudyFolder();
      }
    } catch (error) {
      console.error(error);
      const done = pendingNativeFolderResolve;
      pendingNativeFolderResolve = null;
      if (pendingNativeFolderTimer) {
        clearTimeout(pendingNativeFolderTimer);
        pendingNativeFolderTimer = null;
      }
      if (done) {
        done({ ok: false, error: "bridge_error" });
      }
    }
  });
}

function onNativeFolderPicked(rawPayload) {
  if (!pendingNativeFolderResolve) {
    return;
  }

  let payload = null;
  try {
    payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch (error) {
    console.warn("onNativeFolderPicked parse error", error);
  }

  const done = pendingNativeFolderResolve;
  pendingNativeFolderResolve = null;
  if (pendingNativeFolderTimer) {
    clearTimeout(pendingNativeFolderTimer);
    pendingNativeFolderTimer = null;
  }

  done(payload || { ok: false, error: "invalid_payload" });
}

async function refreshScan() {
  if (state.scanning) {
    return;
  }

  if (supportsNativeFolderPicker()) {
    await connectNativeFolder();
    return;
  }

  if (state.filePool && !state.rootHandle) {
    setStatus("ファイル追加モードです。教材ファイル追加で更新してください。", "warn");
    return;
  }

  if (!state.rootHandle) {
    setStatus("学習フォルダを接続してください。", "warn");
    return;
  }

  const granted = await ensureReadPermission(state.rootHandle, true);
  if (!granted) {
    setStatus("フォルダ読み取り権限がありません。", "warn");
    return;
  }

  await rescanFromRoot("再スキャン中...");
}

async function onFolderChosen(event) {
  await ingestFiles(event.target.files, { replace: true, keepRelativePath: true });
  event.target.value = "";
}

async function onFilesChosen(event) {
  await ingestFiles(event.target.files, { replace: false, keepRelativePath: false });
  event.target.value = "";
}

async function ingestFiles(fileList, options) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }

  const replace = Boolean(options && options.replace);
  const keepRelativePath = Boolean(options && options.keepRelativePath);
  if (replace) {
    state.nativeFileMap = new Map();
    clearNativeMapStorage();
  }
  const nextPool = replace ? new Map() : state.filePool || new Map();
  const nextItems = [];
  const usedPaths = new Set(replace ? [] : Array.from(state.libraryMap.keys()));

  for (const file of files) {
    const rawPath = keepRelativePath
      ? (file.webkitRelativePath || file.name)
      : `追加/${file.name}`;
    const normalized = String(rawPath).replace(/\\/g, "/");
    const type = detectType(normalized);
    if (!type) {
      continue;
    }

    const uniquePath = createUniquePath(normalized, usedPaths);
    usedPaths.add(uniquePath);
    nextPool.set(uniquePath, file);
    nextItems.push(buildItem(uniquePath, type));
  }

  if (!nextItems.length) {
    setStatus("PDFまたは音声ファイルが見つかりませんでした。", "warn");
    return;
  }

  nextItems.sort(compareItems);
  state.filePool = nextPool;
  state.rootHandle = null;
  await clearRootHandle();
  el.refreshBtn.disabled = false;

  if (replace) {
    setLibrary(nextItems, true);
    setStatus("フォルダ読み込み完了。ブラウザ終了後は再選択が必要です。", "warn");
    return;
  }

  const merged = mergeLibrary(state.library, nextItems);
  setLibrary(merged, true);
  setStatus(`${nextItems.length}件を追加しました。`, "warn");
}

async function rescanFromRoot(startMessage) {
  if (!state.rootHandle) {
    return;
  }

  state.scanning = true;
  setStatus(startMessage || "スキャン中...");
  const startedAt = Date.now();

  try {
    const nextLibrary = [];
    await walkDirectory(state.rootHandle, "", nextLibrary);
    nextLibrary.sort(compareItems);
    setLibrary(nextLibrary, true);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    setStatus(`スキャン完了: ${nextLibrary.length}件 (${elapsed}秒)`);
  } catch (error) {
    console.error(error);
    setStatus("スキャンに失敗しました。フォルダを再接続してください。", "error");
  } finally {
    state.scanning = false;
  }
}

async function walkDirectory(dirHandle, prefix, bucket) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (!name || name.startsWith(".")) {
      continue;
    }

    const nextPath = prefix ? `${prefix}/${name}` : name;

    if (handle.kind === "directory") {
      if (SKIP_DIRECTORIES.has(name)) {
        continue;
      }
      try {
        await walkDirectory(handle, nextPath, bucket);
      } catch (error) {
        console.warn("skip directory", nextPath, error);
      }
      continue;
    }

    const type = detectType(name);
    if (!type) {
      continue;
    }

    bucket.push(buildItem(nextPath, type));
    if (bucket.length % 250 === 0) {
      setStatus(`スキャン中... ${bucket.length}件`);
    }
  }
}

function setLibrary(nextLibrary, persist) {
  state.library = nextLibrary
    .map(normalizeItem)
    .filter(Boolean);

  rebuildLibraryMap();
  if (state.nativeFileMap.size) {
    const nextNativeMap = new Map();
    for (const [path, entry] of state.nativeFileMap.entries()) {
      if (state.libraryMap.has(path)) {
        nextNativeMap.set(path, entry);
      }
    }
    state.nativeFileMap = nextNativeMap;
    saveNativeMap();
  }
  pruneQueueAndDone();
  applyFilters();
  renderQueue();
  updateStudyPanel();

  if (persist) {
    saveJson(STORAGE_KEYS.library, state.library);
  }
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const path = String(raw.path || "").replace(/\\/g, "/").trim();
  if (!path) {
    return null;
  }

  const name = String(raw.name || path.split("/").pop() || "");
  const type = raw.type === "audio" ? "audio" : raw.type === "pdf" ? "pdf" : detectType(name);
  if (!type) {
    return null;
  }

  const subject = String(raw.subject || extractSubject(path));
  const material = String(raw.material || detectMaterial(name, path, type));

  return {
    path,
    name,
    type,
    subject,
    material,
    searchable: normalizeText(`${path} ${name} ${subject} ${material}`)
  };
}

function buildItem(path, type) {
  const normalizedPath = path.replace(/\\/g, "/");
  const name = normalizedPath.split("/").pop() || normalizedPath;
  const subject = extractSubject(normalizedPath);
  const material = detectMaterial(name, normalizedPath, type);

  return {
    path: normalizedPath,
    name,
    type,
    subject,
    material,
    searchable: normalizeText(`${normalizedPath} ${name} ${subject} ${material}`)
  };
}

function extractSubject(path) {
  const first = path.split("/")[0];
  return first || "未分類";
}

function detectType(nameOrPath) {
  const lower = String(nameOrPath).toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (shouldSkipAudio(nameOrPath)) {
    return "";
  }
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return "audio";
    }
  }
  return "";
}

function shouldSkipAudio(nameOrPath) {
  const normalized = String(nameOrPath).replace(/\s+/g, "");
  return normalized.includes("1.5倍速") || normalized.includes("2倍速") || normalized.includes("1.5x") || normalized.includes("2x");
}

function detectMaterial(name, path, type) {
  const target = `${name} ${path}`;

  if (/スマート問題集/.test(target)) {
    return "スマート問題集";
  }
  if (/セレクト過去問/.test(target)) {
    return "セレクト過去問";
  }
  if (/選択式ポイント問題集/.test(target)) {
    return "選択式ポイント問題集";
  }
  if (/合格戦略講座/.test(target)) {
    return "合格戦略講座";
  }
  if (/全文/.test(target)) {
    return "法令全文";
  }
  if (type === "audio" || /音声講座|_音声/.test(target)) {
    return "音声講義";
  }

  return "講義テキスト";
}

function rebuildLibraryMap() {
  const map = new Map();
  for (const item of state.library) {
    map.set(item.path, item);
  }
  state.libraryMap = map;
}

function applyFilters() {
  const query = normalizeText(state.query);
  const base = [];
  const counts = new Map();

  for (const item of state.library) {
    if (state.selectedType !== "all" && item.type !== state.selectedType) {
      continue;
    }
    if (state.selectedMaterial !== "all" && item.material !== state.selectedMaterial) {
      continue;
    }
    if (query && !item.searchable.includes(query)) {
      continue;
    }

    base.push(item);
    counts.set(item.subject, (counts.get(item.subject) || 0) + 1);
  }

  state.subjectCounts = counts;
  if (state.selectedSubject !== "all" && !counts.has(state.selectedSubject)) {
    state.selectedSubject = "all";
    saveText(STORAGE_KEYS.selectedSubject, "all");
  }

  if (state.selectedSubject === "all") {
    state.filtered = base;
  } else {
    state.filtered = base.filter((item) => item.subject === state.selectedSubject);
  }

  renderSubjectList();
  renderItemList();
  updateFilterButtons();
}

function updateFilterButtons() {
  if (el.clearSearchBtn) {
    el.clearSearchBtn.hidden = !state.query;
  }
  if (el.resetFiltersBtn) {
    const active =
      Boolean(state.query) ||
      state.selectedType !== "all" ||
      state.selectedMaterial !== "all" ||
      state.selectedSubject !== "all";
    el.resetFiltersBtn.hidden = !active;
  }
}

function renderSubjectList() {
  el.subjectList.textContent = "";

  const allCount = Array.from(state.subjectCounts.values()).reduce((sum, n) => sum + n, 0);
  const fragment = document.createDocumentFragment();

  fragment.appendChild(
    createSubjectChip("all", `すべて (${allCount})`, state.selectedSubject === "all")
  );

  const subjects = Array.from(state.subjectCounts.keys()).sort((a, b) => a.localeCompare(b, "ja"));
  for (const subject of subjects) {
    fragment.appendChild(
      createSubjectChip(subject, `${subject} (${state.subjectCounts.get(subject)})`, state.selectedSubject === subject)
    );
  }

  el.subjectList.appendChild(fragment);
}

function createSubjectChip(subject, label, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  if (selected) {
    button.classList.add("is-selected");
  }
  button.dataset.subject = subject;
  button.textContent = label;
  return button;
}

function renderItemList() {
  el.itemList.textContent = "";
  el.itemCount.textContent = `${state.filtered.length}件`;

  if (!state.filtered.length) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = "該当教材がありません。検索語や種類を変更してください。";
    el.itemList.appendChild(hint);
    return;
  }

  const queueSet = new Set(state.queue);
  const doneMap = ensureTodayDoneMap();
  const todayStudyByPath = buildStudyPathLookupForDay(todayKey());
  const fragment = document.createDocumentFragment();

  const subjectTotals = new Map();
  const materialTotals = new Map();
  const subjectMaterialTotals = new Map();
  for (const item of state.filtered) {
    subjectTotals.set(item.subject, (subjectTotals.get(item.subject) || 0) + 1);
    materialTotals.set(item.material, (materialTotals.get(item.material) || 0) + 1);
    const key = `${item.subject}\t${item.material}`;
    subjectMaterialTotals.set(key, (subjectMaterialTotals.get(key) || 0) + 1);
  }

  if (state.filtered.length > MAX_RENDER_ITEMS) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = `表示件数を ${MAX_RENDER_ITEMS} 件に制限しています。検索条件を絞ると快適です。`;
    fragment.appendChild(hint);
  }

  const groupBySubject = state.selectedSubject === "all";
  const groupByMaterial = state.selectedMaterial === "all";
  let currentSubject = "";
  let currentMaterial = "";

  for (const item of state.filtered.slice(0, MAX_RENDER_ITEMS)) {
    if (groupBySubject && item.subject !== currentSubject) {
      currentSubject = item.subject;
      currentMaterial = "";
      fragment.appendChild(createGroupHeader("subject", item.subject, subjectTotals.get(item.subject) || 0));
    }
    if (groupByMaterial && item.material !== currentMaterial) {
      currentMaterial = item.material;
      const count = groupBySubject
        ? subjectMaterialTotals.get(`${item.subject}\t${item.material}`) || 0
        : materialTotals.get(item.material) || 0;
      fragment.appendChild(createGroupHeader("material", item.material, count));
    }

    const card = document.createElement("li");
    card.className = "item-card";
    if (state.currentPath === item.path) {
      card.classList.add("is-current");
    }
    if (doneMap[item.path]) {
      card.classList.add("is-done");
    }

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "item-main";
    mainButton.dataset.action = "open";
    mainButton.dataset.path = item.path;

    const title = document.createElement("p");
    title.className = "name";
    title.textContent = item.name;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${item.subject} / ${item.material}`;

    mainButton.appendChild(title);
    mainButton.appendChild(meta);

    const tags = document.createElement("div");
    tags.className = "item-tags";

    const typeTag = document.createElement("span");
    typeTag.className = `tag type-${item.type}`;
    typeTag.textContent = item.type === "pdf" ? "PDF" : "音声";
    tags.appendChild(typeTag);

    const pathTag = document.createElement("span");
    pathTag.className = "tag";
    pathTag.textContent = item.path;
    tags.appendChild(pathTag);

    const studyMs = todayStudyByPath.get(item.path) || 0;
    if (studyMs > 0) {
      const studyTag = document.createElement("span");
      studyTag.className = "tag";
      studyTag.textContent = `今日 ${formatDurationCompact(studyMs)}`;
      tags.appendChild(studyTag);
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const queueButton = createSmallButton(
      queueSet.has(item.path) ? "キュー解除" : "今日キュー",
      "queue",
      item.path
    );
    if (queueSet.has(item.path)) {
      queueButton.classList.add("is-active");
    }
    actions.appendChild(queueButton);

    const doneButton = createSmallButton(doneMap[item.path] ? "完了済み" : "完了", "done", item.path);
    if (doneMap[item.path]) {
      doneButton.classList.add("is-done");
    }
    actions.appendChild(doneButton);

    card.appendChild(mainButton);
    card.appendChild(tags);
    card.appendChild(actions);
    fragment.appendChild(card);
  }

  el.itemList.appendChild(fragment);
}

function createGroupHeader(kind, label, count) {
  const li = document.createElement("li");
  li.className = `group-header group-${kind}`;
  li.textContent = count ? `${label} (${count})` : label;
  return li;
}

function renderQueue() {
  el.queueList.textContent = "";
  const doneMap = ensureTodayDoneMap();
  const todayStudyByPath = buildStudyPathLookupForDay(todayKey());
  let doneCount = 0;

  for (const path of state.queue) {
    if (doneMap[path]) {
      doneCount += 1;
    }
  }

  if (!state.queue.length) {
    el.queueStats.textContent = "キューは空です";
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = "教材一覧の「今日キュー」を押すと、今日やる教材をまとめられます。";
    el.queueList.appendChild(hint);
    return;
  }

  el.queueStats.textContent = `完了 ${doneCount} / ${state.queue.length}`;
  const fragment = document.createDocumentFragment();

  for (const path of state.queue) {
    const item = state.libraryMap.get(path);
    const row = document.createElement("li");
    row.className = "queue-item";

    if (state.currentPath === path) {
      row.classList.add("is-current");
    }
    if (doneMap[path]) {
      row.classList.add("is-done");
    }

    const titleButton = document.createElement("button");
    titleButton.type = "button";
    titleButton.className = "item-main";
    titleButton.dataset.action = "open";
    titleButton.dataset.path = path;

    const name = document.createElement("p");
    name.className = "name";
    name.textContent = item ? item.name : path;
    titleButton.appendChild(name);

    if (item) {
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = `${item.subject} / ${item.material}`;
      titleButton.appendChild(meta);

      const studyMs = todayStudyByPath.get(path) || 0;
      if (studyMs > 0) {
        const studyMeta = document.createElement("p");
        studyMeta.className = "meta";
        studyMeta.textContent = `今日の学習 ${formatDurationCompact(studyMs)}`;
        titleButton.appendChild(studyMeta);
      }
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const doneButton = createSmallButton(doneMap[path] ? "完了済み" : "完了", "done", path);
    if (doneMap[path]) {
      doneButton.classList.add("is-done");
    }
    actions.appendChild(doneButton);

    actions.appendChild(createSmallButton("削除", "remove", path));

    row.appendChild(titleButton);
    row.appendChild(actions);
    fragment.appendChild(row);
  }

  el.queueList.appendChild(fragment);
}

function createSmallButton(label, action, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tiny";
  button.dataset.action = action;
  button.dataset.path = path;
  button.textContent = label;
  return button;
}

function createEmptyAppUsageSession() {
  return {
    active: false,
    startedAt: 0,
    lastHeartbeatAt: 0
  };
}

function normalizeAppUsageByDate(raw) {
  if (!isPlainObject(raw)) {
    return {};
  }

  const output = {};
  for (const [dayKey, row] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      continue;
    }
    if (isPlainObject(row)) {
      output[dayKey] = {
        totalMs: normalizeDurationMs(row.totalMs)
      };
      continue;
    }
    output[dayKey] = {
      totalMs: normalizeDurationMs(row)
    };
  }

  return output;
}

function normalizeAppUsageSession(raw) {
  if (!isPlainObject(raw)) {
    return createEmptyAppUsageSession();
  }

  const active = raw.active === true;
  const startedAt = Number.isFinite(raw.startedAt) ? Math.max(0, Math.floor(raw.startedAt)) : 0;
  const lastHeartbeatAt = Number.isFinite(raw.lastHeartbeatAt)
    ? Math.max(0, Math.floor(raw.lastHeartbeatAt))
    : startedAt;

  if (!active || startedAt <= 0) {
    return createEmptyAppUsageSession();
  }

  return {
    active: true,
    startedAt,
    lastHeartbeatAt: Math.max(startedAt, lastHeartbeatAt)
  };
}

function ensureAppUsageDayRecord(dayKey) {
  if (!isPlainObject(state.appUsageByDate[dayKey])) {
    state.appUsageByDate[dayKey] = {
      totalMs: 0
    };
  }
  const record = state.appUsageByDate[dayKey];
  record.totalMs = normalizeDurationMs(record.totalMs);
  return record;
}

function getActiveAppUsageChunks(now = Date.now()) {
  if (!state.appUsageSession.active || !state.appUsageSession.startedAt) {
    return [];
  }
  return splitStudySpanByDay(state.appUsageSession.startedAt, now);
}

function getAppUsageSessionElapsedMs(now = Date.now()) {
  if (!state.appUsageSession.active || !state.appUsageSession.startedAt) {
    return 0;
  }
  return Math.max(0, now - state.appUsageSession.startedAt);
}

function getAppUsageTotalMsForDay(dayKey, now = Date.now()) {
  const record = state.appUsageByDate[dayKey];
  let totalMs = record ? normalizeDurationMs(record.totalMs) : 0;

  if (state.appUsageSession.active) {
    for (const chunk of getActiveAppUsageChunks(now)) {
      if (chunk.dayKey === dayKey) {
        totalMs += chunk.ms;
      }
    }
  }

  return totalMs;
}

function recordAppUsageChunk(dayKey, ms) {
  const safeMs = normalizeDurationMs(ms);
  if (safeMs <= 0) {
    return;
  }

  const record = ensureAppUsageDayRecord(dayKey);
  record.totalMs += safeMs;
}

function commitAppUsageSession(endedAt = Date.now()) {
  const session = state.appUsageSession;
  if (!session.active || !session.startedAt) {
    return 0;
  }

  const chunks = splitStudySpanByDay(session.startedAt, endedAt);
  let savedMs = 0;
  for (const chunk of chunks) {
    recordAppUsageChunk(chunk.dayKey, chunk.ms);
    savedMs += chunk.ms;
  }
  saveJson(STORAGE_KEYS.appUsageByDate, state.appUsageByDate);
  return savedMs;
}

function startAppUsageSession(startedAt = Date.now()) {
  const safeStartedAt = normalizeDurationMs(startedAt) || Date.now();
  state.appUsageSession = {
    active: true,
    startedAt: safeStartedAt,
    lastHeartbeatAt: safeStartedAt
  };
  saveJson(STORAGE_KEYS.appUsageSession, state.appUsageSession);
  syncStudyTicker();
  updateAppUsagePanel();
}

function clearAppUsageSession() {
  state.appUsageSession = createEmptyAppUsageSession();
  saveJson(STORAGE_KEYS.appUsageSession, state.appUsageSession);
  syncStudyTicker();
}

function touchAppUsageSession(now = Date.now(), force) {
  if (!state.appUsageSession.active) {
    return;
  }

  const safeNow = normalizeDurationMs(now) || Date.now();
  const lastHeartbeatAt = normalizeDurationMs(
    state.appUsageSession.lastHeartbeatAt || state.appUsageSession.startedAt
  );
  if (!force && safeNow - lastHeartbeatAt < SESSION_HEARTBEAT_MS) {
    return;
  }

  state.appUsageSession.lastHeartbeatAt = safeNow;
  saveJson(STORAGE_KEYS.appUsageSession, state.appUsageSession);
}

function reviveStoredAppUsageSession() {
  if (!state.appUsageSession.active || !state.appUsageSession.startedAt) {
    return;
  }

  const lastHeartbeatAt = normalizeDurationMs(
    state.appUsageSession.lastHeartbeatAt || state.appUsageSession.startedAt
  );
  if (lastHeartbeatAt < state.appUsageSession.startedAt) {
    clearAppUsageSession();
    return;
  }

  commitAppUsageSession(lastHeartbeatAt);
  clearAppUsageSession();
}

function updateAppUsagePanel(now = Date.now()) {
  if (!el.appUsageTodayTotal || !el.appUsageSessionTime || !el.appUsageState || !el.appUsageRecentList) {
    return;
  }

  const todayTotalMs = getAppUsageTotalMsForDay(todayKey(), now);
  el.appUsageTodayTotal.textContent = `今日 ${formatDurationClock(todayTotalMs)}`;
  el.appUsageSessionTime.textContent = formatDurationClock(getAppUsageSessionElapsedMs(now));
  el.appUsageSessionTime.classList.toggle("is-live", state.appUsageSession.active);

  if (state.appUsageSession.active) {
    el.appUsageState.textContent = "前面で開いている時間を自動記録中です。";
  } else if (isAppUsageTrackableNow()) {
    el.appUsageState.textContent = "アプリを前面で開いている時間を自動で記録します。";
  } else {
    el.appUsageState.textContent = "バックグラウンド中や別画面表示中は自動停止します。";
  }

  renderAppUsageRecentList(now);
}

function renderAppUsageRecentList(now = Date.now()) {
  if (!el.appUsageRecentList) {
    return;
  }

  el.appUsageRecentList.textContent = "";
  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    const dayKey = offsetDayKey(-i, now);
    const totalMs = getAppUsageTotalMsForDay(dayKey, now);
    if (i === 0 || totalMs > 0) {
      rows.push({ dayKey, totalMs });
    }
  }

  if (rows.length === 1 && rows[0].totalMs === 0) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = "まだアプリ利用時間の記録はありません。";
    el.appUsageRecentList.appendChild(hint);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "study-recent-row";

    const label = document.createElement("span");
    label.className = "study-recent-label";
    label.textContent = labelForDayKey(row.dayKey, now);

    const value = document.createElement("span");
    value.className = "study-recent-value";
    value.textContent = formatDurationCompact(row.totalMs);

    li.appendChild(label);
    li.appendChild(value);
    fragment.appendChild(li);
  }

  el.appUsageRecentList.appendChild(fragment);
}

function isAppUsageTrackableNow() {
  const isVisible = typeof document.visibilityState !== "string" || document.visibilityState === "visible";
  return isVisible && state.androidAppForeground !== false;
}

function syncAppUsageTracking(now = Date.now()) {
  const safeNow = normalizeDurationMs(now) || Date.now();
  const shouldTrack = isAppUsageTrackableNow();

  if (!shouldTrack) {
    if (state.appUsageSession.active) {
      commitAppUsageSession(safeNow);
      clearAppUsageSession();
    }
    updateAppUsagePanel(safeNow);
    return;
  }

  if (!state.appUsageSession.active) {
    startAppUsageSession(safeNow);
    return;
  }

  touchAppUsageSession(safeNow);
  updateAppUsagePanel(safeNow);
}

function handleAppVisibilityChange() {
  const now = Date.now();
  if (isAppUsageTrackableNow()) {
    reconcileActiveStudySessionGap(now);
  } else {
    touchStudySession(now, true);
  }
  syncAppUsageTracking(now);
  updateStudyPanel(now);
}

function handlePageHide() {
  const now = Date.now();
  touchStudySession(now, true);
  if (state.appUsageSession.active) {
    commitAppUsageSession(now);
    clearAppUsageSession();
  }
}

function handleBeforeUnload() {
  handlePageHide();
  revokeObjectUrl();
}

function onAndroidAppStateChanged(rawValue) {
  state.androidAppForeground =
    rawValue === true ||
    rawValue === "true" ||
    rawValue === 1 ||
    rawValue === "1";
  handleAppVisibilityChange();
}

function createEmptyStudySession() {
  return {
    active: false,
    path: "",
    subject: "",
    name: "",
    startedAt: 0,
    lastHeartbeatAt: 0
  };
}

function normalizeStudyTimeByDate(raw) {
  if (!isPlainObject(raw)) {
    return {};
  }

  const output = {};
  for (const [dayKey, row] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !isPlainObject(row)) {
      continue;
    }

    const subjects = {};
    const items = {};

    if (isPlainObject(row.subjects)) {
      for (const [subject, ms] of Object.entries(row.subjects)) {
        const safeMs = normalizeDurationMs(ms);
        if (safeMs > 0) {
          subjects[subject] = safeMs;
        }
      }
    }

    if (isPlainObject(row.items)) {
      for (const [path, ms] of Object.entries(row.items)) {
        const safeMs = normalizeDurationMs(ms);
        if (safeMs > 0) {
          items[path] = safeMs;
        }
      }
    }

    output[dayKey] = {
      totalMs: normalizeDurationMs(row.totalMs),
      subjects,
      items
    };
  }

  return output;
}

function normalizeStudySession(raw) {
  if (!isPlainObject(raw)) {
    return createEmptyStudySession();
  }

  const active = raw.active === true;
  const path = String(raw.path || "").trim();
  const subject = String(raw.subject || "").trim();
  const name = String(raw.name || "").trim();
  const startedAt = Number.isFinite(raw.startedAt) ? Math.max(0, Math.floor(raw.startedAt)) : 0;
  const lastHeartbeatAt = Number.isFinite(raw.lastHeartbeatAt)
    ? Math.max(0, Math.floor(raw.lastHeartbeatAt))
    : startedAt;

  if (!active || !path || !subject || !name || startedAt <= 0) {
    return createEmptyStudySession();
  }

  return {
    active: true,
    path,
    subject,
    name,
    startedAt,
    lastHeartbeatAt: Math.max(startedAt, lastHeartbeatAt)
  };
}

function normalizeDurationMs(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function ensureStudyDayRecord(dayKey) {
  if (!isPlainObject(state.studyTimeByDate[dayKey])) {
    state.studyTimeByDate[dayKey] = {
      totalMs: 0,
      subjects: {},
      items: {}
    };
  }

  const record = state.studyTimeByDate[dayKey];
  if (!isPlainObject(record.subjects)) {
    record.subjects = {};
  }
  if (!isPlainObject(record.items)) {
    record.items = {};
  }
  record.totalMs = normalizeDurationMs(record.totalMs);
  return record;
}

function splitStudySpanByDay(startedAt, endedAt) {
  const chunks = [];
  let cursor = normalizeDurationMs(startedAt);
  const finalAt = normalizeDurationMs(endedAt);
  if (finalAt <= cursor) {
    return chunks;
  }

  while (cursor < finalAt) {
    const dayKey = dayKeyFromTimestamp(cursor);
    const nextBoundary = startOfNextDayTimestamp(cursor);
    const chunkEnd = Math.min(finalAt, nextBoundary);
    chunks.push({
      dayKey,
      ms: chunkEnd - cursor
    });
    cursor = chunkEnd;
  }

  return chunks;
}

function getActiveStudyChunks(now = Date.now()) {
  if (!state.studySession.active || !state.studySession.startedAt) {
    return [];
  }
  return splitStudySpanByDay(state.studySession.startedAt, now);
}

function getStudySessionElapsedMs(now = Date.now()) {
  if (!state.studySession.active || !state.studySession.startedAt) {
    return 0;
  }
  return Math.max(0, now - state.studySession.startedAt);
}

function buildStudyPathLookupForDay(dayKey, now = Date.now()) {
  const output = new Map();
  const record = state.studyTimeByDate[dayKey];
  if (record && isPlainObject(record.items)) {
    for (const [path, ms] of Object.entries(record.items)) {
      const safeMs = normalizeDurationMs(ms);
      if (safeMs > 0) {
        output.set(path, safeMs);
      }
    }
  }

  if (state.studySession.active && state.studySession.path) {
    for (const chunk of getActiveStudyChunks(now)) {
      if (chunk.dayKey !== dayKey) {
        continue;
      }
      output.set(
        state.studySession.path,
        (output.get(state.studySession.path) || 0) + chunk.ms
      );
    }
  }

  return output;
}

function getStudyTotalMsForDay(dayKey, now = Date.now()) {
  const record = state.studyTimeByDate[dayKey];
  let totalMs = record ? normalizeDurationMs(record.totalMs) : 0;

  if (state.studySession.active) {
    for (const chunk of getActiveStudyChunks(now)) {
      if (chunk.dayKey === dayKey) {
        totalMs += chunk.ms;
      }
    }
  }

  return totalMs;
}

function recordStudyChunk(dayKey, session, ms) {
  const safeMs = normalizeDurationMs(ms);
  if (safeMs <= 0 || !session || !session.path || !session.subject) {
    return;
  }

  const record = ensureStudyDayRecord(dayKey);
  record.totalMs += safeMs;
  record.subjects[session.subject] = normalizeDurationMs(record.subjects[session.subject]) + safeMs;
  record.items[session.path] = normalizeDurationMs(record.items[session.path]) + safeMs;
}

function commitStudySession(endedAt = Date.now()) {
  const session = state.studySession;
  if (!session.active || !session.startedAt) {
    return 0;
  }

  const chunks = splitStudySpanByDay(session.startedAt, endedAt);
  let savedMs = 0;
  for (const chunk of chunks) {
    recordStudyChunk(chunk.dayKey, session, chunk.ms);
    savedMs += chunk.ms;
  }
  saveJson(STORAGE_KEYS.studyTimeByDate, state.studyTimeByDate);
  return savedMs;
}

function touchStudySession(now = Date.now(), force) {
  if (!state.studySession.active) {
    return;
  }

  const safeNow = normalizeDurationMs(now) || Date.now();
  const lastHeartbeatAt = normalizeDurationMs(
    state.studySession.lastHeartbeatAt || state.studySession.startedAt
  );
  if (!force && safeNow - lastHeartbeatAt < SESSION_HEARTBEAT_MS) {
    return;
  }

  state.studySession.lastHeartbeatAt = safeNow;
  saveJson(STORAGE_KEYS.studySession, state.studySession);
}

function reviveStoredStudySession() {
  if (!state.studySession.active || !state.studySession.startedAt) {
    return;
  }

  const lastHeartbeatAt = normalizeDurationMs(
    state.studySession.lastHeartbeatAt || state.studySession.startedAt
  );
  if (lastHeartbeatAt < state.studySession.startedAt) {
    clearStudySession();
    return;
  }

  commitStudySession(lastHeartbeatAt);
  clearStudySession();
}

function reconcileActiveStudySessionGap(now = Date.now()) {
  if (!state.studySession.active || !state.studySession.startedAt) {
    return;
  }

  const safeNow = normalizeDurationMs(now) || Date.now();
  const lastHeartbeatAt = normalizeDurationMs(
    state.studySession.lastHeartbeatAt || state.studySession.startedAt
  );
  if (lastHeartbeatAt < state.studySession.startedAt) {
    state.studySession.lastHeartbeatAt = safeNow;
    saveJson(STORAGE_KEYS.studySession, state.studySession);
    return;
  }
  if (safeNow - lastHeartbeatAt <= SESSION_RESUME_GRACE_MS) {
    touchStudySession(safeNow);
    return;
  }

  commitStudySession(lastHeartbeatAt);
  state.studySession.startedAt = safeNow;
  state.studySession.lastHeartbeatAt = safeNow;
  saveJson(STORAGE_KEYS.studySession, state.studySession);
  renderItemList();
  renderQueue();
}

function startStudySessionForItem(item, startedAt = Date.now()) {
  if (!item) {
    return;
  }

  const safeStartedAt = normalizeDurationMs(startedAt) || Date.now();
  state.studySession = {
    active: true,
    path: item.path,
    subject: item.subject,
    name: item.name,
    startedAt: safeStartedAt,
    lastHeartbeatAt: safeStartedAt
  };
  saveJson(STORAGE_KEYS.studySession, state.studySession);
  syncStudyTicker();
  updateStudyPanel();
  renderItemList();
  renderQueue();
}

function clearStudySession() {
  state.studySession = createEmptyStudySession();
  saveJson(STORAGE_KEYS.studySession, state.studySession);
  syncStudyTicker();
}

function stopStudySession(notify) {
  const savedMs = commitStudySession(Date.now());
  clearStudySession();
  updateStudyPanel();
  renderItemList();
  renderQueue();
  if (notify) {
    if (savedMs > 0) {
      setStatus(`学習時間を記録しました: ${formatDurationCompact(savedMs)}`);
    } else {
      setStatus("学習時間の記録を停止しました。");
    }
  }
}

function restartStudySessionForItem(item) {
  commitStudySession(Date.now());
  startStudySessionForItem(item, Date.now());
}

function toggleStudyTimer() {
  if (state.studySession.active) {
    stopStudySession(true);
    return;
  }

  const item = state.currentPath ? state.libraryMap.get(state.currentPath) : null;
  if (!item) {
    setStatus("教材を開いてから記録開始してください。", "warn");
    return;
  }

  startStudySessionForItem(item, Date.now());
  setStatus(`学習時間の記録を開始: ${item.subject} / ${item.name}`);
}

function resetTodayStudyTime() {
  const key = todayKey();
  delete state.studyTimeByDate[key];

  if (state.studySession.active) {
    state.studySession.startedAt = Date.now();
    state.studySession.lastHeartbeatAt = state.studySession.startedAt;
    saveJson(STORAGE_KEYS.studySession, state.studySession);
  }

  saveJson(STORAGE_KEYS.studyTimeByDate, state.studyTimeByDate);
  updateStudyPanel();
  renderItemList();
  renderQueue();
  setStatus("今日の学習時間をリセットしました。");
}

function syncStudyTicker() {
  if (studyTickTimer) {
    clearInterval(studyTickTimer);
    studyTickTimer = 0;
  }

  if (!state.studySession.active && !state.appUsageSession.active) {
    updateStudyPanel();
    updateAppUsagePanel();
    return;
  }

  studyTickTimer = window.setInterval(() => {
    const now = Date.now();
    if (isAppUsageTrackableNow()) {
      reconcileActiveStudySessionGap(now);
      touchStudySession(now);
    }
    touchAppUsageSession(now);
    updateStudyPanel(now);
    updateAppUsagePanel(now);
  }, STUDY_TICK_MS);
  updateStudyPanel();
  updateAppUsagePanel();
}

function updateStudyPanel(now = Date.now()) {
  if (!el.studyTodayTotal || !el.studySessionTime || !el.studyCurrentItemTotal || !el.studyTarget) {
    return;
  }

  const today = todayKey();
  const currentItem = state.currentPath ? state.libraryMap.get(state.currentPath) : null;
  const sessionItem = state.studySession.active && state.studySession.path
    ? state.libraryMap.get(state.studySession.path) || state.studySession
    : null;
  const targetItem = state.studySession.active ? sessionItem : currentItem;
  const todayStudyByPath = buildStudyPathLookupForDay(today, now);
  const todayTotalMs = getStudyTotalMsForDay(today, now);
  const currentItemMs = targetItem ? (todayStudyByPath.get(targetItem.path) || 0) : 0;

  el.studyTodayTotal.textContent = `今日 ${formatDurationClock(todayTotalMs)}`;
  el.studySessionTime.textContent = formatDurationClock(getStudySessionElapsedMs(now));
  el.studySessionTime.classList.toggle("is-live", state.studySession.active);
  el.studyCurrentItemTotal.textContent = formatDurationClock(currentItemMs);

  if (state.studySession.active && targetItem) {
    el.studyTarget.textContent = `記録中: ${targetItem.subject} / ${targetItem.name}`;
  } else if (currentItem) {
    el.studyTarget.textContent = `選択中: ${currentItem.subject} / ${currentItem.name}`;
  } else {
    el.studyTarget.textContent = "教材を開いてから記録開始できます。";
  }

  if (el.toggleStudyBtn) {
    el.toggleStudyBtn.disabled = !state.studySession.active && !currentItem;
    el.toggleStudyBtn.textContent = state.studySession.active ? "記録停止" : "記録開始";
    el.toggleStudyBtn.classList.toggle("is-recording", state.studySession.active);
  }
  if (el.resetStudyTodayBtn) {
    el.resetStudyTodayBtn.disabled = todayTotalMs <= 0;
  }

  renderStudyRecentList(now);
}

function renderStudyRecentList(now = Date.now()) {
  if (!el.studyRecentList) {
    return;
  }

  el.studyRecentList.textContent = "";
  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    const dayKey = offsetDayKey(-i, now);
    const totalMs = getStudyTotalMsForDay(dayKey, now);
    if (i === 0 || totalMs > 0) {
      rows.push({ dayKey, totalMs });
    }
  }

  if (rows.length === 1 && rows[0].totalMs === 0) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = "まだ学習時間の記録はありません。";
    el.studyRecentList.appendChild(hint);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "study-recent-row";

    const label = document.createElement("span");
    label.className = "study-recent-label";
    label.textContent = labelForDayKey(row.dayKey, now);

    const value = document.createElement("span");
    value.className = "study-recent-value";
    value.textContent = formatDurationCompact(row.totalMs);

    li.appendChild(label);
    li.appendChild(value);
    fragment.appendChild(li);
  }

  el.studyRecentList.appendChild(fragment);
}

function formatDurationClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationCompact(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}時間${String(minutes).padStart(2, "0")}分`;
  }
  if (minutes > 0) {
    return `${minutes}分`;
  }
  return totalSeconds > 0 ? `${totalSeconds}秒` : "0分";
}

function dayKeyFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfNextDayTimestamp(timestamp) {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function offsetDayKey(offset, baseTimestamp = Date.now()) {
  const date = new Date(baseTimestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return dayKeyFromTimestamp(date.getTime());
}

function labelForDayKey(dayKey, baseTimestamp = Date.now()) {
  const today = dayKeyFromTimestamp(baseTimestamp);
  const yesterday = offsetDayKey(-1, baseTimestamp);
  if (dayKey === today) {
    return "今日";
  }
  if (dayKey === yesterday) {
    return "昨日";
  }
  const [year, month, day] = dayKey.split("-");
  const shortYear = year ? year.slice(-2) : "";
  return `${shortYear}/${month}/${day}`;
}

function toggleQueue(path) {
  const index = state.queue.indexOf(path);
  if (index >= 0) {
    state.queue.splice(index, 1);
  } else {
    state.queue.push(path);
  }
  saveJson(STORAGE_KEYS.queue, state.queue);
  renderItemList();
  renderQueue();
  updateStudyPanel();
}

function removeFromQueue(path) {
  const index = state.queue.indexOf(path);
  if (index < 0) {
    return;
  }
  state.queue.splice(index, 1);
  saveJson(STORAGE_KEYS.queue, state.queue);
  renderItemList();
  renderQueue();
  updateStudyPanel();
}

function toggleDone(path) {
  const doneMap = ensureTodayDoneMap();
  if (doneMap[path]) {
    delete doneMap[path];
  } else {
    doneMap[path] = Date.now();
  }
  saveJson(STORAGE_KEYS.doneByDate, state.doneByDate);
  renderItemList();
  renderQueue();
  updateStudyPanel();
}

function clearTodayDone() {
  const key = todayKey();
  delete state.doneByDate[key];
  ensureTodayDoneMap();
  saveJson(STORAGE_KEYS.doneByDate, state.doneByDate);
  renderItemList();
  renderQueue();
  updateStudyPanel();
}

function pruneQueueAndDone() {
  const pathSet = new Set(state.library.map((item) => item.path));
  state.queue = state.queue.filter((path) => pathSet.has(path));

  const doneMap = ensureTodayDoneMap();
  for (const path of Object.keys(doneMap)) {
    if (!pathSet.has(path)) {
      delete doneMap[path];
    }
  }

  saveJson(STORAGE_KEYS.queue, state.queue);
  saveJson(STORAGE_KEYS.doneByDate, state.doneByDate);
  updateStudyPanel();
}

async function openItem(path) {
  const item = state.libraryMap.get(path);
  if (!item) {
    setStatus("教材が見つかりません。再スキャンしてください。", "warn");
    return;
  }

  const shouldRestartStudySession =
    state.studySession.active &&
    Boolean(state.studySession.path) &&
    state.studySession.path !== path;

  if (state.currentPath && state.currentPath !== path) {
    saveCurrentMemo(false);
  }
  state.currentPath = path;
  loadMemoForCurrent();
  updateMemoAvailability();

  try {
    const nativeEntry = state.nativeFileMap.get(path);
    if (nativeEntry && nativeEntry.url) {
      showNativeInViewer(item, nativeEntry.url);
      if (shouldRestartStudySession) {
        restartStudySessionForItem(item);
      }
      updateStudyPanel();
      setStatus(`${item.subject} / ${item.name}`);
      renderItemList();
      renderQueue();
      return;
    }

    const file = await resolveFile(path);
    if (!file) {
      setStatus("教材ファイルを開けません。フォルダを再接続してください。", "warn");
      return;
    }

    showFileInViewer(item, file);
    if (shouldRestartStudySession) {
      restartStudySessionForItem(item);
    }
    updateStudyPanel();
    setStatus(`${item.subject} / ${item.name}`);
  } catch (error) {
    console.error(error);
    setStatus("教材の読み込みに失敗しました。", "error");
  }

  renderItemList();
  renderQueue();
}

function showFileInViewer(item, file) {
  revokeObjectUrl();
  state.currentObjectUrl = URL.createObjectURL(file);
  hideViewerPlaceholder();

  if (item.type === "pdf") {
    el.audioPlayer.pause();
    el.audioPlayer.removeAttribute("src");
    el.audioPlayer.load();
    el.audioWrap.hidden = true;

    el.pdfViewer.src = `${state.currentObjectUrl}#view=FitH`;
    el.pdfViewer.hidden = false;
    return;
  }

  el.pdfViewer.hidden = true;
  el.pdfViewer.removeAttribute("src");
  el.audioTitle.textContent = item.name;
  el.audioPlayer.src = state.currentObjectUrl;
  el.audioWrap.hidden = false;
  el.audioPlayer.play().catch(() => {});
}

function showNativeInViewer(item, nativeUrl) {
  revokeObjectUrl();
  hideViewerPlaceholder();

  if (item.type === "pdf") {
    el.audioPlayer.pause();
    el.audioPlayer.removeAttribute("src");
    el.audioPlayer.load();
    el.audioWrap.hidden = true;

    if (openPdfInAndroidExternalViewer(nativeUrl)) {
      el.pdfViewer.hidden = true;
      el.pdfViewer.removeAttribute("src");
      showViewerPlaceholder(
        "PDFを外部アプリで開いています",
        "端末のPDFビューアで表示します。戻ると学習アプリに戻れます。"
      );
      return;
    }

    el.pdfViewer.src = `${nativeUrl}#view=FitH`;
    el.pdfViewer.hidden = false;
    return;
  }

  el.pdfViewer.hidden = true;
  el.pdfViewer.removeAttribute("src");
  el.audioTitle.textContent = item.name;
  el.audioPlayer.src = nativeUrl;
  el.audioWrap.hidden = false;
  el.audioPlayer.play().catch(() => {});
}

function openPdfInAndroidExternalViewer(nativeUrl) {
  if (!isAndroidWebView()) {
    return false;
  }
  if (!window.AndroidBridge || typeof window.AndroidBridge.openPdfFromNativeUrl !== "function") {
    return false;
  }
  try {
    const result = window.AndroidBridge.openPdfFromNativeUrl(nativeUrl);
    return result === true || result === "true" || result === 1 || result === "1";
  } catch (error) {
    console.warn("openPdfFromNativeUrl", error);
    return false;
  }
}

function showViewerPlaceholder(title, text) {
  if (!el.viewerPlaceholder) {
    return;
  }
  const titleEl = el.viewerPlaceholder.querySelector("h2");
  const textEl = el.viewerPlaceholder.querySelector("p");
  if (titleEl) {
    titleEl.textContent = title || VIEWER_PLACEHOLDER_DEFAULT_TITLE;
  }
  if (textEl) {
    textEl.textContent = text || VIEWER_PLACEHOLDER_DEFAULT_TEXT;
  }
  el.viewerPlaceholder.hidden = false;
}

function hideViewerPlaceholder() {
  if (!el.viewerPlaceholder) {
    return;
  }
  showViewerPlaceholder(VIEWER_PLACEHOLDER_DEFAULT_TITLE, VIEWER_PLACEHOLDER_DEFAULT_TEXT);
  el.viewerPlaceholder.hidden = true;
}

async function resolveFile(path) {
  if (state.filePool && state.filePool.has(path)) {
    return state.filePool.get(path);
  }

  if (!state.rootHandle) {
    return null;
  }

  const granted = await ensureReadPermission(state.rootHandle, true);
  if (!granted) {
    return null;
  }

  const parts = path.split("/");
  let cursor = state.rootHandle;

  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = await cursor.getDirectoryHandle(parts[i], { create: false });
  }

  const fileHandle = await cursor.getFileHandle(parts[parts.length - 1], { create: false });
  return fileHandle.getFile();
}

function loadMemoForCurrent() {
  if (!state.currentPath) {
    el.memoInput.value = "";
    return;
  }
  el.memoInput.value = state.memos[state.currentPath] || "";
}

function saveCurrentMemo(notify) {
  if (!state.currentPath) {
    return;
  }
  state.memos[state.currentPath] = el.memoInput.value || "";
  saveJson(STORAGE_KEYS.memos, state.memos);
  if (notify) {
    setStatus("メモを保存しました。");
  }
}

function updateMemoAvailability() {
  const enabled = Boolean(state.currentPath);
  el.memoInput.disabled = !enabled;
  el.saveMemoBtn.disabled = !enabled;
}

function revokeObjectUrl() {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }
}

function todayKey() {
  return dayKeyFromTimestamp(Date.now());
}

function ensureTodayDoneMap() {
  const key = todayKey();
  if (!isPlainObject(state.doneByDate[key])) {
    state.doneByDate[key] = {};
  }
  return state.doneByDate[key];
}

function toHalfWidthDigits(value) {
  return String(value || "").replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

function tokenizeNatural(value) {
  const text = toHalfWidthDigits(value);
  const tokens = [];
  const re = /(\d+)/g;
  let last = 0;
  while (true) {
    const match = re.exec(text);
    if (!match) {
      break;
    }
    if (match.index > last) {
      tokens.push({ type: "text", value: text.slice(last, match.index) });
    }
    const raw = match[1];
    tokens.push({ type: "num", value: raw, num: Number.parseInt(raw, 10) });
    last = match.index + raw.length;
  }
  if (last < text.length) {
    tokens.push({ type: "text", value: text.slice(last) });
  }
  return tokens;
}

function naturalCompare(a, b, locale) {
  const left = tokenizeNatural(a);
  const right = tokenizeNatural(b);
  const max = Math.max(left.length, right.length);

  for (let i = 0; i < max; i += 1) {
    const l = left[i];
    const r = right[i];
    if (!l && !r) {
      return 0;
    }
    if (!l) {
      return -1;
    }
    if (!r) {
      return 1;
    }

    if (l.type !== r.type) {
      // Put numbers before text at the same position.
      return l.type === "num" ? -1 : 1;
    }

    if (l.type === "num") {
      const diff = (l.num || 0) - (r.num || 0);
      if (diff) {
        return diff;
      }
      // If numeric value is the same, shorter token first (e.g. 2 < 02).
      const lenDiff = l.value.length - r.value.length;
      if (lenDiff) {
        return lenDiff;
      }
      continue;
    }

    const textDiff = l.value.localeCompare(r.value, locale);
    if (textDiff) {
      return textDiff;
    }
  }

  return String(a || "").localeCompare(String(b || ""), locale);
}

function compareItems(a, b) {
  return (
    naturalCompare(a.subject, b.subject, "ja") ||
    naturalCompare(a.material, b.material, "ja") ||
    naturalCompare(a.type, b.type, "ja") ||
    naturalCompare(a.name, b.name, "ja") ||
    naturalCompare(a.path, b.path, "ja")
  );
}

function mergeLibrary(baseItems, addedItems) {
  const map = new Map();
  for (const item of baseItems) {
    map.set(item.path, item);
  }
  for (const item of addedItems) {
    map.set(item.path, item);
  }
  return Array.from(map.values()).sort(compareItems);
}

function createUniquePath(rawPath, usedPaths) {
  if (!usedPaths.has(rawPath)) {
    return rawPath;
  }

  const slash = rawPath.lastIndexOf("/");
  const directory = slash >= 0 ? rawPath.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? rawPath.slice(slash + 1) : rawPath;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";

  let i = 2;
  while (true) {
    const candidate = `${directory}${stem} (${i})${ext}`;
    if (!usedPaths.has(candidate)) {
      return candidate;
    }
    i += 1;
  }
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function setStatus(text, tone) {
  el.statusText.textContent = text;
  if (!tone || tone === "info") {
    delete el.statusText.dataset.tone;
    return;
  }
  el.statusText.dataset.tone = tone;
}

function setStatusFromState() {
  if (state.library.length === 0) {
    setStatus("学習フォルダ接続 または 教材ファイル追加 で教材を取り込んでください。");
    return;
  }

  if (state.rootHandle || state.filePool || state.nativeFileMap.size) {
    setStatus(`教材 ${state.library.length} 件を読み込み済み。`);
    return;
  }

  setStatus("教材一覧は読み込み済みです。閲覧にはフォルダ接続が必要です。", "warn");
}

function requestNativeRestore() {
  if (!supportsNativeFolderPicker()) {
    return;
  }
  if (!window.AndroidBridge || typeof window.AndroidBridge.restoreNativeStudyData !== "function") {
    return;
  }
  try {
    window.AndroidBridge.restoreNativeStudyData();
  } catch (error) {
    console.warn("restoreNativeStudyData", error);
  }
}

function refreshInstallGuide() {
  if (!el.installGuide || !el.installGuideText || !el.installBtn) {
    return;
  }

  const installed = isRunningAsInstalledApp();
  if (installed) {
    el.installGuide.hidden = true;
    el.installBtn.hidden = true;
    return;
  }

  if (state.deferredPrompt) {
    el.installBtn.hidden = false;
  }

  if (state.installGuideDismissed) {
    el.installGuide.hidden = true;
    return;
  }

  el.installGuide.hidden = false;
  if (state.deferredPrompt) {
    el.installGuideText.textContent = "Android/PCは「アプリとしてインストール」を押すと1タップ起動できます。";
    return;
  }

  if (isIOSDevice()) {
    el.installGuideText.textContent = "iPhone/iPadはSafariの共有メニューから「ホーム画面に追加」で1タップ起動できます。";
    return;
  }

  el.installGuideText.textContent = "ブラウザメニューの「アプリをインストール」または「ホーム画面に追加」を使ってください。";
}

function dismissInstallGuide() {
  state.installGuideDismissed = true;
  saveText(STORAGE_KEYS.installGuideDismissed, "1");
  refreshInstallGuide();
}

function isRunningAsInstalledApp() {
  return Boolean(window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone);
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function supportsNativeFolderPicker() {
  if (!window.AndroidBridge) {
    return false;
  }
  return (
    typeof window.AndroidBridge.pickStudySource === "function" ||
    typeof window.AndroidBridge.pickStudyFolder === "function"
  );
}

function supportsDirectoryPicker() {
  if (isAndroidWebView()) {
    return false;
  }
  return typeof window.showDirectoryPicker === "function";
}

function supportsDirectoryUpload() {
  if (isAndroidWebView()) {
    return false;
  }
  return Boolean(el.folderInput) && typeof el.folderInput.webkitdirectory !== "undefined";
}

function isAndroidWebView() {
  const ua = navigator.userAgent || "";
  return /Android/i.test(ua) && (/\bwv\b/i.test(ua) || /; wv\)/i.test(ua));
}

function supportsHandleStorage() {
  return typeof indexedDB !== "undefined";
}

async function ensureReadPermission(handle, requestPermission) {
  if (!handle || typeof handle.queryPermission !== "function") {
    return false;
  }

  const options = { mode: "read" };
  let status = await handle.queryPermission(options);
  if (status === "granted") {
    return true;
  }

  if (!requestPermission) {
    return false;
  }

  status = await handle.requestPermission(options);
  return status === "granted";
}

async function restoreRootHandle() {
  if (!supportsDirectoryPicker() || !supportsHandleStorage()) {
    return;
  }

  try {
    const handle = await loadRootHandle();
    if (!handle) {
      return;
    }

    const granted = await ensureReadPermission(handle, false);
    if (!granted) {
      setStatus("前回フォルダがあります。学習フォルダ接続を押して再許可してください。", "warn");
      return;
    }

    state.rootHandle = handle;
    el.refreshBtn.disabled = false;

    if (!state.library.length) {
      await rescanFromRoot("前回フォルダを再接続。スキャン中...");
    }
  } catch (error) {
    console.warn("restoreRootHandle", error);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  if (!window.isSecureContext) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("service worker registration failed", error);
  }
}

async function installPwa() {
  if (!state.deferredPrompt) {
    setStatus("この環境ではインストールUIが利用できません。", "warn");
    refreshInstallGuide();
    return;
  }

  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  el.installBtn.hidden = true;
  refreshInstallGuide();
}

async function saveRootHandle(handle) {
  if (!supportsHandleStorage()) {
    return;
  }

  let db;
  try {
    db = await openHandleDb();
    await runTransaction(db, "readwrite", (store) => store.put(handle, ROOT_HANDLE_KEY));
  } catch (error) {
    console.warn("saveRootHandle", error);
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function loadRootHandle() {
  if (!supportsHandleStorage()) {
    return null;
  }

  let db;
  try {
    db = await openHandleDb();
    return await runTransaction(db, "readonly", (store) => store.get(ROOT_HANDLE_KEY));
  } catch (error) {
    console.warn("loadRootHandle", error);
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function clearRootHandle() {
  if (!supportsHandleStorage()) {
    return;
  }

  let db;
  try {
    db = await openHandleDb();
    await runTransaction(db, "readwrite", (store) => store.delete(ROOT_HANDLE_KEY));
  } catch (error) {
    console.warn("clearRootHandle", error);
  } finally {
    if (db) {
      db.close();
    }
  }
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, mode);
    const store = tx.objectStore(HANDLE_STORE);
    const request = operation(store);

    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn("loadJson", key, error);
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("saveJson", key, error);
    setStatus("ローカル保存容量が不足しています。検索条件を絞ってください。", "warn");
  }
}

function loadText(key, fallback) {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value;
}

function saveText(key, value) {
  localStorage.setItem(key, value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
