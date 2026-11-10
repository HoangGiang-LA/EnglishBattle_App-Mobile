# Tích hợp Admin API — 01/11/2026

> Backend mới đã triển khai/export đủ 21 callable; xem [ADMIN-API.md](../Backend/functions/ADMIN-API.md) cho trạng thái mới, schema và kết quả 13 integration/3 E2E nghiệp vụ PASS. Các bảng “chưa có backend” bên dưới là lịch sử giai đoạn adapter frontend, không còn là trạng thái triển khai hiện tại. Battle/Analytics vẫn cần nguồn battle được owner xác minh; cloud chưa deploy.

> Cập nhật sau khi chọn JDK 21: Emulator đã khởi động; Test-Local PASS 4/4 và e2e-local/auth.spec.ts PASS 2/2. Xem [bằng chứng chạy lại](LOCAL-EMULATOR-JDK21-VERIFICATION.md). Đây là xác thực/BE1 thật; Dashboard vẫn dùng mock, 21 callable admin nghiệp vụ vẫn chưa có backend.

Kiểm tra tại nhánh Admin, HEAD 7f20694. Không tìm thấy AGENTS.md trong repository hoặc các thư mục cha. Giữ nguyên .gitattributes chưa được theo dõi từ trước. Phạm vi thay đổi: frontend admin, script chọn nguồn và kiểm thử; không triển khai backend nghiệp vụ.

## Hai lựa chọn độc lập

| Biến | Giá trị | Ý nghĩa |
| --- | --- | --- |
| VITE_ADMIN_DATA_SOURCE | mock (mặc định), firebase | Dữ liệu nghiệp vụ trong trình duyệt hoặc gọi API Firebase |
| VITE_USE_FIREBASE_EMULATORS | true, false | Firebase SDK gọi emulator hoặc project cloud trong config.ts |

.env.example ghi rõ mock. Giá trị nguồn không hợp lệ gây lỗi cấu hình, không tự chuyển về mock. Chỉ cờ emulator không làm thay đổi nguồn dữ liệu. FirebaseAdminService dùng SDK thật, kể cả khi chạy trên emulator. Nhãn Firebase API không phải thông báo backend đã sẵn sàng.

Không bật cloud để kiểm thử nhiệm vụ này. Môi trường cloud chỉ dùng khi nhóm đã chuẩn bị backend, quyền và URL HTTP HTTPS hợp lệ. Production vẫn từ chối flag emulator; local HTTP vẫn chỉ được trỏ http://127.0.0.1:8080. Không tạo Firebase app/config thứ hai.

## Chạy local bằng script có sẵn

Làm theo docs/LOCAL-EMULATOR.md: Setup.ps1, Start-Emulators.ps1, Seed.ps1, Start-AdminServer.ps1 ở các terminal riêng. Node 24 và JDK 21 theo tài liệu. Chỉ một bộ emulator trên các cổng hiện có.

Chọn rõ nguồn khi mở Web:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-AdminWeb.ps1 -DataSource mock
# Hoặc kiểm tra tích hợp adapter (hiện backend admin còn thiếu):
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Start-AdminWeb.ps1 -DataSource firebase
~~~

Script giữ guard kiểm tra emulator/cổng và khôi phục VITE_ADMIN_DATA_SOURCE khi kết thúc. Các biến môi trường khác tiếp tục được bảo toàn bởi Local.Common.ps1. Không đổi .env của thành viên khác. Khi chạy Vite thủ công, đặt cả hai biến độc lập, rồi khởi động lại Vite sau khi đổi .env.

## Luồng và hành vi

Đăng nhập giữ Firebase Auth → ensureUserProfile → POST /api/getAdminSession, header Bearer ID token, body {"data":{}}. HTTP chỉ xác minh phiên, đọc response.result; nghiệp vụ chỉ dùng httpsCallable trên Functions instance đã kết nối, đọc result.data. Client Firebase vẫn nạp động; việc chọn FirebaseAdminService chưa khởi tạo SDK ngay.

Adapter lấy callable, thứ tự request và payloadKey từ contracts/admin.v1.json; kiểu phương thức lấy từ AdminService. Kiểm tra serverNow hữu hạn, payload, các trường và phần tử lồng cần cho UI; sai cấu trúc thì báo lỗi. Đây là kiểm tra cấu trúc tối thiểu, không thay validation/rules nghiệp vụ của server. Không đổi lỗi thành mảng rỗng, không fallback mock, không đọc RTDB để thay API.

Trường undefined được bỏ đệ quy. Mutation có UUID requestId, gom các lần gửi đồng thời cùng phương thức/payload; giữ ID sau thất bại để người dùng chủ động thử lại trong cùng instance, tạo ID mới sau thành công hoặc payload khác. Không tự retry mutation. ID chưa được lưu qua reload trình duyệt. Backend vẫn phải triển khai idempotency; phía frontend không chứng minh được việc chống ghi lặp trên server.

Mutation thành công phát admin:data để các resource tải lại. Form giữ nội dung khi lỗi và khóa nút trong lúc gửi. Profile, audit, notifications có trạng thái tải/lỗi/retry. Khi API báo permission-denied/unauthenticated, hook xóa phiên UI và unmount toàn bộ workspace; dữ liệu quản trị cũ không còn hiển thị. Refresh quyền thất bại cũng ẩn workspace. Đăng xuất lỗi mạng vẫn cho thử lại; không coi lỗi mạng là bằng chứng quyền đã bị thu hồi.

Rating/coins chỉ đọc; saveUser chỉ chuyển name/email và không nhận quyền admin. Khóa/xóa giữ lý do và xác nhận. Sửa/archive câu hỏi giữ expectedVersion; adapter từ chối sửa khi thiếu version. Không có API xóa cứng câu hỏi hoặc sửa kết quả trận đấu. Firebase chỉ cho URL audio HTTPS, tắt file upload base64; tích hợp Storage chưa có. Demo vẫn có upload cục bộ/reset/preview lỗi.

## Màn hình → callable → trạng thái

Nguồn bằng chứng: Backend/functions/src/index.ts chỉ export BE1 (auth/practice/user), không export 21 admin callable. Backend/server/src/accounts.mjs chỉ thực hiện getAdminSession; http.mjs không có CRUD admin. Vì không có implementation admin nên chưa thể đối chiếu sai lệch response thực tế. Danh sách dưới đây là adapter đã viết theo hợp đồng, không phải xác nhận API hoạt động.

| Màn hình | Phương thức → callable | Backend | Kiểm thử lần này |
| --- | --- | --- | --- |
| Hồ sơ | profile → adminGetProfile | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Hồ sơ | saveProfile → adminUpdateProfile | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Dashboard / Analytics | overview → adminGetOverview | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Users | users → adminListUsers | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Users chi tiết | user → adminGetUser | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Users form | saveUser → adminSaveUser | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Users trạng thái | setUserStatus → adminSetUserStatus | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Content | questions → adminListQuestions | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Content chi tiết | question → adminGetQuestion | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Question editor | saveQuestion → adminSaveQuestion | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Content archive | archiveQuestion → adminArchiveQuestion | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Content / Question editor | catalog → adminGetCatalog | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Content editor | saveContent → adminSaveContent | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Battles | battles → adminListBattles | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Battle detail | battle → adminGetBattle | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Dashboard hoạt động | activities → adminListActivities | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Tìm kiếm chung | search → adminSearch | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Thông báo | notifications → adminListNotifications | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Thông báo | readNotifications → adminMarkNotificationsRead | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| Nhật ký | audit → adminListAudit | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |
| CSV Users / Content / Battles / Analytics | exportReport → adminExportReport | Chưa implementation/export | Unit adapter với transport giả lập PASS; E2E CRUD bị chặn |

reset chỉ dùng demo, không có callable. Audit dùng request rỗng (query? không được AdminService hiện tại cung cấp).

## Kết quả lần tích hợp frontend ban đầu (trước khi sửa JDK)

- npm --prefix frontend/admin-web run build: PASS (TypeScript + Vite production bundle).
- npm --prefix frontend/admin-web test: PASS, 9 file / 78 test. Bao gồm suite demo cũ, 35 test adapter, 3 test giao diện Firebase với auth/transport giả lập và 1 test SDK dùng mock module. Các test mới không được gọi là E2E emulator.
- Setup.ps1 -CheckOnly: PASS sau khi cho phép npm tải Firebase CLI 15.34.2. Java mặc định máy là 17; script check hiện có không kiểm tra major Java đủ chặt.
- Test-Local.ps1: chưa chạy được suite integration. Sandbox ban đầu trả EACCES loopback; chạy lại ngoài sandbox trả ECONNREFUSED 127.0.0.1:4400 (Hub chưa chạy).
- Đã thử Start-Emulators.ps1 với Java 26 có sẵn, chỉ đổi môi trường của tiến trình con. Build Functions PASS, CLI nhận project demo-englishbattle, tải Database Emulator 4.11.2 và UI; sau đó npx thoát với mã -1073740791 khi Functions đang khởi động. Không có kết quả emulator sẵn sàng để tuyên bố PASS.
- e2e-local/auth.spec.ts giữ nguyên, chưa chạy trong lần này vì bộ local không khởi động thành công. Test auth này cần -DataSource mock để kiểm tra Dashboard mẫu sau xác thực thật. Không thêm CRUD E2E giả khi backend còn thiếu.
- Không dùng kết quả trong LOCAL-EMULATOR-VERIFICATION.md cho báo cáo này; không deploy/billing/service-account production hoặc sửa cloud.

Phần nghiệp vụ admin CRUD vẫn chưa được xác nhận chạy trên emulator. CRUD, version conflict, quyền learner ở callable admin và lưu dữ liệu sau reload còn bị chặn bởi backend thiếu. Những hành vi đó hiện chỉ có unit/demo test hoặc transport giả lập, chưa phải dữ liệu Firebase tồn tại thật.

## Kiểm thử thủ công và phần hai backend cần hoàn thiện

1. Chuẩn bị Node 24/JDK 21, chạy đủ Emulator → Seed → HTTP → Web bằng scripts/local; không khởi động bộ khác nếu trùng cổng và không dừng tiến trình không rõ chủ sở hữu.
2. Chọn mock: đăng nhập admin local, kiểm tra đủ 5 trang, sửa mẫu, reset, error preview; learner không mở được workspace. Đây chỉ là nghiệp vụ demo sau Auth thật.
3. Chọn firebase: đăng nhập admin; xác nhận nhãn Firebase, request đi tới /demo-englishbattle/asia-southeast1/admin..., API thiếu báo lỗi, Try again không thay bằng dữ liệu mẫu. Profile lỗi không mở form dữ liệu giả; không có reset hoặc upload base64.
4. Backend cần implement/export đủ 21 callable theo bảng, kiểm tra token/admin/accountAccess mỗi request; thêm idempotency requestId, version conflict, bounded pagination, immutable question versions và bảo vệ câu hỏi đang được tham chiếu. Không thêm REST CRUD hoặc mở RTDB để bù thiếu.
5. Khi backend có thật: bổ sung e2e-local CRUD không chặn/thay response. Đăng nhập admin; đọc catalog/API; tạo câu hỏi có prefix fixture duy nhất, sửa với expectedVersion; reload và xác nhận qua API dữ liệu tồn tại; gửi version cũ phải bị từ chối; đăng nhập learner và gọi admin callable phải bị permission-denied. Chỉ xóa fixture do test sở hữu qua cơ chế cleanup local được backend nhóm thống nhất; không xóa root RTDB. Hiện hợp đồng không có hard-delete question, cần chốt cleanup fixture với backend trước khi tự động hóa.
6. Kiểm tra lỗi mạng giữ form, nút gửi không gửi hai mutation đồng thời, Retry rõ ràng; đổi quyền/khóa tài khoản ở công cụ backend local rồi kiểm tra request tiếp theo làm ẩn workspace. Rating/coins/admin role không có ô chỉnh sửa, battle chỉ xem.
7. Chạy build/test và Test-Local.ps1; giữ test auth cũ. Chỉ ghi E2E PASS sau khi SDK Auth/Callable/RTDB thật chạy, không dùng response mock.

## File chính

- src/data/firebase-service.ts: adapter 21 callable, requestId, lỗi quyền và làm mới dữ liệu.
- src/data/admin-response.ts: kiểm tra response unknown theo domain.
- src/data/service.ts, .env.example, scripts/local/Start-AdminWeb.ps1: chọn nguồn độc lập môi trường.
- src/firebase/client.ts, useAdminAuth.ts: chia sẻ Functions, guard emulator reload, ẩn UI khi mất phiên/quyền.
- App.tsx, hooks.ts, lib.ts, pages/*: nhãn theo mode, lỗi/retry/loading, audio và form.
- src/test/firebase-{service,sdk,workspace}.test.*: contract/response/retry/lỗi và wiring UI, đều ghi rõ phạm vi giả lập.
