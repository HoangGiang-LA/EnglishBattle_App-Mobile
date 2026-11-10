package com.englishbattle.app.ui

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.englishbattle.app.R
import com.englishbattle.app.data.*
import kotlinx.coroutines.delay
import java.util.Locale

@Composable fun QuizScreen(state: LoadState<AttemptState>, busy: Boolean, error: String?, preferenceKey: String,
    now: () -> Long, back: () -> Unit, submit: (String?) -> Unit, advance: () -> Unit, leave: () -> Unit, retry: () -> Unit, topicTitle: String = "",
    saveSelection: (String) -> Unit = {}) {
    val a = state.data
    if (a == null) {
        Screen("Phiên làm bài", back) {
            if (busy || state.loading) LoadingPanel("Đang mở phiên...")
            else EmptyPanel("Chưa mở được phiên. Bạn có thể quay lại để bắt đầu hoặc tải lại phiên đang dở.")
            error?.let { ErrorPanel(it, retry) }
        }
        return
    }
    val q = a.current
    if (q == null || a.status !in listOf("active", "waiting")) {
        Screen(a.mode.title, back) { LoadingPanel("Đang cập nhật kết quả..."); Secondary("Tải lại trạng thái", onClick = retry) }
        return
    }
    var selected by rememberSaveable(a.id, q.id) { mutableStateOf(a.selectedOptionId) }
    var quit by rememberSaveable(a.id) { mutableStateOf(false) }
    var currentTime by remember(a.id, q.id, a.deadlineAt) { mutableLongStateOf(now()) }
    val isBattle = a.mode == QuizMode.BATTLE
    val showingFinalAnswer = !isBattle && a.status == "waiting" && a.receipt != null
    val onBack = { if (showingFinalAnswer) back() else quit = true }
    val ticking = isBattle || (!busy && a.receipt == null && a.status == "active")
    val seconds = remainingSeconds(a.deadlineAt, currentTime).let {
        if (isBattle) it else it.coerceAtMost(GameRules.QUESTION_SECONDS)
    }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(a.id, q.id, a.deadlineAt, ticking, owner) {
        if (!ticking) return@LaunchedEffect
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { currentTime = now(); delay(200) }
        }
    }
    LaunchedEffect(a.id, q.id, seconds, a.receipt, busy, error) {
        if (seconds == 0 && a.receipt == null && !busy && error == null && a.status == "active") submit(null)
    }
    BackHandler(onBack = onBack)
    Screen(if (a.mode == QuizMode.BATTLE) "" else if (a.mode == QuizMode.PRACTICE) skillNames[skillIds.indexOf(q.categoryId).coerceAtLeast(0)] else a.mode.title, onBack, action = {
        Text("00:${seconds.toString().padStart(2, '0')}", color = if (seconds <= 5) MaterialTheme.colorScheme.error else Purple)
    }) {
        if (a.mode == QuizMode.BATTLE) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            FighterCard("You", if (a.receipts.all { it.correct != null }) a.receipts.count { it.correct == true } else null, false, Modifier.weight(1f))
            Small("VS")
            FighterCard(a.opponentName, null, true, Modifier.weight(1f))
        }
        a.reconnectDeadlineAt?.takeIf { remainingSeconds(it, currentTime) <= 24 }?.let { deadline ->
            Text("Thời hạn trở lại trận: ${remainingSeconds(deadline, currentTime)} giây", color = MaterialTheme.colorScheme.error)
        }
        if (a.mode == QuizMode.BATTLE && a.status == "waiting") {
            Panel(color = Blue) { Text("Đang chờ đối thủ hoặc kết quả trận đấu...") }
        }
        Progress((a.index + 1f) / a.questions.size)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Small(if (a.mode == QuizMode.BATTLE) "QUESTION ${a.index + 1} OF ${a.questions.size}" else "Câu ${a.index + 1}/${a.questions.size}")
            Small(topicTitle, Modifier.weight(1f).padding(start = 12.dp).wrapContentWidth(Alignment.End), color = Muted)
        }
        Small(if (q.audioText.isNotBlank()) "Nghe và chọn đáp án đúng" else if (q.passage.isNotBlank()) "Đọc đoạn văn và trả lời câu hỏi" else "Chọn một đáp án đúng")
        if (q.passage.isNotBlank()) Panel(color = Blue) { Text(q.passage) }
        if (q.audioText.isNotBlank()) AudioQuestion(q.audioText, preferenceKey, q.id)
        Text(q.prompt, style = MaterialTheme.typography.headlineMedium)
        q.options.forEachIndexed { index, option ->
            val picked = a.receipt?.optionId ?: selected
            val chosen = option.id == picked
            val confirmed = a.receipt != null && chosen
            val color = if (confirmed && a.receipt?.correct == false) Rose else if (chosen) Lavender else Color.White
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(color)
                .border(1.dp, if (chosen) Purple else Line, RoundedCornerShape(16.dp))
                .clickable(enabled = a.receipt == null && !busy && seconds > 0 && a.status == "active") {
                    selected = option.id; saveSelection(option.id)
                }
                .padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("${'A' + index}.", fontSize = 14.sp)
                Text(option.text, Modifier.weight(1f), fontSize = 14.sp)
                if (chosen) Icon(Icons.Outlined.CheckCircle, "Đã chọn", tint = Purple)
            }
        }
        error?.let { ErrorPanel(it, retry) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        a.receipt?.let { receipt ->
            Panel(color = if (receipt.correct == false) Peach else Mint) {
                Text(when { receipt.optionId == null -> "Đã ghi nhận hết thời gian."; receipt.correct == true -> "Chính xác!";
                    receipt.correct == false -> "Chưa chính xác. Xem giải thích khi kết thúc bài."; else -> "Đã ghi nhận đáp án." })
            }
            Primary(if (a.index == a.questions.lastIndex) "Xem kết quả" else if (a.mode == QuizMode.BATTLE) "Cập nhật lượt tiếp theo" else "Câu tiếp theo", enabled = !busy, onClick = advance)
        } ?: Primary(if (busy) "Đang gửi..." else if (seconds == 0) "Hết thời gian" else "Gửi đáp án",
            enabled = selected != null && !busy && seconds > 0 && a.status == "active") { submit(selected) }
    }
    if (quit && !showingFinalAnswer) AlertDialog(onDismissRequest = { if (!busy) quit = false }, title = { Text("Rời ${a.mode.title.lowercase()}?") },
        text = { Text(if (a.mode == QuizMode.BATTLE) "Chủ động rời trận được tính là thua. Đồng hồ vẫn đang chạy."
            else if (a.mode == QuizMode.DAILY) "Bạn sẽ dùng hết lượt hôm nay và không nhận thưởng. Đồng hồ vẫn đang chạy."
            else "Bài này sẽ kết thúc và không nhận thưởng. Đồng hồ vẫn đang chạy.") },
        confirmButton = { TextButton({ quit = false; leave() }, enabled = !busy) { Text("Xác nhận rời phiên") } },
        dismissButton = { TextButton({ quit = false }) { Text("Tiếp tục") } })
}

@Composable private fun FighterCard(name: String, points: Int?, cat: Boolean, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(if (cat) Rose else Blue).padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        MascotFace(cat, Modifier.size(66.dp))
        Text(name, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("${points?.toString() ?: "—"} pts", color = if (cat) Color(0xFFD77E8C) else Color(0xFF5880DA), fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable private fun AudioQuestion(text: String, preferenceKey: String, questionId: String) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var ready by remember { mutableStateOf(false) }
    var error by remember(questionId) { mutableStateOf(false) }
    val speech = remember(context) { TextToSpeech(context) { ready = it == TextToSpeech.SUCCESS } }
    LaunchedEffect(questionId) { speech.stop() }
    DisposableEffect(speech, owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) speech.stop() }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); speech.stop(); speech.shutdown() }
    }
    Panel(color = Blue) {
        IconButton({
            if (ready && speech.setLanguage(Locale.US) >= TextToSpeech.LANG_AVAILABLE) {
                val volume = context.getSharedPreferences(preferenceKey, Context.MODE_PRIVATE).getFloat("sound", .7f)
                val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume) }
                if (speech.speak(text, TextToSpeech.QUEUE_FLUSH, params, questionId) == TextToSpeech.ERROR) error = true
            } else error = true
        }, Modifier.align(Alignment.CenterHorizontally).size(64.dp)) { Icon(Icons.Outlined.VolumeUp, "Nghe nội dung", Modifier.size(40.dp), tint = Purple) }
        Text("Nhấn loa để nghe", Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
        if (error) Text("Chưa phát được giọng tiếng Anh. Nội dung thay thế: $text")
    }
}

@Composable fun ResultScreen(state: LoadState<QuizResult>, back: () -> Unit, review: () -> Unit, again: () -> Unit, skills: List<SkillStat> = emptyList()) {
    Screen(if (state.data?.mode == QuizMode.BATTLE) "Kết quả trận đấu" else "Hoàn thành!", back) {
        if (state.loading) LoadingPanel()
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        val r = state.data
        if (r == null && !state.loading) EmptyPanel("Chưa có kết quả được xác nhận.")
        if (r != null) {
            val battle = r.mode == QuizMode.BATTLE
            Art(if (battle) R.drawable.mascot_winner else R.drawable.mascot_happy, Modifier.fillMaxWidth().height(if (battle) 195.dp else 170.dp))
            if (battle) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Pill(when (r.outcome) { "win" -> "Bạn đã thắng!"; "draw" -> "Hai người hòa nhau"; else -> "Cố gắng lần sau!" }, Color.White, Color(0xFFEC53A2))
            }
            Text(if (battle) "${r.correct} - ${r.opponentCorrect}" else "${r.correct}/${r.total}", Modifier.fillMaxWidth(),
                color = Green, fontSize = 48.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
            if (battle) Row(Modifier.fillMaxWidth()) {
                Text("Bạn", Modifier.weight(1f), color = Muted, textAlign = TextAlign.Center)
                Text(r.opponentName, Modifier.weight(1f), color = Muted, textAlign = TextAlign.Center)
            } else Text(when {
                r.outcome == "abandoned" -> "Đã kết thúc bài đang dở"
                r.correct * 100 / r.total >= 70 -> "Làm tốt lắm!"
                else -> "Tiếp tục luyện tập nhé!"
            }, Modifier.fillMaxWidth(), color = Muted, textAlign = TextAlign.Center)
            if (battle) {
                Panel { Stats(listOf(signed(r.ratingDelta) to "Rating", signed(r.coins) to "Xu")) }
                Primary("↻  Đấu lại", onClick = again)
                if (r.reviews.isNotEmpty()) Secondary("▣  Xem đáp án", onClick = review)
            } else {
                Panel {
                    Text("✓  Độ chính xác: ${r.correct * 100 / r.total}%", color = Green)
                    Small("Thời gian làm bài: ${studyTimeLabel(r.durationMs)}")
                    Text(if (r.outcome == "abandoned") "Bài chưa hoàn thành · Không nhận thưởng" else "⚡  Hoàn thành ${r.total} câu hỏi", color = Purple)
                    if (r.coins > 0) Small("+${r.coins} xu", color = Green)
                }
                Title("Kỹ năng")
                skillIds.forEachIndexed { i, id ->
                    val stat = skills.find { it.id == id }
                    val reviews = r.reviews.filter { it.question.categoryId == id }
                    val count = stat?.answered ?: reviews.size
                    val correct = stat?.correct ?: reviews.count { it.correctId == it.pickedId }
                    val value = if (count > 0) correct.toFloat() / count else 0f
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(skillNames[i]); Small(if (count > 0) "${(value * 100).toInt()}%" else "—", color = Purple)
                        }
                        Progress(value)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (r.reviews.isNotEmpty()) Secondary("Xem đáp án", Modifier.weight(1f), review)
                    Primary("Luyện tập", Modifier.weight(1f), onClick = again)
                }
            }
        }
    }
}@Composable fun ReviewScreen(result: QuizResult?, back: () -> Unit) {
    Screen("Xem đáp án", back) {
        if (result == null || result.reviews.isEmpty()) EmptyPanel("Đáp án chưa được công bố cho phiên này.")
        result?.reviews?.forEachIndexed { i, review ->
            Panel {
                Small("CÂU ${i + 1}")
                if (review.question.passage.isNotBlank()) Small(review.question.passage)
                Text(review.question.prompt, fontWeight = FontWeight.Bold)
                Text("Bạn chọn: ${review.question.options.find { it.id == review.pickedId }?.text ?: "Không trả lời"}")
                Text("Đáp án: ${review.question.options.find { it.id == review.correctId }?.text ?: "Chưa có"}", color = Green)
                Text(review.explanation)
            }
        }
    }
}
