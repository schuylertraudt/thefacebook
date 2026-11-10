package com.personal.friendbook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RedirectGuardTest {

    @Test fun backToBackRedirectsAreAllPerformed() {
        // Regression: two redirects within 1.5 s used to drop the second one -> blank screen.
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 6)
        assertTrue(g.allow(1_000))
        assertTrue(g.allow(1_050))
        assertTrue(g.allow(1_100))
    }

    @Test fun rapidBouncingTripsTheGuard() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 6)
        repeat(6) { assertTrue(g.allow(1_000L + it * 100)) }
        assertFalse(g.allow(1_700))
    }

    @Test fun oldRedirectsExpire() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 2)
        assertTrue(g.allow(0))
        assertTrue(g.allow(1_000))
        assertFalse(g.allow(2_000))
        assertTrue(g.allow(20_000))
    }

    @Test fun resetClears() {
        val g = RedirectGuard(windowMs = 10_000, maxRedirects = 1)
        assertTrue(g.allow(0))
        assertFalse(g.allow(1))
        g.reset()
        assertTrue(g.allow(2))
    }
}
