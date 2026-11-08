# Admin Bước 7 — Kết nối đầy đủ web với backend

Cập nhật: 08/11/2026. Mốc local/Spark và kiểm thử Emulator; chưa nghiệm thu production.

## Phạm vi đã nối

Adapter `FirebaseAdminService` triển khai đủ 21 phương thức nghiệp vụ của `AdminService`.
`dispose()` là vòng đời trong browser, không phải callable mới; `reset()` chỉ dành cho demo.

| Trang/tiện ích                      | Nguồn                                                          |
| ----------------------------------- | -------------------------------------------------------------- |
| Dashboard, Analytics                | adminGetOverview, generation/asOf/lag/coverage từ server       |
| Users, hồ sơ admin                  | 6 API Profile/Users, Auth và RTDB hiện có                      |
| Content                             | 6 API Catalog/Questions, revision/version và snapshot phiên cũ |
| Battles, hoạt động                  | 3 API giám sát nguồn thi đấu/học/đăng ký thật                  |
| Tìm kiếm, thông báo, audit, báo cáo | 5 API Bước 6; hộp thư riêng theo UID                           |

App chỉ tạo service sau khi Firebase Auth, provisioning và HTTP getAdminSession đã
xác nhận admin. AdminContext nhận service theo đúng UID. Mọi callable vẫn tự kiểm tra
quyền hiện tại; xác nhận đăng nhập không thay thế guard server.

Không thêm nghiệp vụ sửa xu/rating, cấp quyền từ web, đảo kết quả trận, daily/private,
Storage/audio upload hoặc FCM.

## Phiên và phản hồi đến muộn

- Mỗi workspace Firebase có adapter riêng. Cleanup của App hủy vòng đời adapter bằng
  AbortSignal khi đăng xuất, đổi UID, mất quyền hoặc khởi tạo lại service.
- Adapter đã đóng không gửi request mới, không trả dữ liệu đến muộn, không phát
  admin:data/access-denied và không xóa intent đang chờ acknowledgement.
- Khi guard từ chối quyền hiện tại, workspace đóng ngay trước khi chờ Firebase signOut.
  Nếu signOut còn chờ hoặc thất bại, màn hình quản trị vẫn đóng.
- App kiểm tra quyền nền bằng profile mỗi 30 giây khi mở workspace Firebase; thao tác
  bất kỳ cũng có guard. Đây là polling, không cam kết phát hiện ngay khi tab ngủ/offline.
- Auth refresh từ tài khoản cũ không thay session của tài khoản mới. Lỗi terminal của
  operation từ phiên cũ được phân biệt với lỗi quyền của phiên hiện tại.
- useResource bỏ phản hồi cũ sau đổi filter/unmount. Users/Content có thêm generation
  cho các lần mở chi tiết/editor, kể cả khi người dùng đổi filter trước khi phản hồi về.

## Lưu, retry và form

Payload và requestId được lưu theo UID trong sessionStorage trước khi gửi mutation.
Payload được chụp sâu theo JSON; việc sửa object range/filter sau đó không đổi intent.
Các lần gửi đồng thời có cùng action/target/payload dùng chung promise; nội dung khác
trên cùng target bị chặn khi yêu cầu trước còn đang xử lý.

Form được khóa trong lúc gửi, gồm input/select/textarea và nút hành động. Lỗi trả về
mở lại các trường và giữ nội dung. Timeout/unavailable không xóa intent; bấm lại với
cùng nội dung dùng đúng ID cũ. Sau reload, adapter thử xác minh các intent đã lưu
(tối đa 5 mỗi lần mở); intent chưa xác minh vẫn được giữ. Export chưa nhận rows không
tự download khi khôi phục phiên.

Adapter đóng sau khi server có thể đã commit vẫn giữ intent cho workspace sau đọc lại.
Nếu storage lỗi trước dispatch, request mới chưa được gửi và không khóa nhầm payload
chưa gửi. Storage lỗi khi dọn intent đã xác nhận không biến thành thông báo timeout giả.

Profile, user và danh mục được đọc lại khi mở editor để lấy revision hiện tại.
Question editor đọc version hiện tại trước khi mở. Server từ chối optimistic conflict;
form giữ giá trị và yêu cầu mở lại bản ghi. Không tự thay expectedRevision/expectedVersion
rồi ghi đè chỉnh sửa của admin khác.

## Phân trang và lỗi

Users/Questions tạo snapshot mới khi gọi trang 1; các trang sau dùng cùng snapshot.
Battles/Activities/Audit/Notifications cũng dùng snapshot server gắn actor/filter/page size.
Kích thước 10/20/50 được giữ nguyên; browser không tải root hoặc toàn bộ danh sách để giả
offset. Mutation thành công làm mất hiệu lực snapshot của adapter. Snapshot hết hạn trả
lỗi rõ, Retry lấy snapshot mới. Với tab danh mục, catalog là response có giới hạn từ API;
phân trang danh mục nhỏ không phải đọc root RTDB.

Đã ánh xạ mất phiên/quyền, validation, email trùng, not-found, version conflict, timeout,
unavailable, giới hạn gọi/báo cáo và API/mode chưa hỗ trợ. API lỗi không mở dữ liệu mẫu
hoặc báo lưu thành công. Trợ giúp và thông báo export trong mode thật không còn mô tả
tính năng đã triển khai như demo hoặc chưa có backend.

## Tách demo khỏi bản dùng thật

Mode mặc định là firebase; demo phải được bật rõ bằng VITE_ADMIN_DATA_MODE=demo.
Giá trị cấu hình khác firebase/demo bị từ chối. Vite kiểm tra từng module trong bundle:
build Firebase thất bại nếu chứa mock-service, seed hoặc content-seed. Build demo chủ động
vẫn được hỗ trợ. Nút reset/preview chỉ có trong demo, không thay đổi dữ liệu thật.

## Chạy và kiểm tra

Chế độ Spark dùng dữ liệu Auth/RTDB thật:

```powershell
cd "D:\Projects\EnglishBattle-full\frontend\admin-web"
npm.cmd run dev:local
```

Cần khóa Admin SDK hợp lệ trong Backend/server/.env, giữ terminal/máy và worker chạy.
Functions dùng Emulator local; không cần deploy hoặc đổi billing cho mốc này.

Kiểm thử phá hủy, tiêm lỗi và dữ liệu mẫu chỉ chạy bằng launcher demo cô lập:

```powershell
# frontend/admin-web
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
# Backend/functions
npm.cmd run test:admin:web
# frontend/verification
npm.cmd test
```

Kết quả cuối tại [ADMIN.md](ADMIN.md). Bộ web nối SDK/HTTP/Functions/Database/Auth Emulator,
bao gồm mất phản hồi sau commit (retry cùng ID/revision/audit), conflict hai trình duyệt,
reload, quyền bị thu hồi, bộ lọc và CSV. Kiểm thử component bổ sung chuyển phiên khi refresh
còn chờ, adapter cũ trả lỗi muộn, khóa form, revision mới và API unimplemented không fallback.

Chưa deploy Rules/index/Functions/Hosting, smoke test Firebase thật, xác nhận email thật
hoặc chạy Android trên thiết bị trong Bước 7. Không coi kết quả Emulator là nghiệm thu
production; nghiệm thu tổng thể Bước 8 là mốc riêng.
