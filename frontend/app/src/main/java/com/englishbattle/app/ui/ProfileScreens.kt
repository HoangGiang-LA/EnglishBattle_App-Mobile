package com.englishbattle.app.ui

import android.content.Context
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.*
import com.englishbattle.app.R
import com.englishbattle.app.data.*

@Composable fun ProfileScreen(user: UserIdentity, dashboard: LoadState<Dashboard>, busy: Boolean,
    go: (Route) -> Unit, save: (String) -> Unit, retry: () -> Unit) {
    var edit by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable(user.name) { mutableStateOf(user.name) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Art(R.drawable.figma_09, Modifier.size(70.dp).clip(CircleShape))
            Column(Modifier.weight(1f)) { Text(user.name, style = MaterialTheme.typography.headlineMedium); Small("Hồ sơ của tôi") }
        }
        if (dashboard.loading && dashboard.data == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        dashboard.error?.let { ErrorPanel(it, retry) }
        Panel { Stats(listOf((dashboard.data?.rating?.toString() ?: "—") to "Rating", (dashboard.data?.wins?.toString() ?: "—") to "Wins", (dashboard.data?.losses?.toString() ?: "—") to "Losses")) }
        Secondary("Chỉnh sửa hồ sơ") { if (!busy) edit = true }
        Title("Thông tin cá nhân")
        Panel {
            ProfileInfo(Icons.Outlined.PersonOutline, "Tên hiển thị", user.name)
            HorizontalDivider(color = Line)
            ProfileInfo(Icons.Outlined.Email, "Địa chỉ email", user.email)
            HorizontalDivider(color = Line)
            ProfileInfo(Icons.Outlined.CalendarMonth, "Ngày tham gia", dateLabel(user.joinedAt).substringBefore(' '))
        }
        MenuRow("Tiến độ của tôi", "Theo dõi hành trình học tập", Icons.Outlined.BarChart) { go(Route.Progress) }
        MenuRow("Thành tích", dashboard.data?.let { "${it.achievements.count { a -> a.unlocked }} huy hiệu đã mở khóa" }, Icons.Outlined.EmojiEvents) { go(Route.Achievements) }
        MenuRow("Thông báo", dashboard.data?.let { "${it.unreadNotificationCount} thông báo chưa đọc" }, Icons.Outlined.NotificationsNone) { go(Route.Notifications) }
        MenuRow("Cài đặt", icon = Icons.Outlined.Settings) { go(Route.Settings) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            TextButton({ go(Route.Wallet) }) { Text("Ví xu") }
            TextButton({ go(Route.LearningHistory) }) { Text("Lịch sử học tập") }
        }
    }
    if (edit) AlertDialog(onDismissRequest = { edit = false }, title = { Text("Chỉnh sửa hồ sơ") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuthField(name, { name = it }, "Tên hiển thị", Icons.Outlined.PersonOutline)
            Small("Email đăng nhập được thay đổi riêng trong Cài đặt.")
        }
    }, confirmButton = { TextButton({ save(name.trim()); edit = false }, enabled = name.trim().length in 2..50 && !busy) { Text("Lưu") } },
        dismissButton = { TextButton({ edit = false }) { Text("Hủy") } })
}
@Composable private fun ProfileInfo(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconTile(icon, Purple, Lavender, 38.dp)
        Column { Small(label); Text(value, fontSize = 14.sp) }
    }
}
@Composable fun NotificationsScreen(state: LoadState<Dashboard>, back: () -> Unit, retry: () -> Unit,
    markRead: (List<String>) -> Unit, open: (String) -> Unit) {
    val d = state.data
    val page = d?.let { NotificationPage(it.notifications, it.unreadNotificationCount, it.notifications.size) }
    NotificationsFeedScreen(LoadState(page, state.loading, state.error), back, retry, markRead,
        { markRead(d?.notifications?.filter { !it.read }?.map { it.id }.orEmpty()) }, {}, open)
}

@Composable fun NotificationsFeedScreen(state: LoadState<NotificationPage>, back: () -> Unit, retry: () -> Unit,
    markRead: (List<String>) -> Unit, markAll: () -> Unit, more: () -> Unit, open: (String) -> Unit) {
    Screen("Thông báo", back) {
        DataContent(state, retry) { d ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Cập nhật của bạn", fontWeight = FontWeight.Bold)
                TextButton(markAll, enabled = d.unreadCount > 0 && !state.loading) { Pill("${d.unreadCount} chưa đọc") }
            }
            if (d.entries.isEmpty()) EmptyPanel("Bạn chưa có thông báo.")
            d.entries.forEach { n ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(if (!n.read) Blue.copy(alpha = .3f) else Color.Transparent)
                    .clickable { if (!n.read) markRead(listOf(n.id)); open(n.destination) }.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    val achievement = n.destination == "Achievements"
                    IconTile(if (achievement) Icons.Outlined.EmojiEvents else Icons.Outlined.NotificationsNone,
                        if (achievement) Color(0xFFB89A3F) else Purple, if (achievement) Yellow else Lavender, 38.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(n.title, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Small(n.body)
                        Small(dateLabel(n.createdAt))
                    }
                }
                HorizontalDivider(color = Line)
            }
            if (d.nextCursor != null) Primary("Xem thêm thông báo", enabled = !state.loading, onClick = more)
        }
    }
}
@Composable fun SettingsScreen(user: UserIdentity, preferenceKey: String, busy: Boolean,
    back: () -> Unit, logout: () -> Unit, changeEmail: (String, String) -> Unit,
    notificationState: NotificationSettingsState, toggleNotifications: (Boolean) -> Unit,
    confirmNotifications: () -> Unit, dismissNotifications: () -> Unit, openNotificationSettings: () -> Unit,
    retryNotificationSync: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember(preferenceKey) { context.getSharedPreferences(preferenceKey, Context.MODE_PRIVATE) }
    var sound by rememberSaveable(preferenceKey) { mutableFloatStateOf(prefs.getFloat("sound", .7f)) }
    var logoutDialog by rememberSaveable { mutableStateOf(false) }
    var emailDialog by rememberSaveable { mutableStateOf(false) }
    var newEmail by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var emailError by rememberSaveable { mutableStateOf<String?>(null) }
    var soundDialog by rememberSaveable { mutableStateOf(false) }
    var info by rememberSaveable { mutableStateOf<String?>(null) }
    Screen("Cài đặt", back) {
        Panel {
            SettingRow("Âm thanh", Icons.Outlined.VolumeUp) { soundDialog = true }
            NotificationSetting(notificationState, toggleNotifications, confirmNotifications, dismissNotifications,
                openNotificationSettings, retryNotificationSync)
            SettingRow("Ngôn ngữ", Icons.Outlined.Translate) { info = "Ngôn ngữ hiện tại: Tiếng Việt. Nội dung bài học: Tiếng Anh." }
            SettingRow("Giao diện", Icons.Outlined.Palette) { info = "Giao diện sáng theo thiết kế English Battle của bạn. Kích thước chữ theo cài đặt Android." }
            SettingRow("Về ứng dụng", Icons.Outlined.Info) { info = "English Battle 1.0.0\nHọc tiếng Anh mỗi ngày.\n\nTài khoản được xác thực bằng Firebase. Kết quả, rating và xu do dịch vụ xác nhận." }
            SettingRow("Chính sách bảo mật", Icons.Outlined.Shield) { info = "App không lưu mật khẩu trong dữ liệu ứng dụng. Tùy chọn âm thanh/thông báo được lưu riêng theo tài khoản. Thông báo trong app cần quyền đọc theo tài khoản; dịch vụ thông báo đẩy chưa được kích hoạt." }
        }
        TextButton({ emailDialog = true }, Modifier.fillMaxWidth(), enabled = !busy) { Text("Đổi email đăng nhập") }
        Spacer(Modifier.height(110.dp))
        TextButton({ logoutDialog = true }, Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Color.White), enabled = !busy) {
            Icon(Icons.Outlined.Logout, null, tint = Color(0xFFCA7788)); Spacer(Modifier.width(12.dp)); Text("Đăng xuất", color = Color(0xFFCA7788))
        }
    }
    if (soundDialog) AlertDialog(onDismissRequest = { soundDialog = false }, title = { Text("Âm thanh") }, text = {
        Column { Text("Âm lượng bài nghe: ${(sound * 100).toInt()}%"); Slider(sound, { sound = it; prefs.edit().putFloat("sound", it).apply() }) }
    }, confirmButton = { TextButton({ soundDialog = false }) { Text("Xong") } })
    info?.let { text -> AlertDialog(onDismissRequest = { info = null }, title = { Text("English Battle") }, text = { Text(text) },
        confirmButton = { TextButton({ info = null }) { Text("Đã hiểu") } }) }
    if (logoutDialog) AlertDialog(onDismissRequest = { logoutDialog = false }, title = { Text("Đăng xuất?") },
        text = { Text("Nếu có bài hoặc trận đang dở, đồng hồ vẫn tiếp tục chạy. Đăng xuất không hủy phiên và không làm mới lượt thử thách.") },
        confirmButton = { TextButton({ logoutDialog = false; logout() }, enabled = !busy) { Text("Đăng xuất") } }, dismissButton = { TextButton({ logoutDialog = false }) { Text("Hủy") } })
    if (emailDialog) AlertDialog(onDismissRequest = { password = ""; emailDialog = false }, title = { Text("Đổi email đăng nhập") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuthField(newEmail, { newEmail = it; emailError = null }, "Email mới", Icons.Outlined.Email)
            AuthField(password, { password = it }, "Mật khẩu hiện tại", Icons.Outlined.Lock, true)
            Small("Bạn sẽ nhận liên kết xác nhận tại email mới.")
            emailError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton({
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(newEmail.trim()).matches() || newEmail.trim() == user.email || password.isBlank()) emailError = "Nhập email mới hợp lệ và mật khẩu hiện tại."
        else { changeEmail(newEmail, password); password = ""; emailDialog = false }
    }, enabled = !busy) { Text("Gửi xác nhận") } }, dismissButton = { TextButton({ password = ""; emailDialog = false }) { Text("Hủy") } })
}



@Composable private fun SettingRow(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = click).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconTile(icon, Muted, Canvas, 38.dp); Text(title, Modifier.weight(1f), fontWeight = FontWeight.Bold); Text("›", color = Muted, fontSize = 22.sp)
    }
}
