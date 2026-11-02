# Nghiệm thu kỹ thuật mục 1 — Backend phía người dùng

Ngày kiểm tra: **02/11/2026**, múi giờ Việt Nam. Phạm vi là mục 1 của
[`CONG-VIEC-BACKEND.md`](../../CONG-VIEC-BACKEND.md), sau các bước triển khai
1–7 và bổ sung kiểm thử tích hợp ở bước 8.

**Kết luận: đạt các lớp kiểm thử kỹ thuật hiện hành của mục 1 trong chế độ
local/Spark.** Lượt chạy cuối trả mã thoát 0; các bước nghiệm thu thực tế
trước phát hành vẫn được liệt kê riêng ở cuối tài liệu.

## Phạm vi kết luận

Nghiệm thu kỹ thuật dùng **Functions chạy local trên Spark**. Tài khoản và
dữ liệu khi dùng app bình thường vẫn thuộc Firebase thật
`englishbattleapp-8d764`; không chuyển ứng dụng sang dữ liệu mô phỏng.

Fixture, tài khoản thử, trận thử và tiêm lỗi đều chạy trong project emulator
`demo-englishbattle-finalization`, không ghi vào Firebase thật. Việc đối chiếu
Firebase thật dùng tài khoản đã có và dữ liệu kết quả nguồn; API đọc có thể
dựng lại view/thành tích/thông báo còn thiếu, không tạo trận hoặc thưởng mới.

Đây không phải nghiệm thu phát hành production, triển khai Blaze hoặc xác
nhận đã thử trên hai điện thoại vật lý. Các phần đó được phân biệt bên dưới.

## Các lớp kiểm chứng

| Lớp | Kết quả |
| --- | --- |
| ESLint và TypeScript Functions | Đạt |
| Hồi quy backend: hồ sơ, nội dung, học, daily, battle, thưởng, community, reporting | 193/193 đạt trên bản cuối |
| Tích hợp HTTP qua Functions Emulator, token Auth và Rules thực tế | 10/10 đạt trên bản cuối, đủ 18 callable |
| Hai Firebase SDK client dùng adapter Android thật trên Medium Phone API 35 | 1/1 đạt, hai UID khác nhau; giữ nguyên phiên Auth mặc định |
| Android build APK app/test, lint và JVM | Build/lint đạt, 27 JVM test đạt |
| Android giao diện/ViewModel | 40/40 đạt trên bản cuối |
| Schema/hợp đồng/export | 9 test đạt |
| Rules đề xuất trong frontend/contracts | 9 test đạt trên emulator 19000 |
| Rules ở gốc database.rules.json | Được kiểm tra bằng token qua RTDB REST trong bộ HTTP |

Lệnh chạy lại và các file test: [`README.md`](README.md). Test hồi quy điều
khiển đồng hồ để kiểm tra race nửa đêm/grace/restart; bài HTTP bổ sung chờ
**30 giây thực tế** và chạy worker tiến trình riêng, không sửa deadline fixture.

Log lần nghiệm thu tại máy phát triển: `.firebase/step8-acceptance-final.log`,
`.firebase/step8-final-android-build.log`, `.firebase/step8-proposed-rules.log`
và `.firebase/step8-live-readiness-final.log`. Thư mục `.firebase` được ignore,
không đưa log hoặc thông tin môi trường local vào Git.

## Đối chiếu từng mục

| Mục | Hành vi đã có và được kiểm tra |
| --- | --- |
| **1.1. Tài khoản/quyền/hồ sơ** | Auth email/password → provision → catalog → dashboard; provision đồng thời/lặp an toàn; tên/email lấy từ Auth; retry sau lỗi RTDB; giữ số dư/rating/tiến độ; chặn banned/deleted/disabled ở 18 API; SDK đăng xuất/đăng nhập lại; reset password và email action trong Auth Emulator. |
| **1.2. Danh mục/ngân hàng câu** | Quan hệ kỹ năng/chủ đề/bài/câu; chỉ published hợp lệ; 4 kỹ năng, Idioms thuộc Vocabulary; query/index catalog; version và option ổn định khi resume; không trả đáp án/explanation trước thời điểm được phép; thiếu ngân hàng không tiêu thụ lượt daily. Listening dùng TTS. |
| **1.3. Luyện tập/test** | 10/20 câu; start/resume/selection/submit/advance/leave/result; câu cuối kết thúc và lưu kết quả; deadline 30 giây; hết giờ chấm lựa chọn đã lưu, không chọn tính sai; owner/option/index; retry/hai client; review đúng quyền; finalization và phục hồi settlement khi app không gọi tiếp. |
| **1.4. Thử thách hằng ngày** | 5 câu, một slot UID/ngày Việt Nam; start đồng thời hội tụ; bỏ dở không tạo lượt mới; deadline giới hạn 00:00; hết ngày abandoned/0 xu; race hoàn tất–hết ngày giữ quyết định đầu; kết quả hợp lệ trước nửa đêm vẫn phục hồi sau restart. |
| **1.5. Thi đấu nhanh** | Hai UID khác nhau, chống ghép trùng/tự ghép; ticket cancel/expiry/race; bộ 10 câu chung và vòng đồng bộ; chưa lộ đáp án/lựa chọn đối thủ; phiên thiết bị/heartbeat; reconnect 30 giây; cả hai quá grace hòa/0 thưởng; hai người chủ động rời trong 3 giây hòa/0 thưởng; quyết định terminal bất biến; lịch sử/review hai bên. |
| **1.6. Xu/rating/tiến độ/thành tích/thông báo** | Thưởng học 1/2/2, thắng +5 rating/+5 xu, thua sàn 0 và actual delta, hòa 0; canonical grants/ledger/ví một lần; phục hồi projection; luyện tập 19/20/21 đúng mục; thành tích battle; thành tích 7 daily thành công; thống kê theo kỳ, phút từng câu, streak; bảng hạng toàn bộ rating tích lũy, snapshot/cursor/self rank; notifications UID-scoped; history/ledger phân trang. |
| **1.7. Hợp đồng API** | Hiện có **18 callable**, không còn chỉ 13 như checklist gốc. Schema response được xác minh trên HTTP; Android SDK/DTO/parser thật đi qua luồng học và battle. Mọi response thành công có serverNow. |

18 callable hiện hành:

`ensureUserProfile`, `getUserDashboard`, `startAttempt`, `resumeAttempt`,
`saveAttemptSelection`, `submitAttemptAnswer`, `advanceAttempt`, `leaveAttempt`,
`getAttemptResult`, `findBattle`, `getBattleTicket`, `cancelBattleSearch`,
`getLeaderboard`, `getNotifications`, `markNotificationsRead`,
`getStudyStatistics`, `getHistory`, `getCoinLedger`.

## Phần được sửa trong đợt nghiệm thu

Thành tích `seven_daily_challenges` đã có định nghĩa xuất bản nhưng trước đây
chưa được tự mở khóa. Đã bổ sung:

- Đếm ngày daily thành công từ slot và kiểm tra lại nguồn attempt, duyệt trang
  25; không lấy số liệu từ 50 lịch sử trên dashboard.
- Bỏ qua phiên bỏ dở, sai chế độ, thiếu nguồn, sai ngày hoặc ngày hết hạn.
- Giữ tiến độ/đã mở khóa khi một lượt tải cũ đến muộn; dừng đếm tại mốc lớn
  nhất đang xuất bản. Mốc seed là 7 ngày thành công, không yêu cầu liên tiếp.
- Lưu sự kiện thông báo cùng quyết định mở khóa; retry/worker phục hồi được
  sau khi định nghĩa bị archive. Thành tích không thưởng thêm xu.
- Gắn vào settlement trước marker hoàn tất, dashboard và community worker,
  để kết quả cũ hợp lệ cũng được bổ sung thành tích mà không chơi lại.

Test giao diện thành tích cũ cũng được cập nhật để dùng `Achievement.progress`
do server trả về và nhãn tiến độ hiện hành; không đổi giao diện sản phẩm.

## Đối chiếu Firebase thật

Đã kiểm tra project `englishbattleapp-8d764`, RTDB vùng `asia-southeast1`:

- **250/250** câu hỏi đang xuất bản vượt qua validator nghiệp vụ; **25** chủ
  đề xuất bản đều đủ tối thiểu 10 câu luyện tập hợp lệ.
- Rules đang chạy khớp các quyền và index yêu cầu trong `database.rules.json`;
  vẫn default-deny cho ghi điểm, xu, quyền, đáp án và dữ liệu server.
- Response của dashboard/statistics/history/ledger/leaderboard/notifications
  khớp hợp đồng trên một tài khoản hiện có có kết quả học tập.
- Thống kê tuần/tháng đối chiếu số phiên/câu/đúng với nguồn kết quả; hai tab
  bảng hạng dùng cùng rating; số dư dashboard khớp canonical settlement.
- Smoke test app trên Medium Phone bằng phiên đăng nhập hiện có: màn Tiến
  độ tải được dữ liệu qua Functions local cổng 5001 và Firebase thật, không
  hiện nút lỗi/Thử lại. Phiên Auth chính vẫn được giữ sau kiểm thử SDK.
- Không tạo tài khoản/trận thử trên Firebase thật, không import lại seed.

Đối chiếu này chạy từ môi trường Admin tin cậy. Kiểm chứng token, Rules,
Android SDK và tính cạnh tranh được thực hiện riêng trên emulator; không
gộp các lớp kiểm tra thành một tuyên bố rằng đã test đầu-cuối trên production.

## Phần còn cần nghiệm thu thực tế trước phát hành

- Hai thiết bị vật lý/hai mạng: background, kill app, mất Wi-Fi, nối lại
  trước/sau 30 giây, rời đồng thời. Test tự động đã kiểm tra engine, HTTP,
  hai tiến trình backend và hai tài khoản SDK trên một Android Emulator;
  chưa xác nhận hành vi phần cứng/hệ điều hành của hai điện thoại.
- Nhận email reset/xác minh đổi email trong hộp thư thật, thao tác link và
  khôi phục phiên trên thiết bị dùng thực tế. Luồng SDK và xử lý email action
  đã test bằng Auth Emulator; chưa xác nhận giao thư cloud trong đợt này.
- Blaze/deploy Functions, Cloud Scheduler, cấu hình release/signing, kiểm tra
  quota và smoke test sau deploy vẫn để sau theo phạm vi đã chốt. Hiện phải
  giữ `npm.cmd run dev:local` và worker chạy; đóng terminal sẽ ngừng xử lý
  nền tức thời, mở lại mới phục hồi công việc đã lưu.

Daily battle/phòng riêng, Google/OTP, file audio/Storage, FCM, avatar cá nhân
và đồng bộ cài đặt nhiều thiết bị vẫn thuộc phạm vi bổ sung riêng. Chúng không
được tính là đã triển khai qua lần nghiệm thu này. Các API battle deferred
trả UNIMPLEMENTED rõ ràng. Backend admin mục 2 và nghiệm thu pixel theo Figma
cũng không nằm trong kết luận mục 1 này.
