package com.personal.friendbook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Tests run against the real shipped assets/rules.json. */
class UrlRulesTest {

    private val rules = UrlRules.fromJson(File("src/main/assets/rules.json").readText())

    private fun decision(url: String) = rules.classify(url).decision

    private fun assertAllowed(url: String) =
        assertEquals("expected ALLOW for $url (${rules.classify(url).reason})", Decision.ALLOW, decision(url))

    private fun assertBlocked(url: String) =
        assertEquals("expected BLOCK for $url (${rules.classify(url).reason})", Decision.BLOCK, decision(url))

    // --- friends feed ---------------------------------------------------------

    @Test fun friendsFeedIsAllowed() {
        assertAllowed(rules.friendsFeedUrl)
        assertEquals("friends-feed", rules.classify(rules.friendsFeedUrl).reason)
        assertTrue(rules.isFriendsFeed(rules.friendsFeedUrl))
    }

    @Test fun friendsFeedMatchesWithReorderedAndExtraParams() {
        assertAllowed("https://m.facebook.com/?sk=h_chr&filter=friends")
        assertAllowed("https://m.facebook.com/?filter=friends&sk=h_chr&ref=bookmarks")
        assertTrue(rules.isFriendsFeed("https://m.facebook.com/?sk=h_chr&filter=friends#top"))
    }

    @Test fun feedWithMissingParamIsNotFeed() {
        assertFalse(rules.isFriendsFeed("https://m.facebook.com/?filter=friends"))
        assertBlocked("https://m.facebook.com/?filter=friends")
    }

    // --- post permalinks --------------------------------------------------------

    @Test fun postPermalinksAreAllowed() {
        assertAllowed("https://m.facebook.com/story.php?story_fbid=1234567890&id=100001234567890")
        assertAllowed("https://m.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100001234567890")
        assertAllowed("https://m.facebook.com/jane.doe.123/posts/pfbid0xyzABC")
        assertAllowed("https://m.facebook.com/100001234567890/posts/1234567890/?comment_id=42")
        assertAllowed("https://m.facebook.com/photo.php?fbid=1234&set=a.5678")
        assertAllowed("https://m.facebook.com/profile.php?id=100001234567890")
        assertAllowed("https://m.facebook.com/notifications")
        assertAllowed("https://m.facebook.com/messages/t/100001234567890")
    }

    @Test fun loginFlowsAreAllowed() {
        assertAllowed("https://m.facebook.com/login/?next=https%3A%2F%2Fm.facebook.com%2F")
        assertAllowed("https://m.facebook.com/login.php?skip_api_login=1")
        assertAllowed("https://m.facebook.com/checkpoint/?next")
        assertAllowed("https://m.facebook.com/two_step_verification/two_factor/")
    }

    @Test fun loggedOutLoginRedirectIsAllowed() {
        // Observed: logged out, the feed URL 302s here.
        assertAllowed(
            "https://m.facebook.com/unified/login_via/app/?filter=friends&sk=h_chr&lid=abc" +
                "&lva_id=51110afe&bn=Y29tLmFuZHJvaWQuY2hyb21l&wtsid=rdr_xyz"
        )
        assertAllowed(rules.loginUrl)
    }

    @Test fun sessionCookieDetection() {
        assertTrue(rules.hasSession("datr=abc; c_user=100001234567890; xs=1%3Aabc"))
        assertTrue(rules.hasSession("c_user=1"))
        assertFalse(rules.hasSession("datr=abc; fr=xyz"))
        assertFalse(rules.hasSession("c_user=; datr=abc"))
        assertFalse(rules.hasSession("xc_user=1"))
        assertFalse(rules.hasSession(null))
        assertEquals("https://m.facebook.com", rules.sessionCookieUrl)
    }

    @Test fun feedDocumentMayRewriteItselfToRoot() {
        // Observed on device: the feed document calls replaceState('/') ~0.5 s after load.
        assertTrue(rules.isFeedCanonical("https://m.facebook.com/"))
        assertTrue(rules.isFeedCanonical("https://m.facebook.com/?wtsid=rdr_abc"))
        assertFalse(rules.isFeedCanonical("https://m.facebook.com/watch/"))
        assertFalse(rules.isFeedCanonical("https://m.facebook.com/reel/1"))
        assertFalse(rules.isFeedCanonical("https://example.org/"))
        // The rewrite target is still blocked as a navigation of its own.
        assertBlocked("https://m.facebook.com/")
    }

    @Test fun desktopModeDefaultsOff() {
        assertFalse(rules.desktopMode)
        assertTrue(rules.desktopUserAgent.contains("Windows"))
    }

    // --- home root ------------------------------------------------------------------

    @Test fun homeRootIsBlocked() {
        assertBlocked("https://m.facebook.com/")
        assertBlocked("https://m.facebook.com")
        assertBlocked("https://www.facebook.com/")
        assertBlocked("https://facebook.com")
    }

    @Test fun homeRootWithQueryIsBlocked() {
        assertBlocked("https://m.facebook.com/?ref=bookmarks")
        assertBlocked("https://m.facebook.com/?sk=h_nor")
        assertBlocked("https://m.facebook.com/?_rdr")
        assertBlocked("https://www.facebook.com/?ref=tn_tnmn")
        assertBlocked("https://m.facebook.com/home.php")
        assertBlocked("https://m.facebook.com/home.php?ref=wizard")
    }

    // --- reels and other sections ---------------------------------------------

    @Test fun reelsAreBlocked() {
        assertBlocked("https://m.facebook.com/reel/1234567890")
        assertBlocked("https://m.facebook.com/reels/")
        assertBlocked("https://m.facebook.com/reels?s=tab")
        assertBlocked("https://www.facebook.com/reel/987654321/?mibextid=abc")
        assertBlocked("https://m.facebook.com/jane.doe/reels/")
    }

    @Test fun otherSectionsAreBlocked() {
        assertBlocked("https://m.facebook.com/watch/?ref=tab")
        assertBlocked("https://m.facebook.com/marketplace/item/1/")
        assertBlocked("https://m.facebook.com/gaming/feed/")
        assertBlocked("https://m.facebook.com/groups/")
        assertBlocked("https://m.facebook.com/groups/feed/")
        assertBlocked("https://m.facebook.com/stories/")
        assertBlocked("https://m.facebook.com/search/top/?q=x")
    }

    @Test fun blockBeatsBroadVanityAllow() {
        // "/marketplace" would also match the vanity-name allow pattern.
        assertBlocked("https://m.facebook.com/marketplace")
        assertBlocked("https://m.facebook.com/bookmarks/")
        assertAllowed("https://m.facebook.com/jane.doe.123")
    }

    // --- unknown paths ------------------------------------------------------------

    @Test fun unknownPathsAreBlockedByDefault() {
        val v = rules.classify("https://m.facebook.com/some/unknown/deep/path?x=1")
        assertEquals(Decision.BLOCK, v.decision)
        assertEquals("default", v.reason)
        assertBlocked("https://m.facebook.com/xy")
        assertBlocked("https://m.facebook.com/settings/account/")
    }

    // --- hosts ------------------------------------------------------------------------

    @Test fun mobileAndWwwHostsAreTreatedTheSame() {
        val paths = listOf(
            "/",
            "/?ref=bookmarks",
            "/?filter=friends&sk=h_chr",
            "/story.php?story_fbid=1&id=2",
            "/reel/123",
            "/watch/",
            "/some/unknown/path",
            "/jane.doe.123/posts/pfbid0abc",
        )
        for (p in paths) {
            val m = rules.classify("https://m.facebook.com$p")
            val w = rules.classify("https://www.facebook.com$p")
            val bare = rules.classify("https://facebook.com$p")
            assertEquals("m vs www for $p", m.decision, w.decision)
            assertEquals("m vs bare for $p", m.decision, bare.decision)
            assertEquals("m vs www reason for $p", m.reason, w.reason)
        }
    }

    @Test fun lookalikeHostsAreExternal() {
        assertEquals(Decision.EXTERNAL, decision("https://facebook.com.evil.example/story.php?story_fbid=1"))
        assertEquals(Decision.EXTERNAL, decision("https://notfacebook.com/"))
        assertEquals(Decision.EXTERNAL, decision("https://example.org/article"))
    }

    @Test fun hostIsCaseAndPortInsensitive() {
        assertAllowed("https://M.FaceBook.com:443/story.php?story_fbid=1&id=2")
    }

    @Test fun linkShimUnwrapsToExternalTarget() {
        val v = rules.classify(
            "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1&h=AT0xyz"
        )
        assertEquals(Decision.EXTERNAL, v.decision)
        assertEquals("https://example.org/a?b=1", v.target)
        assertEquals(Decision.BLOCK, decision("https://lm.facebook.com/l.php?h=only"))
    }

    // --- schemes and resources ----------------------------------------------------

    @Test fun schemes() {
        assertEquals(Decision.ALLOW, decision("about:blank"))
        assertEquals(Decision.ALLOW, decision("blob:https://m.facebook.com/abc"))
        assertEquals(Decision.EXTERNAL, decision("mailto:someone@example.org"))
        assertEquals(Decision.BLOCK, decision("fb://feed"))
        assertEquals(Decision.BLOCK, decision("intent://reel/1#Intent;scheme=fb;end"))
    }

    @Test fun resourceHosts() {
        assertTrue(rules.isResourceHostAllowed("static.xx.fbcdn.net"))
        assertTrue(rules.isResourceHostAllowed("scontent-lax3-1.xx.fbcdn.net"))
        assertTrue(rules.isResourceHostAllowed("m.facebook.com"))
        assertFalse(rules.isResourceHostAllowed("www.google-analytics.com"))
        assertFalse(rules.isResourceHostAllowed("fbcdn.net.evil.example"))
    }

    // --- rule file semantics independent of shipped values -----------------------

    @Test fun inlineRulesDefaultToBlock() {
        val r = UrlRules.fromJson(
            """
            {
              "friendsFeedUrl": "https://m.facebook.com/feed/friends",
              "internalHosts": ["^([a-z0-9-]+\\.)*facebook\\.com$"],
              "allow": ["^/ok"],
              "block": ["^/ok/but-not-this"]
            }
            """.trimIndent()
        )
        assertEquals(Decision.ALLOW, r.classify("https://m.facebook.com/feed/friends/").decision)
        assertEquals(Decision.ALLOW, r.classify("https://m.facebook.com/ok/fine").decision)
        assertEquals(Decision.BLOCK, r.classify("https://m.facebook.com/ok/but-not-this").decision)
        assertEquals(Decision.BLOCK, r.classify("https://m.facebook.com/other").decision)
        assertEquals(Decision.EXTERNAL, r.classify("https://example.org/").decision)
    }
}
