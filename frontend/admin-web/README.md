# English Battle — Web admin

Frontend quản trị React + TypeScript + Vite, chạy độc lập với Gradle/Android. Đăng nhập bằng Firebase Auth, provision qua Callable BE1 `ensureUserProfile`, sau đó xác nhận quyền qua HTTP `getAdminSession`. **Đủ 21 callable admin** phục vụ 5 trang, tìm kiếm, thông báo, audit và export; không fallback sang dữ liệu mẫu.

## Chạy trên máy của bạn

Khi dùng Firebase Spark và chưa deploy Functions, mở PowerShell:

```powershell
cd "D:\Projects\EnglishBattle-full\frontend\admin-web"
npm.cmd run dev:local
```

Lệnh này build Functions rồi chạy Functions Emulator tại `127.0.0.1:5001`, tác vụ nền học tập, server xác nhận quyền tại `127.0.0.1:8080` và web tại **http://127.0.0.1:5173/**. Giữ terminal mở; nhấn `Ctrl+C` để dừng các dịch vụ. Nếu cổng đang bận, dừng dịch vụ cũ trước khi chạy lại.

Firebase Authentication và Realtime Database dùng tài khoản/dữ liệu thật của project hiện tại. `ensureUserProfile` chỉ khởi tạo các bản ghi còn thiếu, không reset ví hoặc tiến độ. Đăng nhập bằng tài khoản đã có claim `admin: true`; quyền được kiểm tra tại từng callable. Thêm/sửa/khóa/xóa user và lưu tên admin thay đổi Firebase. Worker xử lý index, email mời và phục hồi cùng các tác vụ học/thi đấu. Chế độ này cần Internet cho Auth/Database, không yêu cầu deploy Functions hoặc nâng cấp Blaze.

Chuẩn bị một lần: cài thư viện bằng `npm ci` trong `Backend/functions`, `Backend/server`, `frontend/verification` và `frontend/admin-web`. File `Backend/server/.env` phải có project/database đúng và `GOOGLE_APPLICATION_CREDENTIALS` trỏ tới khóa Admin SDK trên máy. Script đọc cấu hình này cho các tiến trình backend; không đưa khóa vào web. Không đặt `FIREBASE_AUTH_EMULATOR_HOST` hoặc `FIREBASE_DATABASE_EMULATOR_HOST` trong chế độ dùng Firebase thật.

Khi đã deploy Functions, chạy server riêng bằng `npm start` trong `Backend/server`, rồi `npm run dev` trong `frontend/admin-web`. Chỉ `dev:local` bật `VITE_USE_FUNCTIONS_EMULATOR=true`; bản build production luôn gọi Functions trên Firebase.

## Firebase Web đã cấu hình

Cấu hình người dùng cung cấp nằm trong [`src/firebase/config.ts`](src/firebase/config.ts), project `englishbattleapp-8d764`, Web App `EnglishBattleAdmin`. [`src/firebase/client.ts`](src/firebase/client.ts) khởi tạo Firebase App, Authentication và Realtime Database SDK. Việc khởi tạo Database SDK chưa chứng minh đã đọc/ghi thành công.

Để thử đăng nhập thật:

1. Trong Firebase Console → **Authentication → Sign-in method**, bật **Email/Password** nếu chưa bật.
2. Dùng tài khoản đã có trong **Authentication → Users**, hoặc tạo tài khoản thử tại đó. Nhập mật khẩu trực tiếp trên trang đăng nhập; không gửi mật khẩu vào chat hoặc file cấu hình.
3. UID phải được provision qua BE1; người quản trị tin cậy cấp claim bằng công cụ trong `Backend/server`. Không có thao tác tự cấp admin từ web.
4. Đăng nhập hoặc Refresh access: web chờ Callable `ensureUserProfile` rồi gửi ID token tới `/api/getAdminSession`. Server kiểm tra cả claim hiện tại, disabled và accountAccess.
5. Quyền hợp lệ mới mở workspace. Profile và Users dùng API thật; tạo user đưa email đặt mật khẩu vào hàng đợi, chi tiết user hiển thị trạng thái gửi. Ban/delete xử lý phiên đang chạy theo engine; deleted không thể mở lại.

Phiên Firebase dùng `browserSessionPersistence`; ứng dụng không lưu mật khẩu. Có khôi phục phiên trong tab, đăng xuất và làm mới claim. Nếu báo `auth/unauthorized-domain`, kiểm tra Authorized domains của project.

Project/Database giữ cấu hình hiện có, vùng `asia-southeast1`. Rules vẫn default-deny, bổ sung catalog published cho user active. Không tự bật Analytics, Messaging hoặc Storage.

Trong production, cấu hình `VITE_BACKEND_BASE_URL` là HTTPS và cho phép origin web trong `ADMIN_ORIGINS`. Không đưa Admin SDK key vào web. Xem `Backend/server/README.md` cho ownership, bootstrap admin và test Emulator; quá trình tích hợp không deploy Rules/Auth policy.

Giao diện dùng tiếng Anh như 5 ảnh thiết kế. Font Inter và icon được đóng gói cục bộ, không cần gọi CDN.

## Chế độ thật hiện có

- Profile: đọc tên/email Auth, sửa tên với revision; không đổi quyền hoặc email đăng nhập của chính mình qua form này.
- Users: tìm tên/email/UID/mã, phân trang 10/20/50 bằng snapshot server, tạo/mời, sửa, khóa/mở khóa và xóa mềm có lý do.
- Rating/xu chỉ đọc. Không cấp custom claim từ web. Chặn tự ban/delete và bảo vệ admin cuối cùng cùng công cụ server.
- Lưu requestId/payload theo UID trong sessionStorage trước khi gửi; khôi phục phiên thử lại đúng intent cũ để xác minh sau timeout/reload. Lỗi giữ dữ liệu form, version conflict yêu cầu đọc lại.
- User đang có operation dở chỉ được xem. Deleted ẩn danh, giữ kết quả/grant/ledger hợp lệ. Không có nút reset dữ liệu thật.
- Content: quản lý 4 kỹ năng, topic/lesson có revision; câu hỏi có expectedVersion, tạo version bất biến và archive. Listening thật chỉ dùng TTS, lesson là bắt buộc; UI ẩn URL/upload.
- Battles: đọc trận nhanh thật, hai người chơi, điểm vòng đã chốt, lý do kết thúc, settlement và các event server có thật. Chi tiết tự tải lại 10 giây; Refresh danh sách tạo snapshot mới. Danh sách công bố `asOf` vì worker cập nhật theo vòng quét.
- **View activities** trong Battles mở hoạt động đăng ký/học/thi đấu, lọc loại và phân trang 10/20/50. Tên tài khoản xóa mềm được ẩn danh cả trên snapshot cũ. Daily/private báo chưa triển khai.
- Dashboard/Analytics: KPI, UID active không trùng, tỷ lệ có trọng số và cohort bắt đầu trong kỳ; lọc kỹ năng gồm mixed-skill, ngày/tuần/tháng lịch thật. API chỉ đọc generation server đã dựng xong, hiển thị asOf/lag/coverage; lịch sử thiếu trường báo N/A hoặc lỗi rõ, không gán số 0 giả.
- Tìm kiếm chung: user/câu hỏi/trận qua index riêng tư, 2–100 ký tự, tối đa 20 kết quả, dẫn tới trang hiện có.
- Thông báo: event nghiệp vụ thật, phân trang và unreadTotal toàn hộp thư; read state riêng theo UID, cutoff giữ nguyên qua retry. Audit có tìm actor/action/target/reason, lọc kết quả/ngày và phân trang 10/20/50.
- Export tạo rồi nhận qua cùng API, kiểm tra quyền/hạn dùng ở mỗi bước; xuất toàn bộ kết quả lọc, BOM UTF-8 và chống CSV formula injection. Tối đa 5.000 dòng/1 MiB CSV; quá giới hạn báo lỗi. Metadata/intent được giữ khi nhận báo cáo timeout.
- Xem [Bước 2](../../Backend/functions/ADMIN-USERS.md), [Bước 3](../../Backend/functions/ADMIN-CONTENT.md), [Bước 4](../../Backend/functions/ADMIN-MONITORING.md), [Bước 5](../../Backend/functions/ADMIN-ANALYTICS.md) và [Bước 6](../../Backend/functions/ADMIN-WORKSPACE.md) cho quy tắc, giới hạn và phục hồi.

## Chế độ demo để xem thiết kế

Đặt `VITE_ADMIN_DATA_MODE=demo` trước khi chạy Vite nếu cần dữ liệu mẫu. Demo vẫn dùng Firebase để xác nhận quyền vào workspace; các thao tác nghiệp vụ sau đó chỉ lưu cục bộ. Không tự bật demo khi API lỗi. Các luồng sau chỉ có dữ liệu mô phỏng trong chế độ demo:

| Phần                | Luồng trong frontend                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard           | KPI tính từ mẫu, ngày bắt đầu/kết thúc, biểu đồ ngày/tuần/tháng, hoạt động gần đây/phân trang và CSV                                                                         |
| Users               | Tìm tên/email/ID, lọc trạng thái, phân trang, xem chi tiết, thêm/sửa, khóa/mở khóa có lý do, xác nhận xóa bằng mã tài khoản                                                  |
| Question & Content  | 250 câu mẫu, 4 kỹ năng, 25 chủ đề, 25 bài học; thêm/sửa câu, đáp án đúng, giải thích, bài đọc, nghe bằng text/audio, xem trước, draft/published/archived, phân trang/lọc/CSV |
| Nội dung phụ        | Sửa kỹ năng; thêm/sửa chủ đề và bài học; trạng thái xuất bản, kiểm tra quan hệ cha–con; không tạo kỹ năng thứ năm                                                            |
| Battle & Moderation | Tìm mã, lọc trạng thái/chế độ nhanh/ngày/phòng riêng, phân trang, xem hai người chơi/điểm/timeline log và CSV                                                                |
| Analytics           | Chọn ngày/kỹ năng, khoảng ngày nhanh, biểu đồ cột/tròn, độ chính xác/tỷ lệ hoàn thành, xếp hạng kỹ năng và CSV                                                               |
| Dùng chung          | Tìm kiếm toàn workspace, Ctrl/Cmd+K, thông báo/đã đọc, hồ sơ admin, nhật ký thao tác, đăng xuất, reset demo, trạng thái tải/rỗng/lỗi/retry, preview thiếu quyền, menu mobile |

Giữ rating và xu; không có XP/level, Premium, thanh toán hoặc doanh thu. Trong Analytics, Idioms & Phrases nằm trong Vocabulary.

## Dữ liệu và giới hạn

- Bản build mặc định là chế độ Firebase. Demo là opt-in và có nhãn riêng; các giới hạn mô phỏng dưới đây chỉ áp dụng khi bật demo.
- Dữ liệu mô phỏng được lưu trong `localStorage` theo khóa `english-battle.admin.demo.v1`. Phiên demo lưu trong `sessionStorage`. Thao tác trong demo không tạo tài khoản hoặc thay đổi dữ liệu Firebase thật.
- Mỗi trình duyệt có bộ dữ liệu riêng. Đăng xuất giữ dữ liệu; chọn menu tài khoản → **Profile & workspace → Reset demo data** và nhập `RESET` để khôi phục mẫu. Dữ liệu demo không phải cơ chế đồng bộ nhiều admin.
- Trong demo, người dùng bị xóa được đổi thành “Deleted user” trong lịch sử mẫu. Chế độ thật có xóa mềm, disabled Auth, revoke phiên và ẩn danh khi đọc lịch sử thật.
- Câu hỏi thay đổi có phiên bản mới; demo giữ tối đa 20 bản trước đó. Đây không phải hệ thống lưu trữ lịch sử production.
- Audio tải lên tối đa 2 MB, lưu cục bộ cho demo. Khi hết dung lượng, thao tác báo lỗi và không commit. URL phải dùng HTTPS; phát được hay không còn phụ thuộc file và máy chủ nguồn. TTS dùng giọng do trình duyệt hỗ trợ.
- Các trận có trạng thái mẫu cố định; nút Refresh nạp lại dữ liệu mẫu, không mô phỏng người thật đang thi đấu. Log chỉ để xem; chưa có nghiệp vụ hủy trận/đảo kết quả/tố cáo.
- CSV xuất toàn bộ tập dữ liệu khớp bộ lọc, có BOM UTF-8 và xử lý chuỗi có thể bị đọc thành công thức bảng tính.
- Ngày thống kê theo `Asia/Ho_Chi_Minh`; số liệu minh họa không đại diện database hiện tại. Nhánh thống kê mixed-skill được loại riêng khỏi bảng tỷ trọng từng kỹ năng.

## Cấu trúc

```text
src/
  domain.ts            # Model và hợp đồng AdminService dùng chung
  context.ts           # Service, ngày chọn và thông báo dùng chung
  data/
    firebase-service.ts # Adapter đủ 21 phương thức; requestId, revision/version, snapshot
    mock-service.ts    # Mô phỏng có kiểm tra dữ liệu, lưu và nhật ký
    metrics.ts         # Tính KPI từ dữ liệu mẫu
    seed.ts            # Khởi tạo người dùng/trận/hoạt động mẫu
    content-seed.json  # Snapshot nội dung khởi tạo công khai của dự án
  pages/               # 5 trang và biểu mẫu
  firebase/            # Config Web App, SDK và màn hình xác thực/trạng thái quyền
  test/                # Kiểm thử logic và React
e2e/                   # Kiểm thử Edge desktop/mobile
docs/design-reference/ # 5 ảnh thiết kế do người dùng cung cấp
docs/qa/               # Ảnh chụp app từ kiểm thử trình duyệt
```

Nghiệm thu đủ 21 API, 5 trang và tiện ích dùng chung với SDK thật nối Emulator riêng: chạy `npm.cmd run test:admin:web` trong `Backend/functions`. Launcher dùng project `demo-englishbattle-admin`, web 15173, HTTP 18180 và Auth/Database/Functions 19299/19200/15003, không đọc credential thật. Bộ `npm.cmd run test:e2e` thông thường kiểm tra demo desktop/mobile ở cổng riêng 15174. Artifact của hai bộ nằm riêng trong `test-results/firebase` và `test-results/demo`.

`tools/refresh-demo-content.ps1` chỉ đọc seed trong repository và ghi lại snapshot cho frontend admin; không kết nối Firebase hoặc sửa backend:

```powershell
pwsh -File tools/refresh-demo-content.ps1
```

## Kiểm tra và build

```powershell
npm test
npm run build
npm run test:e2e
```

Kiểm thử trình duyệt mặc định dùng Edge đã cài trên Windows. Máy dùng Chromium có thể chạy `npx playwright install chromium` rồi đặt `$env:PLAYWRIGHT_CHANNEL='chromium'` trước lệnh E2E. Không chạy hai bộ E2E cùng lúc vì chúng ghi cùng thư mục ảnh.

Để xem gói đã build: `npm run preview`. Kết quả nằm trong `dist/` và bị Git bỏ qua. Hiện chưa cấu hình/deploy hosting.

## Bàn giao

- [Hợp đồng dịch vụ quản trị](docs/API-CONTRACT.md)
- [Bàn giao trước backend và quy tắc đã chốt ngày 25/10](../docs/PRE-BACKEND-HANDOFF.md)
- [Kiểm tra hợp đồng, Rules emulator và bản export Firebase](../verification/README.md)
- [Phạm vi thiết kế và kiểm tra](docs/VERIFICATION.md)
- [Dashboard desktop](docs/qa/desktop-dashboard.png), [Content desktop](docs/qa/desktop-content.png), [Analytics desktop](docs/qa/desktop-analytics.png), [mobile](docs/qa/mobile-dashboard.png)

Web App đã được người dùng đăng ký và cấu hình vào frontend. Tích hợp dữ liệu quản trị thật vẫn cần backend/API/Rules. Không có tài khoản hoặc bản ghi nào được tạo trên Firebase trong quá trình kiểm thử tự động.

Dependency override `@grpc/grpc-js@1.14.6` xử lý advisory của phụ thuộc Node đi kèm gói Firebase tổng hợp. Web này chỉ import App/Auth/Realtime Database; không dùng Firestore hoặc gRPC trong trình duyệt.

## Kết nối web — Bước 7

Adapter có vòng đời riêng theo UID: đổi tài khoản/mất quyền đóng workspace và bỏ phản hồi cũ. Các lần gửi cùng thao tác đang chờ dùng chung request; payload được chụp trước dispatch và giữ qua timeout. Form khóa khi gửi, giữ giá trị khi lỗi. Profile/user/danh mục đọc revision mới trước khi mở editor; server vẫn từ chối conflict.

Trang 1 của Users/Questions tạo snapshot mới, các trang sau giữ snapshot và kích thước 10/20/50. Build mặc định Firebase có kiểm tra không chứa mock/seed; mode cấu hình sai bị từ chối. Xem [quy tắc và kiểm chứng Bước 7](../../Backend/functions/ADMIN-INTEGRATION.md).
