package com.tukku56.syaroshi

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

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

    private val folderPickerLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { treeUri ->
            onStudyFolderPicked(treeUri)
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

    private fun onStudyFolderPicked(treeUri: Uri?) {
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
            } catch (_: SecurityException) {
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
            val stream = contentResolver.openInputStream(targetUri) ?: return emptyResponse(404, "Not Found")
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
        fun pickStudyFolder() {
            runOnUiThread {
                folderPickerLauncher.launch(null)
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
