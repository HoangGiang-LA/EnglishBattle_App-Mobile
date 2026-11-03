# Admin Bước 4 — giám sát thi đấu và hoạt động

Cập nhật: 03/11/2026. Phạm vi local/Spark và Emulator; chưa deploy hoặc nghiệm thu
Firebase/Android thiết bị thật. Bước này thêm 3 API nghiệp vụ, tổng 15/21 API.

## API và dữ liệu nguồn

| API | Nguồn và hành vi |
|---|---|
| `adminListBattles` | Snapshot của `adminBattleIndex`, dựng từ `battleRooms`, `battleResults`, `battleLogs` |
| `adminGetBattle` | Đọc trực tiếp một room, kết quả và log hiện tại; không chạy engine hoặc settlement |
| `adminListActivities` | Snapshot `adminActivityIndex`; đăng ký từ `users/uid/createdAt`, học/thi đấu từ `studyActivities/uid/eventId` |

Guard, validator, rate limit dùng chung với Bước 1. UID actor lấy từ token; mỗi lần đọc
vẫn kiểm tra claim boolean hiện tại, disabled, accountAccess và phiên bị thu hồi.
Không thêm API hủy trận, đảo kết quả hoặc chỉnh rating/xu. Các API này không ghi audit
thay đổi vì chỉ đọc; dữ liệu tạm/rate limit chỉ nằm trong các nhánh admin.

## Ánh xạ trạng thái và điểm

- Room `ready` → `ongoing`, phase `ready`; `active` → `ongoing`, phase `playing`.
  Backend hiện không lưu riêng trạng thái reconnecting. Phase `reconnecting` chỉ là
  chỉ báo heartbeat của room active đã quá `RECONNECT_MS` (30 giây) và đang chờ
  engine xử lý. API đọc không tự quyết định trận đã kết thúc khi quá deadline.
- Room `completed` với lý do `answers`, `leave`, `disconnect`, `account_unavailable`
  → UI `completed`. `both_left`, `both_disconnected`, `ready_timeout` → UI `abandoned`.
  Đây là cách nhóm để giám sát, không sửa outcome/grant hoặc định nghĩa KPI Bước 5.
- Điểm live chỉ tính vòng trước `currentIndex` có câu trả lời của cả hai người.
  Không tính đúng/sai của người vừa nộp khi vòng hiện tại chưa được chốt.
- Điểm cuối lấy `finish.correct`; dữ liệu cũ thiếu trường này mới dùng
  `battleResults.correctCounts`. Outcome win/loss/draw/left lấy giá trị đã lưu,
  không suy ra người thắng từ điểm khi trận kết thúc do bỏ cuộc.
- `endedAt` và `endReason` lấy từ finish, fallback kết quả settled cho lịch sử cũ.
  Settlement hiển thị `not_due`, `pending`, `settled`; admin không thực hiện settlement.
- Hai người chơi sắp theo UID tăng dần để giữ hai cột ổn định. Mã hiển thị giữ UID gốc.
  Category trận dựa trên các câu đã đóng băng; nhiều kỹ năng hoặc chưa phân loại dùng `mixed`.
- `playStartedAt` lấy `questionTimings/0/openedAt` hoặc event `started` thật. Thiếu thì
  trả null và UI báo chưa ghi nhận/chưa bắt đầu; không dùng giờ tạo để giả giờ bắt đầu.
  `startedAt` dùng cho sắp xếp/lọc: giờ bắt đầu đã biết, fallback giờ tạo room.

## Timeline, danh tính và bí mật

Chỉ trả các loại event có thật được engine ghi: joined, started, answered,
round_resolved, left và các lý do kết thúc đã biết. Message là mô tả cố định theo
loại event; không truyền message tùy ý từ dữ liệu nguồn. Event ID/thời gian giữ
nguyên, actorId chỉ có nếu UID thuộc hai người chơi. Không tạo log để lấp lịch sử thiếu.
Room đang chơi chỉ dùng events trong chính snapshot room; `battleLogs` là fallback
bổ sung cho room đã kết thúc. Engine giữ giới hạn lịch sử, nên timeline có thể không đầy đủ.

DTO chỉ chứa trường được phép. Không có questions, keys, reviews, answers,
selections, đúng/sai vòng chưa chốt, session ID, email hoặc token thiết bị.
Participant chỉ gồm id/code/name/status; status phản ánh accountAccess, không phải
một kiểm tra đăng nhập thay cho Auth guard.

Index và snapshot không lưu tên/email. Mỗi trang/chi tiết đọc danh tính hiện tại
từ hồ sơ và accountAccess; deleted/mất access được hiển thị “Tài khoản đã xóa”.
Snapshot tạo trước khi xóa cũng được ẩn danh khi đọc lại. UID và kết quả lịch sử vẫn giữ.

## Hoạt động và chống lặp

- ID `act_<sha256(type, uid, sourceId)>`; đăng ký dùng sourceId = UID, học/thi đấu
  dùng attemptId. Reporting hoặc settlement chạy lại cập nhật cùng một dòng.
- Một trận tạo hai hoạt động theo hai UID, nhưng danh sách trận có một room.
- Hoạt động học gồm PRACTICE/TEST/DAILY thật; DAILY ở đây là thử thách học,
  khác với thi đấu ngày chưa triển khai. `abandoned` được ghi đúng là bỏ dở.
- `answered` từ study activity, `correct` từ entry; không tính trung bình phần trăm.
  Category hoạt động dựa trên các kỹ năng đã có câu trả lời; nhiều hoặc chưa có
  kỹ năng được gắn `mixed`. Không dùng danh sách này để suy ra completion rate.
- Chỉ có sự kiện kết thúc mà reporting đã ghi, cùng đăng ký có createdAt thật.
  Chưa thêm sự kiện bắt đầu; lịch sử thiếu thời gian không được gán Date.now để bù.
- Search trận theo ID/mã; search hoạt động theo UID/source ID/mô tả cố định.
  Tìm kiếm tên/email toàn workspace thuộc Bước 6.

## Worker, phân trang và phục hồi

`runAdminMaintenance` gọi độc lập hai tác vụ mới, đồng thời với các tác vụ admin cũ.
Launcher `npm.cmd run dev:local` đã chạy worker này. Không phụ thuộc database trigger
để chế độ Spark dùng Auth/RTDB thật và Functions Emulator vẫn cập nhật được index.

- Room: tối đa 25 nguồn mỗi lượt, checkpoint theo key.
- Hoạt động: liệt kê hồ sơ UID bằng query một hồ sơ; đọc riêng tối đa 50 activity
  mỗi query, tối đa 10 vòng và 200 activity mỗi lượt. Không đọc root studyActivities.
  Hồ sơ được giữ sau xóa mềm là nguồn liệt kê UID lịch sử; tài khoản Auth chưa provision
  chưa có sự kiện đăng ký nghiệp vụ. Dữ liệu mồ côi ngoài vòng đời provisioning cần xử lý riêng.
- Lease 90 giây, gia hạn khi còn dưới 30 giây. Sequence của lease chặn ghi cũ
  đè lên hàng mới. Lỗi giữ checkpoint, ready=false; chạy lại ghi cùng ID.
  Lease hết hạn khi worker chết khởi động lại vòng khám phá trước khi ready.
- Control tại `adminMonitoringControl/{battles|activities}` gồm checkpoint, sequence,
  asOf, scanStartedAt, lastBatchAt và errorCode cố định. Không lưu exception/raw payload.
  Dữ liệu nguồn sai ngăn ready, cần sửa nguồn rồi để worker chạy lại.
- Danh sách chỉ phục vụ sau khi hoàn tất vòng khám phá đầu tiên. `asOf` là lúc bắt
  đầu vòng khám phá hoàn tất gần nhất; `lagMs` cho biết độ trễ. Đây là index cập nhật
  tuần tự, không phải snapshot nguyên tử của toàn bộ RTDB ở cùng một thời điểm.
  Khi dữ liệu lớn, độ trễ gồm toàn bộ vòng quét và thời gian giữa các lượt worker.
- Snapshot 15 phút, gắn UID admin/loại/bộ lọc/kích thước trang. Sắp thời gian giảm dần,
  ID tăng dần khi bằng thời gian; trang 10/20/50, tổng chính xác trên index đã đọc.
  Đọc index 100 hàng/query, tối đa 10.000 hàng và 8 MiB snapshot; vượt thì báo lỗi.
  Snapshot không được công bố nếu worker đang ghi hoặc sequence đổi trong lúc đọc.
- Trang sau giữ snapshot. Refresh/trang 1 tạo snapshot mới. Chi tiết luôn đọc room
  hiện tại và tự tải lại mỗi 10 giây trên web. Tên vẫn được kiểm tra lại mỗi trang.
- Không xóa cứng room/study activity trong vòng đời hiện tại. Việc dọn nguồn/migration
  hoặc rebuild bằng cách xóa index cần quy trình riêng; không có nút reset từ trình duyệt.

## Web và phạm vi để sau

Giữ 5 trang. Battles dùng API thật, có nút **View activities** để mở danh sách
đăng ký/học/thi đấu ngay cả khi Dashboard còn chờ API Bước 5.
Daily/private báo `unimplemented`, không hiển thị trận mẫu khi API lỗi.
Dashboard/Analytics, search chung, thông báo, xem audit và CSV tiếp tục thuộc Bước 5–6.
Rules vẫn chặn client đọc index quản trị, room, kết quả và đáp án trực tiếp.

## Kiểm thử local

Chạy trong `Backend/functions`:

```powershell
node tools/run-admin-tests.mjs --monitoring
npm.cmd run test:admin
npm.cmd run test:admin:web
```

Launcher xóa thông tin credential kế thừa và bắt buộc project `demo-englishbattle-admin`,
Auth 19299 / Database 19200 / Functions 15003. Fixture chỉ ghi vào namespace Emulator.
QA dành 60 giây cho Firebase CLI khám phá function khi khởi tạo worker trên máy.
Launcher local chờ từng entrypoint khởi động bằng request không đăng nhập, không
gửi lại dồn dập mỗi 2 giây; timeout gọi API nghiệp vụ trên web vẫn là 30 giây.
Kiểm thử bao gồm matchmaking thật, settlement/reporting retry, 63 room, 223 hoạt động,
snapshot/filter/ngày cuối, che bí mật, xóa mềm, mất acknowledgement và lease hết hạn.
Kết quả hồi quy/trình duyệt được ghi ở biên bản cuối trong `ADMIN.md`.
