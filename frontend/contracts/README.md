# Hợp đồng tích hợp v1

- `business-rules.v1.json`: chính sách đã chốt và các mặc định triển khai được ghi riêng.
- `mobile.v1.mjs`: JSON Schema cho request/response của 18 callable Android, gồm thống kê theo kỳ, thời lượng và phân trang lịch sử/ví/thông báo; code server nằm trong Backend/functions.
- `admin.v1.json`: ánh xạ 21 callable admin và một `reset` chỉ dùng demo, giới hạn và mã lỗi. `admin.schemas.v1.json` chứa JSON Schema request/response của đủ 21 API; được xuất từ `Backend/functions/src/admin/contracts.ts`. Wire DTO đã bổ sung revision, operation ID, snapshot và phân trang audit/thông báo. Adapter Profile/Users đã nối UI; các nhóm còn lại nối theo các bước tiếp theo.
- `database.rules.proposed.json`: Rules client để kiểm thử bằng emulator, **chưa deploy**.

Giữ nguyên UI theo Figma. Từ 03/11/2026, 12 callable Profile/Users/Catalog/Questions đã có nghiệp vụ thật và adapter web Firebase. 9 callable còn lại đã được export qua guard/schema/rate limit chung và trả `unimplemented`; web không fallback sang mock. Xem `Backend/functions/ADMIN-USERS.md` và `ADMIN-CONTENT.md` cho operation, revision/version, quan hệ nội dung, TTS và QA.

## Quy tắc đã xác nhận ngày 25/10/2026

| Nội dung | Quy tắc |
|---|---|
| Tuần/Tháng | Cùng bảng rating tích lũy hiện tại, gồm tất cả người chơi; không tính rating kiếm được riêng trong kỳ, không reset rating |
| Cả hai mất kết nối | Khi cả hai đều quá thời hạn reconnect 30 giây và trận chưa được chốt: hòa, không đổi rating/xu |
| Thử thách học qua ngày | Đến 00:00 `Asia/Ho_Chi_Minh` thì phiên cũ hết hạn, không thưởng; lượt ngày mới độc lập |
| Thi đấu giai đoạn đầu | Chỉ thi đấu nhanh chạy thật; `daily/create/join` giữ nguyên giao diện và hợp đồng để phát triển sau |
| Tài khoản bị khóa/xóa | Giữ tài khoản bị khóa trong bảng; ẩn tài khoản đã xóa khỏi bảng mới |

Để không đổi DTO/UI, thử thách hết ngày trả `status: abandoned`, `result.outcome: abandoned`, `coins: 0`. `deadlineAt = min(thời điểm bắt đầu câu + 30 giây, mốc 00:00)`. Không hồi sinh phiên đã hết hạn khi client resume; không thay đổi kết quả đã được chốt trước mốc này.

Mặc định triển khai, không phải câu trả lời bổ sung của người dùng: phá hòa thứ tự bảng bằng rating giảm dần rồi UID tăng dần; kết quả cuối bất biến; backend cần xử lý nguyên tử thứ tự sự kiện hoàn tất/mất kết nối. Hai người cùng chủ động thoát và sự cố server còn cần quy tắc vận hành khi viết backend. Trường hợp một bên đã được phân xử cuối thì không mở lại để áp dụng chính sách cả hai mất kết nối.

`findBattle` vẫn nhận đủ 4 kind; backend giai đoạn đầu trả `UNIMPLEMENTED` cho kind chưa hỗ trợ, không tự ghép thành quick. Bản mô phỏng tiếp tục giữ các luồng để xem thiết kế.

## Ranh giới truy cập

Client dùng SDK Auth cho email/password và đọc danh mục published qua RTDB. Hồ sơ nghiệp vụ, làm bài, đáp án, reward, rating, ví và quản trị phải qua server. UID/claim lấy từ token; không nhận rating/xu/đáp án đúng từ client. Server tự kiểm tra `accountAccess` và quyền admin cho từng request, kể cả khi Admin SDK bỏ qua client Rules.

Rules đề xuất: chặn toàn bộ client write; chỉ tài khoản active được đọc danh mục theo query published và dữ liệu cá nhân của mình; chỉ admin có boolean claim `true` và active được đọc view quản trị. Ngân hàng câu/đáp án, bộ đề trận và cấu hình server không đọc trực tiếp, kể cả từ trình duyệt admin. API admin mới được trả đáp án sau kiểm tra quyền. Đây là một đề xuất bảo thủ; tài liệu schema liệt kê quyền có thể cần thêm về sau không đồng nghĩa tất cả các nhánh ấy đang mở trong file Rules này.

Phiên bản câu hỏi: admin dùng integer `1`, RTDB dùng `v1`; adapter đổi giữa hai dạng. Options từ array có ID sang map keyed theo ID, giữ `order`. Không sửa bản `questionVersions`/`questionAnswers` đang được attempt tham chiếu. Admin `ongoing` ánh xạ từ `playing/reconnecting`; không chuyển status UI thành status lưu trữ một cách trực tiếp.

Kiểm thử: [verification](../verification/README.md). Quy trình triển khai tiếp: [bàn giao trước backend](../docs/PRE-BACKEND-HANDOFF.md).
