# Admin Bước 8 — Kiểm thử tích hợp và nghiệm thu

Cập nhật: 08/11/2026. Phân biệt ba môi trường: kiểm thử demo Emulator cô lập,
local/Spark nối Auth/RTDB thật và production đã deploy. Kết quả của môi trường trước
không thay thế nghiệm thu môi trường sau.

## Chạy lại bộ kiểm thử

Từ Backend/functions:

```powershell
npm.cmd run test:admin:acceptance
```

Lệnh chạy tuần tự lint/build Functions, schema đủ 21 callable, admin integration,
HTTP server, hợp đồng frontend/mobile, web unit/types, hai build Firebase/demo,
browser Firebase/demo và hồi quy backend người dùng. Kết quả và log từng nhóm nằm
trong .firebase/admin-acceptance/<timestamp>/result.json, được Git bỏ qua.
Nếu nhóm nào lỗi, runner dừng, lưu exitCode và trả mã lỗi; không coi lượt bị ngắt là đạt.

Android là tùy chọn, cần APK đã build, JDK tương thích Gradle và Android Emulator riêng:

```powershell
$env:JAVA_HOME = 'C:\Users\Acer\.jdks\jbr-21.0.11'
$env:ANDROID_HOME = 'D:\Androidstudio\Sdk'
# Từ frontend
.\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:lintDebug --offline
# Từ Backend/functions, chọn đúng Android Emulator đang chạy
$env:ANDROID_SERIAL = 'emulator-5560'
npm.cmd run test:admin:acceptance -- --android
# Chạy lại riêng nhóm backend người dùng và Android khi các nhóm khác đã đạt
npm.cmd run test:admin:acceptance -- --only=user-backend --android
```

Đường dẫn JDK/SDK và serial là ví dụ của máy nghiệm thu, cần đổi theo máy.
Gradle 8.13 của dự án đã chạy bằng JDK 21; JBR 25 trên máy này không tương thích.
--offline yêu cầu dependency đã có trong cache.

Launcher xóa biến credential/project thật trước khi tạo tiến trình con. Admin QA dùng
demo-englishbattle-admin (Auth 19299, DB 19200, Functions 15003); hồi quy người dùng
dùng demo-englishbattle-finalization (Auth 9199, DB 9100, Functions 5002). Fixture kiểm tra
project/host trước khi import Admin SDK. Chỉ launcher local/Spark riêng mới đọc server/.env.
Không chạy fixture, seed root hoặc tiêm lỗi trên Firebase thật.

## Phạm vi kiểm chứng tự động

| Nhóm                  | Bằng chứng chính                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phân quyền            | integration.test.mjs gọi đủ 21 API với anonymous, thường, claim không phải boolean true, claim hiện tại đã mất, revoked, disabled, banned, deleted, thiếu accountAccess và Auth đã bị xóa      |
| Quyền admin cuối cùng | users.test.mjs kiểm tra tự khóa/xóa, hai lần thu hồi đồng thời và race giữa API trạng thái với công cụ server                                                                                  |
| Retry/phục hồi        | Auth thành công trước RTDB lỗi, mất acknowledgement sau commit, lỗi index/audit/email, lease hết hạn và requestId dùng lại payload khác; giữ UID/revision/audit duy nhất                       |
| Đồng thời             | Hai admin sửa cùng user, danh mục hoặc question version; một bên nhận conflict và không ghi đè                                                                                                 |
| Học/thi đấu           | Khóa khi đang học/trong trận theo settlement hiện có; sửa/archive question giữ snapshot/version của phiên cũ; rating/xu/ledger không bị reset                                                  |
| Giám sát              | Trạng thái/thời gian/kết quả từ nguồn thật, không tạo timeline giả, không lộ đáp án/lựa chọn chưa công bố/token                                                                                |
| Analytics             | Hơn 50 nguồn, UID union, mixed-skill theo từng câu, accuracy có trọng số, cohort bắt đầu trong kỳ, ngày Việt Nam/kỳ trước, late settlement, rebuild/checkpoint/lease và coverage lịch sử thiếu |
| Workspace             | Tìm kiếm giới hạn loại/đường dẫn, snapshot gắn actor/filter, inbox theo UID, rebuild giữ read-state, audit không trùng, CSV đủ tập lọc, BOM/chống công thức và giới hạn dòng/byte              |
| Web                   | 5 trang, reload, hai browser, timeout sau commit, requestId/payload ổn định, form giữ dữ liệu, phản hồi phiên cũ bị bỏ, thu hồi quyền đóng workspace và không fallback mock                    |
| Android SDK           | Hai app learner hoàn tất học/trận; admin sửa/archive question khi đang học, khóa/mở/xóa account, token cũ bị thu hồi và Auth mặc định không bị đăng xuất                                       |

Chi tiết nghiệp vụ vẫn theo ADMIN-USERS.md, ADMIN-CONTENT.md, ADMIN-MONITORING.md,
ADMIN-ANALYTICS.md, ADMIN-WORKSPACE.md và ADMIN-INTEGRATION.md; bảng này không mở rộng
quyền quản trị hoặc thay quy tắc settlement.

## Kết quả trên mã Bước 8

| Kiểm tra                                                             | Kết quả                             |
| -------------------------------------------------------------------- | ----------------------------------- |
| Functions ESLint, TypeScript, export schema khớp runtime             | Đạt                                 |
| Schema/semantic validation đủ 21 API                                 | 8/8                                 |
| Admin integration Bước 1–6, ma trận guard đã mở rộng                 | 118/118                             |
| HTTP server                                                          | 7/7                                 |
| Hợp đồng frontend/mobile và export                                   | 9/9                                 |
| Web unit/component/adapter                                           | 86/86                               |
| Web TypeScript, build Firebase/demo, loại mock/seed khỏi bundle thật | Đạt                                 |
| Browser Firebase SDK + HTTP/Auth/DB/Functions Emulator               | 18/18                               |
| Browser demo desktop/mobile                                          | 20/20                               |
| Backend người dùng                                                   | 193/193                             |
| HTTP callable và worker người dùng                                   | 10/10                               |
| Android JVM unit, build APK và lint                                  | 27/27; build/lint đạt               |
| Android UI/ViewModel và SDK tích hợp                                 | 40/40 sau retry một ca ảnh; SDK 2/2 |

Bằng chứng nền tảng/server/web:
.firebase/admin-acceptance/2026-11-08T05-58-02-455Z. Lượt này dừng có chủ đích trước
khi thay APK Android; chỉ các nhóm đã hoàn tất được ghi nhận. Sau bản sửa index,
admin 118/118 và browser Firebase 18/18 đạt lại tại
.firebase/admin-acceptance/2026-11-08T09-52-06-683Z/result.json.

Backend người dùng 193/193 và HTTP/worker 10/10 đạt trên mã cuối tại
.firebase/admin-acceptance/2026-11-08T10-00-24-581Z. Lượt này có 39/40 ca UI Android đạt;
ca captureAuthDesignScreens timeout trong Compose forceRedraw (giới hạn 2 giây của
thư viện chụp ảnh), nên result.json của cả stage vẫn giữ failed. Ca đó chạy riêng đạt
1/1; hai ca SDK chạy lại đạt 2/2 tại .firebase/admin-step8/android-rerun-result.json,
hoàn tất 10:22 UTC. Lượt trước đó tại 09:36 UTC đã đạt trọn bộ UI 40/40 và SDK 2/2.
Không đổi timeout nghiệp vụ để vượt kiểm thử.

Các lần chạy lại cũng ghi nhận Functions hot reload khi tài liệu trong chính thư mục
Functions được cập nhật giữa request. Lượt SDK cuối giữ nguyên nguồn và chạy trên
Emulator đủ Rules/index, project và namespace đã kiểm tra. Browser audit/thông báo cuối
đạt sau khi dịch vụ ổn định và dùng đúng nút Try again; CSV đã tải được giữ lại,
không tạo lại export khi chỉ kiểm tra panel.

Trong quá trình bổ sung test Android đã sửa FirebaseGameRepository để dùng đúng Auth
được inject khi xử lý UNAUTHENTICATED. Trước đó repository có Functions của named app
nhưng gọi signOut trên Auth mặc định. Constructor vẫn có giá trị mặc định cho ứng dụng.
Các app SDK test dùng khóa giả khác nhau để tránh cache Auth Emulator trỏ đến named app
đã được xóa từ ca trước.

## Smoke test Auth/RTDB thật ở local/Spark

Trạng thái: đã hoàn tất phạm vi QA thật; chi tiết và giới hạn ở cuối biên bản.

Giới hạn và quy trình:

- Xác nhận project/DB, quyền admin hiện tại và email QA chưa đăng ký trước khi tạo.
  Không ghi mật khẩu, token, khóa SDK hoặc link đặt mật khẩu vào log/artifact/version control.
- Backup chọn lọc metadata projection và dữ liệu đích trước khi thay đổi; không import seed
  hoặc ghi đè root. Dữ liệu lịch sử, kết quả, xu/rating của tài khoản người học sẵn có được giữ.
- Hai phiên browser đăng nhập độc lập; profile giữ nguyên tên, tạo/sửa user QA bằng requestId
  ổn định, kiểm tra reload, mời email, tìm kiếm, thông báo, audit và bốn loại báo cáo.
- Nội dung QA chỉ ở draft rồi archive; không đưa câu thử vào ngân hàng published.
  Khóa/mở/xóa mềm chỉ tài khoản QA mới của lượt này, có lý do và audit.
- Ghi nhận asOf/coverage/độ trễ thật. Projection còn rebuild hoặc stale phải báo đúng lỗi;
  không đổi cờ ready hoặc sửa số tổng hợp để đạt kiểm thử.
- Trạng thái invitation sent chỉ chứng minh dịch vụ nhận yêu cầu; việc nhận email/đặt mật
  khẩu phải do người giữ hộp thư xác nhận riêng.

Bằng chứng riêng tư trong .firebase/admin-step8/ được Git bỏ qua; không đưa UID/email
người dùng hoặc CSV chứa dữ liệu thật vào báo cáo được commit.

## Giới hạn nghiệm thu

Chưa deploy Functions/Hosting hoặc trọn bộ Rules/index, chưa đổi Blaze/domain/HTTPS/secret/quota/cảnh báo.
Ngoại lệ ba index notifications đã được duyệt riêng được ghi ở cuối biên bản.
Chưa nghiệm thu Android trên thiết bị vật lý hoặc mạng hai máy; SDK integration ở trên chạy
trên Android Emulator và Firebase Emulator riêng. Daily/private, Storage/audio upload, FCM,
đảo kết quả/hủy trận và export lớn hơn giới hạn hiện tại tiếp tục nằm ngoài phạm vi.

## Ma trận 21 API

Tất cả API dưới đây có schema request/response và ma trận từ chối quyền trong bộ
Emulator. Cột cuối ghi đúng phạm vi đã kiểm chứng với Auth/RTDB thật; mutation nghiệp vụ
được gửi qua callable local, sau đó đối chiếu nguồn và browser dùng adapter Firebase.

| API                        | Kiểm chứng Emulator                                          | Smoke test local/Spark thật                                                        |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| adminGetProfile            | Auth/RTDB, quyền và revision                                 | Đọc hồ sơ admin hiện tại                                                           |
| adminUpdateProfile         | Allowlist, retry, đồng bộ Auth/RTDB                          | Lưu lại đúng tên cũ, giữ quyền                                                     |
| adminListUsers             | Tìm kiếm, tổng, snapshot 10/20/50                            | Danh sách thật; tìm QA và reload hai browser                                       |
| adminGetUser               | UID, trạng thái, chỉ đọc rating/xu                           | Đối chiếu QA và actor                                                              |
| adminSaveUser              | Tạo/sửa, email trùng, provisioning, lỗi giữa chừng, conflict | Tạo UID ổn định, retry, sửa tên QA                                                 |
| adminSetUserStatus         | Tự bảo vệ, admin cuối, race, revoked, settlement             | Khóa → mở → xóa mềm đúng QA                                                        |
| adminGetCatalog            | Bốn kỹ năng và quan hệ                                       | Đọc danh mục hiện tại                                                              |
| adminSaveContent           | Revision, xuất bản cha, allowlist                            | Tạo topic/lesson draft rồi archive                                                 |
| adminListQuestions         | Tổng, bộ lọc, snapshot, hơn 50 nguồn, worker chạy đồng thời  | Đọc 251 câu sau khi thêm một câu QA                                                |
| adminGetQuestion           | Version, option, đáp án qua guard                            | Đọc câu nguồn và câu QA                                                            |
| adminSaveQuestion          | Validator, expectedVersion, lịch sử bất biến                 | Tạo draft v1, sửa v2                                                               |
| adminArchiveQuestion       | Conflict, giữ snapshot học/trận cũ                           | Archive v3; cả v1/v2/v3 còn tồn tại                                                |
| adminListBattles           | Trạng thái, bộ lọc, phân trang và dữ liệu bí mật             | Đọc 9 trận quick có sẵn                                                            |
| adminGetBattle             | Hai người, kết quả, timeline thật và redaction               | Đọc chi tiết một trận có sẵn                                                       |
| adminListActivities        | Event ID, loại trùng và giới hạn                             | Đọc hoạt động thật; không tạo log giả                                              |
| adminGetOverview           | UID union, cohort, mixed-skill, weighted accuracy, late data | Generation đã publish, asOf và 5 trang không báo lỗi                               |
| adminSearch                | UID/email/text, loại/đường dẫn cho phép                      | Tìm đúng user/câu QA qua index                                                     |
| adminListNotifications     | Phân trang, inbox riêng, phục hồi và TTL                     | API và popover đọc sự kiện thật                                                    |
| adminMarkNotificationsRead | Hai UID độc lập, retry, watermark                            | Chỉ đánh dấu một thông báo QA; read state đã lưu                                   |
| adminListAudit             | Actor/filter/snapshot, audit gắn operation                   | 18 operation QA đều succeeded và có audit đúng actor                               |
| adminExportReport          | Đủ tập lọc, quyền tạo/nhận, TTL, CSV và giới hạn             | Users/Questions/Battles mỗi loại 1 dòng; Analytics 54 dòng; tải CSV QA qua nút web |

Đồng thời hai admin khác UID, lỗi cưỡng bức giữa Auth/RTDB/index/audit/email và dữ liệu
hơn 50 bản ghi được nghiệm thu trên Emulator riêng. Lượt thật dùng hai browser độc lập
cùng một UID admin; không thu hồi quyền hoặc tiêm lỗi trên tài khoản thật.

## Kết quả smoke test và dọn dữ liệu

Đã gọi thành công đủ 21 callable với Auth/RTDB thật qua Functions local; 5 trang
Dashboard, Users, Content, Battles, Analytics đều hiển thị dữ liệu thật ở lượt đọc cuối.
Bộ tự động đã kiểm chứng adapter CRUD và conflict; lượt thật đối chiếu mutation API
với Auth/RTDB và reload hai browser. Không coi các API được gọi trực tiếp là thao tác
bấm form trên web.

Tạo một user QA chưa đăng ký, một topic, một lesson và một question draft. Retry tạo
user giữ cùng UID/revision. Đã kiểm tra sáu nhóm hồ sơ mặc định, không có claim admin,
wallet/rating bằng 0. Đối chiếu 18 operation nghiệp vụ thành công và audit dùng một key
ổn định cho từng operation. Thông báo QA đã được project và trạng thái đọc đã lưu.

Chủ hộp thư đã xác nhận nhận email và đặt mật khẩu thành công. Sau đó user QA được khóa,
mở lại rồi xóa mềm; danh tính trên index/CSV đã được ẩn, Auth disabled và accountAccess
deleted. Topic/lesson/question đều archived, question giữ đủ ba version. Tài khoản người
học sẵn có được kiểm tra lại vẫn active và giữ 4 xu. Tên/quyền của actor được giữ.

Truy vấn thống kê đầu tiên báo overview-stale do worker dừng từ trước; worker tiếp tục
checkpoint cũ rồi publish generation mới. Không sửa cờ ready/asOf hoặc số liệu để vượt
kiểm thử. Đã phát hiện và sửa backfill câu hỏi ghi index dù DTO không đổi, làm ngắt
search/export; ca hồi quy mới chạy worker trong lúc chụp danh sách và vẫn phát hiện thay
đổi nguồn thật.

RTDB thật thiếu ba index của adminNotificationEvents. Sau khi có xác nhận riêng của
chủ dự án, đã backup Rules, đối chiếu bản hiện tại và chỉ cộng .indexOn gồm at,
publishedAt, expiresAt tại đúng nhánh đó. Đã đọc lại để xác minh; không đổi .read/.write
hoặc deploy toàn bộ Rules. Đây là ngoại lệ được duyệt cho lượt smoke test, không phải
nghiệm thu triển khai production.

Bằng chứng riêng tư: .firebase/admin-step8/live/state.json, final-source-checks.json,
mail-receipt.json, ảnh từng trang, CSV, trước/sau index và backup Rules. Không commit
artifact hoặc thông tin đăng nhập. Dữ liệu QA được giữ dưới dạng tombstone/archive và
audit theo chính sách; không xóa cứng lịch sử để dọn test.

Kết quả tổng hợp có dẫn chứng từng lượt: .firebase/admin-step8/final-acceptance-result.json.
Các dịch vụ local và Android Emulator do lượt nghiệm thu khởi chạy đã được dừng sau khi chốt.
