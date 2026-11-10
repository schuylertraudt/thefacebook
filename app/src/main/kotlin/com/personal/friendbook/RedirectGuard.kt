package com.personal.friendbook

/**
 * Counts block-redirects to detect a loop (the start page itself bouncing to blocked URLs).
 *
 * Every redirect is performed unless a loop is detected. One bounce is reported by several
 * hooks (shouldOverrideUrlLoading, onPageStarted, doUpdateVisitedHistory, inject.js), so
 * reports within [mergeMs] of the last counted one count as the same bounce.
 */
class RedirectGuard(
    private val windowMs: Long = 15_000L,
    private val maxRedirects: Int = 5,
    private val mergeMs: Long = 400L,
) {
    private val times = ArrayDeque<Long>()

    /** Records a redirect at [nowMs]. Returns false when the redirect rate means a loop. */
    @Synchronized
    fun allow(nowMs: Long): Boolean {
        val last = times.lastOrNull()
        if (last == null || nowMs - last >= mergeMs) times.addLast(nowMs)
        while (times.isNotEmpty() && nowMs - times.first() > windowMs) times.removeFirst()
        return times.size <= maxRedirects
    }

    @Synchronized
    fun reset() = times.clear()
}
