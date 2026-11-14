package io.github.manboyx.eclipse

import io.github.manboyx.eclipse.update.Updates
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    @Test fun versionOrder() {
        assertTrue(Updates.compare("1.2.0", "1.1.9") > 0)
        assertTrue(Updates.compare("v1.10.0", "1.9.0") > 0)
        assertTrue(Updates.compare("1.0.0-beta.2", "1.0.0") < 0)
        assertTrue(Updates.compare("1.0.0-beta.10", "1.0.0-beta.2") > 0)
        assertEquals(0, Updates.compare("0.2.0", "v0.2.0"))
    }

    @Test fun shaFromSums() {
        val sums = "${"a".repeat(64)}  Eclipse_amd64.AppImage\n${"B".repeat(64)} *Eclipse.apk\n"
        assertEquals("b".repeat(64), Updates.shaFor(sums, "Eclipse.apk"))
        assertNull(Updates.shaFor(sums, "absent.apk"))
    }

    @Test fun stableIgnoresPrereleasesAndDrafts() {
        fun rel(tag: String, pre: Boolean = false, draft: Boolean = false) =
            JSONObject().put("tag_name", tag).put("prerelease", pre).put("draft", draft)
        val list = JSONArray().put(rel("v1.1.0")).put(rel("v1.2.0-beta.1", pre = true)).put(rel("v1.3.0", draft = true))
            .put(rel("beta-channel", pre = true)).put(rel("v1.0.0"))
        assertEquals("v1.1.0", Updates.pickRelease(list, beta = false)!!.getString("tag_name"))
        assertEquals("v1.2.0-beta.1", Updates.pickRelease(list, beta = true)!!.getString("tag_name"))
    }
}
