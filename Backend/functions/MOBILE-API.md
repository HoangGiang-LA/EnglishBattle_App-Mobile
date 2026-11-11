# API Android trên máy chủ riêng

Tên miền: `twgxeo.win`. Tunnel: `englishbattle-api`.
Hostname công khai: `api.twgxeo.win`.

## Khởi động API và worker

Yêu cầu Node.js 24, các dependency trong `Backend/functions` và file
`Backend/server/.env` đã cấu hình Firebase thật. Khóa Admin SDK chỉ nằm trên máy
chủ. Launcher kiểm tra project của khóa, từ chối biến môi trường emulator và
chỉ lắng nghe trên loopback.

Từ thư mục gốc dự án:

```powershell
npm --prefix Backend/functions run start:mobile
```

Lệnh build TypeScript rồi chạy hai tiến trình: HTTP API tại
`http://127.0.0.1:8081` và worker xử lý hạn trả lời, ghép trận, kết quả, thưởng,
cộng đồng, báo cáo và thống kê quản trị. Giữ terminal mở; Ctrl+C dừng cả hai.
Nếu một tiến trình lỗi, launcher dừng tiến trình còn lại và báo cần khởi động lại.
Worker dùng cơ chế lease/idempotency hiện có. Khi máy tắt, ngủ hoặc mất mạng,
API không phục vụ được dù tên miền và dịch vụ Tunnel vẫn được cấu hình.

Có thể đặt `MOBILE_API_PORT` trong `Backend/server/.env` để đổi cổng; phải đổi
Service URL trên Cloudflare tương ứng. `PORT=8080` của máy chủ admin không ảnh
hưởng tới API Android.

## Cấu hình Cloudflare

Trong `Networking → Tunnels → englishbattle-api → Routes → Add route →
Published application`, điền:

| Trường | Giá trị |
|---|---|
| Subdomain | `api` |
| Domain | `twgxeo.win` |
| Path | Để trống |
| Service URL | `http://127.0.0.1:8081` |

Giữ các cài đặt nâng cao mặc định. TLS công khai được Cloudflare xử lý; kết nối
từ connector trên cùng máy tới API dùng HTTP loopback.

Kiểm tra trước ở máy chủ:

```powershell
Invoke-RestMethod http://127.0.0.1:8081/health
```

Sau khi thêm route, kiểm tra từ mạng ngoài:

```powershell
Invoke-RestMethod https://api.twgxeo.win/health
```

Cả hai phải trả về `status: ok` và `service: englishbattle-api`.
Trang gốc `/` trả 404 là bình thường. Nếu báo 502, kiểm tra API còn chạy và cổng
có khớp Service URL. Không trỏ route công khai vào Functions Emulator cổng 5001.

## Giao thức và kiểm soát truy cập

API nhận `POST /api/<tên callable>` với JSON `{"data": ...}`, trả
`{"result": ...}` hoặc lỗi theo giao thức Firebase Callable. Mọi nghiệp vụ cần
Firebase ID token trong `Authorization: Bearer ...`. Server xác minh chữ ký,
project, hạn token, thu hồi phiên và tài khoản bị vô hiệu hóa bằng Admin SDK.
UID và claims của request được tạo từ token đã xác minh. App Check token được
xác minh khi client gửi lên; hiện chưa bắt buộc mọi client có App Check.

Chỉ các API Android được liệt kê trong `tools/mobile-api/http.mjs` được mở.
Endpoint quản trị và tác vụ maintenance không được dispatch qua HTTP. Các kiểm
tra quyền, thời hạn và idempotency trong logic nghiệp vụ tiếp tục được áp dụng.
Không cần sửa hoặc deploy Cloud Functions để vận hành máy chủ này.

Android debug và release hiện mặc định gọi URL callable đầy đủ
`https://api.twgxeo.win/api/<tên callable>` qua
`FirebaseFunctions.getHttpsCallableFromUrl`. Build lại và cài APK mới khi đổi
địa chỉ API; có thể bật Functions Emulator riêng cho debug bằng Gradle property
`useFunctionsEmulator=true`. Web admin vẫn dùng cấu hình riêng.

## Kiểm tra tự động

```powershell
npm --prefix Backend/functions run test:mobile
npm --prefix Backend/functions run build
npm --prefix Backend/functions run lint
npm --prefix Backend/functions run test:acceptance -- --mobile
```

Các bài kiểm tra đơn vị HTTP dùng verifier giả lập. Acceptance `--mobile` chạy
lại toàn bộ luồng HTTP hiện có qua API mới với Auth/Database emulator cô lập
trong project `demo-englishbattle-finalization`, không đọc/ghi Firebase thật.
