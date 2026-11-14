package com.englishbattle.app.ui

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable fun NotificationSettingsEffects(model: NotificationSettingsViewModel, state: NotificationSettingsState) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val connection = remember(context) { connectionFlow(context) }
    val online by connection.collectAsStateWithLifecycle(initialValue = true)
    LaunchedEffect(online, model) { if (online) model.synchronizePreference() }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.onSystemUiResult() }
    val settings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { model.onSystemUiResult() }

    DisposableEffect(owner, model) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) model.onResume() }
        owner.lifecycle.addObserver(observer)
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) model.onResume()
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(state.action) {
        val action = model.consumeAction() ?: return@LaunchedEffect
        try {
            if (action == NotificationSettingsAction.RequestPermission && Build.VERSION.SDK_INT >= 33) {
                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                try { settings.launch(intent) }
                catch (_: ActivityNotFoundException) {
                    settings.launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${context.packageName}".toUri()))
                }
            }
        } catch (_: ActivityNotFoundException) { model.onLaunchFailed() }
        catch (_: SecurityException) { model.onLaunchFailed() }
    }
}

fun Context.canShowNotificationPermissionRationale(): Boolean {
    var current: Context = this
    while (current is ContextWrapper) {
        if (current is Activity) return Build.VERSION.SDK_INT >= 33 &&
            ActivityCompat.shouldShowRequestPermissionRationale(current, Manifest.permission.POST_NOTIFICATIONS)
        current = current.baseContext
    }
    return false
}

@Composable fun NotificationSetting(
    state: NotificationSettingsState,
    toggle: (Boolean) -> Unit,
    confirm: () -> Unit,
    dismiss: () -> Unit,
    openSettings: () -> Unit,
    retrySync: () -> Unit = {}
) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(Icons.Outlined.NotificationsNone, Muted, Canvas, 38.dp)
            Text("Thông báo", Modifier.weight(1f).padding(start = 12.dp), fontWeight = FontWeight.Bold)
            Switch(state.enabled, toggle, enabled = !state.busy && !state.syncing, modifier = Modifier.testTag("notification-switch"))
        }
        state.message?.let { Small(it) }
        if (state.syncing) Small("Đang đồng bộ cài đặt thông báo...")
        if (state.syncFailed) TextButton(retrySync) { Text("Thử đồng bộ lại") }
        TextButton(openSettings, enabled = !state.busy) { Text("Cài đặt thông báo Android") }
    }
    if (state.confirmEnable) AlertDialog(onDismissRequest = dismiss,
        title = { Text("Cho phép gửi thông báo?") },
        text = { Text(if (state.needsSystemSettings)
            "Bạn có muốn bật thông báo cho English Battle? Nếu Android không cho hỏi lại, hãy bật Cho phép thông báo trong Cài đặt Android."
        else "Bạn có muốn cho phép English Battle hiển thị thông báo trên thiết bị này?") },
        confirmButton = { TextButton(confirm) { Text("Đồng ý") } },
        dismissButton = { TextButton(dismiss) { Text("Không đồng ý") } })
}
