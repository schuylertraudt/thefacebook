package com.personal.friendbook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RedirectGuardTest {

    @Test fun backToBackReportsAreAllPerformed() {
        // Regression: a second redirect within 1.5 s used to be dropped -> blank screen.
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 2, mergeMs = 400)
        assertTrue(g.allow(1_000))
        assertTrue(g.allow(1_050))
        assertTrue(g.allow(1_100))
    }

    @Test fun oneBounceSeenByManyHooksCountsOnce() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 2, mergeMs = 400)
        // bounce 1: override, pageStarted, history, js
        listOf(0L, 5L, 40L, 120L).forEach { assertTrue(g.allow(it)) }
        // bounce 2
        listOf(1_000L, 1_010L, 1_200L).forEach { assertTrue(g.allow(it)) }
        // bounce 3 trips
        assertFalse(g.allow(2_000))
    }

    @Test fun rapidBouncingTripsTheGuard() {
        val g = RedirectGuard(windowMs = 15_000, maxRedirects = 5, mergeMs = 400)
        repeat(5) { assertTrue(g.allow(it * 1_000L)) }
        assertFalse(g.allow(5_000))
    }

    @Test fun oldRedirectsExpire() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 2, mergeMs = 0)
        assertTrue(g.allow(0))
        assertTrue(g.allow(1_000))
        assertFalse(g.allow(2_000))
        assertTrue(g.allow(20_000))
    }

    @Test fun resetClears() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 1, mergeMs = 0)
        assertTrue(g.allow(0))
        assertFalse(g.allow(1))
        g.reset()
        assertTrue(g.allow(2))
    }
}
