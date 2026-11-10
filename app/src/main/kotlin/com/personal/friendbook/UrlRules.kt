package com.personal.friendbook

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder

enum class Decision { ALLOW, BLOCK, EXTERNAL }

/**
 * Result of classifying a URL.
 * [target] is the URL to act on: for EXTERNAL decisions coming from Facebook's link shim
 * it is the unwrapped destination, otherwise the input URL.
 */
data class Verdict(val decision: Decision, val reason: String, val target: String)

/**
 * Minimal, lenient URL splitter. java.net.URI rejects many real-world Facebook URLs
 * (raw '|', spaces, unicode in query strings), and android.net.Uri is unavailable in JVM
 * unit tests, so we split with a regex.
 */
data class ParsedUrl(
    val scheme: String,
    val host: String,
    val path: String,
    val query: String?,
) {
    val pathAndQuery: String get() = if (query == null) path else "$path?$query"

    companion object {
        private val URL_RE = Regex(
            "^([a-zA-Z][a-zA-Z0-9+.-]*):(?://([^/?#]*))?([^?#]*)(?:\\?([^#]*))?(?:#.*)?$",
            RegexOption.DOT_MATCHES_ALL,
        )

        fun parse(url: String): ParsedUrl? {
            val m = URL_RE.matchEntire(url.trim()) ?: return null
            val scheme = m.groupValues[1].lowercase()
            val authority = m.groups[2]?.value ?: ""
            val hostPort = authority.substringAfterLast('@')
            val host = hostPort.substringBefore(':').lowercase().trimEnd('.')
            var path = m.groupValues[3]
            if (path.isEmpty() && m.groups[2] != null) path = "/"
            return ParsedUrl(scheme, host, path, m.groups[4]?.value)
        }

        fun queryParams(query: String?): Map<String, String> {
            if (query.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (part in query.split('&')) {
                if (part.isEmpty()) continue
                val k = decode(part.substringBefore('='))
                val v = if (part.contains('=')) decode(part.substringAfter('=')) else ""
                if (!out.containsKey(k)) out[k] = v
            }
            return out
        }

        private fun decode(s: String): String =
            try { URLDecoder.decode(s, "UTF-8") } catch (_: Exception) { s }
    }
}

/**
 * All navigation policy. Loaded from assets/rules.json; contains no Facebook-specific
 * constants of its own.
 *
 * Evaluation order for http(s) URLs:
 *   1. link-shim host  -> classify the wrapped target (usually EXTERNAL)
 *   2. not an internal host -> EXTERNAL
 *   3. open host -> ALLOW
 *   4. matches friendsFeedUrl -> ALLOW
 *   5. any block pattern -> BLOCK
 *   6. any allow pattern -> ALLOW
 *   7. otherwise -> BLOCK ("default")
 * Block is checked before allow so broad allow patterns (e.g. vanity profile names)
 * can never re-open a blocked section.
 */
class UrlRules(
    val friendsFeedUrl: String,
    /** Where to go while logged out. Defaults to the feed URL. */
    val loginUrl: String = friendsFeedUrl,
    /** Cookie whose presence (for [sessionCookieUrl]) means "logged in". Empty = always logged in. */
    val sessionCookieUrl: String = "",
    val sessionCookieName: String = "",
    private val internalHosts: List<Regex>,
    private val openHosts: List<Regex>,
    private val linkShimHosts: List<Regex>,
    private val linkShimParam: String,
    private val resourceHosts: List<Regex>,
    private val allow: List<Regex>,
    private val block: List<Regex>,
    private val internalSchemes: Set<String>,
    private val externalSchemes: Set<String>,
    val uaRemoveTokens: List<String>,
    val injectOrigins: Set<String>,
    /**
     * URLs (path+query patterns) the friends-feed document may rewrite its own address to
     * with history.replaceState. Facebook canonicalises the feed URL to "/" after loading;
     * the content is still what was served for friendsFeedUrl.
     */
    private val feedCanonical: List<Regex> = emptyList(),
    /** Load the desktop site (www) with [desktopUserAgent] instead of the mobile site. */
    val desktopMode: Boolean = false,
    val desktopUserAgent: String = "",
    val desktopHost: String = "",
) {
    private val feed: ParsedUrl = requireNotNull(ParsedUrl.parse(friendsFeedUrl)) {
        "friendsFeedUrl is not a valid URL: $friendsFeedUrl"
    }
    private val feedParams = ParsedUrl.queryParams(feed.query)

    fun classify(url: String): Verdict {
        val u = ParsedUrl.parse(url) ?: return Verdict(Decision.BLOCK, "unparseable", url)
        if (u.scheme != "http" && u.scheme != "https") {
            return when (u.scheme) {
                in internalSchemes -> Verdict(Decision.ALLOW, "scheme:${u.scheme}", url)
                in externalSchemes -> Verdict(Decision.EXTERNAL, "scheme:${u.scheme}", url)
                else -> Verdict(Decision.BLOCK, "scheme:${u.scheme}", url)
            }
        }
        if (linkShimHosts.any { it.containsMatchIn(u.host) }) {
            val target = ParsedUrl.queryParams(u.query)[linkShimParam]
            if (target.isNullOrEmpty() || target == url) {
                return Verdict(Decision.BLOCK, "linkshim-no-target", url)
            }
            val inner = classify(target)
            return inner.copy(reason = "linkshim>" + inner.reason)
        }
        if (!isInternalHost(u.host)) return Verdict(Decision.EXTERNAL, "external-host", url)
        if (openHosts.any { it.containsMatchIn(u.host) }) {
            return Verdict(Decision.ALLOW, "open-host", url)
        }
        if (matchesFeed(u)) return Verdict(Decision.ALLOW, "friends-feed", url)
        val pq = u.pathAndQuery
        block.firstOrNull { it.containsMatchIn(pq) }?.let {
            return Verdict(Decision.BLOCK, "block:${it.pattern}", url)
        }
        allow.firstOrNull { it.containsMatchIn(pq) }?.let {
            return Verdict(Decision.ALLOW, "allow:${it.pattern}", url)
        }
        return Verdict(Decision.BLOCK, "default", url)
    }

    /** Whether a Cookie header value (as from CookieManager.getCookie) contains the session cookie. */
    fun hasSession(cookieHeader: String?): Boolean {
        if (sessionCookieName.isEmpty()) return true
        if (cookieHeader.isNullOrEmpty()) return false
        return cookieHeader.split(';').any { part ->
            val kv = part.trim()
            kv.substringBefore('=') == sessionCookieName && kv.substringAfter('=', "").isNotEmpty()
        }
    }

    fun isInternalHost(host: String): Boolean = internalHosts.any { it.containsMatchIn(host) }

    /** [url] with its host replaced by [host] (scheme, path, query kept). */
    fun withHost(url: String, host: String): String {
        if (host.isEmpty()) return url
        val m = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*://)([^/?#]*)(.*)$").matchEntire(url) ?: return url
        return m.groupValues[1] + host + m.groupValues[3]
    }

    /** True if [url] is an address the friends-feed document may rewrite itself to (see feedCanonical). */
    fun isFeedCanonical(url: String): Boolean {
        val u = ParsedUrl.parse(url) ?: return false
        if ((u.scheme != "http" && u.scheme != "https") || !isInternalHost(u.host)) return false
        return feedCanonical.any { it.containsMatchIn(u.pathAndQuery) }
    }

    /** True if [url] is the friends feed (any internal host, same path, all feed query params present). */
    fun isFriendsFeed(url: String): Boolean {
        val u = ParsedUrl.parse(url) ?: return false
        return (u.scheme == "http" || u.scheme == "https") && isInternalHost(u.host) && matchesFeed(u)
    }

    /** Whether a sub-resource request to [host] may go out. */
    fun isResourceHostAllowed(host: String): Boolean =
        resourceHosts.any { it.containsMatchIn(host.lowercase()) }

    private fun matchesFeed(u: ParsedUrl): Boolean {
        if (normPath(u.path) != normPath(feed.path)) return false
        if (feedParams.isEmpty()) return true
        val p = ParsedUrl.queryParams(u.query)
        return feedParams.all { (k, v) -> p[k] == v }
    }

    private fun normPath(p: String): String =
        if (p.length > 1) p.trimEnd('/').ifEmpty { "/" } else p.ifEmpty { "/" }

    companion object {
        fun fromJson(text: String): UrlRules {
            val o = JSONObject(text)
            val shim = o.optJSONObject("linkShim")
            val session = o.optJSONObject("sessionCookie")
            val feedUrl = o.getString("friendsFeedUrl")
            return UrlRules(
                friendsFeedUrl = feedUrl,
                loginUrl = o.optString("loginUrl", "").ifEmpty { feedUrl },
                sessionCookieUrl = session?.optString("url", "") ?: "",
                sessionCookieName = session?.optString("name", "") ?: "",
                internalHosts = regexes(o.optJSONArray("internalHosts")),
                openHosts = regexes(o.optJSONArray("openHosts")),
                linkShimHosts = regexes(shim?.optJSONArray("hosts")),
                linkShimParam = shim?.optString("param", "u") ?: "u",
                resourceHosts = regexes(o.optJSONArray("resourceHosts")),
                allow = regexes(o.optJSONArray("allow")),
                block = regexes(o.optJSONArray("block")),
                internalSchemes = strings(o.optJSONArray("internalSchemes")).map { it.lowercase() }.toSet(),
                externalSchemes = strings(o.optJSONArray("externalSchemes")).map { it.lowercase() }.toSet(),
                uaRemoveTokens = strings(o.optJSONArray("uaRemoveTokens")),
                injectOrigins = strings(o.optJSONArray("injectOrigins")).toSet(),
                feedCanonical = regexes(o.optJSONArray("friendsFeedCanonical")),
                desktopMode = o.optBoolean("desktopMode", false),
                desktopUserAgent = o.optString("desktopUserAgent", ""),
                desktopHost = o.optString("desktopHost", ""),
            )
        }

        private fun strings(a: JSONArray?): List<String> =
            if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }

        private fun regexes(a: JSONArray?): List<Regex> = strings(a).map { Regex(it) }
    }
}
