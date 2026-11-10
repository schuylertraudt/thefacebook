package com.personal.friendbook

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.core.net.toUri
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap

class MainActivity : ComponentActivity() {

    private lateinit var rules: UrlRules
    private lateinit var injector: Injector

    private lateinit var webView: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var debugPanel: View
    private lateinit var logText: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var errorView: View
    private lateinit var errorMessage: TextView

    /** Debug/discovery mode: filtering off, everything logged. Not persisted. */
    @Volatile private var debug = false

    /** Reported by inject.js: whether the page's scroller is at the top (for pull-to-refresh). */
    @Volatile private var pageAtTop = true

    // Redirect bookkeeping, shared between the UI thread and the JS bridge thread.
    private val redirectGuard = RedirectGuard()

    private val loggedResourceHosts: MutableSet<String> = ConcurrentHashMap.newKeySet()

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = fileCallback
            fileCallback = null
            cb?.onReceiveValue(parseFileResult(res.resultCode, res.data))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Remote debugging via chrome://inspect in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val rulesJson = assets.open("rules.json").bufferedReader().use { it.readText() }
        rules = UrlRules.fromJson(rulesJson)
        injector = Injector(this, rulesJson)

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        swipe = findViewById(R.id.swipe)
        debugPanel = findViewById(R.id.debugPanel)
        logText = findViewById(R.id.logText)
        logScroll = findViewById(R.id.logScroll)
        errorView = findViewById(R.id.errorView)
        errorMessage = findViewById(R.id.errorMessage)

        applyInsets()
        setupDebugPanel()
        setupErrorView()
        setupWebView()
        setupRefresh()

        onBackPressedDispatcher.addCallback(this) {
            val url = webView.url
            when {
                errorView.isVisible -> finish()
                webView.canGoBack() && (url == null || !rules.isFriendsFeed(url)) -> webView.goBack()
                else -> finish()
            }
        }

        loadFeed()
    }

    // ---------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------

    private fun applyInsets() {
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.updatePadding(
                left = bars.left,
                top = bars.top,
                right = bars.right,
                bottom = maxOf(bars.bottom, ime.bottom),
            )
            WindowInsetsCompat.CONSUMED
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = true
        s.setSupportMultipleWindows(false)
        s.javaScriptCanOpenWindowsAutomatically = false
        s.allowFileAccess = false
        s.userAgentString = rules.uaRemoveTokens.fold(WebSettings.getDefaultUserAgent(this)) { ua, t ->
            ua.replace(t, "")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false)
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.addJavascriptInterface(Bridge(), BRIDGE_NAME)
        val docStart = injector.install(webView, rules.injectOrigins)

        webView.webViewClient = Client()
        webView.webChromeClient = Chrome()

        if (BuildConfig.DEBUG) {
            DebugLog.add("init", "documentStartScript=$docStart ua=${s.userAgentString}")
        }
    }

    private fun setupRefresh() {
        swipe.setOnRefreshListener { loadFeed() }
        swipe.setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 || !pageAtTop }
    }

    private fun setupDebugPanel() {
        DebugLog.listener = { line ->
            if (debug) {
                logText.append(if (logText.length() == 0) line else "\n$line")
                logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
            }
        }
        findViewById<Button>(R.id.copyLog).setOnClickListener {
            val cm = getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText("Friendbook log", DebugLog.text()))
            Toast.makeText(this, R.string.log_copied, Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.clearLog).setOnClickListener {
            DebugLog.clear()
            logText.text = ""
        }
        findViewById<Button>(R.id.debugOff).setOnClickListener { setDebug(false) }
    }

    private fun setupErrorView() {
        findViewById<Button>(R.id.retry).setOnClickListener {
            redirectGuard.reset()
            errorView.visibility = View.GONE
            loadFeed()
        }
        // Debug mode is also reachable when the page never loads.
        findViewById<View>(R.id.errorTitle).setOnLongClickListener {
            setDebug(!debug)
            true
        }
    }

    // ---------------------------------------------------------------------------------
    // Navigation policy
    // ---------------------------------------------------------------------------------

    private fun isLoggedIn(): Boolean {
        if (rules.sessionCookieUrl.isEmpty()) return true
        return rules.hasSession(CookieManager.getInstance().getCookie(rules.sessionCookieUrl))
    }

    /**
     * URL rules are enforced only when debug mode is off AND a session exists. While logged
     * out Facebook moves the login form between /, /login/ and /unified/login_via/..., and
     * nothing but login pages is reachable anyway.
     */
    private fun filtering(): Boolean = !debug && isLoggedIn()

    /** Friends feed when logged in, the login page otherwise. Safe to call from any thread. */
    private fun startUrl(): String = if (isLoggedIn()) rules.friendsFeedUrl else rules.loginUrl

    private fun loadFeed() {
        val url = startUrl()
        if (debug) DebugLog.add("nav", "load ${if (url == rules.friendsFeedUrl) "feed" else "login (no session cookie)"} $url")
        webView.loadUrl(url)
    }

    private fun setDebug(on: Boolean) {
        if (debug == on) return
        debug = on
        debugPanel.visibility = if (on) View.VISIBLE else View.GONE
        DebugLog.add("debug", if (on) "ON (filtering disabled)" else "OFF (filtering enabled)")
        if (on) {
            logText.text = DebugLog.text()
            logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
            loggedResourceHosts.clear()
        } else {
            // Re-apply filtering to wherever we are now.
            webView.url?.let { url ->
                if (filtering() && rules.classify(url).decision == Decision.BLOCK) redirectToFeed()
            }
        }
    }

    private fun logNav(source: String, v: Verdict, url: String) {
        if (!debug) return
        val extra = if (v.target != url) " -> ${v.target}" else ""
        val session = if (isLoggedIn()) "" else " (logged out: not enforced)"
        DebugLog.add(source, "${v.decision} [${v.reason}] $url$extra$session")
    }

    /**
     * Applies policy to a main-frame navigation. Returns true if the navigation was
     * consumed (cancelled / redirected / opened externally).
     */
    private fun handleNavigation(url: String, source: String): Boolean {
        val v = rules.classify(url)
        logNav(source, v, url)
        return when (v.decision) {
            Decision.ALLOW -> false
            Decision.EXTERNAL -> {
                openExternal(v.target)
                true
            }
            Decision.BLOCK -> {
                val isWeb = url.startsWith("http://") || url.startsWith("https://")
                when {
                    !isWeb -> true // fb://, intent:// ... never load, never hand to the FB app.
                    !filtering() -> false
                    else -> {
                        redirectToFeed()
                        true
                    }
                }
            }
        }
    }

    /** Sends a blocked navigation to the start URL, unless the start URL itself keeps bouncing. */
    private fun redirectToFeed() {
        if (redirectGuard.allow(SystemClock.elapsedRealtime())) loadFeed() else showLoopError()
    }

    private fun showLoopError() {
        webView.stopLoading()
        DebugLog.add("error", "redirect loop: ${startUrl()} keeps landing on blocked URLs")
        showError(
            "The start page keeps redirecting to a blocked page.\n" +
                "Long-press the title above to enable debug mode and check friendsFeedUrl."
        )
    }

    private fun showError(message: String) {
        errorMessage.text = message
        errorView.visibility = View.VISIBLE
        swipe.isRefreshing = false
    }

    private fun openExternal(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, url.toUri())
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show()
        }
    }

    // ---------------------------------------------------------------------------------
    // WebView clients
    // ---------------------------------------------------------------------------------

    private inner class Client : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return handleNavigation(request.url.toString(), "native:override")
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageAtTop = true
            val v = rules.classify(url)
            logNav("native:start", v, url)
            when {
                v.decision == Decision.EXTERNAL -> {
                    view.stopLoading()
                    openExternal(v.target)
                    if (view.canGoBack()) view.goBack() else loadFeed()
                    return
                }
                v.decision == Decision.BLOCK && filtering() -> {
                    view.stopLoading()
                    redirectToFeed()
                    return
                }
            }
            injector.onPageStarted(view)
        }

        override fun onPageFinished(view: WebView, url: String) {
            swipe.isRefreshing = false
            injector.onPageFinished(view)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            // Catches SPA (pushState) changes too; backstop for inject.js.
            val v = rules.classify(url)
            logNav("native:history", v, url)
            if (v.decision == Decision.BLOCK && filtering() &&
                (url.startsWith("https://") || url.startsWith("http://"))
            ) {
                redirectToFeed()
            }
        }

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val uri = request.url
            val scheme = uri.scheme ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host ?: return blocked()
            if (rules.isResourceHostAllowed(host)) return null
            if (debug && loggedResourceHosts.add(host)) {
                DebugLog.add("net:blocked-host", "$host (first: $uri)")
            }
            return blocked()
        }

        private fun blocked() = WebResourceResponse(
            "text/plain", "utf-8", 403, "Blocked by Friendbook",
            emptyMap(), ByteArrayInputStream(ByteArray(0)),
        )

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            val desc = error.description?.toString() ?: "error ${error.errorCode}"
            DebugLog.add("error", "${error.errorCode} $desc ${request.url}")
            if (desc.contains("ERR_ABORTED")) return
            showError(desc)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The WebView is unusable now; rebuild the activity (and with it the WebView).
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = filePathCallback
            val intent = fileChooserParams.createIntent().apply {
                if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
            }
            return try {
                fileChooser.launch(intent)
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
    }

    private fun parseFileResult(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return Array(clip.itemCount) { clip.getItemAt(it).uri }
        }
        return data.data?.let { arrayOf(it) }
    }

    // ---------------------------------------------------------------------------------
    // JS bridge (called from inject.js on the JavaBridge thread)
    // ---------------------------------------------------------------------------------

    private inner class Bridge {
        @JavascriptInterface
        fun isDebug(): Boolean = debug

        @JavascriptInterface
        fun toggleDebug() {
            runOnUiThread { setDebug(!debug) }
        }

        @JavascriptInterface
        fun shouldRun(url: String): Boolean {
            val u = ParsedUrl.parse(url) ?: return false
            return u.scheme == "https" && rules.isInternalHost(u.host)
        }

        /** Where inject.js sends a blocked SPA navigation. */
        @JavascriptInterface
        fun redirectTarget(): String = startUrl()

        @JavascriptInterface
        fun isFriendsFeed(url: String): Boolean = rules.isFriendsFeed(url)

        /** Returns "allow", "block" (caller must location.replace to the feed) or "external". */
        @JavascriptInterface
        fun checkUrl(url: String, source: String): String {
            val v = rules.classify(url)
            logNav(source, v, url)
            return when (v.decision) {
                Decision.ALLOW -> "allow"
                Decision.EXTERNAL -> "external"
                Decision.BLOCK -> {
                    if (!filtering()) return "allow"
                    if (redirectGuard.allow(SystemClock.elapsedRealtime())) {
                        "block"
                    } else {
                        runOnUiThread { showLoopError() }
                        "stop"
                    }
                }
            }
        }

        @JavascriptInterface
        fun log(tag: String, msg: String) {
            if (debug) DebugLog.add(tag, msg)
        }

        @JavascriptInterface
        fun setAtTop(atTop: Boolean) {
            pageAtTop = atTop
        }
    }

    // ---------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        DebugLog.listener = null
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        injector.remove()
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val BRIDGE_NAME = "FriendbookNative"
    }
}
