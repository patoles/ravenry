import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Nothing secret is committed. A release is signed only when a keystore is
// given (RAVENRY_ANDROID_KEYSTORE, its password and alias, from the
// environment or a gitignored local.properties: CI's way), or, on the Mac
// that holds it, with the testers' release key outside the repository:
// ~/.ravenry-release/ravenry-release.jks, its password in the login
// keychain (service "Ravenry Android release key", read with
// /usr/bin/security only when a release task runs). Without either a
// release build comes out unsigned and a debug build uses the SDK's debug
// key. docs/PUBLISHING.md says how the key was made and how to back it up.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(name: String, fallback: String = ""): String =
    (System.getenv(name) ?: localProps.getProperty(name) ?: fallback).trim()

val releaseKeyFile = File(System.getProperty("user.home"), ".ravenry-release/ravenry-release.jks")
val RELEASE_KEY_SERVICE = "Ravenry Android release key"
val wantsRelease = gradle.startParameter.taskNames.any { it.contains("Release") }
fun keychainPassword(service: String): String {
    val p = ProcessBuilder("/usr/bin/security", "find-generic-password", "-s", service, "-w")
        .redirectError(ProcessBuilder.Redirect.DISCARD).start()
    val out = p.inputStream.bufferedReader().readText().trim()
    if (p.waitFor() != 0 || out.isEmpty()) throw GradleException("No password in the login keychain for \"$service\" (docs/PUBLISHING.md)")
    return out
}

// The app's version, the Mac app's (apps/desktop/package.json), so the
// phone app and the Mac app of one release say the same number;
// RAVENRY_ANDROID_VERSION in its place for a test build. versionCode grows
// with it (major * 1000000 + minor * 1000 + patch: 0.1.47 is 1047), so a
// newer APK always installs over the one before.
val appVersion: String = System.getenv("RAVENRY_ANDROID_VERSION")?.trim()?.takeIf { it.isNotEmpty() }
    ?: Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(rootProject.file("../desktop/package.json").readText())!!.groupValues[1]
val appVersionCode: Int = run {
    val m = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)").find(appVersion) ?: throw GradleException("Not a version: $appVersion")
    val (a, b, c) = m.destructured.toList().map { it.toInt() }
    if (b > 999 || c > 999) throw GradleException("versionCode: minor and patch must stay under 1000 ($appVersion)")
    a * 1_000_000 + b * 1_000 + c
}

// The phone board (../phone, shared with iOS) is web code. It is built
// with Node into build/generated/phone-assets/phone, which the app serves
// at https://appassets.androidplatform.net/phone/. Without the builder (a
// checkout that has not got it yet) a placeholder page says so.
val phoneOut = layout.buildDirectory.dir("generated/phone-assets/phone")
val phoneBuilder = rootProject.file("../phone/build.mjs")
val buildPhoneBoard = tasks.register("buildPhoneBoard") {
    description = "Builds the phone board (apps/phone) into the app's assets."
    val out = phoneOut.get().asFile
    outputs.dir(out)
    outputs.upToDateWhen { false }
    doLast {
        out.deleteRecursively()
        out.mkdirs()
        // RAVENRY_PHONE_OPTIONAL=1: a board that does not build gives the
        // placeholder instead of failing (working on the shell alone).
        val optional = System.getenv("RAVENRY_PHONE_OPTIONAL") == "1"
        var built = false
        if (phoneBuilder.exists()) {
            val node = System.getenv("NODE") ?: "node"
            val p = ProcessBuilder(node, phoneBuilder.absolutePath, "--out", out.absolutePath)
                .directory(rootProject.file("../.."))
                .redirectErrorStream(true)
                .start()
            val log = p.inputStream.bufferedReader().readText()
            if (p.waitFor() == 0) {
                built = true
                if (log.isNotBlank()) println(log.trim())
            } else if (!optional) {
                throw GradleException("The phone board did not build:\n$log")
            } else {
                println("The phone board did not build; using the placeholder.")
            }
        }
        if (!built) {
            out.resolve("index.html").writeText(
                "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">" +
                    "<title>Ravenry</title><body style=\"font:16px sans-serif;padding:24px\">" +
                    "<p>The phone board is not built into this app yet (apps/phone/build.mjs is missing).</p>"
            )
        }
    }
}

android {
    namespace = "dev.ravenry.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.ravenry.app"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/phone-assets"))
    }

    signingConfigs {
        create("release") {
            // v2 for every Android the app runs on, v3 so the key can be rotated later.
            enableV2Signing = true
            enableV3Signing = true
            val store = secret("RAVENRY_ANDROID_KEYSTORE")
            if (store.isNotEmpty() && file(store).exists()) {
                storeFile = file(store)
                storePassword = secret("RAVENRY_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = secret("RAVENRY_ANDROID_KEY_ALIAS", "ravenry")
                keyPassword = secret("RAVENRY_ANDROID_KEY_PASSWORD")
            } else if (wantsRelease && releaseKeyFile.isFile) {
                // The testers' key (PKCS12: one password for the store and the key).
                val pw = keychainPassword(RELEASE_KEY_SERVICE)
                storeFile = releaseKeyFile
                storePassword = pw
                keyAlias = "ravenry-release"
                keyPassword = pw
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val release = signingConfigs.getByName("release")
            signingConfig = if (release.storeFile != null) release else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    lint {
        abortOnError = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") { dependsOn(buildPhoneBoard) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.exifinterface)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.okhttp)
    implementation(libs.zxing.core)
    implementation(libs.unifiedpush.connector)

    testImplementation(libs.junit)
    testImplementation(libs.json)
    testImplementation(libs.tink)
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.okhttp.tls)
}
