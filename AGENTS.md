# English Battle — Mô hình vận hành dự án

Đọc file này trước khi thay đổi kiến trúc, cấu hình kết nối hoặc hướng dẫn triển khai.
Mô hình dưới đây được chủ dự án xác nhận ngày 11/11/2026.

- Máy của chủ dự án chạy API và các tiến trình nền để chấm bài, ghép trận và lưu thưởng.
- Cloudflare Tunnel cung cấp địa chỉ HTTPS để APK gọi API trên máy đó từ mạng bên ngoài.
- Firebase Spark xử lý đăng nhập và lưu dữ liệu của ứng dụng.
- Google Drive là nơi người dùng tải APK đã ký.

Khi sửa hoặc hướng dẫn sử dụng dự án, bám theo mô hình này. Cấu hình API của APK
cần phù hợp với địa chỉ HTTPS của Cloudflare Tunnel và backend đang chạy trên máy
của chủ dự án.

Phần triển khai giao diện và luồng đăng nhập Google nằm trong module Android.

## Cloudflare Tunnel và API Android

- Tên miền đã mua: `twgxeo.win`; hostname API dự kiến: `api.twgxeo.win`.
- Tunnel: `englishbattle-api`; Service URL: `http://127.0.0.1:8081`.
- Chạy API và worker: `npm --prefix Backend/functions run start:mobile` từ thư mục gốc.
- Cấu hình Firebase và đường dẫn khóa Admin SDK nằm trong `Backend/server/.env`;
  khóa riêng chỉ nằm trên máy chủ, không đưa vào APK hoặc Git.
- Cổng `8081` chạy HTTP API xác minh Firebase ID token và dùng lại logic nghiệp vụ.
  Cổng `5001` là Functions Emulator để phát triển; cổng `8080` là máy chủ quản trị tài khoản.
- Hướng dẫn vận hành: `Backend/functions/MOBILE-API.md`.

## Đăng nhập Google Android

- Tài liệu cấu hình và chứng chỉ: `frontend/GOOGLE-SIGN-IN.md`.
- Firebase đã có cả chứng chỉ debug và release; `google-services.json` đã được
  tải lại sau khi bổ sung SHA release ngày 11/11/2026.
- Chủ dự án đã xác nhận đăng nhập Google thành công bằng APK release trên điện thoại.
- Cảnh báo Android Developer Verification về package đăng ký với khóa khác
  vẫn chưa được xử lý; việc thêm SHA vào Firebase không giải quyết cảnh báo này.
