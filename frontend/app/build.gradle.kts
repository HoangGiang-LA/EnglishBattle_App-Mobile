import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
}
val mobileApiBaseUrl = providers.gradleProperty("mobileApiBaseUrl")
    .getOrElse("https://api.twgxeo.win/api").trimEnd('/')
val mobileApiUri = URI(mobileApiBaseUrl)
require(mobileApiUri.scheme == "https" && mobileApiUri.host != null &&
    mobileApiUri.userInfo == null && mobileApiUri.query == null && mobileApiUri.fragment == null) {
    "mobileApiBaseUrl must be an HTTPS API URL without credentials, query or fragment."
}
android {
    namespace = "com.englishbattle.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.englishbattle.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "MOBILE_API_BASE_URL", "\"${mobileApiUri.toASCIIString()}\"")
    }
    buildFeatures { compose = true; buildConfig = true }
    buildTypes {
        getByName("debug") {
            buildConfigField("boolean", "USE_FUNCTIONS_EMULATOR",
                providers.gradleProperty("useFunctionsEmulator")
                    .map { it.toBooleanStrict().toString() }.getOrElse("false"))
        }
        getByName("release") {
            buildConfigField("boolean", "USE_FUNCTIONS_EMULATOR", "false")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-analytics")
    implementation("com.google.firebase:firebase-auth")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("com.google.firebase:firebase-database")
    implementation("com.google.firebase:firebase-functions")
}
