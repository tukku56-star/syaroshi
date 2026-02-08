package com.tukku56.syaroshi

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
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
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipInputStream

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val nativeFileMap = mutableMapOf<String, Uri>()
    private val nativeFileLock = Any()

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

        webView = findViewById(R.id.webView)
        configureWebView()

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(APP_URL)
        }

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

        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(nextNativeMap)
        }

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

        val files = JSONArray()
        val nextNativeMap = mutableMapOf<String, Uri>()
        val rootCanonical = try {
            rootDir.canonicalFile
        } catch (_: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }

        try {
            val input = contentResolver.openInputStream(zipUri) ?: return JSONObject()
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

                    val id = UUID.randomUUID().toString()
                    nextNativeMap[id] = Uri.fromFile(outCanonical)
                    files.put(
                        JSONObject()
                            .put("path", relativePath)
                            .put("name", fileName)
                            .put("type", type)
                            .put("url", "$NATIVE_FILE_BASE/$id")
                    )
                    zip.closeEntry()
                }
            }
        } catch (_: Exception) {
            return JSONObject()
                .put("ok", false)
                .put("error", "zip_unavailable")
        }

        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(nextNativeMap)
        }

        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }

        return JSONObject()
            .put("ok", true)
            .put("count", nextNativeMap.size)
            .put("files", files)
    }

    private fun prepareSyncDirectory(rootDir: File): Boolean {
        return try {
            if (rootDir.exists()) {
                rootDir.deleteRecursively()
            }
            rootDir.mkdirs()
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

        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(nextNativeMap)
        }

        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }

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

        synchronized(nativeFileLock) {
            nativeFileMap.clear()
            nativeFileMap.putAll(nextNativeMap)
        }

        if (nextNativeMap.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "no_supported_files")
        }

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
            return "audio"
        }
        return null
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
            val stream = openNativeInputStream(targetUri) ?: return emptyResponse(404, "Not Found")
            val mime = contentResolver.getType(targetUri) ?: guessMimeType(targetUri.toString())
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
        val script = "window.__onNativeFolderPicked(${JSONObject.quote(payload.toString())});"
        webView.evaluateJavascript(script, null)
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
        private val AUDIO_EXTENSIONS = setOf(".mp3", ".m4a", ".aac", ".wav", ".ogg")
        private val SKIP_DIRECTORIES = setOf(".git", "offline-study-app", "node_modules")
    }
}
