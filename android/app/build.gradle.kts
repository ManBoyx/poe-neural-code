import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val eclipseVersion: String = providers.gradleProperty("eclipseVersion").get()

/** versionCode croissant dérivé de X.Y.Z[-beta.N] : X*1_000_000 + Y*10_000 + Z*100 + (N pour une bêta, 99 sinon). */
fun versionCodeOf(v: String): Int {
    val (core, pre) = v.split("-", limit = 2).let { it[0] to it.getOrNull(1) }
    val (x, y, z) = core.split(".").map { it.toInt() }
    val n = pre?.substringAfterLast(".")?.toIntOrNull() ?: 99
    return x * 1_000_000 + y * 10_000 + z * 100 + n.coerceIn(0, 99)
}

android {
    namespace = "io.github.manboyx.eclipse"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.manboyx.eclipse"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeOf(eclipseVersion)
        versionName = eclipseVersion
    }

    // Signature de publication : le keystore et ses mots de passe viennent des secrets GitHub Actions
    // (variables d'environnement), jamais du dépôt. Sans eux, la variante release n'est pas signée.
    signingConfigs {
        create("release") {
            val store = System.getenv("ANDROID_KEYSTORE_PATH")
            if (!store.isNullOrBlank()) {
                storeFile = file(store)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (!System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
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
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("org.connectbot:termlib:0.3.15")
    implementation("com.hierynomus:sshj:0.41.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.87")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.87")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814") // org.json réel (celui d'android.jar est vide en test JVM)
    testImplementation("org.apache.sshd:sshd-core:2.20.1") // vrai serveur SSH pour les tests de connexion
}
