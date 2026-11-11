package com.englishbattle.app

import android.app.Application
import com.englishbattle.app.data.*
import com.google.firebase.database.FirebaseDatabase

class EnglishBattleApplication : Application() {
    val container by lazy { AppContainer() }
    override fun onCreate() {
        super.onCreate()
        // Remove cached state from the retired offline trial after upgrading.
        deleteSharedPreferences("english_battle_session")
        deleteSharedPreferences("english_battle_demo_v2")
        deleteSharedPreferences("english_battle_settings_DEMO_demo-local")
        val pending = getSharedPreferences("english_battle_pending", MODE_PRIVATE)
        val legacyKeys = pending.all.keys.filter {
            it.matches(Regex("^(active|start-mode|start-topic|start|ticket|find-kind|find-code|find)-DEMO-demo-local(-.*)?$"))
        }
        if (legacyKeys.isNotEmpty()) pending.edit().also { editor -> legacyKeys.forEach(editor::remove) }.apply()
    }
}
class AppContainer {
    val auth: AuthRepository by lazy { FirebaseAuthRepository() }
    val clock = ServerClock()
    val catalog: CatalogRepository by lazy { FirebaseCatalogRepository(FirebaseDatabase.getInstance(
        "https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app")) }
    val game: GameRepository by lazy {
        FirebaseGameRepository(clock, apiBaseUrl =
            if (BuildConfig.USE_FUNCTIONS_EMULATOR) null else BuildConfig.MOBILE_API_BASE_URL)
    }
}
