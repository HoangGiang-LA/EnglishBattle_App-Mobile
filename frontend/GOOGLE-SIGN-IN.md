# Đăng nhập Google trên Android

## Cấu hình hiện tại

- Firebase project: `englishbattleapp-8d764`.
- Android application ID: `com.englishbattle.app`.
- Firebase Android app: `1:1052524880202:android:e666de6019a29c16fb21b3`.
- Google provider đã được xác nhận đang bật qua Identity Toolkit API. Web OAuth client ID được lấy từ
  resource `default_web_client_id` do plugin Google Services sinh từ JSON.
- App dùng Credential Manager với nút Sign in with Google, đổi Google ID token
  thành phiên Firebase Auth, rồi gọi API xác minh Firebase ID token để khởi tạo
  hồ sơ. Token không được ghi vào log, preferences hoặc saved-instance state.
- Cả debug và release mặc định gọi `https://api.twgxeo.win/api`. Firebase Auth và
  Realtime Database tiếp tục dùng Firebase thật. Web admin có cấu hình riêng.

## Chứng chỉ release

Ngày 11/11/2026 đã xác minh chữ ký của
`app/release/app-release.apk`, bổ sung hai dấu vân tay sau vào Firebase Android
app và tải lại `app/google-services.json` bằng Firebase Management API. Đã xác
nhận cấu hình trả về có Android OAuth client khớp SHA-1 release. Các chứng chỉ
debug hiện có được giữ lại.

```text
SHA-1:
3A:92:93:62:DE:74:F4:4E:5C:CF:87:7C:64:4F:D8:17:D5:6F:48:30

SHA-256:
4E:D2:1C:DD:D0:B0:2F:26:8D:EA:0D:E8:AE:68:8E:81:29:79:EE:5E:B7:25:24:0E:E0:6B:78:02:FD:65:4E:14
```

Keystore do chủ dự án tạo tại
`D:\EnglishBattleKeys\englishbattle-release.jks`, alias `englishbattle-release`.
Mật khẩu do chủ dự án giữ; không đặt mật khẩu hoặc keystore vào Git.
APK đưa lên Drive phải tiếp tục được ký bằng đúng khóa này, hoặc khóa đã đăng
ký trước đây nếu đối chiếu đăng ký package cho thấy cần dùng lại khóa cũ.

**Cảnh báo đăng ký package bằng khóa khác chưa được xử lý.** Firebase đã nhận
SHA release không có nghĩa Android Developer Verification đã đăng ký package
với khóa này. Cần xác minh quyền sở hữu package/khóa trong Android Developer
Console hoặc Google Play Console trước khi phát hành rộng rãi; thao tác Generate
APK trong Android Studio không phải đăng ký package.

## Chạy và kiểm tra

Khởi động API và worker từ thư mục gốc:

```powershell
npm.cmd --prefix Backend/functions run start:mobile
```

`https://api.twgxeo.win/health` cần trả `status: ok`. Mở `frontend` trong
Android Studio, Sync Gradle và chạy app debug để kiểm tra. Nếu đang kiểm tra
Functions Emulator, chủ động bật bằng `-PuseFunctionsEmulator=true`; mặc định
không dùng emulator. Các client Firebase được inject trong bài QA vẫn có thể
chọn emulator riêng.

Kiểm tra thủ công trên thiết bị có Google Play services và Internet:

1. Chọn Đăng nhập với Google, chọn tài khoản và hoàn tất xác thực của Google.
2. Kiểm tra app khởi tạo hồ sơ và mở trang chính qua API HTTPS.
3. Đăng xuất rồi đăng nhập lại cùng tài khoản, kiểm tra giữ nguyên UID và dữ liệu.
4. Đóng hộp chọn tài khoản: quay lại màn hình đăng nhập, không báo lỗi hủy.
5. Nếu email đã có phương thức khác và Firebase báo collision, đăng nhập đúng
   email/mật khẩu đó để liên kết Google; không tạo bản sao hồ sơ nghiệp vụ.

Bộ kiểm tra `GoogleSignInTest` và `GoogleSignInScreenTest` dùng client giả lập,
không chọn tài khoản Google thật hoặc thay đổi phiên Firebase của người dùng.
Kiểm tra tự động không thay thế xác nhận đăng nhập Google thật trên thiết bị.

Ngày 11/11/2026, chủ dự án đã cài APK release hiện có trên điện thoại và xác nhận
đăng nhập Google thành công sau khi bổ sung chứng chỉ release vào Firebase.
Chưa có xác nhận riêng về thao tác đăng xuất/đăng nhập lại giữ nguyên dữ liệu
trên điện thoại; các tình huống trạng thái và đồng bộ hồ sơ có bài kiểm tra riêng.

Kết quả kiểm tra ngày 11/11/2026: build debug và AndroidTest, compile release và
lint debug thành công; 27 bài JVM cùng 11 bài Google sign-in/UI/profile trên
máy ảo đều đạt. Lần chạy instrumentation ngay sau cold boot bị ANR khởi động;
chạy lại khi máy ảo ổn định đạt đủ 11 bài.

Sau khi hoàn thiện code/config, xuất lại APK release qua
Build → Generate Signed App Bundle / APK → APK bằng keystore đã chọn.
Mật khẩu được nhập trên máy trong Android Studio. Dùng APK đã ký trong
`app/release`, không dùng `app-release-unsigned.apk` để phân phối.
