# Kiểm thử local với JDK 21 — 01/11/2026

Đây là kết quả chạy mới trong tác vụ sửa môi trường, không sao chép PASS từ LOCAL-EMULATOR-VERIFICATION.md. Nhánh Admin, HEAD 7f20694; giữ nguyên các thay đổi frontend từ lượt tích hợp trước và .gitattributes chưa được theo dõi. Không sửa implementation/export callable backend.

## Sửa môi trường và script

- Java mặc định là 17; máy cũng có Java 25 (Android Studio) và 26. Không có JDK 21 tại các vị trí đã kiểm tra.
- Tải ZIP [Microsoft Build of OpenJDK 21](https://learn.microsoft.com/en-us/java/openjdk/download) vào `.local/tools`; không cài MSI và không sửa biến môi trường cấp User/Machine.
- Bản tải thực tế: **21.0.13.0.2+1-LTS**, Windows x64. SHA-256 đã đối chiếu khớp file checksum của nhà phát hành: `c5706a9cf482ef1a0622a86eea5b13d557b07f04554572af061e2d02b58c0f99`.
- Thư mục JDK: `.local/tools/jdk21/jdk-21.0.13.0.2+1`. Toàn bộ `.local` được Git ignore.
- `Local.Common.ps1` thêm `Invoke-LocalJava21`: chọn JDK đúng major, kiểm tra release/java/javac; ưu tiên `-JavaHome` nếu có, nếu không tìm ở JAVA_HOME, thư mục portable, các thư mục cài JDK thông dụng rồi PATH. Không tìm thấy thì dừng với thông báo rõ ràng.
- `Setup.ps1` và `Start-Emulators.ps1` dùng helper, nhận thêm `-JavaHome`. JAVA_HOME/PATH chỉ đổi trong tiến trình đang chạy và được khôi phục trong finally, kể cả khi action lỗi. Guard project, cổng, import/export dữ liệu hiện có được giữ nguyên.
- Lần khởi động đầu phát hiện cổng 9000 đang bị chiếm. Đã xác minh PID 27224 là Database Emulator Java 26 do chính tác vụ trước khởi động lúc 18:29:43, rồi chỉ dừng đúng PID đó. Không dừng tiến trình của thành viên khác.
- Bộ emulator chạy lại báo **All emulators ready**. Kiểm tra cuối xác nhận PID 24428 chạy java.exe bên trong thư mục JDK 21 portable, không dùng Java 26.

Không khẳng định JDK giải thích mọi lỗi native của Node trên Windows: lần khởi động mới thành công với JDK 21, nhưng bước export riêng bên dưới vẫn gặp lỗi khi CLI thoát.

## Lệnh và kết quả thực tế

Từ repository root, các dịch vụ chạy ở terminal/tiến trình riêng:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Setup.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-Emulators.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Seed.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-AdminServer.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-AdminWeb.ps1 -DataSource mock
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Test-Local.ps1 -Browser
```

Chromium được cài riêng vào `.local/playwright` bằng CLI Playwright có sẵn trong node_modules; không cài lại dependencies hoặc đổi lockfile. Các lệnh kết nối loopback/chạy dịch vụ được thực thi ngoài sandbox sau khi được cho phép.

| Bước | Kết quả |
| --- | --- |
| Setup -CheckOnly | PASS: JDK 21 và Firebase CLI 15.34.2 |
| Build Functions trong Start-Emulators | PASS, chỉ biên dịch backend hiện có |
| Start-Emulators | PASS: Auth 9099, RTDB 9000, Functions 5001, Hub 4400; project demo-englishbattle, region asia-southeast1 |
| Seed | PASS: thêm 926 mục nội dung còn thiếu; giữ dữ liệu/runtime hiện có |
| HTTP server / Web | PASS: 8080 / 5173, Web chọn mock rõ ràng |
| Test-Local: local.integration.test.mjs | **4 passed, 0 failed**, khoảng 25,5 giây |
| Playwright: e2e-local/auth.spec.ts | **2 passed, 0 failed**, khoảng 7,7 giây |
| Kiểm tra helper Java | PASS: chọn đúng 21, từ chối -JavaHome trỏ Java 26, khôi phục JAVA_HOME/PATH khi thành công và khi action ném lỗi |
| Kiểm tra cuối Hub / HTTP health / Web | HTTP **200 / 200 / 200** |

Các script PowerShell sửa trong lượt này đã được thực thi trên Windows PowerShell. Build/test React 78/78 thuộc lượt trước; không chạy lại bộ đó vì lượt này không đổi mã React/TypeScript.

## Phạm vi đã được kiểm chứng

Bốn test local thực sự chạy:

1. Admin dùng Auth → ensureUserProfile → HTTP getAdminSession; không thay đổi profile/wallet ngoài dự kiến và HTTP không nhận các nghiệp vụ BE1.
2. Chạy seed lại không thay đổi runtime learner hiện có.
3. Anonymous, learner, tài khoản banned/disabled bị từ chối lấy phiên admin.
4. Luồng BE1 dashboard/practice/resume/leave/result và Database Rules bảo vệ ví chạy trên emulator thật.

Hai bài E2E giữ nguyên source `e2e-local/auth.spec.ts`:

1. Admin đăng nhập qua Auth Emulator; quan sát request ensureUserProfile rồi HTTP getAdminSession đúng thứ tự; Dashboard hiển thị và không có pageerror.
2. Learner thấy Administrator access required và không có navigation admin.

Auth, Callable BE1, HTTP và RTDB là dịch vụ local thật. Không thay response bằng mock; route trong bài E2E chỉ chặn URL ngoài loopback. **Dashboard nghiệp vụ vẫn dùng MockAdminService theo -DataSource mock.** Không coi kết quả này là CRUD admin end-to-end.

21 callable admin trong admin.v1.json vẫn chưa được triển khai/export. Không tạo mới callable backend, REST CRUD, hay mở quyền RTDB để vượt phần thiếu. Test tạo/sửa câu hỏi, lưu sau reload và xung đột version vẫn chờ backend. Không deploy, bật billing, dùng service-account production hoặc sửa dữ liệu cloud. Chỉ dùng fixture/seed local của script; không xóa root Database.

## Artefact và trạng thái dịch vụ

- Ảnh Dashboard từ E2E: `frontend/admin-web/test-results/local-admin-dashboard.png`.
- `frontend/admin-web/test-results/.last-run.json`: status `passed`, failedTests rỗng.
- Tại thời điểm bàn giao, các dịch vụ local của tác vụ vẫn đang chạy tại 127.0.0.1; có thể mở Web cổng 5173 và Emulator UI cổng 4000. Không khởi động thêm bộ trùng cổng.
- Đã chạy thêm `Export.ps1` để giữ dữ liệu local. CLI in `Export complete`, tạo `.local/emulator-data/firebase-export-metadata.json`, Auth accounts/config và Database JSON. Sau đó CLI/npx thoát **-1073740791**, kèm `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`. Vì vậy **lệnh export chưa được đánh dấu PASS**. Đây là lỗi native khi tiến trình CLI thoát; không làm các test trước đó thất bại và kiểm tra Hub/HTTP/Web sau đó vẫn trả 200. Không kiểm chứng import phục hồi trong lượt này.
