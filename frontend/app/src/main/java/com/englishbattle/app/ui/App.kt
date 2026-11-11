package com.englishbattle.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.englishbattle.app.data.*

enum class Route { Splash, Login, Register, Forgot, Home, Challenge, Practice, Vocabulary, Grammar,
    Listening, Reading, Quiz, PracticeResult, Battle, Matching, BattleQuiz, BattleResult, History,
    Leaderboard, Progress, Profile, Achievements, Notifications, Settings, Review, Test, PracticeIntro, PrivateRoom, Wallet, LearningHistory }

@Composable fun EnglishBattleApp(initial: String = "Splash",
    auth: AuthViewModel = viewModel(), catalog: CatalogViewModel = viewModel(),
    userData: UserDataViewModel = viewModel(), play: PlayViewModel = viewModel(),
    access: AccountAccessViewModel = viewModel(), reporting: ReportingViewModel = viewModel()) {
    val authState by auth.state.collectAsStateWithLifecycle()
    val accessState by access.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val onlineFlow = remember(context) { connectionFlow(context) }
    val online by onlineFlow.collectAsStateWithLifecycle(initialValue = true)
    val identity = authState.user
    val sessionKey = identity?.let { "FIREBASE-${it.uid}" }
    val ready = sessionKey != null && accessState.key == sessionKey && accessState.ready
    LaunchedEffect(sessionKey) {
        if (identity != null) access.connect(identity.uid) else access.clear()
    }
    LaunchedEffect(sessionKey, ready) {
        if (identity != null && ready) {
            catalog.connect(); userData.connect(); play.connect(identity.uid); reporting.connect()
        } else { catalog.clear(); userData.clear(); play.clear(); reporting.clear() }
    }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(online, ready) { if (online && ready) auth.refreshProfile() }
    DisposableEffect(owner, sessionKey, ready) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) play.setForeground(false)
            if (event == Lifecycle.Event.ON_START) {
                play.setForeground(true)
                if (ready) { auth.refreshProfile(); userData.refresh() }
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    Box(Modifier.fillMaxSize().background(Canvas).safeDrawingPadding().imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 600.dp).fillMaxSize()) {
            if (!online) Text("Thiết bị đang mất kết nối mạng.", Modifier.fillMaxWidth().background(Rose).padding(10.dp), color = MaterialTheme.colorScheme.error)
            if (authState.initializing) LoadingPanel("Đang khôi phục phiên đăng nhập...")
            else if (identity == null) {
                var route by rememberSaveable { mutableStateOf(if (initial in listOf("Login", "Register", "Forgot")) Route.valueOf(initial) else Route.Splash) }
                BackHandler(route !in listOf(Route.Splash, Route.Login)) { if (!authState.busy) { auth.dismiss(); route = Route.Login } }
                if (route == Route.Splash) SplashScreen { route = Route.Login }
                else AuthScreen(route, authState, { auth.dismiss(); route = it }, { route = Route.Login },
                    auth::submit, auth::reset, auth::dismiss, { auth.signInWithGoogle(context) })
            } else if (!ready) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    val error = accessState.error?.takeIf { accessState.key == sessionKey }
                    if (error == null) LoadingPanel("Đang khởi tạo tài khoản...")
                    else ErrorPanel(error, access::retry)
                    Secondary("Đăng xuất", onClick = auth::signOut)
                }
            } else key(sessionKey) {
                SignedInApp(identity, authState, initial, catalog, userData, play, auth, reporting)
            }
        }
    }
}

@Composable private fun SignedInApp(user: UserIdentity, authState: AuthState, initial: String,
    catalogVM: CatalogViewModel, dataVM: UserDataViewModel, play: PlayViewModel, authVM: AuthViewModel, reporting: ReportingViewModel) {
    val catalog by catalogVM.state.collectAsStateWithLifecycle()
    val dashboard by dataVM.dashboard.collectAsStateWithLifecycle()
    val board by dataVM.board.collectAsStateWithLifecycle()
    val notifications by dataVM.notifications.collectAsStateWithLifecycle()
    val statistics by reporting.statistics.collectAsStateWithLifecycle()
    val history by reporting.history.collectAsStateWithLifecycle()
    val ledger by reporting.ledger.collectAsStateWithLifecycle()
    val message by dataVM.message.collectAsStateWithLifecycle()
    val attempt by play.attempt.collectAsStateWithLifecycle()
    val ticket by play.ticket.collectAsStateWithLifecycle()
    val result by play.result.collectAsStateWithLifecycle()
    val busy by play.busy.collectAsStateWithLifecycle()
    val playError by play.error.collectAsStateWithLifecycle()
    val first = runCatching { Route.valueOf(initial) }.getOrDefault(Route.Home).takeUnless { it in listOf(Route.Splash, Route.Login, Route.Register, Route.Forgot) } ?: Route.Home
    var stack by rememberSaveable { mutableStateOf(listOf(first.name)) }
    val route = Route.valueOf(stack.last())
    var categoryId by rememberSaveable { mutableStateOf("vocabulary") }
    var topicId by rememberSaveable { mutableStateOf("") }
    var resultId by rememberSaveable { mutableStateOf<String?>(null) }
    var cancelRequested by rememberSaveable { mutableStateOf(false) }
    var enterRequested by rememberSaveable { mutableStateOf(false) }
    val preferenceKey = "english_battle_settings_FIREBASE_${user.uid}"
    val context = LocalContext.current
    val notificationPrefs = remember(preferenceKey) { context.getSharedPreferences(preferenceKey, android.content.Context.MODE_PRIVATE) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(dashboard.data?.notifications) {
        val latest = dashboard.data?.notifications?.filter { !it.read }?.maxByOrNull { it.createdAt }
        if (latest != null && latest.createdAt > notificationPrefs.getLong("last-notification", 0)) {
            notificationPrefs.edit().putLong("last-notification", latest.createdAt).apply()
            if (notificationPrefs.getBoolean("notifications", true)) snackbar.showSnackbar(latest.title)
        }
    }
    fun go(to: Route) { stack = stack + to.name }
    fun root(to: Route) { stack = listOf(to.name) }
    fun back() { if (stack.size > 1) stack = stack.dropLast(1) else root(Route.Home) }
    fun start(mode: QuizMode, topic: String? = null) { play.start(mode, topic); go(if (mode == QuizMode.BATTLE) Route.BattleQuiz else Route.Quiz) }
    fun resume(id: String? = play.activeId) { play.resume(id); go(if (attempt.data?.mode == QuizMode.BATTLE) Route.BattleQuiz else Route.Quiz) }
    fun find(kind: String, code: String? = null) { cancelRequested = false; enterRequested = false; play.find(kind, code); go(Route.Matching) }
    BackHandler(route != Route.Home) { back() }
    LaunchedEffect(attempt.data?.result?.attemptId, route, busy) {
        val r = attempt.data?.result
        if (r != null && !busy && playError == null && route in listOf(Route.Quiz, Route.BattleQuiz)) {
            resultId = r.attemptId
            root(if (r.mode == QuizMode.BATTLE) Route.BattleResult else Route.PracticeResult)
            dataVM.refresh(); dataVM.loadBoard(dataVM.period)
        }
    }
    LaunchedEffect(route, ticket.data, busy, cancelRequested) {
        if (route == Route.Matching && cancelRequested && !busy && ticket.data == null && playError == null) {
            cancelRequested = false
            if (attempt.data?.mode == QuizMode.BATTLE) go(Route.BattleQuiz) else root(Route.Battle)
            dataVM.refresh()
        }
        if (route == Route.Matching && enterRequested && attempt.data != null && ticket.data == null && !busy && !cancelRequested && attempt.data?.mode == QuizMode.BATTLE) { enterRequested = false; go(Route.BattleQuiz) }
    }
    LaunchedEffect(route) {
        if (route == Route.Leaderboard) dataVM.loadBoard(dataVM.period)
        if (route == Route.Notifications) dataVM.loadNotifications()
        if (route == Route.Progress) reporting.loadStatistics()
        if (route == Route.History || route == Route.LearningHistory) reporting.loadHistory(if (route == Route.History) "battle" else "learning")
        if (route == Route.Wallet) reporting.loadLedger()
        if (route == Route.Matching && ticket.data == null && play.hasPendingMatch && !busy) play.retryMatch()
        if (route in listOf(Route.Profile, Route.History, Route.LearningHistory, Route.Challenge, Route.Progress, Route.Wallet, Route.Notifications, Route.Achievements)) dataVM.refresh()
        if (route in listOf(Route.PracticeResult, Route.BattleResult, Route.Review) && result.data == null && !result.loading) resultId?.let(play::viewResult)
    }
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (route) {
                Route.Home -> HomeScreen(user.name, dashboard, attempt.data, play.activeId != null || play.hasPendingStart,
                    play.hasPendingMatch || ticket.data != null || ticket.loading, ::go, { resume() }, dataVM::refresh)
                Route.Practice -> PracticeScreen(catalog, ::back, catalogVM::retry) { chosen ->
                    categoryId = chosen.id
                    go(when (chosen.id) { "grammar" -> Route.Grammar; "listening" -> Route.Listening; "reading" -> Route.Reading; else -> Route.Vocabulary })
                }
                Route.Vocabulary, Route.Grammar, Route.Listening, Route.Reading -> {
                    val id = when (route) { Route.Grammar -> "grammar"; Route.Listening -> "listening"; Route.Reading -> "reading"; else -> categoryId }
                    TopicsScreen(id, catalog, dashboard.data, ::back, catalogVM::retry) { topic -> topicId = topic.id; go(Route.PracticeIntro) }
                }
                Route.PracticeIntro -> AttemptIntroScreen(QuizMode.PRACTICE, catalog.data?.topics?.find { it.id == topicId }, dashboard, busy,
                    ::back, dataVM::refresh, { start(QuizMode.PRACTICE, topicId) }, { resume(it) })
                Route.Test -> AttemptIntroScreen(QuizMode.TEST, null, dashboard, busy, ::back, dataVM::refresh, { start(QuizMode.TEST) }, { resume(it) })
                Route.Challenge -> AttemptIntroScreen(QuizMode.DAILY, null, dashboard, busy, ::back, dataVM::refresh, { start(QuizMode.DAILY) }, { resume(it) })
                Route.Quiz, Route.BattleQuiz -> QuizScreen(attempt, busy, playError, preferenceKey, play::now, ::back, play::submit, play::advance, play::leave, { play.resume() },
                    catalog.data?.topics?.find { it.id == attempt.data?.current?.topicId }?.title.orEmpty(), play::saveSelection)
                Route.PracticeResult, Route.BattleResult -> ResultScreen(result, { root(Route.Home) }, { go(Route.Review) }, {
                    if (result.data?.mode == QuizMode.BATTLE) { root(Route.Battle); find("quick") } else root(Route.Practice)
                }, dashboard.data?.skills.orEmpty())
                Route.Review -> ReviewScreen(result.data, ::back)
                Route.Battle -> BattleScreen(dashboard, busy, ::back, { find(it) }, { go(Route.History) }, { go(Route.PrivateRoom) })
                Route.PrivateRoom -> PrivateRoomScreen(busy, ::back, { find("create") }, { find("join", it) })
                Route.Matching -> MatchingScreen(ticket, busy, playError,
                    { cancelRequested = true; play.cancelMatch() }, { enterRequested = true; play.enterMatch() }, play::retryMatch, { root(Route.Battle) })
                Route.History, Route.LearningHistory -> HistoryScreen(history, ::back, { reporting.loadHistory() }, { id -> resultId = id; play.viewResult(id); go(Route.PracticeResult) }, route == Route.LearningHistory, { reporting.loadHistory(more = true) })
                Route.Leaderboard -> LeaderboardScreen(board, dataVM.period, ::back, { dataVM.loadBoard(it) }, { dataVM.loadBoard(dataVM.period, true) })
                Route.Progress -> ProgressScreen(statistics, dashboard.data, catalog.data, reporting.period, ::back, reporting::loadStatistics)
                Route.Profile -> ProfileScreen(user, dashboard, authState.busy, ::go, authVM::updateName, dataVM::refresh)
                Route.Wallet -> WalletScreen(dashboard, ledger, ::back, { dataVM.refresh(); reporting.loadLedger() }, { reporting.loadLedger(true) })
                Route.Achievements -> AchievementsScreen(dashboard, ::back, dataVM::refresh)
                Route.Notifications -> NotificationsFeedScreen(notifications, ::back, { dataVM.loadNotifications() },
                    dataVM::markRead, dataVM::markAllRead, { dataVM.loadNotifications(true) }) { destination ->
                    val target = runCatching { Route.valueOf(destination) }.getOrDefault(Route.Notifications)
                    if (target in listOf(Route.Achievements, Route.Challenge, Route.Practice, Route.Battle, Route.Leaderboard, Route.History, Route.Wallet)) go(target)
                }
                Route.Settings -> SettingsScreen(user, preferenceKey, authState.busy, ::back, authVM::signOut, authVM::changeEmail)
                else -> HomeScreen(user.name, dashboard, attempt.data, play.activeId != null, ticket.data != null, ::go, { resume() }, dataVM::refresh)
            }
        }
        if (route in listOf(Route.Home, Route.Challenge, Route.Profile)) {
            NavigationBar(containerColor = Color.White, tonalElevation = 0.dp, windowInsets = WindowInsets(0), modifier = Modifier.heightIn(min = 72.dp)) {
                val tabs = if (route == Route.Challenge) listOf(Triple(Route.Home, "Trang chủ", Icons.Outlined.Home), Triple(Route.Practice, "Học tập", Icons.Outlined.MenuBook),
                    Triple(Route.Challenge, "Thử thách", Icons.Outlined.LocalFireDepartment), Triple(Route.Profile, "Cá nhân", Icons.Outlined.PersonOutline))
                else listOf(Triple(Route.Home, "Trang chủ", Icons.Outlined.Home), Triple(Route.Battle, "Thi đấu", Icons.Outlined.SportsEsports),
                    Triple(Route.Leaderboard, "Xếp hạng", Icons.Outlined.EmojiEvents), Triple(Route.Profile, "Hồ sơ", Icons.Outlined.PersonOutline))
                tabs.forEach { (target, label, icon) ->
                    NavigationBarItem(route == target, { root(target) }, { Icon(icon, null, Modifier.size(22.dp)) }, label = { Text(label, fontSize = 10.sp) },
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = Purple, selectedTextColor = Purple, indicatorColor = Lavender,
                            unselectedIconColor = Muted, unselectedTextColor = Muted))
                }
            }
        }
    }
    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp, vertical = 88.dp))
    }
    val modal = authState.error ?: authState.message ?: message ?: playError?.takeUnless { route in listOf(Route.Quiz, Route.BattleQuiz, Route.Matching) }
    if (modal != null) AlertDialog(onDismissRequest = { authVM.dismiss(); dataVM.dismiss(); play.dismiss() }, title = { Text("English Battle") },
        text = { Text(modal) }, confirmButton = { TextButton({ authVM.dismiss(); dataVM.dismiss(); play.dismiss() }) { Text("Đã hiểu") } })
    if (route in listOf(Route.PracticeResult, Route.BattleResult) && result.error != null) {
        AlertDialog(onDismissRequest = { back() }, title = { Text("Chưa tải được kết quả") }, text = { Text(result.error!!) },
            confirmButton = { TextButton({ resultId?.let(play::viewResult) }) { Text("Thử lại") } }, dismissButton = { TextButton({ back() }) { Text("Quay lại") } })
    }
}
