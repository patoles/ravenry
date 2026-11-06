import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Nothing secret is committed. A release is signed only when a keystore is
// given (RAVENRY_ANDROID_KEYSTORE, its password and alias, from the
// environment or a gitignored local.properties); without one a release
// build comes out unsigned and a debug build uses the SDK's debug key.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun secret(name: String, fallback: String = ""): String =
    (System.getenv(name) ?: localProps.getProperty(name) ?: fallback).trim()

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
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/phone-assets"))
    }

    signingConfigs {
        create("release") {
            val store = secret("RAVENRY_ANDROID_KEYSTORE")
            if (store.isNotEmpty() && file(store).exists()) {
                storeFile = file(store)
                storePassword = secret("RAVENRY_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = secret("RAVENRY_ANDROID_KEY_ALIAS", "ravenry")
                keyPassword = secret("RAVENRY_ANDROID_KEY_PASSWORD")
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
