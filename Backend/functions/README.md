# Backend học tập, thi đấu và tác vụ nền

Nền tảng backend admin Bước 1: [guard, hợp đồng, operation và QA](ADMIN.md).
Quản lý danh mục và câu hỏi Bước 3: [phiên bản, quan hệ, TTS và phân trang](ADMIN-CONTENT.md).
Giám sát Bước 4: [trận thật, timeline, hoạt động và worker](ADMIN-MONITORING.md).
Dashboard/Analytics Bước 5: [KPI, cohort, mixed-skill và generation tổng hợp](ADMIN-ANALYTICS.md).

Thi đấu nhanh, kết nối lại và kết quả bất biến: [luật và vận hành](BATTLE.md).
Bảng xếp hạng và thông báo: [API, phân trang và phục hồi](COMMUNITY.md).
Thống kê theo kỳ, thời lượng học và lịch sử: [REPORTING](REPORTING.md).
Kiểm thử tích hợp toàn mục 1: [cách chạy](../tests/be1/README.md) và
[biên bản nghiệm thu](../tests/be1/ACCEPTANCE.md).

## Chạy trên Spark khi chưa deploy

Trong `frontend/admin-web`, chạy `npm.cmd run dev:local`. Lệnh build TypeScript,
khởi động Functions Emulator và worker `tools/learning-worker.mjs` cùng server
admin/web. Worker là tiến trình riêng dùng cùng khóa Admin SDK trong
`Backend/server/.env`; không có HTTP endpoint cho phép gọi bảo trì công khai.
Auth và Realtime Database tiếp tục dùng Firebase thật.

Giữ máy tính, Internet và terminal chạy. Worker kiểm tra công việc mỗi giây,
không chồng các lượt chạy. Khi tắt máy, không có server local để xử lý ngay;
khi chạy lại, worker tiếp tục từ công việc lưu trong database. Sau khi sửa
TypeScript, build lại Functions; worker tự khởi động lại khi output thay đổi.

## Quy tắc xử lý

- Mỗi câu tối đa 30 giây. App gửi lựa chọn ngay lúc bấm đáp án qua
  `saveAttemptSelection`, chưa công bố đáp án đúng. Xác nhận sớm chấm ngay.
  Hết giờ chấm lựa chọn cuối server nhận trước deadline dù chưa xác nhận;
  chưa có lựa chọn thì sai. Lựa chọn đến sau deadline không thay đổi kết quả.
- Worker chuyển câu theo deadline gốc, xử lý bù nhiều câu nếu bị gián đoạn.
  `expectedIndex` ngăn yêu cầu chuyển câu cũ bỏ qua câu mới.
- Xác nhận câu cuối chuyển ngay sang `waiting`, không cần gọi `advance` hoặc
  chờ hết đồng hồ; sau đó tự finalization và lưu kết quả.
  Quy tắc thưởng hiện có vẫn là hoàn tất đủ số câu đã được xử lý, kể cả timeout.
- Daily còn dở tại 00:00 `Asia/Ho_Chi_Minh` thành `abandoned`, không thưởng và
  không chiếm lượt ngày mới. Phiên đã hoàn tất trước nửa đêm được phép phục hồi
  settlement sau đó. Không hồi tố hoàn thành một daily còn dở của ngày trước.
  Quyết định hết hạn kiểm tra lại trạng thái trong transaction, để snapshot cũ
  từ worker hoặc yêu cầu tải lại không hủy phiên vừa hoàn thành đúng hạn.
- Đáp án và quyết định terminal cùng nằm trong transaction của attempt;
  `attemptAnswers` là bản sao phục vụ đọc. Kết quả terminal đầu tiên được giữ.
- `userSettlements` quyết định thưởng một lần. Ví, ledger, tiến độ, kỹ năng,
  thành tích, daily và review đều có thể chạy lại an toàn. Chỉ đặt
  `settlementVersion: 1` sau khi tất cả bản sao đã ghi thành công.
- Yêu cầu hoàn tất cùng phiên dùng chung xử lý khi trùng outcome trong một
  tiến trình; outcome khác được xếp sau lượt đang chạy. Tránh các projection
  local hủy transaction SDK của nhau. Quyết định giữa nhiều tiến trình vẫn do
  transaction canonical giữ; xử lý lỗi được giải phóng để lần retry tiếp tục.

## Hàng đợi và phục hồi

`learningWork/{sha256([uid, attemptId])}` lưu deadline, revision, lease và số
lần retry. Worker nhận tối đa 25 công việc/lượt, lease 90 giây, retry tăng dần
1–60 giây. Một phiên lỗi không chặn các công việc khác. Cần index
`learningWork/.indexOn = ["dueAt"]`, client vẫn không được đọc/ghi hàng đợi.

Job đang được worker giữ nằm ngoài truy vấn các job đến hạn. Yêu cầu mới từ
app được lưu ở `wakeAt` và revision, rồi xử lý sau khi trả lease; không để job
đang chạy chiếm hết nhóm 25 job. Lỗi nhận job hoặc lưu retry được cô lập theo
job; nếu không lưu được retry, job vẫn tồn tại để nhận lại sau khi lease hết.

Discovery duyệt phân trang danh sách tài khoản và lịch sử, lưu cursor tại
`learningMaintenance/discovery`, tối đa 8 trang/lượt, 50 bản ghi/trang. Nó bổ sung
job thiếu, phục hồi phiên cũ chưa có marker và đóng daily mồ côi từ ngày trước.
Kết thúc một vòng thì đợi 60 giây. Khóa tiến trình và cursor cho phép chạy lại
sau crash. Các bản ghi lỗi cấu hình giữ job để sửa rồi retry, không giả lập
đáp án hoặc bỏ qua lỗi lưu.

Discovery lỗi vẫn cho các job có sẵn tiếp tục chạy. Daily cũ thiếu cấu hình
được giữ thành job lỗi có retry để sửa dữ liệu; nó không chặn cursor tìm công
việc của người dùng khác.

Khi có Blaze và deploy: `maintainLearningAttempts` dùng Cloud Scheduler mỗi
phút; `expireDailyAttempts` khởi chạy cùng logic lúc nửa đêm. Scheduler chưa
được deploy trong chế độ local. Thời điểm chấm căn cứ deadline trên server;
việc ghi và hiển thị có thể trễ một lượt worker/scheduler.

## Kiểm thử an toàn

Từ thư mục gốc, dùng JDK 21 rồi chạy:

```powershell
npm.cmd --prefix Backend/functions run test:acceptance
```

Các test xác nhận project demo và Auth/Database ở `127.0.0.1:9199/9100` trước
khi ghi fixtures. Không dùng dữ liệu Firebase thật để tạo phiên thử. Test bao
gồm timeout có/không lựa chọn, câu cuối, restart, midnight, lease, đồng thời,
lỗi ở từng giai đoạn settlement và chạy worker bằng tiến trình thật. Bộ HTTP
chạy Functions riêng ở cổng 5002. Thêm `-- --android` để chạy hai client bằng
adapter SDK thật trên máy ảo; xem hướng dẫn tích hợp ở liên kết đầu tài liệu.
