"use strict";

const STORAGE_KEYS = {
  library: "sharoushi.offline.library",
  queue: "sharoushi.offline.queue",
  doneByDate: "sharoushi.offline.doneByDate",
  memos: "sharoushi.offline.memos",
  selectedType: "sharoushi.offline.selectedType",
  selectedSubject: "sharoushi.offline.selectedSubject",
  query: "sharoushi.offline.query",
  installGuideDismissed: "sharoushi.offline.installGuideDismissed"
};

const DB_NAME = "sharoushi-offline-db";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const ROOT_HANDLE_KEY = "study-root";

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg"];
const SKIP_DIRECTORIES = new Set([".git", "offline-study-app", "node_modules"]);
const MAX_RENDER_ITEMS = 350;

const state = {
  library: [],
  libraryMap: new Map(),
  filtered: [],
  subjectCounts: new Map(),
  queue: [],
  doneByDate: {},
  memos: {},
  selectedType: "all",
  selectedSubject: "all",
  query: "",
  rootHandle: null,
  filePool: null,
  currentPath: null,
  currentObjectUrl: null,
  deferredPrompt: null,
  scanning: false,
  installGuideDismissed: false
};

const el = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  hydrateState();
  applyFilters();
  renderQueue();
  updateMemoAvailability();

  if (!supportsDirectoryPicker() && !supportsDirectoryUpload()) {
    el.connectBtn.textContent = "教材ファイル追加";
  } else if (!supportsDirectoryPicker()) {
    el.connectBtn.textContent = "学習フォルダ選択";
  }

  await registerServiceWorker();
  await restoreRootHandle();
  setStatusFromState();
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
  el.typeFilter = document.getElementById("typeFilter");
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
  el.typeFilter.addEventListener("change", onTypeChange);
  el.subjectList.addEventListener("click", onSubjectSelect);
  el.itemList.addEventListener("click", onItemListClick);
  el.queueList.addEventListener("click", onQueueClick);
  el.clearDoneBtn.addEventListener("click", clearTodayDone);
  el.saveMemoBtn.addEventListener("click", () => saveCurrentMemo(true));
  el.memoInput.addEventListener("blur", () => saveCurrentMemo(false));
  el.folderInput.addEventListener("change", onFolderChosen);
  el.fileInput.addEventListener("change", onFilesChosen);
  el.installBtn.addEventListener("click", installPwa);
  el.dismissInstallGuideBtn.addEventListener("click", dismissInstallGuide);
  window.addEventListener("beforeunload", revokeObjectUrl);

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

  state.selectedType = loadText(STORAGE_KEYS.selectedType, "all");
  if (!["all", "pdf", "audio"].includes(state.selectedType)) {
    state.selectedType = "all";
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

  el.typeFilter.value = state.selectedType;
  el.searchInput.value = state.query;
}

function onSearchInput() {
  state.query = el.searchInput.value;
  saveText(STORAGE_KEYS.query, state.query);
  applyFilters();
}

function onTypeChange() {
  state.selectedType = el.typeFilter.value;
  saveText(STORAGE_KEYS.selectedType, state.selectedType);
  applyFilters();
}

function onSubjectSelect(event) {
  const target = event.target.closest("button[data-subject]");
  if (!target) {
    return;
  }

  state.selectedSubject = target.dataset.subject || "all";
  saveText(STORAGE_KEYS.selectedSubject, state.selectedSubject);
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

  if (isAndroidWebView()) {
    setStatus("Androidアプリではフォルダ接続は未対応です。教材ファイル追加を使ってください。", "warn");
    el.fileInput.click();
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

async function refreshScan() {
  if (state.scanning) {
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
  pruneQueueAndDone();
  applyFilters();
  renderQueue();

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
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return "audio";
    }
  }
  return "";
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
  const fragment = document.createDocumentFragment();

  if (state.filtered.length > MAX_RENDER_ITEMS) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = `表示件数を ${MAX_RENDER_ITEMS} 件に制限しています。検索条件を絞ると快適です。`;
    fragment.appendChild(hint);
  }

  for (const item of state.filtered.slice(0, MAX_RENDER_ITEMS)) {
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

function renderQueue() {
  el.queueList.textContent = "";
  const doneMap = ensureTodayDoneMap();
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
}

function clearTodayDone() {
  const key = todayKey();
  delete state.doneByDate[key];
  ensureTodayDoneMap();
  saveJson(STORAGE_KEYS.doneByDate, state.doneByDate);
  renderItemList();
  renderQueue();
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
}

async function openItem(path) {
  const item = state.libraryMap.get(path);
  if (!item) {
    setStatus("教材が見つかりません。再スキャンしてください。", "warn");
    return;
  }

  if (state.currentPath && state.currentPath !== path) {
    saveCurrentMemo(false);
  }
  state.currentPath = path;
  loadMemoForCurrent();
  updateMemoAvailability();

  try {
    const file = await resolveFile(path);
    if (!file) {
      setStatus("教材ファイルを開けません。フォルダを再接続してください。", "warn");
      return;
    }

    showFileInViewer(item, file);
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
  el.viewerPlaceholder.hidden = true;

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
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function ensureTodayDoneMap() {
  const key = todayKey();
  if (!isPlainObject(state.doneByDate[key])) {
    state.doneByDate[key] = {};
  }
  return state.doneByDate[key];
}

function compareItems(a, b) {
  return (
    a.subject.localeCompare(b.subject, "ja") ||
    a.material.localeCompare(b.material, "ja") ||
    a.type.localeCompare(b.type, "ja") ||
    a.name.localeCompare(b.name, "ja") ||
    a.path.localeCompare(b.path, "ja")
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

  if (state.rootHandle || state.filePool) {
    setStatus(`教材 ${state.library.length} 件を読み込み済み。`);
    return;
  }

  setStatus("教材一覧は読み込み済みです。閲覧にはフォルダ接続が必要です。", "warn");
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
