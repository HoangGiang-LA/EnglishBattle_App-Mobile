# Notifications — gửi thông báo và tặng xu

Trang mới của web admin: `#/notifications`. Dùng Firebase Auth và quyền admin hiện tại như các trang khác. Backend và worker tiếp tục chạy trên máy chủ dự án; Android gọi API HTTPS qua Cloudflare Tunnel, không cần FCM hoặc nâng Firebase Spark lên Blaze.

## Thao tác

- Chọn **Notification** hoặc **Coin gift**.
- Chọn **All active accounts** hoặc **Selected accounts**. Tìm tài khoản theo tên/email/UID, chọn tối đa 50 tài khoản trong một đợt chọn riêng; lựa chọn được giữ khi tìm kiếm hoặc đổi trang. Gửi tất cả được worker quét theo từng batch, không bị giới hạn 50 tài khoản.
- Nhập tiêu đề, nội dung, trang mở khi chạm thông báo và lý do nội bộ. Quà xu mở trang Wallet; số xu là số nguyên từ 1 đến 1.000.000 **cho mỗi tài khoản**.
- **Review send** hiển thị lại nội dung, phạm vi và số xu trước **Confirm send**. Lý do chỉ vào audit, không nằm trong thông báo của người học.
- **Recent sends** hiển thị 20 đợt gần nhất, tự làm mới mỗi 5 giây: trạng thái, số tài khoản đã xử lý, đã nhận, hộp thư nhận tin và bị bỏ qua. `Delivered` của đợt quà là số ví nhận xu; `Inboxes` là số hộp thư nhận thông báo kèm quà.
- Khi kết quả gửi chưa rõ do mất mạng/timeout, form giữ nội dung và chỉ cho **Retry same request**. Request ID/payload được adapter giữ trong sessionStorage theo UID và phục hồi khi tải lại, tránh tạo quà xu lần nữa.

## Nhận thông báo trong Android

`setNotificationPreference` nhận `{enabled, accountUid}`. Server kiểm tra phiên Firebase còn hợp lệ, tài khoản active và `accountUid` trùng UID đã xác thực. Trường này chặn yêu cầu cũ của tài khoản trước nếu người dùng đổi phiên trong lúc request đang chờ; nó không cho phép chọn UID người nhận khác.

Android Repository lưu lựa chọn chờ đồng bộ; ViewModel đồng bộ khi bật/tắt, quay về app hoặc có mạng trở lại, có nút thử lại nếu lỗi. Công tắc bật sau khi đã có quyền Android **và** server xác nhận. APK cũ chưa đồng bộ lựa chọn cần được cập nhật.

Quyền nhận tin admin được lưu tại `notifications/{uid}/_settings/enabled`; thiếu giá trị nghĩa là **tắt**. Endpoint cũng cập nhật `userSettings.notificationsEnabled` để phản ánh lựa chọn. Worker kiểm tra và chèn thông báo trong **cùng transaction trên hộp thư của tài khoản**. Vì vậy, sau khi thao tác tắt đã được server xác nhận, thông báo admin mới không thể được chèn xen qua thao tác tắt. Các tin đã nhận trước đó được giữ; bật lại không gửi bù các đợt đã bị bỏ qua.

Khi mất mạng, tùy chọn trên thiết bị có hiệu lực với hiển thị ngay; server áp dụng khi đồng bộ thành công. UI báo rõ lỗi/chờ đồng bộ, không báo bật thành công khi server chưa xác nhận. Đây là tùy chọn theo tài khoản; thiết bị đang dùng gửi thay đổi cho đúng UID.

Thông báo admin ghi vào `notifications/{uid}/{admin_campaignId}`, cập nhật bộ đếm chưa đọc và xuất hiện trong mục **Thông báo** của ứng dụng. `_settings` không phải một thông báo, không được tính vào tổng/chưa đọc hoặc trả về danh sách. Luồng này không triển khai push khi app đóng.

Tắt nhận thông báo **không chặn tặng xu**: tài khoản đủ điều kiện vẫn nhận xu và lịch sử ví, nhưng không nhận tin kèm quà. Tài khoản bị khóa, xóa, không còn Auth hoặc đang có cập nhật quản trị dở sẽ bị bỏ qua. Gửi tất cả bỏ qua tài khoản được provision sau thời điểm tạo đợt gửi; `provisionedAt` lưu mốc mili giây vì metadata tạo tài khoản từ Admin SDK chỉ có độ chính xác giây.

## Chống trùng và phục hồi

- `adminCreateCampaign` là operation có requestId, fingerprint, audit và kiểm tra quyền. `adminListCampaigns` là API chỉ đọc, trả 20 đợt mới nhất qua allowlist.
- `runCampaignMaintenance` được gọi từ `runAdminMaintenance`, vốn đã chạy trong worker của `start:mobile`/`dev:local`. Mỗi lượt nhận tối đa 3 đợt, mỗi đợt tối đa 10 tài khoản, lease 90 giây và checkpoint sau từng tài khoản.
- Mỗi người nhận có receipt ở `adminCampaignDeliveries/{campaignId}/{uid}`. Nếu worker dừng giữa chừng, lượt sau tiếp tục từ checkpoint và dùng lại cùng receipt/grant ID.
- Quà xu dùng transaction trên `userSettlements/{uid}`, cùng nguồn số dư chuẩn của học tập/thi đấu; ví dùng `appliedGrants`, lịch sử xu và reward grant dùng khóa ổn định `admin_{campaignId}`. Retry hoặc hai đợt chạy đồng thời không cộng trùng và không ghi đè số dư của nhau.
- Lỗi tạm thời đưa đợt gửi về `retrying`. Thu hồi quyền hoặc phiên admin chặn các lượt gửi tiếp và chuyển thành `failed`; số đã giao vẫn được giữ. Đợt gửi không phải giao dịch hoàn tác toàn bộ: các quà đã cộng không bị tự thu hồi khi một người nhận sau đó lỗi. Nếu lỗi xảy ra sau khi đã commit một phần hiệu ứng của tài khoản hiện tại, cần kiểm tra receipt/grant trước khi xử lý vận hành, không tạo đợt mới để thay thế một cách mù quáng.

## Vận hành và kiểm thử

Sau khi cập nhật mã, khởi động lại các tiến trình hiện có để nạp API/worker mới:

```powershell
# Từ thư mục gốc, cho Android và tác vụ nền
npm.cmd --prefix Backend/functions run start:mobile
# Web admin local (Functions Emulator + worker + admin server + Vite)
npm.cmd --prefix frontend/admin-web run dev:local
```

Nếu đang chạy cả hai launcher, giữ cách vận hành hiện có của dự án và tránh chạy trùng tiến trình trên cùng cổng; không dừng tiến trình khác chỉ để chạy kiểm thử. Cài APK Android mới, mở Cài đặt và đồng bộ lựa chọn thông báo trước khi thử gửi. Không đưa khóa Admin SDK vào web hoặc APK.

Firebase thật cần hai index `createdAt` và `nextRunAt` tại `adminCampaigns`. Nếu thiếu, lịch sử không tải được và worker không lấy được các đợt đang queued. Chỉ có index trong file Rules của repository chưa đủ: index phải tồn tại trên database đang dùng. Ngày 14/11/2026 đã bổ sung hai index này trên project thật, xác minh mọi quyền đọc/ghi và các quy tắc khác được giữ nguyên; hai đợt cũ tiếp tục xử lý bằng ID ban đầu.

Để kiểm tra hoặc bổ sung index trên môi trường máy chủ hiện có, chạy trong `Backend/functions` sau khi build:

```powershell
npm.cmd run indexes:campaigns:check
npm.cmd run indexes:campaigns
```

Helper đọc chính policy đang chạy, lưu bản sao trong `lib/diagnostics`, chỉ hợp nhất hai index, kiểm tra policy chưa bị thay đổi trước khi lưu và đọc lại để xác minh. Không dùng toàn bộ file Rules trong checkout để thay thế policy thật. Có index rồi thì lệnh không ghi lại. Nếu backend thiếu index, API trả lý do `campaign-index-required` để web báo đúng nguyên nhân thay vì báo mất kết nối. Web không hiển thị “No sends yet” khi lịch sử tải lỗi.

Kiểm thử riêng, không dùng Firebase thật:

```powershell
npm.cmd --prefix Backend/functions run test:admin -- --campaigns
npm.cmd --prefix Backend/functions run test:mobile
npm.cmd --prefix frontend/admin-web test
npm.cmd --prefix frontend/admin-web run build
npm.cmd --prefix frontend/admin-web run test:e2e -- notifications.spec.ts
```

Suite Firebase dùng project `demo-englishbattle-admin`, Auth `19299`, Database `19200`, Functions `15003`; launcher xóa cấu hình credential thật khỏi môi trường kiểm thử. Kiểm tra phân quyền, hợp đồng đầu vào, chọn/tất cả tài khoản, opt-in/opt-out/chưa cấu hình, bộ đếm/read state, quà cho tài khoản tắt thông báo, retry, worker bị ngắt, hai quà đồng thời, thu hồi admin và đồng bộ nhầm UID. Playwright kiểm tra desktop/mobile với dữ liệu demo riêng.
