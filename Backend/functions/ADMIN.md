# Backend admin — nền tảng API

Cập nhật: 08/11/2026. Phạm vi: local/Spark, chưa deploy production.

Bước 2 và bảo vệ admin cuối cùng: [hành vi, API, phục hồi và email](ADMIN-USERS.md).
Bước 3: [danh mục, ngân hàng câu hỏi, phiên bản và TTS](ADMIN-CONTENT.md).
Bước 4: [giám sát trận, hoạt động, dữ liệu riêng tư và worker](ADMIN-MONITORING.md).
Bước 5: [Dashboard/Analytics, cohort, dữ liệu tổng hợp và rebuild](ADMIN-ANALYTICS.md).
Bước 6: [tìm kiếm, hộp thư admin, audit và xuất CSV](ADMIN-WORKSPACE.md).
Bước 7: [kết nối web, vòng đời phiên, retry và form](ADMIN-INTEGRATION.md).

## Trạng thái

- Export đủ 21 callable tại `asia-southeast1`, dùng chung guard, validator và rate limit.
- Đã gắn đủ 21 handler Bước 2–6. Web dùng adapter Firebase cho cả 5 trang và các tiện ích
  tìm kiếm/thông báo/audit/export; demo là opt-in.
- HTTP `getAdminSession` tiếp tục xác nhận phiên đăng nhập; không thay thế guard callable.
- Không thêm API cấp quyền, đổi rating/xu, sửa kết quả, daily/private, Storage hoặc FCM.

## Hợp đồng và giới hạn

Nguồn runtime: `src/admin/contracts.ts`. Bản JSON Schema dùng cho tích hợp:
`frontend/contracts/admin.schemas.v1.json`. Ánh xạ phương thức và lỗi:
`frontend/contracts/admin.v1.json`. Sau khi đổi schema, chạy trong `Backend/functions`:

```powershell
npm.cmd run build
npm.cmd run contract:admin
```

QA kiểm tra bản JSON đã xuất khớp nguồn runtime. Validator không ép kiểu, không âm thầm
bỏ trường lạ và không trả lỗi kèm raw input. Ngoài schema có kiểm tra quan hệ trường:
option ID/text khác nhau, đáp án thuộc option, explanation/Reading/TTS khi published,
revision khi sửa, loại filter export và cutoff đọc thông báo.

| Nội dung | Quy tắc Bước 1 |
|---|---|
| Request / response | Tối đa 64 KiB / 2 MiB JSON UTF-8 |
| ID / requestId | Một segment `[A-Za-z0-9_-]`, 1–128 ký tự; UID đích khác actor UID |
| Phân trang | 10/20/50; page 1–1000; response có `snapshotId`, `expiresAt`, `nextCursor` |
| Khoảng ngày | Ngày lịch hợp lệ, bao gồm ngày cuối, tối đa 366 ngày, `Asia/Ho_Chi_Minh` |
| Search | 2–100 ký tự có nội dung, tối đa 20 kết quả |
| Export | Tối đa 5.000 dòng, 1 MiB CSV và dưới 2 MiB JSON; tạo bằng requestId, nhận bằng reportId |
| Rate limit | Theo UID, cửa sổ phút server: 120 read, 30 write, 5 export |
| Sửa dữ liệu | `expectedRevision` cho profile/user/status/content; `expectedVersion` cho câu hỏi |
| Đọc tất cả thông báo | Một trong `id` hoặc `throughAt`; giữ nguyên cutoff qua retry |

Profile/user/catalog wire DTO thêm `revision`. Audit/thông báo trả `page`, thay danh sách
không giới hạn. Tạo export cần `requestId`; nhận lại kiểm tra quyền và hạn dùng riêng.
Adapter giữ requestId/payload qua retry, gồm cả timeout khi nhận báo cáo đã tạo.

Profile/Users, Questions, trận, thống kê, audit và thông báo dùng index/snapshot server
và các giới hạn hiện hành; xem tài liệu từng bước cho freshness và retention.
Không triển khai offset bằng cách tải root RTDB về trình duyệt.

## Guard

Mọi entrypoint (đọc/ghi/search/audit/export) đi qua `createAdminRuntime`:

1. Yêu cầu callable đã có `request.auth`; đọc Bearer token từ request server.
2. `verifyIdToken(token, true)` kiểm tra token, hết hạn, revoke và disabled.
3. UID phải khớp context callable; `admin` phải đúng boolean `true` trong token.
4. Đọc Auth hiện tại, yêu cầu `customClaims.admin === true`, không disabled.
5. Đọc `accountAccess/{uid}`, chỉ nhận `active`; thiếu bản ghi cũng bị chặn.
6. Tại mỗi checkpoint, kiểm tra lại quyền hiện tại và `tokensValidAfterTime`.

Chỉ lưu UID và `auth_time` để worker kiểm tra actor gốc; không lưu ID token. Worker không
tiếp tục hiệu ứng mới cho actor đã bị thu hồi quyền, revoke, khóa hoặc xóa. Token hết hạn
sau khi đã tạo operation không hủy công việc đã được cấp quyền; revoke/khóa vẫn chặn.
Không lấy actor UID hoặc claim từ request payload.

## Operation, đồng thời và phục hồi

`AdminOperations` được dùng cho mọi mutation và export. Handler đăng ký tập trung trong
`src/admin/service.ts`, kèm version và target ổn định. Không có callable ghi path tùy ý.

- Operation ID = SHA-256 của `[actorUid, action, requestId]`.
- Payload fingerprint = SHA-256 của JSON sắp xếp key; giữ kiểu và thứ tự array.
- Reservation được lưu trước hiệu ứng; cùng ID/payload dùng chung operation.
  Dùng lại ID với payload khác trả `already-exists` / `request-id-conflict`.
- Lease 60 giây, heartbeat mỗi 15 giây, kiểm tra owner trước/sau từng bước.
- Khóa target tồn tại bền cho tới kết quả cuối. Operation khác cùng target đợi hoặc
  trả `aborted`; không ghi đè operation đang dở bằng một requestId mới.
- `ctx.resourceId` được suy ra từ operation ID trước khi tạo Auth/content. Handler tạo
  user phải dùng UID này và xử lý trường hợp Auth đã có đúng UID, không tạo UID ngẫu nhiên.
- `ctx.mutateRecord` gộp revision CAS, thay đổi record và receipt `_adminApplied` vào cùng
  transaction. Reducer phải thuần và giữ các trường hiện có. Không xóa receipt bằng một
  lệnh set thay toàn record. Receipt giúp phục hồi khi commit đã xảy ra nhưng mất ACK.
- `ctx.step` chỉ dùng cho hiệu ứng có thể chạy lại an toàn. Tạo index/event/notification
  phải dùng key xác định, không dùng push hay cộng dồn không có receipt.
- `ctx.externalStep` dùng cho Auth/email. Nếu đã lưu checkpoint thành công thì không
  gọi lại. Nếu lỗi/crash giữa lời gọi và checkpoint thì kết quả là chưa xác định:
  operation chuyển `blocked`, giữ target lock, không tự chạy lặp.
  Callback external trả `void`, không lưu Auth record/link đặt mật khẩu làm kết quả bước.
- RTDB không có transaction chung với Auth. Không tự rollback ví/tiến độ/quyền để
  che lỗi giữa hai hệ thống. Trạng thái partial và checkpoint được giữ để đối soát.
- Thành công lưu nguyên envelope dạng JSON string để giữ `[]`/`null`; retry trả chính
  envelope đó. Timeout sau commit không phải lý do tạo requestId mới.
- Kết quả `succeeded` có audit chưa ghi xong vẫn nằm trong due-index. Worker hoàn tất
  audit và mở khóa; không chạy lại handler nghiệp vụ.

Handler Bước 2 phải kiểm tra revision dưới target lock **trước** hiệu ứng Auth, rồi
đồng bộ Auth/RTDB/index qua các bước riêng. Callback transaction có thể nhận `null`
từ cache trước khi thấy dữ liệu server: nhánh sửa record phải cho CAS đọc lại, không
abort ngay vì cache trống. Bộ QA có test cho tình huống này.

Đối với operation `blocked`: kiểm tra checkpoint và Auth/RTDB bằng công cụ server;
chấm dứt process cũ trước khi đối soát hiệu ứng external chưa rõ kết quả. Chỉ sau đó
mới thiết kế bản sửa được audit, kiểm tra revision/quyền mới. Bước 1 không cung cấp nút
web hoặc CLI bỏ qua lock, sửa trạng thái sang thành công hay chạy lại email không rõ kết quả.

## Audit, Rules, index và thời gian lưu

Audit khóa theo operation ID, có actor UID, action, target, thời gian server, lý do,
kết quả và mã lỗi cố định. Không chép request/response/exception vào audit. Lý do có
chuỗi nhận diện credential được thay bằng thông báo redacted. Log worker chỉ có mã lỗi
chuẩn và operation ID. Không lưu password, token, private key hoặc link đặt mật khẩu.

Rules giữ `.read = false`, `.write = false` ở root. Trình duyệt, kể cả có claim admin,
không được đọc/ghi trực tiếp operation, audit, search/email index, snapshot, báo cáo,
đáp án, ví, rating hoặc dữ liệu server. Truy cập thông qua callable đã guard.
`database.rules.json` thêm index due/cleanup/expiry và các index phục vụ bước sau;
**chưa deploy Rules/index lên Firebase thật**.

| Dữ liệu | Thời gian lưu mặc định |
|---|---|
| Snapshot / báo cáo | 15 phút; producer ở bước sau đặt `expiresAt` |
| Payload, kết quả, checkpoint operation hoàn tất | 7 ngày |
| Tombstone ID/fingerprint của operation | Giữ bền, không tái sử dụng requestId |
| Operation bị blocked / lock đang dở | Giữ để đối soát, không xóa tự động |
| Audit | 365 ngày |
| Rate bucket | 2 ngày |

Worker xử lý tối đa 25 operation và 25 mục cho mỗi nhánh cleanup trong một lượt,
có lease housekeeping và giãn tối thiểu 10 giây. Tombstone không cho chạy lại mutation
sau khi result hết hạn; client đọc lại tài nguyên. Thay đổi chính sách giữ tombstone/
receipt cần migration riêng để bảo toàn chống lặp.

## Quy tắc cho các bước sau

Profile/Users, mời/đặt mật khẩu, bảo vệ admin cuối cùng và xóa mềm đã được triển khai,
kiểm thử bằng Emulator theo `ADMIN-USERS.md`. Gửi/nhận email thật vẫn cần nghiệm thu riêng.
Các mặc định thống kê dưới đây còn chờ triển khai:

- Bước 5: active là distinct UID cả khoảng; một trận là một KPI; accuracy dùng tổng
  correct/answered; completion dùng tập bắt đầu trong kỳ; kỳ trước cùng độ dài, mẫu
  số 0 trả null; mixed-skill phân bổ theo câu thực tế. Chỉ trả overview khi projection
  đã ready, kèm `asOf` và `lagMs`; dữ liệu chưa dựng xong phải báo lỗi rõ.

## Chạy local và QA

Local/Spark từ `frontend/admin-web`:

```powershell
npm.cmd run dev:local
```

Launcher dùng Functions Emulator + HTTP server + web + worker học/trận/community/
reporting/admin. Auth/RTDB ở chế độ này là **dữ liệu thật**. Cần file khóa còn tồn tại
theo `Backend/server/.env`; lỗi thiếu file in đường dẫn đang được dùng. Không đưa file
khóa vào Git. Không dùng launcher này để chạy bài test phá hủy/tiêm lỗi.

QA tự động từ `Backend/functions`:

```powershell
npm.cmd run test:admin
```

Launcher xóa credential/config thật được kế thừa, không đọc `.env`, chọn project
`demo-englishbattle-admin` và namespace `demo-englishbattle-admin-default-rtdb`.
Auth `127.0.0.1:19299`, Database `127.0.0.1:19200`, Functions `127.0.0.1:15003`;
hub/log/eventarc/tasks lần lượt 14421/14521/19311/19511, UI tắt. Test kiểm tra đích trước
khi import SDK. Yêu cầu Node 24, Java tương thích Emulator và dependencies đã cài.
Trên Windows có thể dùng JBR của Android Studio nếu chưa đặt `JAVA_HOME`.

QA gồm schema 21 API, guard toàn bộ entrypoint, HTTP read/write/export, revoked,
stale/string claim, disabled/banned/deleted, self-protection, duplicate/concurrent,
revision conflict, mất ACK, lỗi Auth→RTDB, lỗi audit sau commit, expired lease,
external outcome chưa rõ, rate limit, retention và Rules. Handler kiểm thử chỉ được
inject trong process test, không export hay bật bằng biến môi trường.

Chưa nghiệm thu Firebase production, email thật, deploy, hoặc các handler Bước 4–6.

## Biên bản nền tảng Bước 1 — 03/11/2026

| Kiểm tra | Kết quả |
|---|---|
| Functions lint + TypeScript build | Đạt |
| Schema admin và semantic validation | 7/7 test đạt; đủ 21 cặp request/response |
| Admin Auth/RTDB/Functions Emulator riêng | 16/16 test đạt |
| Hồi quy backend người dùng | 193/193 test đạt |
| HTTP callable người dùng và worker thật trên Emulator | 10/10 test đạt |
| Server HTTP unit test + syntax check | 7/7 test đạt; syntax check đạt |
| Hợp đồng frontend/mobile và kiểm tra export | 9/9 test đạt |
| Schema JSON đã xuất khớp nguồn runtime | Đạt |

Các test có kết nối loopback đã chạy ngoài sandbox vì sandbox chặn kết nối local
(`EACCES`). Không dùng Firebase thật cho fixture hoặc tiêm lỗi. Android UI/device,
luồng gửi email thật, local launcher kết nối dữ liệu thật và production chưa nghiệm thu
trong mốc này. Kết quả hồi quy chứng minh các ca được chạy; không thay thế nghiệm thu
đồng bộ Android ở Bước 8.

## Biên bản Bước 2 — 03/11/2026

| Kiểm tra | Kết quả |
|---|---|
| Functions toàn bộ lint + TypeScript build | Đạt |
| Schema admin và semantic validation | 7/7 đạt; JSON xuất khớp runtime |
| Admin Auth/RTDB/Functions Emulator | 45/45 đạt, gồm nền tảng và Profile/Users |
| Web unit/component/adapter | 50/50 đạt; production build đạt |
| Web Profile/Users qua SDK thật nối Emulator | 3/3 đạt: CRUD/reload/hai context, profile, mất quyền |
| Hồi quy giao diện demo desktop/mobile | 20/20 đạt; 5 trang, modal, overflow và đăng nhập |
| Server HTTP unit + syntax | 7/7 đạt; syntax đạt |
| Hợp đồng frontend/mobile và export | 9/9 đạt |
| Hồi quy BE1 sau provisioning/session/privacy | 193/193 đạt; HTTP/worker 10/10 đạt |

Các ca admin bao phủ khóa membership giữa CLI/API, hai lần revoke đồng thời, admin
cuối cùng, revision conflict, cùng requestId, lỗi sau Auth/provision/index/audit,
email trùng do race, pending chỉ đọc, stale index writer, snapshot hơn 50 user,
khóa khi học/thi đấu, deleted không hồi sinh, ẩn danh khi đọc và retention.
Worker được kiểm tra không cấp quyền từ pending role intent trong database.

Kiểm thử trên dữ liệu Emulator tách biệt; chưa chạy smoke test Firebase thật, deploy
Rules/Functions, gửi/nhận thư ở hộp thư thật hoặc kiểm chứng Android trên thiết bị.
Email `sent` chỉ xác nhận Firebase chấp nhận yêu cầu. Local launcher dùng dữ liệu thật
vẫn cần đường dẫn khóa Admin SDK hợp lệ trong `Backend/server/.env`.

## Biên bản Bước 3 — 03/11/2026

Đã nối 6 API Catalog/Questions và trang Content thật. Tổng hiện tại 12/21 API có
nghiệp vụ; 9 API của Bước 4–6 vẫn báo `unimplemented`. Kiểm tra đạt 7 schema +
65 admin integration, 54 web unit/component/adapter, 6 browser Firebase/Emulator,
20 browser demo desktop/mobile, 193 hồi quy BE1 + 10 HTTP/worker và 9 contract/export.
Build/lint/format đạt. Quy tắc nội dung, phục hồi và giới hạn kiểm chứng tại
[`ADMIN-CONTENT.md`](ADMIN-CONTENT.md#biên-bản-nghiệm-thu-local--03112026).

Tài liệu Firebase tham chiếu: [thu hồi phiên](https://firebase.google.com/docs/auth/admin/manage-sessions),
[transaction RTDB](https://firebase.google.com/docs/database/admin/save-data),
[callable](https://firebase.google.com/docs/functions/callable).

## Biên bản Bước 4 — 03/11/2026

Đã nối `adminListBattles`, `adminGetBattle`, `adminListActivities` và adapter/web
Battles cùng hộp thoại hoạt động. Tổng hiện tại 15/21 API có nghiệp vụ;
6 API Bước 5–6 tiếp tục báo `unimplemented`. Chi tiết và giới hạn tại
[`ADMIN-MONITORING.md`](ADMIN-MONITORING.md).

| Kiểm tra local trên mã cuối | Kết quả |
|---|---|
| Functions lint, TypeScript build, schema export khớp runtime | Đạt |
| Schema 21 API | 7/7 |
| Hồi quy admin Bước 1–4 | 79/79, gồm 14 kiểm thử giám sát |
| Web unit/component/adapter | 56/56 |
| Browser Firebase qua HTTP/callable Emulator | 9/9, gồm 3 luồng giám sát mới |
| Browser demo desktop/mobile | 20/20 |
| Web production build, format các file TS thay đổi, git diff check | Đạt |

Kiểm thử giám sát dùng matchmaking/settlement/reporting thật trong project Emulator
tách biệt, 63 room và 223 activity. Đã kiểm tra retry không trùng, mất acknowledgement,
lease hết hạn, nguồn sai không được coi là ready, snapshot gắn actor/filter, ngày cuối,
ẩn danh khi xóa mềm và không lộ dữ liệu bí mật. Đã đối chiếu ảnh dialog trận trên web.

Lượt browser đầu gặp lỗi khởi tạo Functions Emulator. Đã dừng cây tiến trình QA,
tăng thời gian discovery riêng local/QA lên 60 giây và chạy lại toàn bộ 9/9 đạt.
Timeout nghiệp vụ web giữ 30 giây. Không sửa Auth/RTDB thật hoặc deploy trong QA.
Launcher Spark thật chỉ kiểm tra cú pháp, vẫn cần khóa Admin SDK hợp lệ.

Chưa nghiệm thu Android trên thiết bị hoặc smoke test Firebase production.
Không chạy lại toàn bộ suite BE1 193+10 trong Bước 4; các luồng user thực tế liên quan
đã được kiểm tra trong suite admin (matchmaking, settlement, reporting, khóa/xóa,
snapshot phiên học và phiên thi đấu). Các số 193+10 ở biên bản Bước 3 là kết quả mốc trước.

## Biên bản Bước 5 — 03/11/2026

Đã triển khai `adminGetOverview`, worker tổng hợp và adapter thật cho Dashboard/Analytics.
Tổng hiện tại 16/21 API có nghiệp vụ. Quy tắc chỉ số, cohort, dữ liệu thiếu, giới hạn,
backfill và độ trễ tại [`ADMIN-ANALYTICS.md`](ADMIN-ANALYTICS.md).

| Kiểm tra local | Kết quả |
|---|---|
| Functions lint, TypeScript build, schema export khớp runtime | Đạt |
| Schema 21 API | 7/7 |
| Hồi quy admin Bước 1–5 | 99/99, gồm 20 kiểm thử thống kê |
| Web unit/component/adapter | 59/59 |
| Browser Firebase SDK qua HTTP/callable Emulator | 12/12, gồm 3 luồng Dashboard/Analytics |
| Browser demo desktop/mobile | 20/20 |
| Web production build, format các file TS thay đổi, git diff check | Đạt |
| Hồi quy backend người dùng | 193/193 |
| HTTP callable người dùng và worker thật trên Emulator | 10/10 |
| Server HTTP unit và syntax | 7/7; syntax đạt |
| Hợp đồng frontend/mobile và kiểm tra export | 9/9 |

Đã đối chiếu nguồn từ engine luyện tập và thi đấu thật trong Emulator: 1 phiên học,
1 trận, 2 UID hoạt động, 30 slot câu hỏi và 17 đúng; settlement lặp không cộng lại.
Kiểm tra bao phủ hơn 50 Auth/session records, distinct UID, kỳ trước, ngày Việt Nam,
calendar buckets, mixed-skill, late completion, thiếu số đếm/start, mất acknowledgement,
lease hết hạn và nguồn lỗi. Worker giữ nguyên ví, rating, grant, ledger và nguồn phiên.
Đã đối chiếu ảnh Dashboard/Analytics với fixture trình duyệt (12 tài khoản, 3 UID
hoạt động, 1 phiên học hoàn tất, 10/10 câu Vocabulary đúng).

Các lượt browser đầu gặp timeout khởi tạo kết nối Emulator và kỳ vọng cũ rằng
Dashboard chưa triển khai. Launcher QA nay kiểm tra các API đọc có xác thực đồng thời
trước khi bắt đầu deadline UI; các bài kiểm thử chờ dữ liệu ban đầu và kiểm tra đúng
popover thông báo. Lượt cuối toàn bộ 12/12 đạt. Timeout nghiệp vụ web vẫn 30 giây.

Toàn bộ fixture và tiêm lỗi dùng project Emulator cô lập, không dùng Auth/RTDB thật.
Chưa deploy Rules/index/Functions, smoke test Firebase production hoặc kiểm chứng
Android trên thiết bị. Launcher Spark dùng dữ liệu thật vẫn cần khóa Admin SDK hợp lệ.
5 API tìm kiếm/thông báo/audit/export thuộc Bước 6; không fallback sang mock khi lỗi.

## Biên bản Bước 6 — 08/11/2026

Đã triển khai và nối adapter thật cho `adminSearch`, `adminListNotifications`,
`adminMarkNotificationsRead`, `adminListAudit`, `adminExportReport`. Tổng hiện tại
21/21 callable nghiệp vụ; 5 trang và tiện ích dùng chung dùng Firebase khi mode thật.
Quy tắc, giới hạn và phục hồi tại [`ADMIN-WORKSPACE.md`](ADMIN-WORKSPACE.md).

| Kiểm tra trên mã Bước 6 | Kết quả |
|---|---|
| Functions lint, TypeScript build, schema xuất khớp runtime | Đạt |
| Schema và semantic validation đủ 21 API | 8/8 |
| Hồi quy admin Bước 1–6 | 117/117, gồm 18 kiểm thử workspace mới |
| Web unit/component/adapter | 67/67 |
| Browser Firebase SDK qua HTTP/callable Emulator | 16/16, gồm 4 luồng Bước 6 mới |
| Browser demo desktop/mobile | 20/20 |
| Web production build, format các file web thay đổi, git diff check | Đạt |
| Hồi quy backend người dùng | 193/193 |
| HTTP callable người dùng và worker thật trên Emulator | 10/10 |
| Server HTTP unit | 7/7 |
| Hợp đồng frontend/mobile và kiểm tra export | 9/9 |

Các ca mới kiểm tra hơn 50 event/audit/user, timestamp trùng, snapshot gắn actor/filter,
tìm kiếm không lộ đáp án/token, thông báo riêng giữa hai admin, mark-all theo thời điểm
publish và late event, rebuild giữ read state, lease hết hạn và retry mất acknowledgement.
Đã tiêm lỗi sau artifact/read-state/audit, gọi trùng đồng thời, đổi quyền/privacy, hết hạn,
vượt dòng/byte và nguồn bị treo: phản hồi đến muộn sau deadline không tạo artifact.

Browser đã kiểm tra tìm kiếm dẫn đúng Users/Content/Battles, hai admin đọc độc lập và
reload giữ trạng thái, audit lọc/phân trang, CSV đủ 11 kết quả lọc dù bảng chỉ hiện 10.
Đã đối chiếu ảnh popover thông báo và modal audit. CSV có BOM và escape công thức;
operation/checkpoint không giữ rows hoặc email của báo cáo, chỉ metadata.

Lượt browser đầu gặp timeout/429 do nhiều lần đọc đồng thời và quota dùng chung giữa
các ca; audit còn phụ thuộc số thao tác từ ca trước. Adapter nay dùng chung các lần đọc
giống nhau đang chờ trong cùng UID/generation, không cache kết quả sau hoàn tất.
Fixture chỉ reset rate limit trong project demo cô lập và ca audit tự tạo operation thật.
Không tăng rate limit production. Lượt cuối toàn bộ 16/16 đạt.

Tài liệu hợp đồng web đã cập nhật theo adapter và DTO thật, gồm Page cho audit/thông báo
và quy trình tạo/nhận export. Lệnh dev:local trong README dùng đường dẫn mới
`D:\Projects\EnglishBattle-full\frontend\admin-web`.

Toàn bộ fixture và tiêm lỗi dùng project Emulator tách biệt. Chưa deploy
Rules/index/Functions, smoke test Auth/RTDB Firebase thật, gửi/nhận email thật hoặc
kiểm chứng Android trên thiết bị trong mốc này. Local/Spark dùng dữ liệu thật vẫn cần
khóa Admin SDK hợp lệ và terminal/worker đang chạy. Báo cáo lớn hơn 5.000 dòng/1 MiB
trả lỗi rõ; chưa có job export lớn. Daily/private, Storage/audio upload và FCM giữ
phạm vi riêng.

## Biên bản Bước 7 — 08/11/2026

Đã rà và hoàn thiện adapter đủ 21 API, App/AdminContext theo UID, 5 trang và các tiện ích
dùng chung. Chi tiết hành vi và giới hạn tại [`ADMIN-INTEGRATION.md`](ADMIN-INTEGRATION.md).

| Kiểm tra trên mã cuối | Kết quả |
|---|---|
| Web unit/component/adapter | 86/86, gồm 19 ca kết nối mới |
| Firebase SDK qua HTTP/callable/Auth/Database Emulator | 18/18 |
| Hồi quy giao diện desktop/mobile | 20/20 |
| Schema đủ 21 API, export khớp runtime | 8/8 |
| Functions lint và TypeScript build trong launcher web | Đạt |
| Web production build Firebase và build demo opt-in | Đạt |
| Bundle Firebase không chứa module mock/seed | Đạt, kiểm tra trong Vite generateBundle |
| Hợp đồng frontend/mobile và kiểm tra export | 9/9 |
| Format nguồn web/fixture thay đổi | Đạt |
| Local launcher syntax; env/project và file credential tồn tại | Đạt về cấu hình, chưa xác thực credential với Firebase thật |

Đã kiểm tra adapter đóng khi đổi phiên, bỏ phản hồi muộn, giữ requestId/payload khi
workspace đóng trước acknowledgement, dùng chung mutation đồng thời và chụp sâu payload.
Form khóa khi gửi, mở lại và giữ giá trị khi timeout/validation/conflict; API chưa hỗ trợ
báo lỗi và không mở dữ liệu mẫu. Refresh Auth từ tài khoản cũ không ghi đè session mới;
mất quyền đóng workspace ngay cả khi signOut còn chờ. Lỗi terminal của intent phiên cũ
không tự đăng xuất phiên hiện tại hợp lệ.

Editor Profile/Users/Catalog đọc dữ liệu và revision hiện tại khi mở; question editor
giữ luồng đọc version hiện tại. Browser kiểm tra hai editor cùng mở: chỉ bên đầu lưu,
bên sau giữ form và báo conflict; mở lại đọc bản mới. Đã kiểm tra mất phản hồi sau server
commit bằng lỗi mạng mô phỏng: lần bấm lại giữ nguyên requestId, revision và audit;
không tạo thay đổi trùng hoặc báo lưu thành công trước khi nhận xác nhận.

Users/Questions trang 1 tạo snapshot mới; trang sau giữ snapshot server và cỡ 10/20/50.
Kiểm tra còn bao phủ reload, dữ liệu/filter thật trên cả 5 trang, thu hồi claim, trạng thái
đọc riêng theo admin, tìm kiếm và báo cáo CSV. Đã loại thông báo export “Demo users” và
nội dung trợ giúp cũ rằng các API tiện ích chưa hoạt động.

Các lượt trước có lỗi đọc RTDB Emulator tạm thời trong CRUD; UI hiển thị timeout và Retry.
Fixture nay dùng chính nút Retry với thời gian chờ có giới hạn khi bảng lỗi đọc, không tự
gửi mutation mới hoặc thay rate limit production. Ca conflict Content cũ cần chờ editor
đọc revision xong rồi mới mô phỏng cập nhật từ xa. Lượt cuối toàn bộ 18/18 đạt. Một lượt
unit chạy cùng Emulator bị timeout ca UI; chạy lại tuần tự trên mã cuối đạt 86/86.

Không thay nguồn backend người dùng, Rules hoặc schema wire trong Bước 7. Không chạy lại
bộ hồi quy BE1 193+10 hoặc toàn bộ admin 117 ca trong mốc này; kết quả đầy đủ gần nhất ở
Bước 6. Functions lint/build, schema và browser tích hợp đã chạy lại qua launcher.

Fixture và tiêm lỗi chỉ dùng project demo Emulator cô lập. Đường dẫn credential local đã
kiểm tra tồn tại, không xuất khóa hoặc chạy worker với dữ liệu thật. Chưa deploy,
smoke test Firebase production, gửi/nhận email thật hoặc nghiệm thu Android trên thiết bị.
Bước 8 và nghiệm thu production vẫn là các mốc riêng.
