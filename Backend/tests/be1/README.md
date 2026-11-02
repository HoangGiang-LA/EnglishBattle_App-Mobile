# Kiểm thử tích hợp backend người dùng (mục 1)

## Bộ hiện hành

Tại thư mục gốc dự án, dùng Node 24 và đặt `JAVA_HOME` tới JDK 21:

```powershell
npm.cmd --prefix Backend/functions run test:acceptance
```

Lệnh chạy ESLint, TypeScript, khởi động Auth/Database/Functions Emulator, sau
đó chạy tuần tự các bộ hồi quy hiện hành và kiểm thử HTTP. Có lỗi thì trả mã
thoát khác 0; Emulator được Firebase CLI dừng khi script kết thúc.

Môi trường cố định: project `demo-englishbattle-finalization`, Auth 9199,
Database 9100, Functions 5002, hub 4411, logging 4511, Eventarc 9301, Tasks
9501, tất cả trên `127.0.0.1`. Cổng đang dùng làm lệnh dừng; không tự tắt
dịch vụ khác. Cổng 5001 của `dev:local` không được dùng cho fixture.

Launcher bỏ cấu hình/credential của dịch vụ thật khỏi môi trường con. Test
xác nhận project và địa chỉ emulator trước khi ghi seed hoặc tạo tài khoản.
Không dùng service account hoặc import seed vào Firebase thật cho bài test này.

## Kiểm thử bằng adapter Android thật

Mở Android Emulator, build hai APK debug, đặt `ANDROID_HOME` tới Android SDK
và `ANDROID_SERIAL` tới máy ảo cần dùng (`adb devices`), rồi chạy:

```powershell
cd frontend
.\gradlew.bat --offline --no-daemon assembleDebug assembleDebugAndroidTest
cd ..
$env:ANDROID_SERIAL = "emulator-5554"
npm.cmd --prefix Backend/functions run test:acceptance -- --android
```

Launcher cài APK bằng `install -r`, chạy bộ giao diện/ViewModel hiện có rồi
chạy `FirebaseIntegrationTest`. Test tích hợp dùng
hai FirebaseApp có tên riêng và `useEmulator` cho cả Auth, Database, Functions
trước khi truy cập. `FirebaseAuthRepository`, `FirebaseCatalogRepository`,
`FirebaseGameRepository` và `WireCodec` thật được sử dụng, không thay bằng fake.
Test xác nhận UID của phiên mặc định không đổi; chỉ xóa hai tài khoản QA.

Test này tự bỏ qua khi chạy instrumentation thông thường không có tham số
`acceptanceEmulators=true`. Chỉ launcher trên mới truyền tham số ấy sau khi
khởi động đúng bộ emulator. Hai client trên một máy ảo kiểm chứng tích hợp SDK;
không thay thế nghiệm thu mạng/Wi-Fi/vòng đời trên hai thiết bị vật lý.

## Nội dung kiểm tra

- `profileContent.test.mjs`: provision/sync hồ sơ, Auth email action, lỗi đồng
  bộ có thể retry, nội dung xuất bản và quan hệ cha-con/version/TTS.
- `practice/attemptCompletion.test.mjs`: câu cuối, kết quả terminal và review.
- `practice/learningMaintenance.test.mjs`: timeout, daily hết ngày/race nửa đêm,
  lease/restart/discovery, phục hồi từng projection sau lỗi lưu.
- `practice/progressAchievements.test.mjs`: mốc 19/20/21 và hoàn tất đồng thời.
- `battle/battle.test.mjs`: ghép/hủy, hai phiên độc lập, reconnect, hai người
  mất kết nối/rời trận, kết quả bất biến và hiệu ứng thưởng.
- `battle/battleEffects.test.mjs`: rating sàn, thành tích, notification và
  outbox/sequence khi nhiều backend chạy đồng thời.
- `community.test.mjs`: thứ tự và snapshot phân trang bảng hạng, tài khoản
  bị khóa/xóa, cursor, thông báo/đếm chưa đọc/dọn dữ liệu.
- `dailyAchievements.test.mjs`: mốc 6/7/8 ngày thành công, nguồn dữ liệu hợp lệ,
  phân trang, scan cũ đến muộn, lỗi thông báo/archive và settlement không
  thưởng xu thành tích.
- `reporting.test.mjs`: kỳ tuần/tháng Việt Nam, hơn 50 kết quả, thời gian theo
  từng câu, lịch sử/ledger, nâng cấp và sửa view sau gián đoạn.
- `integration/http.test.mjs`: token và lỗi HTTP của đủ 18 callable, RTDB Rules
  **ở gốc dự án**, Auth → catalog → học → thi đấu → thưởng → thống kê. Có test
  dùng đồng hồ thật chờ 30 giây và worker tiến trình riêng chấm lựa chọn
  đúng/sai/chưa chọn mà không có callback từ app.

`integration/run.mjs` giữ các bộ ghi fixture chạy tuần tự; không chạy chúng
đồng thời trên cùng namespace RTDB. Lỗi lưu được tiêm có chủ đích có thể xuất
hiện trong log; kết luận dựa vào số test thất bại và mã thoát cuối.

Các script cũ trong `user-profile/`, `practice/practiceAttempt.test.mjs` và
`practice/testDailyAttempt.test.mjs` là kiểm tra thủ công từ hợp đồng trước,
dùng các cổng 5001/9000/9099 và kỳ vọng cũ. Chúng không thuộc bộ nghiệm thu
hiện hành; không chạy glob toàn bộ `tests/be1/**/*.mjs` vào stack `dev:local`.

## Kiểm tra bổ sung

```powershell
cd frontend/verification
npm.cmd test
npm.cmd run test:rules
cd ../..
cd frontend
.\gradlew.bat --offline --no-daemon lintDebug testDebugUnitTest
```

`test:rules` kiểm tra Rules đề xuất trong `frontend/contracts` trên cổng
19000. Bài HTTP ở trên mới kiểm tra file `database.rules.json` thực tế của
backend; hai kết quả có phạm vi khác nhau.

Kết quả nghiệm thu theo từng mục và giới hạn kiểm chứng được ghi riêng tại
[`ACCEPTANCE.md`](ACCEPTANCE.md).
