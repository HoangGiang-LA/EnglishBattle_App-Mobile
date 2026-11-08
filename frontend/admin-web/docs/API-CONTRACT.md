# Hợp đồng dịch vụ admin

Cập nhật: 08/11/2026. Đủ 21 callable nghiệp vụ tại `asia-southeast1`, dùng adapter Firebase mặc định. Phạm vi nghiệm thu hiện tại là local/Emulator; chưa deploy production.

Nguồn chuẩn:

- [Kiểu giao diện và AdminService](../src/domain.ts).
- [Adapter Firebase](../src/data/firebase-service.ts), được tạo cho UID đã xác thực.
- [Ánh xạ callable](../../contracts/admin.v1.json) và [JSON Schema](../../contracts/admin.schemas.v1.json), xuất từ validator runtime.
- [Quy tắc backend và biên bản kiểm thử](../../../Backend/functions/ADMIN.md).

`MockAdminService` chỉ dùng khi chủ động bật demo; lỗi API thật không chuyển sang mock. `reset()` chỉ có hiệu lực ở demo. Bố cục 5 trang được giữ nguyên.

## Phiên và phân quyền

Firebase Auth đăng nhập, provision qua `ensureUserProfile`, rồi HTTP `getAdminSession` xác nhận quyền trước khi mở workspace. Mỗi callable tiếp tục kiểm tra token, claim boolean true và quyền hiện tại trong Auth, disabled, revoked và `accountAccess`; không tin actor UID do browser gửi.

Không đưa Admin SDK hoặc credential server vào bundle. Web dùng SDK callable với token của phiên hiện tại. Thiếu quyền hoặc hết phiên được chuyển về luồng xác thực; phản hồi cũ sau khi đổi tài khoản/bộ lọc không ghi đè dữ liệu mới.

## Phương thức

| Nhóm       | AdminService                                               | Callable                                                                      |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hồ sơ      | `profile`, `saveProfile`                                   | adminGetProfile, adminUpdateProfile                                           |
| Tổng quan  | `overview`                                                 | adminGetOverview                                                              |
| Người dùng | `users`, `user`, `saveUser`, `setUserStatus`               | adminListUsers, adminGetUser, adminSaveUser, adminSetUserStatus               |
| Danh mục   | `catalog`, `saveContent`                                   | adminGetCatalog, adminSaveContent                                             |
| Câu hỏi    | `questions`, `question`, `saveQuestion`, `archiveQuestion` | adminListQuestions, adminGetQuestion, adminSaveQuestion, adminArchiveQuestion |
| Giám sát   | `battles`, `battle`, `activities`                          | adminListBattles, adminGetBattle, adminListActivities                         |
| Tìm kiếm   | `search`                                                   | adminSearch                                                                   |
| Thông báo  | `notifications`, `readNotifications`                       | adminListNotifications, adminMarkNotificationsRead                            |
| Audit      | `audit`                                                    | adminListAudit                                                                |
| Báo cáo    | `exportReport`                                             | adminExportReport                                                             |

Response wire có `serverNow` và payload theo manifest; mutation có `operationId`. Adapter chuyển envelope sang kiểu UI. `notifications` và `audit` trả `Page<T>`; thông báo có thêm `unreadTotal`.

## Phân trang, đồng thời và retry

- Danh sách dùng snapshot/index phía server, trang 10/20/50; snapshot gắn UID, filter và kích thước trang. Adapter giữ snapshot cho các trang tiếp theo. Browser không tải root RTDB để giả offset.
- Profile/user/catalog sửa bằng `expectedRevision`; câu hỏi dùng `expectedVersion`. Xung đột yêu cầu đọc lại, không tự ghi đè.
- Adapter lưu payload và requestId theo UID trong sessionStorage trước mutation. Timeout/reload giữ cùng intent; server dedupe UID + action + requestId và từ chối payload khác.
- Các lần đọc giống nhau đang chờ được dùng chung trong cùng adapter và generation. Kết quả không được cache sau khi hoàn tất; mutation làm đổi generation.
- Audit gắn operation ID, không ghi mật khẩu/token. Trạng thái Auth–RTDB được phục hồi bằng các bước operation, không giả định là một transaction.

## Tìm kiếm, thông báo và audit

Tìm kiếm nhận 2–100 ký tự sau trim, tối đa 20 kết quả từ index riêng tư. Chỉ trả đường dẫn Users/Content/Battles và ID đã kiểm tra. Không trả đáp án hoặc lựa chọn chưa công bố.

Thông báo lấy từ sự kiện server thật, trạng thái đọc riêng cho từng UID admin. `readNotifications(id)` đánh dấu một thông báo; bỏ id dùng cutoff server từ danh sách gần nhất. Retry giữ nguyên cutoff. Event nghiệp vụ đến muộn nhưng publish sau cutoff vẫn chưa đọc.

Audit hỗ trợ từ khóa actor/action/target/reason, kết quả, khoảng ngày và phân trang. Ngày tính theo Asia/Ho_Chi_Minh, gồm cả ngày cuối. Giới hạn nguồn, retention và độ trễ tại [quy tắc Bước 6](../../../Backend/functions/ADMIN-WORKSPACE.md).

## Xuất CSV

`exportReport` dùng cùng callable theo hai bước: tạo bằng requestId nhận metadata, sau đó nhận rows bằng reportId. Mỗi bước kiểm tra quyền hiện tại, chủ sở hữu, hạn 15 phút và thay đổi privacy khi xóa tài khoản. Operation chỉ lưu metadata.

Báo cáo Users/Questions/Battles xuất toàn bộ tập lọc trên server, bỏ page/pageSize/cursor/snapshotId của bảng. Chỉ áp dụng filter ngày khi bảng có filter đó. Analytics giữ range/skill/granularity và generation đang hiển thị. CSV có BOM UTF-8, CRLF, escape dấu quote và chống formula injection.

Tối đa 5.000 dòng, 1 MiB CSV, dưới 2 MiB JSON và 20 giây capture. Vượt giới hạn báo lỗi và yêu cầu thu hẹp bộ lọc; chưa có job báo cáo lớn. Timeout bước nhận giữ intent để retry, khôi phục phiên không tự tải file xuống.

## Nghiệp vụ và lỗi

Rating/xu chỉ đọc; tài khoản deleted không mở lại. Nội dung sửa tạo version bất biến, không thay đề phiên cũ. Listening dùng TTS; audio upload, daily/private, FCM và đảo kết quả trận thuộc phạm vi riêng.

Thống kê thật theo [quy tắc Bước 5](../../../Backend/functions/ADMIN-ANALYTICS.md): active UID distinct trong kỳ, accuracy tổng đúng/tổng slot, completion theo cohort bắt đầu, mixed-skill theo câu thực tế, kỳ trước cùng độ dài. Response công bố asOf/lag/coverage; dữ liệu thiếu hoặc mẫu số 0 trả N/A khi phù hợp.

Adapter ánh xạ hết phiên/thiếu quyền, validation/email trùng, not-found, version conflict, timeout và lỗi tạm thời. Form giữ nội dung khi thất bại; chỉ báo thành công sau khi server xác nhận. Xem [hướng dẫn chạy và kiểm thử](../README.md).
