package com.englishbattle.app.data

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

data class NotificationPermissionStatus(
    val runtimePermissionRequired: Boolean,
    val runtimePermissionGranted: Boolean,
    val systemNotificationsEnabled: Boolean
) {
    val canPost: Boolean get() = runtimePermissionGranted && systemNotificationsEnabled
}

interface NotificationSettingsRepository {
    var enabled: Boolean
    var permissionRequested: Boolean
    var lastNotificationAt: Long
    fun permissionStatus(): NotificationPermissionStatus
    fun cancelNotifications()
    val needsSynchronization: Boolean get() = false
    suspend fun synchronizePreference() {}
}

class AndroidNotificationSettingsRepository(context: Context, preferenceKey: String,
    private val updateRemote: suspend (Boolean) -> Unit) : NotificationSettingsRepository {
    private val app = context.applicationContext
    private val preferences = app.getSharedPreferences(preferenceKey, Context.MODE_PRIVATE)
    // Android grants permission to the installation, rather than to an individual account.
    private val devicePreferences = app.getSharedPreferences("english_battle_notification_permission", Context.MODE_PRIVATE)
    private val manager = app.getSystemService(NotificationManager::class.java)

    override var enabled: Boolean
        get() = preferences.getBoolean("notifications", false)
        set(value) {
            if (value != enabled || !preferences.contains("notification-server-synced"))
                preferences.edit().putBoolean("notifications", value).putBoolean("notification-server-synced", false).apply()
        }
    override val needsSynchronization: Boolean get() = !preferences.getBoolean("notification-server-synced", false)
    override suspend fun synchronizePreference() {
        val requested = enabled
        updateRemote(requested)
        if (requested == enabled) preferences.edit().putBoolean("notification-server-synced", true).apply()
    }
    override var permissionRequested: Boolean
        get() = devicePreferences.getBoolean("requested", false)
        set(value) { devicePreferences.edit().putBoolean("requested", value).apply() }
    override var lastNotificationAt: Long
        get() = preferences.getLong("last-notification", 0)
        set(value) { preferences.edit().putLong("last-notification", value).apply() }

    override fun permissionStatus(): NotificationPermissionStatus {
        val runtimeRequired = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        return NotificationPermissionStatus(runtimeRequired,
            !runtimeRequired || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
            manager.areNotificationsEnabled())
    }

    override fun cancelNotifications() { manager.cancelAll() }
}
