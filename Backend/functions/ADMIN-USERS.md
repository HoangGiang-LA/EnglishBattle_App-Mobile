# Bước 2 — hồ sơ admin và quản lý người dùng

Cập nhật 03/11/2026. Đã triển khai local/Spark; chưa deploy hoặc nghiệm thu production.

## API và web

| Callable | Hành vi |
|---|---|
| `adminGetProfile` | Hồ sơ Auth thật của actor; email, tên, revision; không trả custom claims |
| `adminUpdateProfile` | Sửa tên của actor, đồng bộ Auth/public profile và index; cần revision gốc |
| `adminListUsers` | Tìm tên/email/UID/mã, lọc active/banned/deleted, tổng chính xác trong snapshot, trang 10/20/50 |
| `adminGetUser` | Chi tiết theo UID, rating/xu từ nguồn hiện có, trạng thái mời và operation đang dở nếu có |
| `adminSaveUser` | Tạo Auth user + mặc định hoặc sửa tên/email; hỗ trợ `resendInvitation` rõ ràng |
| `adminSetUserStatus` | Khóa/mở khóa/xóa mềm có lý do, revision, thu hồi phiên và settlement phiên đang chạy |

Mỗi API vẫn đi qua guard/schema/rate limit của Bước 1. Tất cả mutation dùng operation
và audit theo actor UID. Không có trường input cấp admin, custom claims, rating hoặc xu.
Email đăng nhập của chính actor không sửa qua form Users; Profile chỉ sửa tên.

Web mặc định dùng `FirebaseAdminService` cho Profile và Users; Content đã nối ở Bước 3
(xem `ADMIN-CONTENT.md`). Các nhóm thuộc Bước 4–6
báo chưa triển khai; không fallback sang mock. Demo phải bật riêng bằng
`VITE_ADMIN_DATA_MODE=demo` trước khi chạy Vite. Bố cục 5 trang được giữ lại.
Chế độ thật không có reset demo. Sau đăng nhập mở Users; lưu xong phát sự kiện reload
và xóa snapshot cũ. Header tên admin lấy từ profile thật.

Form giữ nguyên dữ liệu khi lỗi. Adapter lưu requestId/payload trong sessionStorage
theo UID trước khi gửi, dùng lại sau timeout/reload. Không cho gửi payload khác trong
cùng luồng khi kết quả cũ chưa xác định. Khi mở lại workspace, adapter thử lại đúng
intent đã lưu (tối đa 5 intent mỗi lần mở) để xác minh trước khi mở form mới.
Revision lấy từ bản ghi lúc mở form, không đọc
revision mới rồi tự ghi đè. Lỗi quyền đăng xuất workspace; kiểm tra phiên định kỳ 30 giây.

## Bảo vệ admin cuối cùng

`adminMembership/lock` là khóa bền dùng chung giữa API trạng thái và công cụ claim.
Thứ tự khóa: membership trước, user target sau. Khóa không tự hết hạn trong một saga
Auth chưa rõ kết quả. Operation khác trả retry/busy; không đếm admin từ client.

Trước ban/delete hoặc revoke một admin đang hoạt động, server duyệt Auth phân trang và
phải tìm được **một UID khác** có `customClaims.admin === true`, không disabled và có
`accountAccess.status === active`. Banned, deleted, missing access, disabled và claim
chuỗi `"true"` không được tính. Hai thao tác loại bỏ đồng thời không thể cùng vượt guard.
API chặn tự ban/delete, kể cả còn admin khác.

`Backend/server/tools/admin-role.mjs` đã dùng cùng cơ chế bảo vệ, operation và audit.
Grant chỉ cho tài khoản đã provision, đang active và enabled. Revoke thu hồi phiên và
giữ các claim không liên quan. Bootstrap admin đầu tiên vẫn là quyền của operator có
credential server, không có API hoặc nút web tự cấp quyền.

```powershell
# Build trước khi chạy công cụ server; chạy các lệnh dưới trong Backend/server.
npm.cmd run admin -- grant FIREBASE_UID --request-id role-change-001 --reason 'Bootstrap approved administrator'
npm.cmd run admin -- revoke FIREBASE_UID --request-id role-change-002 --reason 'Remove administrator access'
```

Nếu không truyền requestId, công cụ tạo và in ID **trước** hiệu ứng. Retry phải giữ ID
và lý do đó. Audit API có actor UID từ token. Audit công cụ SDK dùng actor
`server_operator`, `actorType: service`, thể hiện quyền vận hành server, không giả UID
của một người đăng nhập. Quy tắc bao phủ API và công cụ được cung cấp; thao tác trực
tiếp trong Firebase Console hoặc code SDK khác có quyền owner nằm ngoài coordinator.
Worker chỉ sửa audit/cleanup cho role operation đã kết thúc; không cấp/thu hồi claim
từ intent trong database. Role operation đang dở phải retry qua công cụ server với
đúng requestId/lý do ban đầu; startup/login không tự cấp quyền.

## UID, provisioning, revision và phục hồi

- UID tạo mới = `admin_` + 40 ký tự đầu operation ID, được giữ qua mọi retry.
- Email có khóa theo hash để hai thao tác admin không tranh cùng địa chỉ.
- Account access mới ở `provisioning` trong lúc tạo. Chưa mở ứng dụng cho tài khoản
  thiếu mặc định. Tạo Auth với UID đã giữ là bước có thể lặp an toàn: không overwrite
  user đã tồn tại. Không tạo/ghi mật khẩu trong API admin.
- `be1/auth/userProvisioning.ts` là logic server dùng chung cho UID đã được cấp quyền
  nội bộ. Callable `ensureUserProfile` vẫn chỉ lấy UID đang đăng nhập từ token.
- Mặc định dùng create-if-missing cho public/private profile, stats, wallet, settings
  và access. Retry không reset balance, rating, progress hay grant.
- `adminUserState/{uid}` giữ canonical identity/revision và `pendingOperation`.
  Reservation trước Auth ngăn provisioning thông thường chép một identity cũ đè lên
  thao tác admin. Public/private profile có revision fence cho read đã bắt đầu trước đó.
- Sau Auth, các projection được ghi có thể chạy lại; commit canonical và checkpoint
  cho phép tiếp tục khi RTDB/index/audit lỗi sau đó. Target/email lock giữ tới kết quả cuối.
- Email trùng được kiểm tra trước hiệu ứng. Nếu Auth xác nhận `email-already-exists`
  do một luồng đăng ký bên ngoài tranh địa chỉ, server chỉ hoàn trả reservation khi
  xác minh identity chưa đổi; form có thể sửa lại email với revision gốc. Kết quả được
  audit là failed, không tự coi một Auth timeout là lỗi trùng email đã an toàn.
- Auth update/revoke có kết quả chưa xác định vẫn là `blocked`, giữ lock và mã operation
  để operator đối soát. Không tự rollback Auth hoặc xóa checkpoint để chạy lại mù.
- User có operation đang dở không làm dừng backfill toàn dự án. Get/list trả identity
  đã biết cùng `pendingOperation`; UI chỉ cho xem, tạm dừng nút sửa/xóa/mời lại.

## Khóa, mở khóa và xóa mềm

Ban/delete ghi chặn `accountAccess` trước, rồi cập nhật Auth và revoke refresh token.
Server lưu fence `sessionsValidAfter`; 18 callable phía người dùng kiểm tra fence này
nên token cũ vẫn bị từ chối sau khi unban. Mở khóa bật Auth trước, mở access sau; không
mở lại tài khoản deleted. Không đổi claim admin qua input Users.

Các attempt active/waiting được bỏ dở bằng finalizer đang có; trận và ticket dùng
coordinator/settlement đang có. Không ghi trực tiếp kết quả, rating hoặc wallet.
Kết quả terminal đã chốt vẫn bất biến; các thay đổi xu/rating hợp lệ do settlement
giữ luật hiện có. Nếu có hơn 100 attempt mỗi trạng thái, operation giữ checkpoint và
tiếp tục từng batch khi retry, không âm thầm bỏ sót phần còn lại.

Xóa mềm giữ Auth UID ở trạng thái disabled, bỏ claim admin, đổi tên và email Auth sang
placeholder riêng; public profile thành `Tài khoản đã xóa`, private email rỗng.
Giữ UID tham chiếu, kết quả, snapshot câu hỏi, grant, ledger, balance, stats và progress.
Đây là chính sách xóa mềm của ứng dụng, không phải xóa mọi dữ liệu lịch sử.

Danh sách mới loại tài khoản deleted theo mặc định; bảng hạng mới lọc theo access.
Snapshot admin cũ bị invalidated ngay tại bước restrict delete, kể cả bước Auth sau
đó lỗi. Mỗi trang còn kiểm tra trạng thái deleted hiện tại để không trả lại email/tên
từ index đang chờ cập nhật. Lịch sử/trận trả tên đối thủ ẩn danh ở thời điểm đọc;
không sửa các kết quả đã đóng băng. Lịch sử thiếu room/UID đối thủ dùng nhãn chung
thay vì công bố lại tên không xác định được trạng thái. Provisioning không hồi sinh deleted.

## Danh sách, index và giới hạn

Worker duyệt Auth 50 user/lượt, lưu cursor/lease 90 giây, đồng bộ index server.
Chỉ đánh dấu ready sau khi duyệt hết lần đầu. Trước đó API báo đang chuẩn bị danh sách,
không trả một tổng rút gọn như tổng chính xác. Số liệu trong index có độ trễ tới lượt
worker tiếp theo; chi tiết user đọc nguồn Auth/RTDB hiện tại.

Snapshot quét index theo key từng 100 dòng, kiểm tra version/writer trước/sau để không
công bố snapshot bị xé giữa các cập nhật. Sau đó lọc và sắp createdAt giảm dần, UID
tăng dần, đóng băng tập kết quả 15 phút. Snapshot/cursor ràng buộc UID admin, query và
page size. Trang 2+ cần snapshot, adapter tạo trang đầu khi cần; trình duyệt không tải root.

Giới hạn hiện tại: scan tối đa 10.000 user, snapshot 8 MiB, response 2 MiB. Vượt giới hạn
trả lỗi, không cắt tổng. Dự án lớn hơn cần phân hoạch index trước khi tăng giới hạn.
Writer index chết được phát hiện sau 90 giây và yêu cầu rebuild đầy đủ trước khi tiếp
tục công bố ready. Index/email/snapshot/operation đều bị Rules chặn đọc trực tiếp.

## Mời và đặt mật khẩu

Sau khi tạo user và mở access đầy đủ, API lưu outbox `adminInvitations/{uid}` rồi trả
`pending`. Worker gọi Firebase Auth `accounts:sendOobCode` với `PASSWORD_RESET` để dùng
email mẫu/hosted action của Firebase. Không tạo thêm dịch vụ SMTP. Có thể cấu hình
`FIREBASE_WEB_API_KEY`; project hiện tại có fallback từ public Web App config.

| Trạng thái | Ý nghĩa |
|---|---|
| pending / sending | Chưa gửi hoặc lời gọi đang chạy |
| sent | Firebase chấp nhận yêu cầu, chưa chứng minh thư đã vào hộp thư |
| failed | Lỗi xác định hoặc người nhận/trạng thái tài khoản không còn phù hợp |
| unknown | Timeout/crash sau khi bắt đầu gửi, có thể đã gửi; không tự gửi lại |

UI chi tiết user hiển thị trạng thái và nút gửi lại có chủ ý. Resend dùng
`adminSaveUser` với `id`, input hiện tại, revision, requestId mới và
`resendInvitation: true`; thao tác cũng được audit. Pending/sending bị chặn, gửi lại
sent/unknown cần cách lần trước ít nhất 5 phút; failed được thử lại ngay. Mỗi operation
chỉ tạo một intent; retry không tạo thêm user hoặc thêm email.

Worker kiểm tra email Auth hiện tại, enabled và active trước khi gửi. Email đã đổi
hoặc tài khoản đã deleted không nhận thư từ intent cũ. Không lưu/log link reset, OOB
code, mật khẩu hay token. Email action được Emulator ghi ở vùng QA riêng để kiểm tra.
Sau 7 ngày, job hoàn tất bỏ địa chỉ email và metadata gửi, giữ trạng thái + operation ID.
Role operation hoàn tất cũng compact sau 7 ngày, giữ fingerprint/tombstone chống chạy lại.
Blocked operation và lock giữ để đối soát; audit theo chính sách 365 ngày của Bước 1.

## Chạy và kiểm chứng

Local/Spark: `npm.cmd run dev:local` tại `frontend/admin-web`; cần credential còn tồn
tại theo `Backend/server/.env`. Auth/RTDB của chế độ này là dữ liệu thật. Worker phải
tiếp tục chạy để backfill, email và phục hồi hoạt động.

```powershell
# Trong Backend/functions
npm.cmd run test:admin
npm.cmd run test:admin:web
```

QA khóa vào project `demo-englishbattle-admin`, Auth/Database/Functions ở
19299/19200/15003; không kế thừa credential thật. Browser QA dùng web 15173 và HTTP
18180, SDK Firebase thật kết nối Emulator, Edge headless. Có kiểm tra reload và hai
browser context. QA config chỉ chấp nhận `demo-*` khi chạy dev server.

Hồi quy người dùng dùng `npm.cmd run test:acceptance` và project Emulator riêng của
bộ BE1. Chưa nghiệm thu deploy, Rules thật, Android thiết bị thật hoặc gửi/nhận email
ở hộp thư thật. Xem biên bản cuối tài liệu nền tảng admin cho kết quả từng bộ test.
