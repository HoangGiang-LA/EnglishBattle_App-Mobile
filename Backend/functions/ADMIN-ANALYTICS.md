# Admin Bước 5 — Dashboard, Analytics và dữ liệu tổng hợp

Cập nhật: 03/11/2026. Phạm vi local/Spark và Emulator. `adminGetOverview` có nghiệp vụ,
dùng chung guard/schema/rate limit và phục vụ hai trang Dashboard/Analytics.
Tổng 16/21 API nghiệp vụ; 5 API tìm kiếm/thông báo/audit/export thuộc Bước 6.

## Quy tắc tính

| Chỉ số | Định nghĩa |
|---|---|
| totalUsers | Số tài khoản Auth được giữ lại, tạo trước cutoff và chưa xóa mềm tại cutoff; banned/disabled vẫn được tính. Không phụ thuộc bộ lọc ngày/kỹ năng |
| newUsers | Tài khoản Auth được giữ lại có thời gian tạo trong kỳ; gồm cả tài khoản xóa mềm sau đăng ký |
| User growth | Tổng đăng ký lũy kế từ cùng tập Auth, gồm tài khoản xóa mềm; khác với số tài khoản hiện còn |
| activeUsers | Union UID có thời điểm bắt đầu, tham gia trận, nhận câu trả lời hoặc kết thúc được ghi nhận trong kỳ. Không cộng các tổng active mỗi ngày; một trận có hai UID |
| completedLessons | Các phiên PRACTICE/TEST/DAILY có status completed và kết thúc trong kỳ. Wire key giữ tương thích; UI thật gọi là learning sessions |
| completedBattles | Một room quick kết thúc trong kỳ và thuộc nhóm completed của Bước 4. answers/leave/disconnect/account_unavailable được tính; both_left/both_disconnected/ready_timeout không được tính |
| Accuracy | Tổng đúng / tổng slot câu hỏi đã phân xử của các phiên terminal trong kỳ; gồm câu đã trả lời trong phiên abandoned. Slot timeout cũng nằm trong mẫu số theo engine. Không tính đáp án trận đang chơi |
| Completion | Các phiên bắt đầu trong kỳ đã completed trước cutoff / chính tập phiên bắt đầu trong kỳ. Phiên học là một phiên; room là một phiên, không nhân hai người |
| Kỳ trước | Ngay trước kỳ chọn, cùng số ngày lịch gồm cả ngày cuối. Tăng trưởng `(current-previous)/previous`; previous=0 trả null |

Các mốc ngày dùng `Asia/Ho_Chi_Minh` (+07), khoảng `[00:00 from, 00:00 sau to)`.
Ngày/tuần/tháng là bucket lịch thật (tuần bắt đầu thứ Hai), không lấy mẫu mỗi 7/30 ngày.
Active trong từng bucket và cả kỳ đều union UID. Các bucket người dùng dùng điểm lũy
kế cuối bucket; các bucket phiên dùng tổng số phiên. Kỳ đang diễn ra được đánh dấu
`coverage.partialPeriod`; so sánh vẫn dùng cùng số ngày lịch, không giả đã có dữ liệu tương lai.

Accuracy và completion cố ý dùng hai tập khác nhau: accuracy theo kết thúc; completion
theo bắt đầu. Ví dụ phiên bắt đầu trước kỳ, kết thúc trong kỳ ảnh hưởng accuracy/số phiên
hoàn tất, nhưng không thêm vào mẫu số completion của kỳ. Phiên bắt đầu trong kỳ và hoàn
tất sau kỳ nhưng trước cutoff vẫn hoàn tất trong cohort đó.

Mixed-skill được nhận diện từ `attemptQuestions`/questions của room đã đóng băng.
Lọc một kỹ năng nhận phiên có câu thuộc kỹ năng đó; answered/correct chỉ nhận đúng câu
thuộc kỹ năng ấy. KPI room vẫn một trận; từng hàng kỹ năng có thể cùng chứa một trận.
UI gọi tỷ trọng này là **skill appearances**. Donut dùng số câu đã phân xử theo kỹ năng,
không cộng các phiên mixed thành nhiều phiên toàn hệ thống.

## Nguồn và lịch sử thiếu dữ liệu

Worker đọc Auth có page token, hồ sơ RTDB để tìm UID lịch sử, practiceAttempts,
attemptQuestions, attemptAnswers cũ, battleRooms, battleResults, grant settlement và
studyActivities. Canonical attempt/room ưu tiên hơn projection báo cáo. Fact ID là hash
theo learning+UID+attemptId hoặc battle+roomId; reporting/settlement retry không tạo fact mới.
Phiên active/waiting/abandoned được đọc, không chỉ lịch sử completed.

- Waiting chưa finalize chưa tính completed. Luồng getAttemptResult/worker của engine
  hoàn tất settlement trước; vòng tổng hợp sau cập nhật đúng ngày/cohort cũ.
- Summary học cũ còn timestamp kết thúc và count hợp lệ vẫn đóng góp chỉ số biết được.
  Không gán giờ kết thúc thành giờ bắt đầu. Có lịch sử thiếu start còn có thể thuộc cohort
  được chọn thì completion trả null. `unknownStartSessions` là số lịch sử thiếu start của cả generation.
- Thiếu phân bổ câu/kỹ năng: All skills vẫn trả KPI biết được, bỏ breakdown thay vì trả
  số 0 giả. Skill filter trên khoảng có dữ liệu không phân bổ được báo lỗi rõ.
- Thiếu tổng answered/correct đáng tin cậy: accuracy/denominator trả null, không giả số 0.
- Kết quả trận cũ có hai UID và status settled có thể tính từ battleResults; không có start
  thì cohort không được suy đoán. Chỉ có study summary mà thiếu nguồn phân loại kết thúc
  hoặc người tham gia thì khoảng bị ảnh hưởng báo `overview-history-incomplete`.
- Active dựa trên các timestamp thực sự còn được lưu. Không bù lịch sử đăng nhập/heartbeat
  đã mất bằng sự kiện giả. Names được đọc lại lúc trả recent; deleted/mất access ẩn danh theo Bước 4.
- Dữ liệu sai không đủ để xác định một fact (thiếu thời gian kết thúc, count không hợp lệ…)
  làm lượt rebuild báo lỗi và giữ generation đã công bố trước đó.

Scope tài khoản là **retained Auth**, gồm tài khoản Auth chưa provision hồ sơ. Quy trình xóa
mềm giữ Auth UID nên không mất lịch sử đăng ký. Hard-delete Auth ngoài quy trình hiện tại
không có đủ dữ liệu để tái dựng toàn bộ đăng ký đã mất; không tuyên bố khôi phục phần đó.

## Projection, backfill và phục hồi

`runAdminAnalyticsMaintenance` chạy trong worker/scheduler admin hiện có. Không cần
database trigger để chế độ Spark dùng Auth/RTDB thật và Functions Emulator hoạt động.
Worker chỉ ghi các nhánh admin, không finalize phiên, cấp grant hoặc sửa nguồn người dùng.

1. Dựng generation riêng: Auth → UID hồ sơ → attempts → rooms → results cũ → study summaries.
2. Reduce account/fact thành daily counters, UID sets, cohort counters và recent index theo skill.
   Mỗi fact/ngày có receipt ổn định; mất acknowledgement rồi retry không cộng lại.
3. Tạo số đăng ký lũy kế theo ngày, ghi metadata ready và chuyển activeGeneration bằng transaction.
   API luôn đọc một generation bất biến; không trộn hai lần rebuild.

Lease 90 giây, gia hạn khi còn dưới 30 giây. Mỗi lượt tối đa hai page/phase (tham số
server kiểm thử tối đa bốn), query 25 source records, tối đa 10 UID rỗng được đi qua trong
một page nguồn theo UID. Checkpoint lưu phase, cursor, UID và Auth page token. Lỗi giữ
checkpoint; owner hết hạn khởi tạo generation mới, giữ writer cũ trong vùng bị bỏ, không
cho công bố. Vòng mới tự bắt đầu sau khi vòng trước hoàn tất, tối thiểu 60 giây sau publish.

`adminAnalyticsControl` chứa activeGeneration/pending/asOf/errorCode cố định, không lưu
exception hoặc raw Auth record. `adminAnalyticsGenerationMeta` có TTL 24 giờ. Cleanup
tối đa 5 metadata hết hạn/lượt, luôn giữ active và pending. Generation cũ được giữ ít nhất
24 giờ sau publish để request đang đọc không bị xóa giữa chừng. Không có reset/rebuild API
cho trình duyệt; không cần xóa dữ liệu nguồn để dựng lại.

`asOf` là cutoff khi bắt đầu generation, không phải thời gian trình duyệt tải trang.
Event sau cutoff không được gán vào chỉ số đã hoàn tất của cutoff cũ. Dữ liệu đến muộn
hoặc settlement phục hồi được nhận ở generation tiếp theo theo thời gian nguồn gốc.
Đây là khám phá tuần tự qua Auth/RTDB, không phải transaction snapshot liên hệ thống.
Độ trễ gồm cả vòng backfill; dữ liệu lớn có thể cần nhiều lượt worker. UI công bố lag và
coverage. Chưa có generation hoàn tất thì báo preparing; lag vượt 24 giờ thì báo stale.

## Giới hạn và hợp đồng

- Giữ giới hạn khoảng ngày 366; cùng với kỳ trước tối đa 732 ngày được đọc trên server.
- Tối đa 10.000 UID roster, 25.000 session facts, 100.000 source rows/generation.
- Daily bucket tối đa 1 MiB (có thể chạm trước giới hạn tổng khi hoạt động dồn một ngày).
  API đọc từng page 7 ngày, tổng raw aggregate tối đa 8 MiB. Vượt giới hạn trả lỗi,
  không cắt dữ liệu hoặc trả tổng đang dựng như số chính xác.
- Recent index có orderByChild(at), lấy 5 dòng đúng khoảng/kỹ năng, độc lập với tính KPI.
  Không tải root RTDB hay toàn bộ source về trình duyệt.
- Response bổ sung generation, granularity, timezone, denominators và coverage. Chỉ có
  số tổng hợp và recent DTO; không có đáp án, lựa chọn, secret, email hoặc raw source.
- Rules default-deny giữ nguyên; thêm index cho generation TTL và recent theo skill.
  Chưa deploy Rules/Functions. Snapshot nội dung, rating, ví và ledger không thay đổi.

## Kiểm tra local

Trong `Backend/functions`, chạy `node tools/run-admin-tests.mjs --analytics` hoặc toàn bộ
`npm.cmd run test:admin`; browser dùng `npm.cmd run test:admin:web`.
Các launcher ép demo project/host và bỏ credential thật khỏi môi trường kiểm thử.
20 kiểm thử riêng đối chiếu cohort, mixed-skill, UID unions, calendar buckets, hơn 50
Auth/session records, late settlement, source lỗi, lease/receipt và engine thực tế.
Biên bản kết quả cuối nằm trong `ADMIN.md`.

Firebase production, Android thiết bị, quota/độ trễ production và deploy là mốc nghiệm thu sau.
