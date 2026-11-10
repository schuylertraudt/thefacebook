package com.personal.friendbook

/**
 * Counts block-redirects to detect a loop (the start page itself bouncing to blocked URLs).
 *
 * Every redirect is always performed unless a loop is detected: an earlier version skipped
 * "duplicate" redirects, which cancelled the navigation without starting a new one and left
 * a blank WebView.
 */
class RedirectGuard(
    private val windowMs: Long = 10_000L,
    private val maxRedirects: Int = 6,
) {
    private val times = ArrayDeque<Long>()

    /** Records a redirect at [nowMs]. Returns false when the redirect rate means a loop. */
    @Synchronized
    fun allow(nowMs: Long): Boolean {
        times.addLast(nowMs)
        while (times.isNotEmpty() && nowMs - times.first() > windowMs) times.removeFirst()
        return times.size <= maxRedirects
    }

    @Synchronized
    fun reset() = times.clear()
}
