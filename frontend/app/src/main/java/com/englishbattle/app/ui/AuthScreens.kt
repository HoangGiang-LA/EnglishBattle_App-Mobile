package com.englishbattle.app.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.*
import com.englishbattle.app.R
import com.englishbattle.app.data.PasswordPolicy

@Composable fun SplashScreen(start: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFFB8E3F9), Color(0xFFF2FBFF))))) {
        val screenHeight = maxHeight
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            fun cloud(x: Float, y: Float, r: Float) {
                drawCircle(Color.White.copy(alpha = .55f), r, androidx.compose.ui.geometry.Offset(x, y))
                drawCircle(Color.White.copy(alpha = .55f), r * .75f, androidx.compose.ui.geometry.Offset(x + r, y + r * .3f))
                drawCircle(Color.White.copy(alpha = .55f), r * .7f, androidx.compose.ui.geometry.Offset(x - r, y + r * .3f))
            }
            cloud(size.width * .9f, size.height * .12f, 25.dp.toPx())
            cloud(size.width * .05f, size.height * .46f, 20.dp.toPx())
            cloud(size.width * .93f, size.height * .65f, 24.dp.toPx())
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height((screenHeight * .12f).coerceAtMost(90.dp)))
            Art(R.drawable.brand_logo, Modifier.fillMaxWidth(.82f).height(180.dp), "English Battle. Learn, Challenge, Improve.")
            Spacer(Modifier.height((screenHeight * .1f).coerceAtMost(80.dp)))
            Art(R.drawable.splash_friends, Modifier.fillMaxWidth().height(210.dp))
            Spacer(Modifier.height(16.dp))
            Primary("Bắt đầu  ›", Modifier.widthIn(max = 290.dp), onClick = start)
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable fun AuthField(value: String, change: (String) -> Unit, placeholder: String, icon: ImageVector,
    password: Boolean = false, enabled: Boolean = true, supportingText: String? = null, isError: Boolean = false) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(value, change, Modifier.fillMaxWidth(), enabled = enabled,
        placeholder = { Text(placeholder, color = Muted, fontSize = 14.sp) }, singleLine = true,
        isError = isError,
        supportingText = supportingText?.let { message -> {
            Text(message, color = if (isError) MaterialTheme.colorScheme.error else Muted)
        } },
        leadingIcon = { Icon(icon, null, Modifier.size(20.dp), tint = Muted) },
        trailingIcon = if (password) { { IconButton({ visible = !visible }) {
            Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                if (visible) "Ẩn mật khẩu" else "Hiện mật khẩu", tint = Muted)
        } } } else null,
        visualTransformation = if (password && !visible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else if (placeholder.contains("Email", true)) KeyboardType.Email else KeyboardType.Text),
        shape = RoundedCornerShape(14.dp), colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Line,
            unfocusedContainerColor = Color(0xFFF6F5F9), focusedContainerColor = Color.White))
}

@Composable fun AuthScreen(route: Route, state: AuthState, go: (Route) -> Unit, back: () -> Unit,
    submit: (Boolean, String, String, String) -> Unit, reset: (String) -> Unit, dismiss: () -> Unit,
    signInWithGoogle: () -> Unit = {}) {
    var name by rememberSaveable(route) { mutableStateOf("") }
    var email by rememberSaveable(route) { mutableStateOf("") }
    // Passwords are never placed in saved-instance state or preferences.
    var password by remember(route) { mutableStateOf("") }
    var confirm by remember(route) { mutableStateOf("") }
    var error by rememberSaveable(route) { mutableStateOf<String?>(null) }
    var attempted by remember(route) { mutableStateOf(false) }
    val login = route == Route.Login
    val forgot = route == Route.Forgot
    val register = route == Route.Register
    val passwordInvalid = register && (password.isNotEmpty() || attempted) && !PasswordPolicy.isValid(password)
    val passwordHint = if (register && (password.isEmpty() || passwordInvalid)) PasswordPolicy.MESSAGE else null
    Column(Modifier.fillMaxSize().background(Color.White).verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        if (!login) TopBar("", { if (!state.busy) { dismiss(); back() } })
        if (login) {
            Spacer(Modifier.height(24.dp))
            MascotFace(false, Modifier.size(146.dp).padding(8.dp))
            Text("Welcome Back!", style = MaterialTheme.typography.headlineLarge)
            Small("Học tiếng Anh mỗi ngày")
            Spacer(Modifier.height(48.dp))
        } else {
            Spacer(Modifier.height(if (forgot) 100.dp else 20.dp))
            Text(if (forgot) "Quên mật khẩu?" else "Tạo tài khoản", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineLarge)
            Small(if (forgot) "Nhập email của bạn để nhận liên kết đặt\nlại mật khẩu" else "Tham gia cộng đồng học tập!", Modifier.fillMaxWidth())
            Spacer(Modifier.height(32.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!login && !forgot) AuthField(name, { name = it }, "Tên hiển thị", Icons.Outlined.PersonOutline, enabled = !state.busy)
        AuthField(email, { email = it; error = null; dismiss() }, "Email", Icons.Outlined.Email, enabled = !state.busy)
        if (!forgot) AuthField(password, { password = it; error = null; dismiss() }, "Mật khẩu", Icons.Outlined.Lock,
            true, !state.busy, supportingText = passwordHint, isError = passwordInvalid)
        if (!login && !forgot) AuthField(confirm, { confirm = it }, "Nhập lại mật khẩu", Icons.Outlined.Lock, true, !state.busy)
        }
        if (login) TextButton({ dismiss(); go(Route.Forgot) }, Modifier.align(Alignment.End), enabled = !state.busy) { Text("Quên mật khẩu?") }
        (error ?: state.error)?.takeUnless { register && passwordHint == it }?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        state.message?.let { Panel(color = Mint) { Text(it) } }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        Spacer(Modifier.height(if (login || forgot) 16.dp else 56.dp))
        Primary(if (state.busy) "Đang xử lý..." else if (forgot) "Gửi liên kết" else if (login) "Đăng nhập" else "Đăng ký", enabled = !state.busy) {
            attempted = true
            error = when {
                !android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches() -> "Vui lòng nhập email hợp lệ."
                register && !PasswordPolicy.isValid(password) -> PasswordPolicy.MESSAGE
                login && password.length < 6 -> "Mật khẩu cần ít nhất 6 ký tự."
                !login && !forgot && name.trim().length !in 2..50 -> "Tên hiển thị cần từ 2 đến 50 ký tự."
                !login && !forgot && password != confirm -> "Mật khẩu nhập lại chưa khớp."
                else -> null
            }
            if (error == null) { if (forgot) reset(email) else submit(!login, name, email, password) }
        }
        if (login) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton({ error = null; dismiss(); signInWithGoogle() }, Modifier.fillMaxWidth().heightIn(min = 50.dp), enabled = !state.busy,
                shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Line)) {
                Image(painterResource(R.drawable.google_g), contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(12.dp)); Text("Đăng nhập với Google", color = Ink)
            }
        }
        Spacer(Modifier.height(if (forgot) 120.dp else 32.dp))
        TextButton({ dismiss(); if (login) go(Route.Register) else back() }, enabled = !state.busy) {
            Text(if (login) "Chưa có tài khoản? Đăng ký" else "Quay lại Đăng nhập")
        }
    }
}
