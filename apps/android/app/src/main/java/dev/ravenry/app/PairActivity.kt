package dev.ravenry.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Pairing with the computer (docs/PHONE.md section 3, picture 1): the QR
 * code, the code typed with its check number, and the `ravenry://pair`
 * link. Native, since there is no board to show yet.
 */
class PairActivity : ComponentActivity() {
    private sealed class Step {
        object Scan : Step()
        data class Typing(val address: String = "", val code: String = "", val error: String? = null) : Step()
        data class Check(val link: PairLink, val pin: String) : Step()
        data class Confirm(val link: PairLink) : Step()
        object Busy : Step()
    }

    private val step = mutableStateOf<Step>(Step.Scan)
    private val error = mutableStateOf<String?>(null)
    /** Why the computer did not answer, when Tailscale is the reason: its button under the words. */
    private val reach = mutableStateOf<Reach.Why?>(null)
    private val cameraOn = mutableStateOf(false)
    @Volatile private var scanned = false
    private val analysis = Executors.newSingleThreadExecutor()

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { cameraOn.value = it }
    // Asked when the camera's screen shows, not before: a pairing link
    // opens on "Pair with ...?" and needs no camera.
    private var cameraAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        InkLaunch.markWarm()
        enableEdgeToEdge()
        if (intent.getBooleanExtra(SIGNED_OUT, false)) error.value = getString(R.string.signed_out)
        cameraOn.value = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        fromIntent(intent)
        setContent { Screen() }
    }

    // A theme change keeps this activity (and the step the person is on,
    // manifest configChanges): the bar icons follow the new theme here.
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        enableEdgeToEdge()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        fromIntent(intent)
    }

    /** A `ravenry://pair` link, tapped or pasted: the person confirms which computer first. */
    private fun fromIntent(i: Intent?) {
        val data = i?.data?.toString() ?: return
        PairLink.parse(data).fold({ step.value = Step.Confirm(it) }, { error.value = it.message })
    }

    private fun onScanned(text: String) {
        if (scanned) return
        PairLink.parse(text).fold({ scanned = true; runOnUiThread { pair(it, it.pin!!) } }, { e -> runOnUiThread { error.value = e.message } })
    }

    /** A typed code has no pin: take the computer's key, then show its check number. */
    private fun fetchKey(link: PairLink) {
        step.value = Step.Busy
        Hub.io.execute {
            val c = HubClient(link.hosts, link.port, null, null, skip = Reach.skip(this), dns = DebugNet.dns(this))
            val r = runCatching { c.call("GET", "/api/phone/hello") }
            val pin = c.trust.seen
            runOnUiThread {
                if (pin == null) {
                    val w = Reach.why(this, link.hosts, r.exceptionOrNull())
                    reach.value = w.takeIf { it.reason.startsWith("tailscale") }
                    step.value = Step.Typing(link.hosts.first(), link.code, w.words)
                }
                else {
                    val name = r.getOrNull()?.let { runCatching { JSONObject(it.text).str("name") }.getOrNull() }
                    step.value = Step.Check(link.copy(name = name ?: link.name), pin)
                }
            }
        }
    }

    private fun pair(link: PairLink, pin: String) {
        step.value = Step.Busy
        error.value = null
        reach.value = null
        Hub.io.execute {
            val c = HubClient(link.hosts, link.port, pin, null, skip = Reach.skip(this), dns = DebugNet.dns(this))
            val body = JSONObject().put("code", link.code).put("name", DeviceName.of(this@PairActivity)).put("platform", "android").put("app", BuildConfig.VERSION_NAME)
            val r = runCatching { c.call("POST", "/api/phone/pair", body.toString()) }
            val o = r.getOrNull()?.let { runCatching { JSONObject(it.text) }.getOrNull() }
            // Why it did not answer, in plain words: Tailscale off or not on
            // this phone, else the Mac (never a host name: Reach).
            val why = if (r.isFailure) Reach.why(this, link.hosts, r.exceptionOrNull()) else null
            val err = when {
                why != null -> why.words
                r.getOrNull()?.status != 200 || o == null -> o.str("error") ?: "The Mac did not pair (${r.getOrNull()?.status})."
                o.optJSONObject("hub").str("pin").let { it != null && it != pin } -> "The Mac answered with another key. Not paired."
                else -> null
            }
            if (err != null) {
                runOnUiThread { error.value = err; reach.value = why?.takeIf { it.reason.startsWith("tailscale") }; scanned = false; step.value = if (why != null) Step.Confirm(link) else Step.Scan }
                return@execute
            }
            val hub = o!!.optJSONObject("hub") ?: JSONObject()
            val dev = o.optJSONObject("device") ?: JSONObject()
            val hosts = (listOf(c.host) + link.hosts).distinct()
            Store.get(this).save(Paired(
                hubName = hub.str("name") ?: link.name, hosts = hosts, port = hub.optInt("port", link.port), pin = pin,
                token = o.getString("token"), deviceId = dev.str("id", ""), deviceName = dev.str("name") ?: DeviceName.of(this@PairActivity), lastHost = c.host,
            ))
            Hub.reset()
            runOnUiThread {
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
        }
    }

    // ------------------------------------------------------------ the screen

    @Composable
    private fun Screen() {
        val tx = colorResource(R.color.tx); val tx2 = colorResource(R.color.tx2)
        Column(
            Modifier.fillMaxSize().background(colorResource(R.color.win)).statusBarsPadding().navigationBarsPadding().imePadding()
                .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)
        ) {
            Row(Modifier.padding(top = 22.dp, bottom = 30.dp), verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.logo), null, Modifier.size(24.dp))
                Spacer(Modifier.width(10.dp))
                Text(stringResource(R.string.app_name), color = tx, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
            // Android's Back goes one step up (the camera first); it leaves only from the camera.
            val up = when (val s = step.value) {
                is Step.Check -> Step.Typing(s.link.hosts.first(), s.link.code)
                is Step.Typing, is Step.Confirm -> Step.Scan
                else -> null
            }
            BackHandler(enabled = up != null) { error.value = null; reach.value = null; if (up != null) step.value = up }
            when (val s = step.value) {
                is Step.Scan, is Step.Busy -> ScanStep(s is Step.Busy)
                is Step.Typing -> TypingStep(s)
                is Step.Check -> CheckStep(s)
                is Step.Confirm -> ConfirmStep(s)
            }
            error.value?.let { Text(it, color = Color(0xFFFF6961), fontSize = 14.sp, modifier = Modifier.padding(top = 14.dp)) }
            reach.value?.let { w ->
                Spacer(Modifier.height(12.dp))
                Quiet(if (w.reason == "tailscale-off") stringResource(R.string.open_tailscale) else stringResource(R.string.get_tailscale)) { Reach.openTailscale(this@PairActivity) }
            }
            Spacer(Modifier.weight(1f).height(24.dp))
            Text(stringResource(R.string.pair_foot), color = tx2, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 20.dp))
        }
    }

    @Composable
    private fun Title(title: String, sub: String) {
        Text(title, color = colorResource(R.color.tx), fontSize = 26.sp, fontWeight = FontWeight.Bold, lineHeight = 32.sp)
        Text(sub, color = colorResource(R.color.tx2), fontSize = 15.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 8.dp, bottom = 22.dp))
    }

    @Composable
    private fun ScanStep(busy: Boolean) {
        val tx2 = colorResource(R.color.tx2); val blue = colorResource(R.color.work)
        val ctx = LocalContext.current
        LaunchedEffect(Unit) { if (!cameraOn.value && !cameraAsked) { cameraAsked = true; askCamera.launch(Manifest.permission.CAMERA) } }
        Title(stringResource(R.string.pair_title), stringResource(R.string.pair_sub))
        Box(Modifier.fillMaxWidth().height(356.dp).clip(RoundedCornerShape(20.dp)).background(Color(0xFF1E1E21)), contentAlignment = Alignment.Center) {
            if (cameraOn.value && !busy) Camera() else if (!busy) Text(stringResource(R.string.pair_no_camera), color = Color(0xFFA1A1A8), fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp))
            if (busy) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(color = Color.White)
                Text(stringResource(R.string.pairing), color = Color.White, modifier = Modifier.padding(top = 12.dp))
            }
            Corners()
            Row(
                Modifier.align(Alignment.BottomCenter).padding(bottom = 18.dp).clip(RoundedCornerShape(50)).background(Color(0xE6111113)).padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Canvas(Modifier.size(14.dp)) {
                    val w = size.width; val st = 1.6.dp.toPx()
                    listOf(Offset(0f, 0f), Offset(w * .58f, 0f), Offset(0f, w * .58f)).forEach { o ->
                        drawRect(Color.White, o, androidx.compose.ui.geometry.Size(w * .42f, w * .42f), style = androidx.compose.ui.graphics.drawscope.Stroke(st))
                    }
                    drawRect(Color.White, Offset(w * .66f, w * .66f), androidx.compose.ui.geometry.Size(w * .34f, w * .34f))
                }
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.pair_hold), color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(24.dp))
        Text(buildAnnotatedString {
            append(stringResource(R.string.pair_away)); append(" ")
            withStyle(SpanStyle(color = blue, fontWeight = FontWeight.SemiBold)) { append(stringResource(R.string.pair_tailscale)) }
        }, color = tx2, fontSize = 14.sp, lineHeight = 20.sp, modifier = Modifier.clickable {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://tailscale.com/download"))) }
        })
        // The typed code's screen: drawn as a mock first, then approved.
        if (!TYPED_CODE) return
        Spacer(Modifier.height(22.dp))
        Text(buildAnnotatedString {
            append(stringResource(R.string.pair_camera_q)); append(" ")
            withStyle(SpanStyle(color = blue, fontWeight = FontWeight.SemiBold)) { append(stringResource(R.string.pair_type)) }
        }, color = tx2, fontSize = 14.sp, modifier = Modifier.clickable(enabled = !busy) { error.value = null; step.value = Step.Typing() })
    }

    @Composable
    private fun Corners() {
        Canvas(Modifier.size(196.dp)) {
            val l = 34.dp.toPx(); val st = 4.dp.toPx(); val w = size.width; val h = size.height
            val c = Color.White
            fun corner(x: Float, y: Float, dx: Float, dy: Float) {
                drawLine(c, Offset(x, y), Offset(x + dx * l, y), st, StrokeCap.Round)
                drawLine(c, Offset(x, y), Offset(x, y + dy * l), st, StrokeCap.Round)
            }
            corner(0f, 0f, 1f, 1f); corner(w, 0f, -1f, 1f); corner(0f, h, 1f, -1f); corner(w, h, -1f, -1f)
        }
    }

    @Composable
    private fun Camera() {
        AndroidView(factory = { ctx ->
            val view = PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                val analyzer = ImageAnalysis.Builder()
                    .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                val reader = QRCodeReader()
                val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)
                analyzer.setAnalyzer(analysis) { img ->
                    try {
                        val plane = img.planes[0]
                        val buf = plane.buffer
                        val data = ByteArray(buf.remaining()).also { buf.get(it) }
                        val src = PlanarYUVLuminanceSource(data, plane.rowStride, img.height, 0, 0, img.width, img.height, false)
                        val text = runCatching { reader.decode(BinaryBitmap(HybridBinarizer(src)), hints).text }.getOrNull()
                        reader.reset()
                        if (text != null) onScanned(text)
                    } finally { img.close() }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analyzer)
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        }, modifier = Modifier.fillMaxSize())
    }

    @Composable
    private fun field(value: String, onChange: (String) -> Unit, label: String, type: KeyboardType, mono: Boolean) {
        OutlinedTextField(
            value, onChange, label = { Text(label) }, singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 17.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default, color = colorResource(R.color.tx)),
            keyboardOptions = KeyboardOptions(keyboardType = type, capitalization = if (mono) KeyboardCapitalization.Characters else KeyboardCapitalization.None, autoCorrectEnabled = false),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colorResource(R.color.work), unfocusedBorderColor = colorResource(R.color.tx3), focusedLabelColor = colorResource(R.color.work), unfocusedLabelColor = colorResource(R.color.tx2), cursorColor = colorResource(R.color.work)),
            modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
        )
    }

    @Composable
    private fun Big(text: String, enabled: Boolean = true, onClick: () -> Unit) {
        Button(onClick, enabled = enabled, shape = RoundedCornerShape(14.dp), colors = ButtonDefaults.buttonColors(containerColor = colorResource(R.color.work), contentColor = Color.White),
            modifier = Modifier.fillMaxWidth().height(54.dp)) { Text(text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) }
    }

    @Composable
    private fun Quiet(text: String, onClick: () -> Unit) {
        Button(onClick, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, colorResource(R.color.tx3).copy(alpha = .4f)),
            colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = colorResource(R.color.tx)),
            modifier = Modifier.fillMaxWidth().height(50.dp).padding(top = 6.dp)) { Text(text, fontSize = 16.sp) }
    }

    @Composable
    private fun TypingStep(s: Step.Typing) {
        Title(stringResource(R.string.pair_title), stringResource(R.string.pair_type_sub))
        field(s.address, { step.value = s.copy(address = it, error = null) }, stringResource(R.string.pair_address), KeyboardType.Uri, false)
        field(s.code, { step.value = s.copy(code = it, error = null) }, stringResource(R.string.pair_code), KeyboardType.Ascii, true)
        s.error?.let { Text(it, color = Color(0xFFFF6961), fontSize = 14.sp, modifier = Modifier.padding(bottom = 12.dp)) }
        reach.value?.let { w -> Quiet(if (w.reason == "tailscale-off") stringResource(R.string.open_tailscale) else stringResource(R.string.get_tailscale)) { Reach.openTailscale(this@PairActivity) } }
        Big(stringResource(R.string.pair_next)) {
            PairLink.typed(s.address, s.code).fold({ fetchKey(it) }, { step.value = s.copy(error = it.message) })
        }
        Quiet(stringResource(R.string.pair_back)) { step.value = Step.Scan }
    }

    @Composable
    private fun CheckStep(s: Step.Check) {
        Title(stringResource(R.string.pair_check_title), stringResource(R.string.pair_check_sub))
        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colorResource(R.color.card)).padding(vertical = 26.dp), contentAlignment = Alignment.Center) {
            Text(Pins.checkNumber(s.pin), color = colorResource(R.color.tx), fontSize = 30.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
        }
        Text(MacName.say(s.link.name) + ", " + s.link.hosts.first(), color = colorResource(R.color.tx2), fontSize = 14.sp, modifier = Modifier.padding(top = 10.dp, bottom = 24.dp))
        Big(stringResource(R.string.pair_match)) { pair(s.link, s.pin) }
        Quiet(stringResource(R.string.pair_back)) { step.value = Step.Typing(s.link.hosts.first(), s.link.code) }
    }

    @Composable
    private fun ConfirmStep(s: Step.Confirm) {
        // The computer by its name only: its addresses mean nothing to a person.
        Title(stringResource(R.string.pair_confirm, MacName.say(s.link.name)), stringResource(R.string.pair_confirm_sub))
        Big(stringResource(R.string.pair_button)) { pair(s.link, s.link.pin!!) }
        Quiet(stringResource(R.string.pair_back)) { step.value = Step.Scan }
    }

    companion object {
        const val SIGNED_OUT = "signedOut"
    }
}

/** "Type the code instead" and its screens (their mock is approved). */
private const val TYPED_CODE = true
