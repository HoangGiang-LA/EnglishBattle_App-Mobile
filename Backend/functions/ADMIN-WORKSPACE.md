# Admin Bước 6 — Tìm kiếm, thông báo, audit và CSV

Cập nhật: 08/11/2026. Phạm vi local/Spark và Emulator. Đủ 21 callable admin có
nghiệp vụ, giữ 5 trang hiện có. Thi đấu daily/private, FCM và Storage vẫn là phạm vi riêng.

## API và phân quyền

| API | Hành vi |
|---|---|
| adminSearch | Tìm user/câu hỏi/trận từ index quản trị; tối đa 20 kết quả |
| adminListNotifications | Trang thông báo và unreadTotal của UID lấy từ token |
| adminMarkNotificationsRead | Operation đánh dấu một ID hoặc toàn bộ tới cutoff đã xác nhận |
| adminListAudit | Snapshot có lọc actor/action/target/result/từ khóa/ngày |
| adminExportReport | Tạo bằng requestId; nhận bằng reportId qua cùng callable |

Mọi nhánh, kể cả nhận báo cáo đã tạo, dùng guard kiểm tra token, claim boolean true,
Auth hiện tại, disabled/revoked và accountAccess active. Browser không truyền actor UID.
Index email, event, inbox, audit, snapshot và artifact không được client đọc/ghi trực tiếp.
Rules chỉ thêm index event, chưa deploy lên Firebase thật.

## Tìm kiếm

- Chuỗi sau trim dài 2–100 ký tự. Chuẩn hóa dấu tiếng Việt, kể cả đ/Đ.
- Dùng adminUserIndex, adminQuestionIndex và adminBattleIndex; scan có phân trang
  trên server, tối đa 10.000 row/8 MiB/20 giây mỗi index. Vượt giới hạn báo lỗi.
- Index phải ready, không có writer đang thay đổi, và version/sequence phải giữ nguyên
  suốt scan. Không coi một index đang dựng dở là kết quả đầy đủ.
- Kết quả gồm id/label/detail/page/query; page chỉ users/content/battles, query là UID
  hoặc ID nguồn đã kiểm tra. Exact ID/code ưu tiên, sau đó sắp theo ID kết quả ổn định.
- User đã xóa bị loại; tên/email được đọc lại để áp dụng trạng thái hiển thị hiện tại.
  Không trả options, đáp án, lựa chọn đối thủ, raw record hoặc token.

## Thông báo theo admin

Worker đọc adminActivityIndex và adminAudit, gồm đăng ký, kết quả học, kết quả trận
và thao tác quản trị thành công/thất bại/cần phục hồi. Không tạo nội dung mẫu.
Thông báo trận dùng room ID nên hai participant không tạo hai notice. Đọc thông báo
vẫn có audit nhưng không sinh notice mới, tránh vòng lặp unread.

Event bất biến tại adminNotificationEvents. ID suy từ loại + nguồn; transaction
create-once giữ publishedAt qua retry/backfill. Nội dung dùng template server, không
chép email, tên cũ của deleted user, lựa chọn hay payload nguồn.

Hộp thư cá nhân lưu tại adminNotificationInboxes/{uid}, gồm revision, throughAt và
readAt/expiry của từng ID. API kết hợp catalog event với trạng thái của đúng UID;
không tải trạng thái của admin khác hoặc ghi read vào event dùng chung.

- Danh sách phân trang 10/20/50, lọc unreadOnly; unreadTotal tính toàn hộp thư được giữ,
  không chỉ trang đang mở. Snapshot ràng buộc UID/filter/page size/read revision.
- Mark all dùng asOf của lần lấy danh sách, so với publishedAt. Một kết quả nghiệp vụ
  đến muộn được publish sau cutoff vẫn unread, dù timestamp gốc cũ hơn.
- Adapter giữ cutoff và requestId cũ khi retry, kể cả sau khi danh sách đã refresh.
  Transaction chỉ tăng read revision khi trạng thái thay đổi; mất ACK không cộng lại.
- Event giữ 30 ngày theo thời gian nghiệp vụ. Bootstrap bỏ lịch sử ngoài khoảng này.
  Giới hạn 5.000 event/read ID đang giữ; vượt giới hạn báo lỗi rõ.
- Worker quét 25 source row/page, tối đa 2 page/lượt, checkpoint theo timestamp + key
  để không bỏ các row trùng timestamp. Tối đa 10.000 row mỗi phase nguồn.
- Lease 90 giây; writer mất lease bị chặn, owner chết khởi động lại scan. Published ID
  ổn định nên scan lại không tạo notice hoặc reset read state.
- Cleanup tối đa 25 event hết hạn và 5 inbox/lượt; watermark cá nhân được giữ lại.
  Việc dọn cần worker chạy; API tự loại event đã hết hạn ngay cả khi chưa dọn.

Chưa hoàn tất discovery đầu tiên thì trả notifications-not-ready. projectionAsOf/lagMs
cho biết mốc của vòng quét hoàn tất; tổng danh sách là tổng event đã publish, không
cam kết mọi nguồn đang thay đổi đã được bắt kịp. Header tải lại khi mở hoặc Refresh;
đây là thông báo trong app quản trị, không gửi push FCM.

## Audit

Mutation và tạo export ghi một audit theo operation ID. Công cụ role server dùng cùng
writer. Actor là UID hoặc server_operator; record gồm action, target, thời gian server,
lý do đã lọc, kết quả và operation ID. Không copy request/response/Auth record vào audit.
Lý do có dấu hiệu password/token/private key/JWT được che cả trong audit và input lý do
của operation. Không thể tự sửa/xóa audit bằng web.

Writer có version và ticket; list kiểm tra trước/sau scan, writer crash được recovery
loại ticket sau 90 giây. Query theo at và key, hỗ trợ timestamp trùng, gồm ngày cuối theo
Asia/Ho_Chi_Minh. Mặc định chỉ trong retention 365 ngày; tối đa 366 ngày khi lọc.
Snapshot 15 phút gắn actor/filter. Scan tối đa 10.000 row/8 MiB/20 giây; không cắt tổng.
UI giữ modal hiện có, thêm tìm actor/action/target/reason, kết quả, ngày và phân trang.

## Export và nhận báo cáo

Một callable có hai request loại trừ nhau:

1. {requestId, kind, query, range, reason?} tạo operation và artifact riêng tư. Response
   report chỉ gồm id/filename/total/asOf/expiresAt. Operation/checkpoint không giữ rows.
2. {reportId} kiểm tra quyền hiện tại, quyền sở hữu UID, expiry và privacyRevision, rồi
   trả columns/rows. Nhận báo cáo tính vào read budget; tạo tính vào 5 export/phút.

Metadata retry cũng kiểm tra artifact hiện tại. Sau expiry hoặc khi tài khoản bị xóa
làm đổi privacyRevision, không trả bản dữ liệu cũ từ operation JSON. Artifact không có
URL công khai; cleanup dùng expiresAt. Mỗi artifact giữ 15 phút. Operation giữ metadata
7 ngày rồi compact tombstone; audit giữ 365 ngày như nền tảng hiện có.

Artifact ID là operation ID. Crash sau khi ghi nhưng chưa nhận ACK đọc lại artifact cũ,
không dựng lại từ dữ liệu đã đổi. Audit ghi sau capture; lỗi audit được recovery từ
operation terminal. Cùng requestId/payload chỉ một artifact và audit. Đổi payload với
ID cũ bị từ chối. Adapter giữ intent cho tới khi nhận rows thành công, kể cả timeout ở
bước nhận; khôi phục phiên không tự tải file xuống.

| Báo cáo | Bộ lọc và nội dung |
|---|---|
| Users | q/status của bảng; UID, mã, tên, email, trạng thái, rating/xu chỉ đọc, ngày tạo |
| Questions | q/status/skill/difficulty; mã, prompt, skill, difficulty, status, version; không xuất đáp án |
| Battles | q/status/mode/skill và range nếu có trong query; người chơi đã áp dụng privacy, điểm, lý do, thời gian |
| Analytics | range/skill/granularity và generation đang hiển thị; KPI, denominator, tăng trưởng, coverage, series và skill |

Users/Questions không có bộ lọc ngày trên bảng, nên range chung không âm thầm lọc bớt
hai báo cáo đó. Battles chỉ áp dụng range khi query của bảng có range. Daily/private
báo chưa hỗ trợ. Các báo cáo bảng tạo snapshot mới với đúng bộ lọc, đọc hết các trang
trên server; asOf công bố mốc nguồn/capture. Dữ liệu có thể khác một bảng chưa refresh
nếu nguồn đã đổi sau lúc mở trang. Analytics pin generation bất biến để khớp số đang xem.

Giới hạn: tối đa 5.000 dòng CSV, 1 MiB CSV UTF-8, dưới 2 MiB JSON, capture tối đa 20 giây.
Vượt giới hạn trả report-too-large/report-timeout và yêu cầu thu hẹp filter; chưa có job
cho báo cáo lớn, không âm thầm lấy trang đầu. CSV có BOM UTF-8, CRLF, quote/escape đúng;
string có prefix công thức =/+/-/@ kể cả sau whitespace/control được thêm apostrophe.
Numeric giữ kiểu số. Thứ tự cột cố định theo kind; Analytics có Section để phân biệt
KPI/series/skill, tỷ lệ 0–100 và N/A khi mẫu số/lịch sử không đủ.

## Kiểm tra và vận hành

Trong Backend/functions: node tools/run-admin-tests.mjs --workspace hoặc toàn bộ
npm.cmd run test:admin; browser dùng npm.cmd run test:admin:web. Các launcher ép
demo project/host và xóa credential thật khỏi môi trường fixture.
Biên bản kết quả cuối tại ADMIN.md. Không dùng fixture/tiêm lỗi trên Auth/RTDB thật.

dev:local tự chạy worker mới qua runAdminMaintenance. Vẫn cần khóa Admin SDK hợp lệ
ở Backend/server/.env và giữ terminal/máy chạy. Deploy Rules/index/Functions, smoke test
Firebase thật, Android trên thiết bị và quota production thuộc mốc nghiệm thu sau.
