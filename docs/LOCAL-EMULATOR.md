# Chạy English Battle bằng Firebase Emulator (Spark)

Môi trường này chạy trên máy mỗi thành viên, không deploy, không bật billing,
không dùng khóa Admin SDK thật. Project giả lập cố định: **demo-englishbattle**.
Không chạy đồng thời bộ local này và bộ BE1 QA cũ vì dùng chung cổng.

## 1. Chuẩn bị máy mới

- Node.js **24 LTS** và npm (phù hợp runtime Functions hiện có).
- HTTP server chạy riêng vẫn hỗ trợ Node 22.9+; Web với bộ dependencies hiện tại
  cần Node 22.13+ nếu dùng nhánh 22. Bộ Emulator chọn đúng major 24 để khớp Functions.
- JDK **21**. Setup/Start-Emulators chọn đúng major 21 và chỉ đổi JAVA_HOME/PATH
  trong tiến trình script; không đổi Java mặc định Windows hay Gradle JDK.
- Git; PowerShell 5.1 hoặc 7.
- Android Studio, Android SDK Platform 35 và một Android Emulator API 26 trở lên
  nếu chạy app. Chọn Gradle JDK 21; mở thư mục `frontend` và đợi Sync.
- Firebase CLI: script dùng `firebase.cmd` đã cài; nếu chưa có, tự gọi
  `npx --yes firebase-tools@15.34.2`. Lần đầu cần internet tải dependencies/emulator.
- Không cần Firebase CLI login cho bộ Auth/Database/Functions local này.

Mở PowerShell tại thư mục repository (đổi đường dẫn theo máy):

```powershell
Set-Location 'D:\EnglishBattle_App-Mobile'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup.ps1
```

Script cài dependencies của Functions, HTTP server và Admin Web, sau đó build
Functions. Không ghi đè `.env`, local.properties hoặc đổi Firebase project thật.
`Setup.ps1 -CheckOnly` chỉ kiểm tra công cụ, không cài dependencies.

### Chọn JDK 21 riêng cho Emulator

Nếu Java mặc định là 17/25/26, không cần gỡ hoặc đổi cấu hình toàn máy.
Có thể tải ZIP JDK 21 từ [Microsoft](https://learn.microsoft.com/en-us/java/openjdk/download),
kiểm tra SHA-256 rồi giải nén vào `.local/tools/jdk21` (được Git ignore).
Script tìm JDK 21 ở JAVA_HOME, thư mục portable này, các thư mục cài Java thông dụng,
và java.exe trên PATH. Phiên bản khác 21 bị bỏ qua; không tìm thấy sẽ báo lỗi trước khi mở emulator.
Dùng tham số để chọn chính xác một thư mục, đường dẫn sai sẽ bị từ chối:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Setup.ps1 -CheckOnly -JavaHome 'C:\Tools\jdk-21'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-Emulators.ps1 -JavaHome 'C:\Tools\jdk-21'
~~~

Trên máy kiểm thử lần này, JDK portable 21.0.13.0.2 được chọn tự động.
Kết quả chạy lại thật: [kiểm thử JDK 21](LOCAL-EMULATOR-JDK21-VERIFICATION.md).
Nếu cổng bị chiếm, xác định chủ sở hữu trước; không tự dừng tiến trình của người khác.

## 2. Khởi động — bốn terminal tại thư mục repository

**Terminal 1 — Emulator** (đợi thông báo sẵn sàng):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Start-Emulators.ps1
```

**Terminal 2 — seed**, chạy sau khi Emulator sẵn sàng:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Seed.ps1
```

Seed dùng dữ liệu từ `Backend/database/english-battle.seed.json`, chỉ thêm các
mục nội dung còn thiếu. Tài khoản được tạo trong Auth Emulator, khởi tạo bằng
Callable `ensureUserProfile`, rồi mới cấp quyền Admin. Chạy lại không ghi đè
nội dung hoặc số dư/hồ sơ đã có; không mở khóa tài khoản bị chặn. Nếu đã đổi
mật khẩu demo, script sẽ báo lỗi thay vì tự đặt lại mật khẩu.

**Terminal 3 — HTTP server Admin**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Start-AdminServer.ps1
```

**Terminal 4 — Web Admin**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Start-AdminWeb.ps1
```

Mở **http://127.0.0.1:5173/**. Dùng tài khoản **chỉ dành cho local**:

| Tài khoản | Mật khẩu demo | Quyền |
| --- | --- | --- |
| admin@example.test | LocalDemo123! | Mở Admin workspace |
| learner@example.test | LocalDemo123! | Dùng Android; bị từ chối vào Admin |

Không dùng lại mật khẩu demo cho tài khoản thật. Auth Emulator và dữ liệu local
độc lập với Firebase thật; không tự đồng bộ giữa các thành viên.

## 3. Chạy Android Debug

Mở một Android Emulator bằng Android Studio Device Manager. Tại repository:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Run-Android.ps1
```

Script build/install Debug với `-PfirebaseEmulators=true`, rồi mở app. Chọn đăng
nhập Firebase bình thường và dùng `learner@example.test`, không chọn chế độ
"Khám phá bản mô phỏng" (chế độ đó dùng dữ liệu demo riêng, không gọi backend).
Các SDK truy cập máy chủ qua **10.0.2.2**. Bản hiện tại chỉ cấu hình Android
Emulator trên cùng máy, chưa hỗ trợ điện thoại thật hoặc máy khác qua LAN.

Script tìm adb theo sdk.dir trong frontend/local.properties, sau đó ANDROID_HOME,
ANDROID_SDK_ROOT, PATH và vị trí SDK mặc định của Windows. Không sửa các cấu hình này.

Nếu nhiều máy ảo, thêm `-Serial emulator-5554`. Nếu chạy bằng nút Run của
Android Studio, thêm dòng sau vào **frontend/local.properties** trên máy mình,
giữ nguyên dòng sdk.dir có sẵn, rồi Sync:

```properties
firebaseEmulators=true
```

File này đã được Git ignore. Xóa dòng hoặc đổi false để quay lại Firebase thật
trong Debug. Tham số Gradle `-PfirebaseEmulators=...` được ưu tiên hơn file.
Release luôn tắt Emulator; chỉ Debug cho phép HTTP tới 10.0.2.2 và 127.0.0.1.
Analytics bị tắt trong Debug để tránh gửi dữ liệu từ phiên phát triển.

## 4. Kiểm thử

Giữ Emulator và HTTP server chạy; lệnh sau dùng SDK/API local thật:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Test-Local.ps1
```

Kiểm thử trình duyệt thật, thêm bước cài Chromium rồi giữ Web chạy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup.ps1 -Browser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Test-Local.ps1 -Browser
```

Setup -Browser cũng cài lại dependencies, nên chạy trước khi khởi động các dịch vụ.
Browser suite dùng Auth/Callable/HTTP thật trên loopback, không thay response bằng mock.
Test-Local tạo fixture thử và một lượt Practice cho learner; đây là dữ liệu local.

Android smoke test bằng SDK/repository thật (cần máy ảo và seed):

```powershell
Push-Location .\frontend
.\gradlew.bat -PfirebaseEmulators=true :app:connectedDebugAndroidTest '-Pandroid.testInstrumentationRunnerArguments.class=com.englishbattle.app.FirebaseEmulatorSmokeTest' --console=plain
Pop-Location
```

Build/unit tests riêng:

```powershell
npm.cmd --prefix Backend/functions run build
npm.cmd --prefix Backend/server test
npm.cmd --prefix frontend/admin-web run build
npm.cmd --prefix frontend/admin-web test
Push-Location .\frontend
.\gradlew.bat -PfirebaseEmulators=true :app:compileDebugKotlin :app:testDebugUnitTest :app:compileReleaseKotlin --console=plain
Pop-Location
```

Các bài BE1 QA cũ hardcode project englishbattleapp-8d764; phải chạy với cấu hình
firebase.auth-qa.json theo tài liệu cũ **sau khi dừng bộ demo**, không chạy nhầm
chúng trên bộ demo hoặc đổi source test chỉ để khớp môi trường.

## 5. Dừng, lưu và khôi phục

- Dừng Web và HTTP server bằng Ctrl+C trong terminal tương ứng.
- Dừng Emulator bằng Ctrl+C **một lần**, đợi export hoàn tất. Không tắt cưỡng bức
  terminal nếu muốn giữ dữ liệu.
- Có thể lưu chủ động trước khi dừng bằng lệnh dưới đây; nếu đã có bản lưu, CLI
  hỏi xác nhận ghi đè (script không truyền --force):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Export.ps1
```

- Lần chạy sau Start-Emulators tự import `.local/emulator-data` nếu có manifest.
- `Start-Emulators.ps1 -Fresh` chạy phiên mới, không import và không xóa bản lưu cũ.
  Nếu đã có bản lưu, phiên fresh export vào thư mục timestamp riêng và in đường dẫn;
  lần chạy bình thường tiếp tục dùng bản lưu mặc định.
- `.local/`, log, cache và dữ liệu export không được commit.
- Script không tự dừng tiến trình khác nếu trùng cổng; người dùng xác định và dừng
  đúng dịch vụ đang chiếm cổng trước khi chạy lại.

| Dịch vụ | Địa chỉ trên Windows |
| --- | --- |
| Emulator UI | http://127.0.0.1:4000 |
| Auth | 127.0.0.1:9099 |
| Realtime Database | 127.0.0.1:9000 |
| Callable Functions | 127.0.0.1:5001, vùng asia-southeast1 |
| Emulator Hub / Logging | 127.0.0.1:4400 / 4500 |
| Admin HTTP / Web | 127.0.0.1:8080 / 5173 |

## Phạm vi và xử lý lỗi

Luồng cũ vẫn được giữ: Backend/server dùng npm ci, .env và npm start;
Admin Web dùng npm ci và npm run dev; Android Studio mở frontend rồi Run Debug.
Không bật flag local thì Web/Android tiếp tục dùng project Firebase thật, nên đăng
nhập thật vẫn cần Cloud Function tương ứng đã triển khai và quyền tài khoản hợp lệ.
Chạy script local trong tiến trình PowerShell riêng như trên không bật flag vĩnh viễn.
Không chạy đồng thời server/Web của hai môi trường trên cùng cổng 8080/5173.

- `profile/unavailable`: kiểm tra Functions Emulator, project demo và build Functions.
- `backend/unavailable`: kiểm tra HTTP server và cổng 8080.
- `admin-required` hoặc Admin access required: dùng đúng tài khoản demo admin;
  không thêm trường admin trong Database để né custom claim.
- Không khởi động đủ ba emulator thì các script client/seed sẽ từ chối chạy.
- Server local không đọc `.env` production, không dùng service-account key.
- Logic BE1, Callable contracts, reward settlement và Rules/indexes được giữ nguyên.
  Thay đổi trong firebaseAdmin.ts chỉ chọn Database namespace demo khi chạy Emulator.
- Chỉ các tính năng BE1 đã triển khai mới hoạt động. API battle/leaderboard hoặc API
  BE2 còn thiếu không được tạo tự động bởi Emulator.
- Scheduler `expireDailyAttempts` không tự chạy theo lịch trong bộ local này;
  bộ test TEST/DAILY kiểm tra worker riêng. Emulator không mô phỏng toàn bộ lịch production.
- Admin Auth dùng SDK/API thật trên Emulator. Start-AdminWeb.ps1 mặc định chọn
  **MockAdminService**; thêm -DataSource firebase để chọn FirebaseAdminService.
  Hai lựa chọn nguồn nghiệp vụ và emulator/cloud độc lập. Backend đã export
  21 callable admin; nguồn battle vẫn cần engine/owner xác minh. Không fallback dữ liệu mẫu.
  Xem [bàn giao API admin](ADMIN-API-INTEGRATION.md) cho trạng thái và kiểm thử lần mới.

Tham khảo: [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite),
[kết nối Functions](https://firebase.google.com/docs/emulator-suite/connect_functions).

## Backend admin mới

Xem [ADMIN-API.md](../Backend/functions/ADMIN-API.md) cho 21 callable, schema, giới hạn và kết quả kiểm thử mới. Setup.ps1 tạo ADMIN_REQUEST_HMAC_KEY riêng cho emulator trong Backend/functions/.env.local nếu chưa có, không ghi đè key hiện có hoặc cấp quyền cloud.

Để chạy E2E nghiệp vụ, Web phải được mở với -DataSource firebase:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Test-Local.ps1 -AdminBrowser
~~~

Script chạy 4 test local cũ, type-check --noEmit, 13 test admin và 3 E2E thật. Start-Emulators đã build trước khi mở watcher; không rebuild lib trong lúc suite gửi request để tránh restart worker giữa chừng. -Browser vẫn chọn auth.spec.ts cũ với Web mock; hiện assertion provisioning của suite cũ lệch luồng HTTP read-only trong working tree, xem ghi chú backend.
