# English Battle — Frontend

## Web admin

Web quản trị nằm riêng trong [`admin-web/`](admin-web/README.md), dùng React + TypeScript + Vite. Khi chưa deploy Functions, chạy `npm.cmd run dev:local` trong thư mục đó, mở `http://127.0.0.1:5173/`. Lệnh khởi động Functions Emulator, worker, server xác nhận quyền và web. Đăng nhập dùng Firebase Auth thật; đủ 21 callable phục vụ 5 trang cùng tìm kiếm, thông báo admin, audit và CSV. Demo là chế độ chọn riêng, không fallback khi API lỗi.

## Android người dùng

Ứng dụng Kotlin + Jetpack Compose, dùng Firebase Authentication và Realtime Database thật. Các luồng học tập, thi đấu nhanh, bảng xếp hạng và thông báo gọi backend trong `Backend/functions`.

## Chạy

Mở thư mục `frontend` trong Android Studio; dùng Gradle JDK 21. Trên máy hiện tại:

```powershell
$env:JAVA_HOME='C:\Users\Acer\.jdks\jbr-21.0.11'
.\gradlew.bat assembleDebug lintDebug testDebugUnitTest
.\gradlew.bat connectedDebugAndroidTest
```

APK: `app/build/outputs/apk/debug/app-debug.apk`.

### Chạy Android với Functions Emulator khi chưa deploy

1. Khởi động các dịch vụ local và giữ terminal mở:

   ```powershell
   cd "D:\Projects\EnglishBattle-full\frontend\admin-web"
   npm.cmd run dev:local
   ```

2. Chờ thông báo web đã sẵn sàng. Trong Android Studio, mở project `frontend`, Sync Gradle, chọn bản `debug` và máy ảo Android (ví dụ `Medium Phone`), rồi nhấn Run.
3. Đăng nhập/đăng ký bằng Firebase thật. App debug tự gọi Functions Emulator ở `10.0.2.2:5001` (địa chỉ máy tính từ máy ảo Android). Authentication và Realtime Database tiếp tục dùng project thật, nên các thao tác nghiệp vụ có thể ghi dữ liệu thật.

Chỉ bản debug cho phép HTTP tới địa chỉ máy tính. Bản release luôn gọi Functions trên cloud. Sau khi deploy, có thể thử cloud bằng bản debug với `./gradlew.bat -PuseFunctionsEmulator=false assembleDebug`; bỏ tham số để trở về Emulator. Cấu hình mặc định này dành cho máy ảo Android; điện thoại thật cần cấu hình kết nối riêng.

## Chế độ dữ liệu

- **Firebase thật (mặc định):** đăng ký/đăng nhập email, đặt lại mật khẩu, đổi tên/email và khôi phục phiên. Danh mục đọc `categories`/`topics` published. Cần bật Email/Password và cấp Rules phù hợp. Lỗi dịch vụ được hiển thị, không chuyển sang dữ liệu giả.
- **Backend:** 18 callable Android đã được export trong `Backend/functions`, chạy trên Functions Emulator khi phát triển. Thông báo trong app đã hoạt động; thông báo đẩy FCM chưa được triển khai.

Tên được đồng bộ từ Auth sang RTDB sau khi lưu; khi mở lại app hoặc có mạng trở lại, app tải lại hồ sơ Auth và gọi `ensureUserProfile` để phục hồi đồng bộ bị gián đoạn. Email mới chỉ được đồng bộ sau khi Firebase Auth đã xác nhận thay đổi. Bước đồng bộ chỉ sửa tên/email và thời điểm cập nhật, giữ dữ liệu nghiệp vụ hiện có.

Đề mới chỉ nhận câu có kỹ năng, chủ đề và bài học được xuất bản, đúng quan hệ. Backend kiểm tra phiên bản, bốn lựa chọn, đáp án/giải thích, đoạn đọc và tài nguyên TTS. Phiên đã bắt đầu giữ snapshot nội dung dù danh mục hoặc phiên bản sau đó thay đổi.

`dev:local` cũng chạy tác vụ nền cho luyện tập, bài kiểm tra và thử thách hôm nay. App lưu lựa chọn ngay khi bấm đáp án. Hết 30 giây, server chấm lựa chọn cuối đã nhận trước deadline dù chưa xác nhận; chưa chọn thì tính sai. Tác vụ nền chuyển câu, kết thúc phiên và khôi phục lưu kết quả/thưởng bị gián đoạn. App đang mở nhận trạng thái mới sau tối đa một lượt polling khoảng 3 giây.

Daily chưa hoàn thành hết ngày bị đóng và không nhận thưởng theo múi giờ `Asia/Ho_Chi_Minh`. Daily đã hoàn thành trước nửa đêm vẫn được phục hồi lưu thưởng nếu server khởi động lại sau đó. Giữ máy tính và `dev:local` chạy để xử lý nền liên tục; khi máy tắt, tác vụ được xử lý bù ở lần khởi động sau. Xem [cách vận hành và kiểm thử tác vụ nền](../Backend/functions/README.md).

Thi đấu nhanh đã có ghép hai người, bộ 10 câu dùng chung, timeout, kết nối lại trong 30 giây và chốt kết quả/thưởng một lần. Hai người cùng chủ động rời trong 3 giây thì hòa; chỉ một người rời thì thua. App giữ session theo thiết bị và polling để server xác nhận kết nối. Thi đấu ngày/phòng riêng giữ giao diện và trả thông báo chưa hỗ trợ từ server. Xem [luật, dữ liệu và kiểm thử thi đấu](../Backend/functions/BATTLE.md).

## Tài liệu bàn giao

Xem [10 nhóm việc, hợp đồng API và các bước kiểm tra](docs/FRONTEND-HANDOFF.md).

Chuẩn bị ngày 25/10: [bàn giao trước backend](docs/PRE-BACKEND-HANDOFF.md), [hợp đồng máy đọc và Rules đề xuất](contracts/README.md), [công cụ kiểm tra/emulator/so export thật](verification/README.md). Các thay đổi dữ liệu/nghiệp vụ giữ nguyên giao diện theo Figma. Chưa viết backend, triển khai Rules hoặc xác nhận toàn bộ dữ liệu cloud.

Giao diện đã được khôi phục về bố cục thiết kế gốc, bỏ XP/level: [phạm vi và giới hạn đối chiếu Figma](docs/FIGMA-RESTORATION.md), [ảnh xem nhanh](docs/figma-restoration-preview.png).

Kết quả kiểm thử trước đây: [QA ngày 24/10/2026](docs/QA-2026-10-24.md). Chế độ học thử, repository mô phỏng và asset câu hỏi demo đã được loại bỏ khỏi app Android. Kiểm thử giao diện xác thực dùng các màn hình độc lập; kiểm thử nghiệp vụ dùng Firebase Emulator riêng.

`contracts/database.rules.proposed.json` là bản Rules đề xuất được kiểm thử bằng emulator, yêu cầu `accountAccess` active và chặn client ghi dữ liệu. Rules gốc deny-all được giữ nguyên; bản đề xuất chưa được triển khai lên Firebase.

## Mã nguồn

Tiến độ tuần/tháng dùng thống kê cả kỳ/kỳ trước từ server, không suy ra từ 50
phiên gần nhất. Biểu đồ dùng phút học; thời gian từng câu được server giới hạn
30 giây, loại thời gian chờ. Lịch sử học/thi đấu và ví xu có tải thêm 25 mục.
Kết quả hiển thị thời lượng; phiên cũ thiếu timing hiển thị chưa có dữ liệu.
Xem [REPORTING](../Backend/functions/REPORTING.md).

Bảng xếp hạng và thông báo đã nối Functions: hai tab cùng rating tích lũy,
phân trang theo snapshot và có vị trí bản thân. Trung tâm thông báo tải thêm,
hiển thị tổng chưa đọc của tài khoản và đánh dấu tất cả; phản hồi cũ không ghi
đè tab hoặc trạng thái đọc mới. Vận hành và API: [COMMUNITY](../Backend/functions/COMMUNITY.md).

`data/` chứa model, repository interfaces, Firebase adapter và DTO codec. `ui/UserViewModels.kt` quản lý trạng thái theo nhóm chức năng; `ui/App.kt` điều hướng, lifecycle và phiên người dùng. Các màn hình có loading/rỗng/lỗi/retry và hỗ trợ cuộn, TTS, kích thước chữ lớn.

Tài khoản và dữ liệu Firebase thật cần được kiểm thử tích hợp trên môi trường staging trước phát hành. App Android không đóng gói ngân hàng câu hỏi hoặc đáp án mẫu; nội dung được tải từ Firebase.
