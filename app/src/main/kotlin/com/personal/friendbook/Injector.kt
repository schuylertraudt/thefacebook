package com.personal.friendbook

import android.content.Context
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Builds the injected script from assets and installs it.
 *
 * The final script is:
 *   (function (THEME_CSS, CFG) { 'use strict'; <inject.js> })("<theme.css>", <rules.json>);
 * so inject.js receives the theme and the whole rules file as arguments and contains no
 * Facebook-specific values of its own. The script is idempotent: it guards against running
 * twice in the same document.
 */
class Injector(context: Context, rulesJson: String) {

    val script: String

    private var handler: ScriptHandler? = null

    /** True when WebViewCompat.addDocumentStartJavaScript is in use. */
    var usesDocumentStart = false
        private set

    init {
        val css = context.assets.open("theme.css").bufferedReader().use { it.readText() }
        val js = context.assets.open("inject.js").bufferedReader().use { it.readText() }
        // Re-serialise rules.json so it is guaranteed to be a single valid JS expression.
        val cfg = JSONObject(rulesJson).toString()
        script = buildString {
            append("(function (THEME_CSS, CFG) {\n'use strict';\n")
            append(js)
            append("\n})(")
            append(JSONObject.quote(css))
            append(", ")
            append(cfg)
            append(");")
        }
    }

    /**
     * Registers the script to run at document start in every frame whose origin matches
     * [origins] (inject.js itself bails out in sub-frames). Returns false when the WebView
     * does not support it; the caller then relies on [onPageStarted] / [onPageFinished].
     */
    fun install(webView: WebView, origins: Set<String>): Boolean {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            handler = WebViewCompat.addDocumentStartJavaScript(webView, script, origins)
            usesDocumentStart = true
        }
        return usesDocumentStart
    }

    fun onPageStarted(view: WebView) {
        if (!usesDocumentStart) view.evaluateJavascript(script, null)
    }

    fun onPageFinished(view: WebView) {
        // Always safe: the script is a no-op if it already ran in this document.
        if (!usesDocumentStart) view.evaluateJavascript(script, null)
    }

    fun remove() {
        handler?.remove()
        handler = null
    }
}
