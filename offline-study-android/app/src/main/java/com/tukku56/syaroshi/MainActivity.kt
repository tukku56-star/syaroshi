package com.tukku56.syaroshi

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipInputStream

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val nativeFileMap = mutableMapOf<String, Uri>()
    private val nativeFileLock = Any()
    private val pdfLaunchLock = Any()
    private var lastPdfLaunchId: String = ""
    private var lastPdfLaunchAtMs: Long = 0L
    private val zipImportLock = Any()
    private var lastZipImportUri: String = ""
    private var lastZipImportAtMs: Long = 0L
    private var cachedNativePayload: JSONObject? = null
    private var restoredPayloadDispatched = false

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback ?: return@registerForActivityResult
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            callback.onReceiveValue(uris)
            filePathCallback = null
        }

    private val studyFolderPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val directoryUri = result.data?.data
            if (result.resultCode == RESULT_OK) {
                onDirectoryFolderPicked(directoryUri)
            } else {
                onDirectoryFolderPicked(null)
            }
        }

    private val driveFolderPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val treeUri = result.data?.data
            if (result.resultCode == RESULT_OK) {
                onTreeFolderPicked(treeUri)
            } else {
                onTreeFolderPicked(null)
            }
        }

    private val studyFilesPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            onStudyFilesPicked(result.resultCode, result.data)
        }

    private val studyZipPickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val zipUri = result.data?.data
            if (result.resultCode == RESULT_OK) {
                onStudyZipPicked(zipUri)
            } else {
                onStudyZipPicked(null)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        restoreNativeStateFromPrefs()

        webView = findViewById(R.id.webView)
        configureWebView()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(APP_URL)
        }

        // Support importing a ZIP via "Open with"/"Share" intents (e.g., from Google Drive).
        maybeImportZipFromIntent(intent)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        finish()
                    }
                }
            }
        )
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) {
            return
        }
        setIntent(intent)
        maybeImportZipFromIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            builtInZoomControls = false
            displayZoomControls = false
        }

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.scheme == "http" || url.scheme == "https") {
                    return false
                }
                return openExternal(url)
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val url = request?.url ?: return super.shouldInterceptRequest(view, request)
                val nativeResponse = interceptNativeFileRequest(url)
                if (nativeResponse != null) {
                    return nativeResponse
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                dispatchCachedPayloadIfAvailable()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val chooserIntent = try {
                    fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                } catch (_: Exception) {
                    Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (_: ActivityNotFoundException) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }
        }
    }

    private fun onTreeFolderPicked(treeUri: Uri?) {
        if (treeUri == null) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "canceled")
            )
            return
        }

        try {
            contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Some providers do not allow persistable permissions.
        }

        Thread {
            val payload = buildStudyFolderPayload(treeUri)
            runOnUiThread { dispatchNativeFolderPayload(payload) }
        }.start()
    }

    private fun onDirectoryFolderPicked(directoryUri: Uri?) {
        if (directoryUri == null) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "canceled")
            )
            return
        }

        try {
            contentResolver.takePersistableUriPermission(directoryUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Some providers do not allow persistable permissions.
        }

        Thread {
            val payload = buildStudyFolderPayloadFromDirectoryUri(directoryUri)
            runOnUiThread { dispatchNativeFolderPayload(payload) }
        }.start()
    }

    private fun onStudyZipPicked(zipUri: Uri?) {
        if (zipUri == null) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "canceled")
            )
            return
        }

        try {
            contentResolver.takePersistableUriPermission(zipUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Some providers do not allow persistable permissions.
        }

        Thread {
            val payload = buildStudyFolderPayloadFromZip(zipUri)
            runOnUiThread { dispatchNativeFolderPayload(payload) }
        }.start()
    }

    private fun maybeImportZipFromIntent(intent: Intent?) {
        if (intent == null) {
            return
        }

        val zipUri = extractZipUriFromIntent(intent) ?: return
        val key = zipUri.toString()
        if (key.isBlank()) {
            return
        }

        val now = System.currentTimeMillis()
        synchronized(zipImportLock) {
            // Prevent accidental re-imports caused by configuration changes or repeated intent delivery.
            if (key == lastZipImportUri && now - lastZipImportAtMs < 30_000) {
                return
            }
            lastZipImportUri = key
            lastZipImportAtMs = now
        }

        try {
            contentResolver.takePersistableUriPermission(zipUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Most share/view flows grant temporary permission only.
        }

        Thread {
            val payload = buildStudyFolderPayloadFromZip(zipUri)
            runOnUiThread { dispatchNativeFolderPayload(payload) }
        }.start()
    }

    private fun extractZipUriFromIntent(intent: Intent): Uri? {
        val action = intent.action ?: return null
        val hintMime = intent.type

        val candidates = mutableListOf<Uri>()
        when (action) {
            Intent.ACTION_VIEW -> {
                val uri = intent.data ?: return null
                candidates.add(uri)
            }

            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return null
                candidates.add(uri)
            }

            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: return null
                candidates.addAll(uris)
            }

            else -> return null
        }

        for (uri in candidates) {
            if (isZipUri(uri, hintMime)) {
                return uri
            }
        }
        return null
    }

    private fun isZipUri(uri: Uri, hintMime: String?): Boolean {
        val name = resolveDisplayName(uri)
        if (name.lowercase(Locale.US).endsWith(".zip")) {
            return true
        }
        val mime = (hintMime ?: contentResolver.getType(uri) ?: "").lowercase(Locale.US)
        return mime == "application/zip" || mime == "application/x-zip-compressed"
    }

    private fun showStudySourceChooser() {
        val options = arrayOf(
            "PC同期ZIPをインポート（推奨）",
            "フォルダ丸ごと選択（このフォルダを使用 / 標準）",
            "フォルダ丸ごと選択（フォルダ名タップ / 互換）",
            "ファイル選択（最終手段）"
        )
        AlertDialog.Builder(this)
            .setTitle("学習データの取り込み")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> openStudyZipPicker()
                    1 -> openDriveFolderPicker()
                    2 -> openStudyFolderPicker()
                    else -> openStudyFilesPicker()
                }
            }
            .setOnCancelListener {
                dispatchNativeFolderPayload(
                    JSONObject()
                        .put("ok", false)
                        .put("error", "canceled")
                )
            }
            .show()
    }

    private fun openStudyZipPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed"))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }

        try {
            studyZipPickerLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "picker_unavailable")
            )
        }
    }

    private fun openStudyFolderPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("vnd.android.document/directory", "application/vnd.google-apps.folder")
            )
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            putExtra(Intent.EXTRA_LOCAL_ONLY, false)
        }

        try {
            studyFolderPickerLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "picker_unavailable")
            )
        }
    }

    private fun openDriveFolderPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            putExtra(Intent.EXTRA_LOCAL_ONLY, false)
        }

        try {
            driveFolderPickerLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            openStudyFolderPicker()
        }
    }

    private fun openStudyFilesPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "audio/*"))
        }

        try {
            studyFilesPickerLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "picker_unavailable")
            )
        }
    }

    private fun onStudyFilesPicked(resultCode: Int, data: Intent?) {
        if (resultCode != RESULT_OK) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "canceled")
            )
            return
        }

        val uris = mutableListOf<Uri>()
        data?.data?.let { uris.add(it) }
        val clipData = data?.clipData
        if (clipData != null) {
            for (i in 0 until clipData.itemCount) {
                clipData.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        }

        if (uris.isEmpty()) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "empty")
            )
            return
        }

        val files = JSONArray()
        val nextNativeMap = mutableMapOf<String, Uri>()
        val usedPaths = mutableSetOf<String>()

        for (uri in uris.distinct()) {
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: SecurityException) {
                // Some providers do not allow persistable permissions.
            }

            val name = resolveDisplayName(uri)
            if (shouldSkipAudio(name)) {
                continue
            }
            val type = detectStudyType(name) ?: detectStudyTypeFromMime(contentResolver.getType(uri)) ?: continue
            val prefix = if ((uri.authority ?: "").contains("google.android.apps.docs")) "GoogleDrive" else "追加"
            val path = uniquePath("$prefix/$name", usedPaths)
            usedPaths.add(path)

            val id = UUID.randomUUID().toString()
            nextNativeMap[id] = uri
            files.put(
                JSONObject()
                    .put("path", path)
                    .put("name", name)
                    .put("type", type)
                    .put("url", "$NATIVE_FILE_BASE/$id")
            )
        }

        if (nextNativeMap.isEmpty()) {
            dispatchNativeFolderPayload(
                JSONObject()
                    .put("ok", false)
                    .put("error", "no_supported_files")
            )
            return
        }
        replaceNativeState(nextNativeMap, files)

        dispatchNativeFolderPayload(
            JSONObject()
                .put("ok", true)
                .put("count", nextNativeMap.size)
                .put("files", files)
        )
    }

    private fun resolveDisplayName(uri: Uri): String {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) {
                        val value = cursor.getString(index)
                        if (!value.isNullOrBlank()) {
                            return value
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Ignore and fallback.
        }

        val raw = uri.lastPathSegment ?: "file"
        val tail = raw.substringAfterLast('/')
        return if (tail.isBlank()) "file" else tail
    }

    private fun detectStudyTypeFromMime(mime: String?): String? {
        if (mime == null) {
            return null
        }
        if (mime.equals("application/pdf", ignoreCase = true)) {
            return "pdf"
        }
        if (mime.lowercase(Locale.US).startsWith("audio/")) {
            return "audio"
        }
        return null
    }

    private fun uniquePath(basePath: String, usedPaths: Set<String>): String {
        if (!usedPaths.contains(basePath)) {
            return basePath
        }

        val slash = basePath.lastIndexOf('/')
        val directory = if (slash >= 0) basePath.substring(0, slash + 1) else ""
        val filename = if (slash >= 0) basePath.substring(slash + 1) else basePath
        val dot = filename.lastIndexOf('.')
        val stem = if (dot > 0) filename.substring(0, dot) else filename
        val ext = if (dot > 0) filename.substring(dot) else ""

        var index = 2
        while (true) {
            val candidate = "$directory$stem ($index)$ext"
            if (!usedPaths.contains(candidate)) {
                return candidate
            }
            index += 1
        }
    }

    private fun buildStudyFolderPayloadFromZip(zipUri: Uri): JSONObject {
        val rootDir = File(filesDir, "study-sync")
        if (!prepareSyncDirectory(rootDir)) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }

        val mergedFilesByPath = LinkedHashMap<String, JSONObject>()
        val existingPayload = cachedNativePayload
        if (existingPayload != null && existingPayload.optBoolean("ok")) {
            val existingFiles = existingPayload.optJSONArray("files")
            if (existingFiles != null) {
                for (i in 0 until existingFiles.length()) {
                    val row = existingFiles.optJSONObject(i) ?: continue
                    val path = row.optString("path", "").trim()
                    val url = row.optString("url", "").trim()
                    val type = row.optString("type", "").trim()
                    if (path.isBlank() || url.isBlank() || type.isBlank()) {
                        continue
                    }
                    mergedFilesByPath[path] = row
                }
            }
        }

        val existingNativeSnapshot: Map<String, Uri> = synchronized(nativeFileLock) { nativeFileMap.toMap() }
        val extractedIdToUri = mutableMapOf<String, Uri>()
        val rootCanonical = try {
            rootDir.canonicalFile
        } catch (_: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }

        try {
            val input = openNativeInputStream(zipUri) ?: return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")

            ZipInputStream(input).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (entry.isDirectory) {
                        zip.closeEntry()
                        continue
                    }

                    val relativePath = sanitizeZipEntryPath(entry.name)
                    if (relativePath == null) {
                        zip.closeEntry()
                        continue
                    }

                    val fileName = relativePath.substringAfterLast('/')
                    if (shouldSkipAudio(relativePath) || shouldSkipAudio(fileName)) {
                        zip.closeEntry()
                        continue
                    }
                    val type = detectStudyType(fileName)
                    if (type == null) {
                        zip.closeEntry()
                        continue
                    }

                    val outFile = File(rootDir, relativePath)
                    val outCanonical = try {
                        outFile.canonicalFile
                    } catch (_: Exception) {
                        zip.closeEntry()
                        continue
                    }
                    if (!isInsideDirectory(rootCanonical, outCanonical)) {
                        zip.closeEntry()
                        continue
                    }

                    outCanonical.parentFile?.mkdirs()
                    FileOutputStream(outCanonical).use { output ->
                        zip.copyTo(output)
                    }

                    val existingId =
                        mergedFilesByPath[relativePath]?.optString("url")?.let { extractNativeFileId(it) }
                    val id = if (!existingId.isNullOrBlank()) existingId else UUID.randomUUID().toString()
                    extractedIdToUri[id] = Uri.fromFile(outCanonical)
                    mergedFilesByPath[relativePath] =
                        JSONObject()
                            .put("path", relativePath)
                            .put("name", fileName)
                            .put("type", type)
                            .put("url", "$NATIVE_FILE_BASE/$id")
                    zip.closeEntry()
                }
            }
        } catch (_: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }

        if (mergedFilesByPath.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }

        val usedIds = mutableSetOf<String>()
        val mergedFiles = JSONArray()
        for ((_, row) in mergedFilesByPath) {
            val url = row.optString("url", "")
            val id = extractNativeFileId(url)
            if (!id.isNullOrBlank()) {
                usedIds.add(id)
            }
            mergedFiles.put(row)
        }
        if (usedIds.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }

        val nextNativeMap = mutableMapOf<String, Uri>()
        for (id in usedIds) {
            val uri = extractedIdToUri[id] ?: existingNativeSnapshot[id] ?: continue
            nextNativeMap[id] = uri
        }
        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }
        replaceNativeState(nextNativeMap, mergedFiles)

        return JSONObject()
            .put("ok", true)
            .put("count", nextNativeMap.size)
            .put("files", mergedFiles)
    }

    private fun prepareSyncDirectory(rootDir: File): Boolean {
        return try {
            if (rootDir.exists()) {
                rootDir.isDirectory
            } else {
                rootDir.mkdirs()
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun sanitizeZipEntryPath(rawPath: String?): String? {
        if (rawPath.isNullOrBlank()) {
            return null
        }
        val normalized = rawPath.replace('\\', '/').trim('/')
        if (normalized.isEmpty()) {
            return null
        }
        val cleaned = normalized
            .split('/')
            .filter { it.isNotBlank() && it != "." && it != ".." }
        if (cleaned.isEmpty()) {
            return null
        }
        return cleaned.joinToString("/")
    }

    private fun isInsideDirectory(root: File, target: File): Boolean {
        val rootPath = root.path
        val targetPath = target.path
        return targetPath == rootPath || targetPath.startsWith("$rootPath${File.separator}")
    }

    private fun buildStudyFolderPayloadFromDirectoryUri(directoryUri: Uri): JSONObject {
        val viaTree = buildStudyFolderPayloadFromDirectoryAsTree(directoryUri)
        if (viaTree.optBoolean("ok")) {
            return viaTree
        }

        val viaDocument = buildStudyFolderPayloadFromDocumentUri(directoryUri)
        if (viaDocument.optBoolean("ok")) {
            return viaDocument
        }

        return if (viaDocument.optString("error").isNotBlank()) viaDocument else viaTree
    }

    private fun buildStudyFolderPayloadFromDirectoryAsTree(directoryUri: Uri): JSONObject {
        return try {
            val authority = directoryUri.authority
            if (authority.isNullOrBlank()) {
                JSONObject()
                    .put("ok", false)
                    .put("error", "folder_unavailable")
            } else {
                val documentId = DocumentsContract.getDocumentId(directoryUri)
                val treeUri = DocumentsContract.buildTreeDocumentUri(authority, documentId)
                try {
                    contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: SecurityException) {
                    // Provider may only grant one of document/tree URIs.
                }
                buildStudyFolderPayload(treeUri)
            }
        } catch (_: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", "folder_unavailable")
        }
    }

    private fun buildStudyFolderPayloadFromDocumentUri(directoryUri: Uri): JSONObject {
        val authority = directoryUri.authority
        if (authority.isNullOrBlank()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "folder_unavailable")
        }

        val rootDocumentId = try {
            DocumentsContract.getDocumentId(directoryUri)
        } catch (_: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("error", "folder_unavailable")
        }

        val files = JSONArray()
        val nextNativeMap = mutableMapOf<String, Uri>()
        val stack = ArrayDeque<Pair<String, String>>()
        stack.add(rootDocumentId to "")

        while (stack.isNotEmpty()) {
            val (documentId, prefix) = stack.removeLast()
            val childrenUri = DocumentsContract.buildChildDocumentsUri(authority, documentId)
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            )

            val cursor = try {
                contentResolver.query(childrenUri, projection, null, null, null)
            } catch (_: Exception) {
                null
            } ?: continue

            cursor.use {
                val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (cursor.moveToNext()) {
                    if (idIndex < 0 || nameIndex < 0 || mimeIndex < 0) {
                        continue
                    }
                    val childId = cursor.getString(idIndex) ?: continue
                    val name = cursor.getString(nameIndex) ?: continue
                    val mimeType = cursor.getString(mimeIndex) ?: continue
                    if (name.startsWith(".")) {
                        continue
                    }
                    if (shouldSkipAudio(name)) {
                        continue
                    }

                    val path = if (prefix.isEmpty()) name else "$prefix/$name"
                    val isDirectory =
                        mimeType == DocumentsContract.Document.MIME_TYPE_DIR ||
                            mimeType.equals("application/vnd.google-apps.folder", ignoreCase = true)
                    if (isDirectory) {
                        if (SKIP_DIRECTORIES.contains(name)) {
                            continue
                        }
                        stack.add(childId to path)
                        continue
                    }

                    val type = detectStudyType(name) ?: detectStudyTypeFromMime(mimeType) ?: continue
                    val fileUri = DocumentsContract.buildDocumentUri(authority, childId)
                    val id = UUID.randomUUID().toString()
                    nextNativeMap[id] = fileUri
                    files.put(
                        JSONObject()
                            .put("path", path)
                            .put("name", name)
                            .put("type", type)
                            .put("url", "$NATIVE_FILE_BASE/$id")
                    )
                }
            }
        }

        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }
        replaceNativeState(nextNativeMap, files)

        return JSONObject()
            .put("ok", true)
            .put("count", nextNativeMap.size)
            .put("files", files)
    }

    private fun buildStudyFolderPayload(treeUri: Uri): JSONObject {
        val root = DocumentFile.fromTreeUri(this, treeUri)
        if (root == null || !root.isDirectory || !root.canRead()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "folder_unavailable")
        }

        val files = JSONArray()
        val nextNativeMap = mutableMapOf<String, Uri>()
        val stack = ArrayDeque<Pair<DocumentFile, String>>()
        stack.add(root to "")

        while (stack.isNotEmpty()) {
            val (dir, prefix) = stack.removeLast()
            val children = try {
                dir.listFiles()
            } catch (_: Exception) {
                emptyArray()
            }

            for (child in children) {
                val name = child.name ?: continue
                if (name.startsWith(".")) {
                    continue
                }
                if (shouldSkipAudio(name)) {
                    continue
                }

                val path = if (prefix.isEmpty()) name else "$prefix/$name"
                if (child.isDirectory) {
                    if (SKIP_DIRECTORIES.contains(name)) {
                        continue
                    }
                    stack.add(child to path)
                    continue
                }

                val type = detectStudyType(name) ?: continue
                val id = UUID.randomUUID().toString()
                nextNativeMap[id] = child.uri
                files.put(
                    JSONObject()
                        .put("path", path)
                        .put("name", name)
                        .put("type", type)
                        .put("url", "$NATIVE_FILE_BASE/$id")
                )
            }
        }

        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }
        replaceNativeState(nextNativeMap, files)

        return JSONObject()
            .put("ok", true)
            .put("count", nextNativeMap.size)
            .put("files", files)
    }

    private fun detectStudyType(name: String): String? {
        val lower = name.lowercase(Locale.US)
        if (lower.endsWith(".pdf")) {
            return "pdf"
        }
        if (AUDIO_EXTENSIONS.any { lower.endsWith(it) }) {
            if (shouldSkipAudio(name)) {
                return null
            }
            return "audio"
        }
        return null
    }

    private fun shouldSkipAudio(name: String): Boolean {
        val normalized = name.replace("\\s+".toRegex(), "")
        return normalized.contains("1.5倍速") || normalized.contains("2倍速") || normalized.contains("1.5x") || normalized.contains("2x")
    }

    private fun replaceNativeState(nextNativeMap: Map<String, Uri>, files: JSONArray) {
        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(nextNativeMap)
        }
        val payload = JSONObject()
            .put("ok", true)
            .put("count", nextNativeMap.size)
            .put("files", files)
        cachedNativePayload = payload
        restoredPayloadDispatched = false
        persistNativeStateToPrefs(nextNativeMap, payload)
    }

    private fun restoreNativeStateFromPrefs() {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val raw = prefs.getString(PREF_KEY_NATIVE_MAP, null) ?: return
        val restored = mutableMapOf<String, Uri>()
        try {
            val json = JSONObject(raw)
            val keys = json.keys()
            while (keys.hasNext()) {
                val id = keys.next()
                if (id.isBlank()) {
                    continue
                }
                val uriText = json.optString(id, "")
                if (uriText.isBlank()) {
                    continue
                }
                restored[id] = Uri.parse(uriText)
            }
        } catch (_: Exception) {
            clearNativeStatePrefs()
            synchronized(nativeFileLock) {
                nativeFileMap.clear()
            }
            cachedNativePayload = null
            return
        }

        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(restored)
        }

        val payloadRaw = prefs.getString(PREF_KEY_NATIVE_PAYLOAD, null)
        cachedNativePayload = try {
            if (payloadRaw.isNullOrBlank()) {
                null
            } else {
                JSONObject(payloadRaw)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun persistNativeStateToPrefs(map: Map<String, Uri>, payload: JSONObject) {
        val json = JSONObject()
        for ((id, uri) in map) {
            if (id.isBlank()) {
                continue
            }
            json.put(id, uri.toString())
        }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putString(PREF_KEY_NATIVE_MAP, json.toString())
            .putString(PREF_KEY_NATIVE_PAYLOAD, payload.toString())
            .apply()
    }

    private fun clearNativeStatePrefs() {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .remove(PREF_KEY_NATIVE_MAP)
            .remove(PREF_KEY_NATIVE_PAYLOAD)
            .apply()
    }

    private fun extractNativeFileId(nativeUrl: String): String? {
        return try {
            val uri = Uri.parse(nativeUrl)
            if (!uri.scheme.equals("https", ignoreCase = true) || uri.host != NATIVE_HOST) {
                return null
            }
            val segments = uri.pathSegments
            if (segments.size < 2 || segments[0] != NATIVE_FILE_PATH) {
                return null
            }
            segments[1]
        } catch (_: Exception) {
            null
        }
    }

    private fun copyPdfToShareCache(nativeId: String, sourceUri: Uri): File? {
        val dir = File(cacheDir, "shared-pdf")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        val safeId = nativeId.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val outFile = File(dir, "$safeId.pdf")
        return try {
            val input = openNativeInputStream(sourceUri) ?: return null
            input.use { stream ->
                FileOutputStream(outFile).use { output ->
                    stream.copyTo(output)
                }
            }
            outFile
        } catch (_: Exception) {
            null
        }
    }

    private fun openPdfFileExternally(file: File): Boolean {
        return try {
            val contentUri =
                FileProvider.getUriForFile(
                    this,
                    "$packageName.fileprovider",
                    file
                )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(contentUri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun openPdfFromUri(nativeId: String, sourceUri: Uri): Boolean {
        val file = copyPdfToShareCache(nativeId, sourceUri) ?: return false
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return openPdfFileExternally(file)
        }
        val latch = CountDownLatch(1)
        var opened = false
        return try {
            runOnUiThread {
                opened = openPdfFileExternally(file)
                latch.countDown()
            }
            latch.await(2, TimeUnit.SECONDS)
            opened
        } catch (_: Exception) {
            false
        }
    }

    private fun shouldLaunchPdfExternally(nativeId: String): Boolean {
        val now = System.currentTimeMillis()
        synchronized(pdfLaunchLock) {
            if (nativeId == lastPdfLaunchId && now - lastPdfLaunchAtMs < 1500) {
                return false
            }
            lastPdfLaunchId = nativeId
            lastPdfLaunchAtMs = now
            return true
        }
    }

    private fun dispatchCachedPayloadIfAvailable() {
        dispatchCachedPayloadIfAvailable(force = false)
    }

    private fun dispatchCachedPayloadIfAvailable(force: Boolean) {
        if (!force && restoredPayloadDispatched) {
            return
        }
        val payload = cachedNativePayload ?: return
        val hasMap = synchronized(nativeFileLock) { nativeFileMap.isNotEmpty() }
        if (!hasMap) {
            return
        }
        restoredPayloadDispatched = true
        dispatchNativeFolderPayload(payload)
    }

    private fun interceptNativeFileRequest(url: Uri): WebResourceResponse? {
        if (url.scheme != "https" || url.host != NATIVE_HOST) {
            return null
        }

        val segments = url.pathSegments
        if (segments.size < 2 || segments[0] != NATIVE_FILE_PATH) {
            return emptyResponse(404, "Not Found")
        }

        val id = segments[1]
        val targetUri = synchronized(nativeFileLock) { nativeFileMap[id] } ?: return emptyResponse(404, "Not Found")

        return try {
            val mime = contentResolver.getType(targetUri) ?: guessMimeType(targetUri.toString())
            if (mime.equals("application/pdf", ignoreCase = true) && shouldLaunchPdfExternally(id)) {
                val opened = openPdfFromUri(id, targetUri)
                if (opened) {
                    return emptyResponse(204, "No Content")
                }
            }
            val stream = openNativeInputStream(targetUri) ?: return emptyResponse(404, "Not Found")
            WebResourceResponse(mime, null, stream).apply {
                setStatusCodeAndReasonPhrase(200, "OK")
                responseHeaders = mapOf(
                    "Cache-Control" to "no-store",
                    "Access-Control-Allow-Origin" to "*"
                )
            }
        } catch (_: Exception) {
            emptyResponse(500, "Error")
        }
    }

    private fun openNativeInputStream(uri: Uri): java.io.InputStream? {
        return if (uri.scheme.equals("file", ignoreCase = true)) {
            val path = uri.path ?: return null
            FileInputStream(File(path))
        } else {
            contentResolver.openInputStream(uri)
        }
    }

    private fun guessMimeType(path: String): String {
        val lower = path.lowercase(Locale.US)
        return when {
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".m4a") -> "audio/mp4"
            lower.endsWith(".aac") -> "audio/aac"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".ogg") -> "audio/ogg"
            else -> "application/octet-stream"
        }
    }

    private fun emptyResponse(code: Int, reason: String): WebResourceResponse {
        return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0))).apply {
            setStatusCodeAndReasonPhrase(code, reason)
            responseHeaders = mapOf("Cache-Control" to "no-store")
        }
    }

    private fun dispatchNativeFolderPayload(payload: JSONObject) {
        dispatchNativeFolderPayload(payload, 0)
    }

    private fun dispatchNativeFolderPayload(payload: JSONObject, attempt: Int) {
        val quoted = JSONObject.quote(payload.toString())
        val script =
            "(function(){" +
                "const raw = $quoted;" +
                "try {" +
                "const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;" +
                "if (payload && payload.ok === true && typeof state === 'object' && typeof setLibrary === 'function' && typeof buildItem === 'function') {" +
                "const files = Array.isArray(payload.files) ? payload.files : [];" +
                "const nextItems = [];" +
                "const nativeMap = new Map();" +
                "const usedPaths = new Set();" +
                "for (const row of files) {" +
                "const rawPath = String(row && row.path ? row.path : '').replace(/\\\\/g, '/').trim();" +
                "const type = row && (row.type === 'pdf' || row.type === 'audio') ? row.type : (typeof detectType === 'function' ? detectType(rawPath) : '');" +
                "const url = String(row && row.url ? row.url : '').trim();" +
                "if (!rawPath || !type || !url) { continue; }" +
                "const uniquePath = typeof createUniquePath === 'function' ? createUniquePath(rawPath, usedPaths) : rawPath;" +
                "usedPaths.add(uniquePath);" +
                "nextItems.push(typeof buildItem === 'function' ? buildItem(uniquePath, type) : { path: uniquePath, type: type });" +
                "nativeMap.set(uniquePath, { url: url, type: type });" +
                "}" +
                "if (typeof compareItems === 'function') { nextItems.sort(compareItems); }" +
                "state.nativeFileMap = nativeMap;" +
                "state.filePool = null;" +
                "state.rootHandle = null;" +
                "if (typeof clearRootHandle === 'function') { try { clearRootHandle(); } catch (_) {} }" +
                "if (typeof el === 'object' && el && el.refreshBtn) { el.refreshBtn.disabled = false; }" +
                "setLibrary(nextItems, true);" +
                "if (typeof setStatus === 'function') { setStatus('フォルダ読み込み完了: ' + nextItems.length + '件'); }" +
                "return 'ok';" +
                "}" +
                "if (typeof window.__onNativeFolderPicked === 'function') {" +
                "window.__onNativeFolderPicked(raw);" +
                "return 'ok';" +
                "}" +
                "} catch (_) {" +
                "if (typeof window.__onNativeFolderPicked === 'function') {" +
                "window.__onNativeFolderPicked(raw);" +
                "return 'ok';" +
                "}" +
                "}" +
                "return 'missing';" +
                "})();"
        webView.evaluateJavascript(script) { result ->
            if (result == "\"ok\"") {
                return@evaluateJavascript
            }
            if (attempt >= 20) {
                return@evaluateJavascript
            }
            webView.postDelayed(
                { dispatchNativeFolderPayload(payload, attempt + 1) },
                250
            )
        }
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun pickStudySource() {
            runOnUiThread {
                showStudySourceChooser()
            }
        }

        @JavascriptInterface
        fun pickStudyFolder() {
            runOnUiThread {
                showStudySourceChooser()
            }
        }

        @JavascriptInterface
        fun restoreNativeStudyData() {
            runOnUiThread {
                dispatchCachedPayloadIfAvailable(force = true)
            }
        }

        @JavascriptInterface
        fun openPdfFromNativeUrl(nativeUrl: String): Boolean {
            val id = extractNativeFileId(nativeUrl) ?: return false
            val sourceUri = synchronized(nativeFileLock) { nativeFileMap[id] } ?: return false
            return openPdfFromUri(id, sourceUri)
        }
    }

    private fun openExternal(uri: Uri): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, uri)
        return try {
            startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    companion object {
        private const val APP_URL = "https://tukku56-star.github.io/syaroshi/"
        private const val NATIVE_HOST = "native.local"
        private const val NATIVE_FILE_PATH = "native-file"
        private const val NATIVE_FILE_BASE = "https://native.local/native-file"
        private const val PREFS_NAME = "offline-study-native"
        private const val PREF_KEY_NATIVE_MAP = "native_file_map_json"
        private const val PREF_KEY_NATIVE_PAYLOAD = "native_payload_json"
        private val AUDIO_EXTENSIONS = setOf(".mp3", ".m4a", ".aac", ".wav", ".ogg")
        private val SKIP_DIRECTORIES = setOf(".git", "offline-study-app", "node_modules")
    }
}
