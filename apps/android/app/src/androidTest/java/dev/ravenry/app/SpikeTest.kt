package dev.ravenry.app

import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The MCP Apps double-iframe sandbox on this WebView (SpikeActivity). */
@RunWith(AndroidJUnit4::class)
class SpikeTest {
    @Test fun theSandboxHolds() {
        ActivityScenario.launch(SpikeActivity::class.java).use {
            val until = System.currentTimeMillis() + 30000
            while (SpikeActivity.results == null && System.currentTimeMillis() < until) Thread.sleep(200)
            val r = SpikeActivity.results ?: error("the spike page never finished")
            Log.i("RavenrySpike", "results " + r.toString(2))
            Log.i("RavenrySpike", "hub requests " + SpikeActivity.hubRequests)
            Log.i("RavenrySpike", "top navigations " + SpikeActivity.topNavigations)
            Log.i("RavenrySpike", "shell messages " + SpikeActivity.shellMessages)
            // The relay works both ways, through the outer frame.
            assertEquals("ok", r.getString("relay"))
            // The app's frame has an opaque origin and reads nothing above it.
            assertEquals("null", r.getString("inner_origin"))
            assertEquals("blocked", r.getString("inner_reads_parent"))
            assertEquals("blocked", r.getString("inner_reads_top"))
            assertEquals("blocked", r.getString("outer_reads_parent"))
            // ravenryShell exists only at the board's origin.
            assertEquals("object", r.getString("host_shell"))
            assertEquals("undefined", r.getString("outer_shell"))
            assertEquals("undefined", r.getString("inner_shell"))
            // No storage, no popup, no top navigation, no network for the app.
            assertEquals("blocked", r.getString("inner_storage"))
            assertEquals("blocked", r.getString("inner_cookie"))
            assertEquals("blocked", r.getString("inner_popup"))
            assertEquals("blocked", r.getString("inner_top_nav"))
            assertTrue(SpikeActivity.topNavigations.isEmpty())
            assertEquals("blocked", r.getString("inner_fetch_app"))
            assertEquals("blocked", r.getString("inner_fetch_hub"))
            // The board reads the hub; another origin's request is refused at the door.
            assertEquals("allowed", r.getString("host_fetch_hub"))
            // A no-cors fetch from the outer frame arrives with no Origin, only its Referer: refused.
            assertTrue(SpikeActivity.hubRequests.toString(), SpikeActivity.hubRequests.any { it.contains("sandbox.ravenry.test") && it.endsWith("refused") })
            assertTrue(SpikeActivity.hubRequests.none { it.contains("sandbox.ravenry.test") && it.endsWith("served") })
            // The addJavascriptInterface object reaches every frame, the sandboxed one included: why the shell never uses it.
            assertEquals("object", r.getString("inner_leaky"))
            assertEquals("native reached", r.getString("inner_leaky_call"))
        }
    }
}
