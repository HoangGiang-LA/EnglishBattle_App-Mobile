# Danh sách công việc backend — English Battle

> Đây là bản checklist gốc ngày 25/10. Hiện trạng kiểm chứng mục 1 ngày
> 02/11/2026 được ghi tại [biên bản nghiệm thu](tests/be1/ACCEPTANCE.md);
> hướng dẫn chạy lại nằm tại [bộ kiểm thử tích hợp](tests/be1/README.md).

Cập nhật: 25/10/2026. Đây là checklist triển khai tiếp theo, chưa phải backend đã hoạt động. Các ô chưa đánh dấu là việc còn phải làm hoặc kiểm chứng khi tích hợp.

## Phạm vi và hiện trạng

- Android và Web admin cùng dùng Firebase project `englishbattleapp-8d764`, Realtime Database tại `asia-southeast1`.
- Firebase Auth email/password đã có adapter thật. Mật khẩu do Firebase Auth quản lý; không ghi password, password hash hoặc token vào RTDB.
- Android đã có adapter gọi 13 callable. Web admin có 22 phương thức service: 21 callable dự kiến và một `reset` chỉ phục vụ demo.
- `functions/src/index.ts` hiện chỉ là khung cấu hình, chưa export API nghiệp vụ. Admin workspace hiện dùng `MockAdminService` và dữ liệu cục bộ.
- Đã xuất JSON chỉ đọc từ Firebase Console và đối chiếu ngày 25/10/2026: đủ 13 nhánh dữ liệu tĩnh theo seed, gồm 250 câu hỏi, 25 chủ đề, 4 kỹ năng; còn thiếu 11 trường cấu hình mới trong `appConfig/server`, liệt kê ở phần 3.1. Không có trường credential bị công cụ đối chiếu phát hiện trong bản export này; kết quả này không thay thế kiểm thử quyền hoặc API thật.
- Đã đọc Rules trên Firebase Console: `.read: false`, `.write: false`, khớp `database.rules.json` ở gốc. Rules đề xuất mới được thử trên emulator, chưa deploy. Auth đăng nhập được không đồng nghĩa app được phép đọc danh mục khi Rules đang chặn.
- Giữ giao diện theo Figma, bỏ XP/level theo yêu cầu. Không bổ sung Premium, thanh toán, doanh thu hoặc đổi thưởng xu.
- Giai đoạn đầu: luyện tập, bài kiểm tra, thử thách học hằng ngày, thi đấu nhanh và 5 trang admin. Thi đấu theo ngày và phòng riêng giữ nguyên UI/model, phát triển sau. Thử thách học hằng ngày khác với thi đấu theo ngày.

Nguồn hợp đồng: [mobile](../frontend/contracts/mobile.v1.mjs), [admin](../frontend/contracts/admin.v1.json), [luật nghiệp vụ](../frontend/contracts/business-rules.v1.json), [kiểu admin](../frontend/admin-web/src/domain.ts), [schema database](database/schema.md).

## 1. Backend phía người dùng

### 1.1. Tài khoản, quyền truy cập và hồ sơ

- [ ] Khởi tạo Firebase Admin SDK trong môi trường server; lấy UID từ token đã xác thực.
- [ ] Viết `ensureUserProfile` có tính lặp an toàn: gọi nhiều lần không đặt lại rating, ví hoặc tiến độ.
- [ ] Provision các bản ghi cần thiết theo UID: `users`, `userPrivate`, `accountAccess`, `userStats`, `wallets` và các mặc định nghiệp vụ phù hợp schema.
- [ ] Tài khoản mới có rating 0; không tạo lịch sử, trận đấu hoặc số dư giả để lấp các nhánh runtime.
- [ ] Kiểm tra `active/banned/deleted` ở mọi API; không cho `ensureUserProfile` tự mở lại tài khoản bị khóa/xóa.
- [ ] Đồng bộ tên/email giữa Auth và hồ sơ nghiệp vụ sau thay đổi hợp lệ; không tin email/UID do client tùy ý gửi.
- [ ] Thiết kế xử lý khi tạo Auth thành công nhưng provision RTDB thất bại; retry phục hồi được mà không tạo hai hồ sơ.
- [ ] Giữ đăng nhập/đăng ký/reset password bằng SDK Auth; kiểm thử email reset, đổi email có xác thực lại và khôi phục phiên thật.

### 1.2. Danh mục và ngân hàng câu hỏi

- [ ] Xác nhận dữ liệu cloud khớp schema và các ID frontend sử dụng; kiểm tra quan hệ kỹ năng → chủ đề → bài → câu hỏi.
- [ ] Chỉ trả nội dung được xuất bản và hợp lệ; `Idioms & Phrases` thuộc Vocabulary, không phải kỹ năng thứ năm.
- [ ] Hỗ trợ query danh mục `orderByChild("status").equalTo("published")`; cấu hình Rules/index đúng với query thực tế.
- [ ] Tách metadata câu hỏi, phiên bản bất biến và đáp án riêng: `questions`, `questionVersions`, `questionAnswers`.
- [ ] Chọn câu ngẫu nhiên bằng server, giữ question ID, version, thứ tự và option ID ổn định trong suốt phiên.
- [ ] Không trả đáp án đúng/giải thích trong payload câu hỏi đang chơi; không trả lựa chọn chưa công bố của đối thủ.
- [ ] Xử lý ngân hàng không đủ câu hợp lệ bằng lỗi rõ ràng, không sinh đề thiếu số câu hoặc trừ lượt trước khi start thành công.

### 1.3. Luyện tập và bài kiểm tra

- [ ] Viết vòng đời start → resume → submit → advance → hoàn tất/rời phiên → kết quả/review.
- [ ] Luyện tập 10 câu, kiểm tra 20 câu; luyện tập gắn chủ đề/kỹ năng đã chọn, không lấy câu thuộc kỹ năng khác.
- [ ] Mỗi câu có deadline 30 giây do server xác định; resume không bốc lại đề hoặc cấp lại 30 giây.
- [ ] Kiểm tra người sở hữu phiên, trạng thái hiện tại, question ID, option ID và deadline trước khi nhận đáp án.
- [ ] `optionId: null` biểu thị không trả lời/hết giờ; server kiểm tra thời gian, không tin client tự khai đã hết giờ.
- [ ] Chấm điểm và tổng hợp kỹ năng trên server. Kết quả terminal phải có `result`; đảm bảo dữ liệu đúng schema và ngữ nghĩa.
- [ ] Chống gửi trùng, hai thiết bị cùng nộp, advance sớm, callback muộn và start lặp sau timeout.
- [ ] Server tự xử lý phiên hết hạn; không phụ thuộc việc app còn mở hoặc client gọi advance.
- [ ] Chỉ cấp review/đáp án theo trạng thái đã cho phép và cho đúng chủ phiên.

### 1.4. Thử thách học hằng ngày

- [ ] Dùng múi giờ `Asia/Ho_Chi_Minh`, ngày do server xác định.
- [ ] Một lượt/người/ngày, khóa duy nhất `userDailyChallenges/{uid}/{dateKey}` trên mọi thiết bị.
- [ ] Chiếm lượt khi start thành công; mở lại tiếp tục phiên cũ, bỏ dở không tạo thêm lượt cùng ngày.
- [ ] Mỗi lượt 5 câu, 30 giây/câu; deadline câu bị giới hạn bởi mốc 00:00 kế tiếp.
- [ ] Đến 00:00 kết thúc phiên cũ bằng `status: abandoned`, `result.outcome: abandoned`, thưởng 0 xu.
- [ ] Không thưởng cho đáp án/kết quả cũ gửi trễ; phiên cũ không chiếm lượt của ngày mới.
- [ ] Chốt kết quả nguyên tử khi hoàn tất và hết ngày xảy ra đồng thời; kết quả đã chốt không thay đổi.

### 1.5. Thi đấu nhanh và kết nối lại

- [ ] Xây hàng chờ, ticket tìm trận, ghép hai UID khác nhau, hủy tìm và hết hạn ticket.
- [ ] Không để một người bị ghép vào hai trận hoặc gặp chính mình; chống hai worker cùng lấy một ticket.
- [ ] Tạo một bộ 10 câu/version chung cho hai người; quản lý thứ tự vòng, deadline và trạng thái trận trên server.
- [ ] `findBattle` giai đoạn đầu chỉ phục vụ `quick`; `daily/create/join` trả `UNIMPLEMENTED` rõ ràng, không tự chuyển sang quick.
- [ ] Xử lý race giữa hủy tìm và ghép trận; dùng trạng thái đã commit để quyết định hủy hoặc rời trận.
- [ ] Thiết kế tín hiệu sống theo phiên/thiết bị và phát hiện mất kết nối. Có thể dùng polling `resumeAttempt` hiện có làm tín hiệu được server ghi nhận nếu đủ yêu cầu; nếu cần heartbeat/presence riêng phải bổ sung hợp đồng và adapter tương ứng.
- [ ] Cho phép kết nối lại trong 30 giây; một bên quá hạn thì thua. Không dùng thông báo mạng từ client làm bằng chứng duy nhất.
- [ ] Khi cả hai đã quá grace và trận chưa chốt: hòa, không đổi rating, không thưởng xu.
- [ ] Chủ động rời trận đang chơi: xử thua theo luật đã có. Hai người cùng chủ động rời cần chốt quy tắc trước khi triển khai.
- [ ] Chốt đúng một kết quả dù submit, timeout, leave và reconnect đến đồng thời; trạng thái cuối bất biến.
- [ ] Lưu kết quả, lịch sử, review và log cần thiết cho hai người; không lưu dữ liệu nhạy cảm không cần thiết.

### 1.6. Xu, rating, tiến độ, thành tích và thông báo

| Sự kiện hợp lệ | Rating | Xu |
| --- | --- | --- |
| Thắng trận | +5 | +5 |
| Thua trận | `max(0, rating cũ - 2)` | 0 |
| Hòa | 0 | 0 |
| Hoàn thành luyện tập | 0 | +1 |
| Hoàn thành bài kiểm tra | 0 | +2 |
| Hoàn thành thử thách học ngày | 0 | +2 |
| Thử thách hết ngày/bỏ dở | 0 | 0 |

- [ ] Tạo `coinLedger`, `ratingLedger`, `rewardGrants`; dùng khóa sự kiện ổn định để mỗi kết quả chỉ tạo một hiệu ứng thưởng.
- [ ] Lưu actual rating delta sau khi áp sàn 0; thua từ rating 1 có delta -1, không ghi sai thành -2.
- [ ] Thiết kế transaction/operation/outbox hoặc cách tương đương để phục hồi khi kết quả đã chốt nhưng cập nhật ví, thống kê hoặc notification chưa xong. Không giả định nhiều lần ghi riêng rẽ là một giao dịch nguyên tử.
- [ ] Tiến độ 0/20 tính số lần hoàn thành luyện tập hợp lệ theo từng mục; retry không tăng, attempt mới hoàn thành được tăng. Test/daily không tự tăng tiến độ luyện tập.
- [ ] Mở thành tích của đúng mục ở lần hoàn thành thứ 20 đúng một lần; chưa có yêu cầu thưởng xu riêng cho thành tích.
- [ ] Tổng hợp `userActivityDaily`, `userSkillStats`, streak và các số liệu cần cho dashboard bằng dữ liệu nguồn thật.
- [ ] Cung cấp thống kê đầy đủ kỳ hiện tại/kỳ trước để màn tiến độ không phụ thuộc 50 bản ghi lịch sử gần nhất; xem phần 3.3.
- [ ] Hai tab bảng xếp hạng Tuần/Tháng cùng xếp tất cả người chơi theo rating tích lũy hiện tại; không reset rating hoặc lọc theo hoạt động trong kỳ.
- [ ] Phân trang bảng hạng nhất quán, có vị trí bản thân; mặc định kỹ thuật hiện tại là rating giảm dần rồi UID tăng dần.
- [ ] Tạo notification trong app từ sự kiện thật, đánh dấu đọc đúng UID; destination chỉ thuộc danh sách màn hình cho phép.
- [ ] Giữ giới hạn payload dashboard/lịch sử/ledger; khi cần xem đầy đủ phải có API phân trang thay vì tải toàn bộ dữ liệu.

### 1.7. Danh sách 13 callable người dùng

Mọi response có `serverNow` theo epoch milliseconds. Kiểu trường, bắt buộc/tùy chọn và enum lấy trực tiếp từ `mobile.v1.mjs`.

| Callable | Công việc chính | Payload ngoài `serverNow` |
| --- | --- | --- |
| `ensureUserProfile` | Provision hồ sơ lặp an toàn | Không có |
| `getUserDashboard` | Tổng hợp dữ liệu người dùng | `dashboard` |
| `startAttempt` | Bắt đầu phiên học hợp lệ | `attempt` |
| `resumeAttempt` | Phục hồi trạng thái server | `attempt` |
| `submitAttemptAnswer` | Nhận/chấm câu trả lời | `attempt` |
| `advanceAttempt` | Chuyển lượt được phép | `attempt` |
| `leaveAttempt` | Rời phiên theo luật | `attempt` |
| `findBattle` | Tìm trận và trả ticket | `ticket` |
| `getBattleTicket` | Đọc trạng thái tìm trận | `ticket` |
| `cancelBattleSearch` | Hủy tìm theo trạng thái hiện tại | Không có |
| `getLeaderboard` | Bảng rating, cursor và vị trí bản thân | `page` |
| `markNotificationsRead` | Đánh dấu đọc thông báo của mình | Không có |
| `getAttemptResult` | Đọc kết quả/review được phép | `result` |

## 2. Backend phía admin

Mốc 07/11/2026: nền tảng API và Bước 2–6 đã triển khai ở local/Emulator;
chưa deploy production hoặc kiểm chứng email/Android thiết bị thật. Chi tiết và biên bản:
[`functions/ADMIN.md`](functions/ADMIN.md), [`functions/ADMIN-USERS.md`](functions/ADMIN-USERS.md),
[`functions/ADMIN-CONTENT.md`](functions/ADMIN-CONTENT.md), [`functions/ADMIN-MONITORING.md`](functions/ADMIN-MONITORING.md).
Dashboard/Analytics và quy tắc số liệu: [`functions/ADMIN-ANALYTICS.md`](functions/ADMIN-ANALYTICS.md).
Tìm kiếm/thông báo/audit/export: [`functions/ADMIN-WORKSPACE.md`](functions/ADMIN-WORKSPACE.md).
Các dấu hoàn thành dưới đây chỉ áp dụng cho mốc local/Emulator này.

### 2.1. Xác thực và phân quyền

- [ ] Cấp custom claim boolean `admin: true` từ môi trường tin cậy theo danh sách quản trị được chủ dự án cho phép.
- [x] Mọi API admin kiểm tra token, claim và `accountAccess` active; kiểm tra lại phía server kể cả khi UI đã ẩn nút.
- [ ] Nếu tách vai trò nội dung/vận hành, định nghĩa rõ quyền từng thao tác; chưa tự thêm màn phân quyền mới.
- [x] Có cách thu hồi quyền, khóa tài khoản và xử lý token/claim còn cache; không chỉ dựa vào claim cũ khi tài khoản đã bị khóa.
- [x] Không đưa service-account, private key hoặc Admin SDK vào APK/web bundle.
- [x] Chặn tự khóa/xóa, bảo vệ admin hoạt động cuối cùng qua khóa chung giữa API trạng thái và công cụ claim server.

### 2.2. Dashboard và Analytics

- [x] Dashboard/Analytics dùng adminGetOverview: tài khoản/Auth, phiên học, room và summary thật; công bố asOf/lag/coverage.
- [x] Active là union UID theo timestamp thực; trận một room cho KPI, hai UID cho hoạt động; mixed-skill theo snapshot câu thực.
- [x] Ngày Việt Nam gồm ngày cuối, bucket lịch ngày/tuần/tháng; cohort completion theo phiên bắt đầu trong kỳ, không gán start cho lịch sử thiếu.
- [x] Kỳ trước cùng số ngày lịch; mẫu số 0 hoặc dữ liệu tỷ lệ không đủ trả null/N/A/lỗi rõ.
- [x] Accuracy tổng đúng/tổng slot đã phân xử trong các phiên terminal của kỳ, gồm abandoned có câu đã trả lời.
- [x] Backfill phân trang, checkpoint/lease, receipt chống lặp; generation riêng và publish pointer nguyên tử, giữ bản cũ khi lỗi; không tải source root về web.
- [x] Xuất toàn bộ kết quả theo bộ lọc; BOM UTF-8 và chống CSV formula injection. Giới hạn 5.000 dòng/1 MiB/20 giây; báo cáo lớn báo lỗi rõ, chưa có job lớn.

### 2.3. Quản lý người dùng

- [x] Danh sách, tìm kiếm, bộ lọc, phân trang và chi tiết dùng UID ổn định; mã hiển thị không thay thế UID.
- [x] Tạo/sửa tên và email đồng bộ Auth/RTDB, xử lý email trùng và lỗi cập nhật một phần. Kết quả Auth chưa rõ giữ lock để đối soát.
- [x] Mời/đặt mật khẩu qua email Firebase; có trạng thái gửi và gửi lại có chủ ý, không lưu password/link vào RTDB. Còn cần nghiệm thu hộp thư thật.
- [x] Khóa/mở khóa/xóa có lý do và audit; xóa mềm, thu hồi phiên, settlement phiên đang hoạt động và ẩn danh khi đọc lịch sử.
- [x] Rating/xu trong trang người dùng chỉ đọc; không tạo API sửa tùy ý khi chưa có nghiệp vụ được duyệt.
- [x] Không cho thao tác quản lý hồ sơ tự cấp quyền admin.
- [x] Hồ sơ admin lấy từ Auth/RTDB, sửa tên với revision và đồng bộ index.

### 2.4. Quản lý nội dung/câu hỏi

- [x] Quản lý kỹ năng, chủ đề, bài học và trạng thái; kiểm tra quan hệ cha–con trước xuất bản. Cha draft/archive chặn chọn câu mới, giữ trạng thái con.
- [x] Danh sách/tìm kiếm/lọc câu hỏi có index, snapshot phân trang và tổng chính xác; vượt giới hạn báo lỗi.
- [x] Server kiểm tra 4 option có ID ổn định, text không trùng, đáp án nằm trong tập option; published cần giải thích.
- [x] Reading cần passage; Listening dùng TTS/audioText trong phạm vi hiện tại, không nhận file/URL.
- [x] Chuyển admin `version: 1` ↔ RTDB `v1`; options array ↔ map option ID có `order`.
- [x] Dùng `expectedVersion` để từ chối sửa dữ liệu cũ; sửa/archive tạo version mới, không sửa snapshot phiên đang học/thi đấu.
- [x] Archive thay vì xóa cứng câu đang được tham chiếu trong lịch sử/attempt.
- [ ] Nếu dùng audio upload thật: Storage, kiểm tra quyền/loại/kích thước, metadata và dọn file mồ côi. Mock base64 hiện tại không phải luồng lưu trữ production.

### 2.5. Trận đấu, hoạt động và vận hành

- [x] Danh sách/chi tiết trận nhanh, timeline và bộ lọc dùng nguồn server. `ready/active` → `ongoing`; không tạo log thiếu. Daily/private báo chưa triển khai.
- [x] Không lộ lựa chọn, đáp án bí mật, session ID hoặc token; điểm live chỉ tính vòng đã chốt.
- [x] Hoạt động đăng ký/học/thi đấu có ID ổn định, worker checkpoint/lease, phân trang snapshot và asOf; chạy lại không tạo dòng trùng.
- [x] Phạm vi hiện tại là xem/giám sát; không có API đảo kết quả/hủy trận. Reads không chạy settlement hoặc sửa nguồn.
- [x] Tìm kiếm toàn hệ thống có giới hạn, chỉ trả nhóm/đường dẫn cho phép; index chứa email chỉ qua API admin.
- [x] Hộp thư admin và trạng thái đọc gắn đúng UID admin; event có ID ổn định, mark-all giữ cutoff, phân trang và retention.
- [x] Audit do backend ghi theo operation ID: actor, target, thời gian server, kết quả và lý do đã lọc; phân trang/lọc, không ghi mật khẩu/token.
- [x] Không cung cấp `reset()` dữ liệu production; đó là phương thức chỉ dành cho demo.

### 2.6. Danh sách 21 callable admin

Tên và request cụ thể lấy từ `admin.v1.json` và `admin.schemas.v1.json`; kiểu UI lấy từ
`domain.ts`. Cả 21 callable đã có guard/schema; 6 API Profile/Users có nghiệp vụ và
adapter thật; Bước 3 bổ sung 6 API Catalog/Questions, Bước 4 bổ sung 3 API Battles/Activities.
Overview của Bước 5 bổ sung Dashboard/Analytics. Bước 6 bổ sung tìm kiếm/thông báo/audit/export;
tổng 21/21 có nghiệp vụ. Mutation/tạo export có operationId; nhận export dùng reportId và kiểm tra quyền riêng.
Xem `functions/ADMIN-CONTENT.md` và `functions/ADMIN-MONITORING.md`.

| Callable | Phương thức AdminService | Payload ngoài `serverNow` |
| --- | --- | --- |
| `adminGetProfile` | `profile` | `profile` |
| `adminUpdateProfile` | `saveProfile` | `profile` |
| `adminGetOverview` | `overview` | `overview` |
| `adminListUsers` | `users` | `page` |
| `adminGetUser` | `user` | `user` |
| `adminSaveUser` | `saveUser` | `user` |
| `adminSetUserStatus` | `setUserStatus` | Không có |
| `adminListQuestions` | `questions` | `page` |
| `adminGetQuestion` | `question` | `question` |
| `adminSaveQuestion` | `saveQuestion` | `question` |
| `adminArchiveQuestion` | `archiveQuestion` | Không có |
| `adminGetCatalog` | `catalog` | `catalog` |
| `adminSaveContent` | `saveContent` | Không có |
| `adminListBattles` | `battles` | `page` |
| `adminGetBattle` | `battle` | `detail` |
| `adminListActivities` | `activities` | `page` |
| `adminSearch` | `search` | `items` |
| `adminListNotifications` | `notifications` | `page` |
| `adminMarkNotificationsRead` | `readNotifications` | Không có |
| `adminListAudit` | `audit` | `page` |
| `adminExportReport` | `exportReport` | `report` |

## 3. Kết nối API, Firebase và kiểm thử tích hợp

### 3.1. Môi trường và dữ liệu

- [ ] Thiết lập môi trường local/staging riêng và cấu hình runtime phù hợp với Functions; project hiện dùng TypeScript, `functions/package.json` khai báo Node 24.
- [ ] Chuẩn hóa region `asia-southeast1`, database URL và nguồn cấu hình; không nhầm project demo emulator với project thật.
- [x] Đối chiếu export cloud bằng công cụ trong `frontend/verification`: đủ 13 static roots, còn 11 trường cấu hình thiếu; đây là kiểm tra snapshot vừa xuất, chưa phải kiểm thử API người dùng/admin end-to-end.
- [ ] Migration chọn lọc 11 trường thiếu trong `appConfig/server` theo `business-rules.v1.json`: `bothDisconnectedAfterGraceOutcome`, `bothDisconnectedRatingDelta`, `bothDisconnectedCoins`; `dailyChallengeExpiresAtNextMidnight`, `dailyChallengeExpiredWireStatus`, `dailyChallengeExpiredWireOutcome`, `dailyChallengeExpiredCoins`; `leaderboardMetric`, `leaderboardParticipants`, `weekMonthUseSameRanking`, `leaderboardRatingReset`. Kiểm tra giá trị sau migration và để backend thực thi các quy tắc này; chỉ thêm cấu hình chưa tạo ra hành vi server.
- [ ] Migration có backup và chỉ cập nhật nhánh cần thiết; không import lại seed vào root database đang có tài khoản/kết quả thật.
- [ ] Hoàn thiện Rules/index theo nhu cầu truy cập đã thống nhất. Chỉ triển khai khi provisioning và API tương thích đã sẵn sàng; giữ chặn client tự ghi rating/xu/quyền/đáp án.
- [ ] Admin SDK tự kiểm tra quyền và input vì client Rules không bảo vệ các thao tác đặc quyền của server.
- [ ] Thiết lập giới hạn request, kích thước payload, deadline, rate limit chống spam và lịch dọn dữ liệu hết hạn.
- [ ] Định nghĩa retry/backoff, log có mã tương quan, cảnh báo tác vụ lỗi và quy trình phục hồi; bảo vệ dữ liệu riêng tư trong log/backup.
- [ ] Kiểm tra điều kiện gói dịch vụ, billing và quota trên Console trước triển khai Functions/Storage/scheduler; chưa bật dịch vụ trả phí chỉ để làm checklist này.

### 3.2. Adapter và lỗi API

- [ ] Triển khai 13 callable mobile, giữ nguyên envelope và DTO đã có; kiểm tra schema của cả request và response.
- [x] Viết adapter Firebase callable đủ 21 API `AdminService`; mode thật mở sau xác thực/quyền, không fallback mock. Hoàn thiện local/Emulator ở Bước 7; xem `functions/ADMIN-INTEGRATION.md`.
- [x] `AdminService.mode` hỗ trợ firebase/demo; mặc định Firebase, demo opt-in, giữ bố cục 5 trang và kiểm tra bundle Firebase không chứa mock/seed.
- [ ] Client gửi Firebase Auth token qua SDK; server lấy UID/claim từ context đã xác thực. Không dùng UID client gửi làm căn cứ quyền.
- [ ] Response có `serverNow` epoch ms; deadline và dateKey dùng giờ server. Không cho client tự quyết định thời gian tính thưởng.
- [ ] Mutation dùng request ID ổn định qua retry/timeout; server dedupe theo UID + operation + ID, kiểm tra nội dung yêu cầu và trả lại kết quả đã commit.
- [ ] Ánh xạ lỗi xác thực, thiếu quyền, validation, không tìm thấy, xung đột version/trạng thái, timeout và dịch vụ tạm lỗi sang trạng thái UI hiện có.
- [ ] Không báo thành công khi server chưa xác nhận; lỗi API thật không chuyển ngầm sang demo. Sau timeout cần xác minh trạng thái/operation thay vì giả định chưa ghi.
- [ ] Admin giữ phân trang 10/20/50 và tổng theo bộ lọc. RTDB cần index/snapshot hoặc adapter lưu lịch sử cursor để giữ UI số trang; không giả offset bằng cách tải toàn bộ tập.

### 3.3. Điểm cần hoàn thiện ở lớp tích hợp frontend

Các việc dưới đây thuộc kết nối API, có thể cần sửa ViewModel/DTO/service khi backend được triển khai, đồng thời giữ giao diện Figma.

- [ ] **Thứ tự khởi tạo tài khoản:** hiện `App.kt` bắt đầu catalog và dashboard song song; `ensureUserProfile` nằm trong dashboard refresh. Rules đề xuất yêu cầu `accountAccess` active, nên tài khoản mới có thể bị từ chối catalog trước khi provision xong. Chờ provision thành công rồi mở listener, hoặc có cơ chế retry sau provision; kiểm thử cả tài khoản mới và tài khoản bị khóa. Leaderboard cũng cần tránh chạy trước bước khởi tạo cần thiết.
- [ ] **Thống kê tiến độ:** `ProgressScreen` hiện tính tuần/tháng từ `dashboard.history`, trong khi schema giới hạn lịch sử 50 mục. Cần DTO/API thống kê theo kỳ hoặc tải đủ dữ liệu có phân trang để accuracy/biểu đồ/kỳ trước đúng khi người dùng hoạt động nhiều; không chỉ tăng giới hạn tùy ý. Frame Figma ghi biểu đồ hoạt động bằng **phút học**, còn frontend hiện đếm số phiên đã tải. Cần thống nhất cách ghi thời lượng học hợp lệ trên server, bổ sung dữ liệu phút theo ngày/kỳ vào hợp đồng và nối lại biểu đồ để đúng ý nghĩa thiết kế; không đổi đơn vị ngầm hoặc dùng số phiên làm số phút.
- [ ] **Thời gian và phản hồi bài học:** frame kết quả luyện tập có thời gian hoàn thành, frame câu hỏi có giải thích sau khi nộp. DTO hiện chưa có thời lượng kết quả và receipt chưa có explanation. Cần bổ sung trường/mapping tương ứng nếu nghiệm thu đúng các thông tin trên Figma; chỉ trả giải thích sau thời điểm được phép cho đúng chế độ, không làm lộ đáp án hoặc câu chưa chơi trong trận đấu.
- [ ] **Mất kết nối trận:** app đang poll khoảng 3 giây khi foreground và resume khi quay lại; chưa có giao thức presence/heartbeat riêng. Chốt cách server nhận biết phiên thật còn sống và kiểm thử hết grace ngay cả khi app bị kill.
- [ ] **Nghe:** DTO câu hỏi mobile hiện hỗ trợ `audioText`/TTS, còn admin có `audioUrl`. Nếu phát file audio thật, bổ sung DTO/parser/player và kiểm thử quyền truy cập file; chỉ triển khai Storage backend là chưa đủ.
- [ ] **Lịch sử/ledger:** dashboard trả tối đa 50 mục; nếu phạm vi sản phẩm cần duyệt toàn bộ, bổ sung hợp đồng phân trang và nối với UI phù hợp trước nghiệm thu.
- [ ] **Danh tính hiển thị:** avatar một số màn đang là ảnh mặc định/chọn theo thứ hạng; nếu yêu cầu avatar cá nhân thật, thêm nguồn dữ liệu và mapping tương ứng, không coi ảnh mặc định là ảnh từ Firebase.
- [ ] **Auth bổ sung:** Google hiện là nút có thông báo chưa cấu hình; điện thoại chưa có OTP dù provider đã bật. Chỉ tích hợp khi phạm vi được chốt; bật provider không tự tạo luồng đăng nhập trong app.
- [ ] **Thông báo/cài đặt:** thông báo trong app khác FCM push. Nếu cần push hoặc đồng bộ cài đặt nhiều thiết bị, bổ sung SDK, token thiết bị, API đăng ký/hủy và tuân thủ lựa chọn nhận thông báo. Hiện các tùy chọn được lưu cục bộ theo tài khoản.

### 3.4. Những quyết định còn cần chốt

- [ ] Phạm vi chọn câu cho test/daily/battle: trộn kỹ năng hay theo cấu hình; không tự coi mặc định seed là yêu cầu cuối cùng.
- [ ] Có cấm lặp câu trong cùng phiên, cách đồng bộ vòng và deadline khi reconnect; ghi rõ mặc định kỹ thuật trước khi áp dụng.
- [ ] Hai người cùng chủ động thoát, sự cố server, và thứ tự xử lý các sự kiện terminal cạnh tranh.
- [ ] Định nghĩa streak, độ trễ bảng hạng/thống kê, thời gian giữ log và chính sách dữ liệu khi xóa tài khoản.
- [ ] Phạm vi Google/OTP, audio file, push, đồng bộ cài đặt và avatar thật; không coi toàn bộ là đã triển khai.
- [ ] Các nghiệp vụ daily battle/phòng riêng giữ cho giai đoạn sau: lịch, giới hạn lượt, mã phòng, host, phòng đầy/hết hạn và lời mời nếu có.

### 3.5. Kiểm thử và tiêu chí nghiệm thu

- [ ] Chạy lại test frontend/hợp đồng/Rules hiện có, sau đó thêm test backend và kiểm thử tích hợp dùng tài khoản thử riêng trên staging.
- [ ] Auth → provision → catalog → dashboard hoạt động với tài khoản mới; khóa/xóa/thu hồi admin chặn đúng cả API và quyền đọc.
- [ ] Không đọc được email/đáp án của người khác, không tự tăng rating/xu, không sửa quyền, không truy cập attempt của UID khác.
- [ ] Hai thiết bị cùng UID, hai worker, retry sau server đã commit, submit/advance/result lặp không làm tăng lượt/thưởng/tiến độ.
- [ ] Đủ số câu, đề/version giữ nguyên khi resume, câu hết 30 giây, app nền/kill/reopen và thiếu mạng được xử lý đúng.
- [ ] Daily start sát 00:00, quá ngày, submit trễ và hai thiết bị cùng start không tạo lượt hoặc phần thưởng sai.
- [ ] Hai tài khoản trên hai thiết bị thật nhận cùng bộ câu; hủy tìm khi vừa matched, chủ động rời, mất kết nối trước/sau 30 giây, cả hai quá grace đều đúng luật.
- [ ] Rating thua từ 0/1/5 lần lượt thành 0/0/3; thắng +5 rating/+5 xu; hòa 0; kết quả bất biến và ledger khớp số dư.
- [ ] Luyện tập lần 19/20/21 mở thành tích đúng một lần; cùng attempt retry không tăng lượt, attempt mới hoàn tất được tăng.
- [ ] Thống kê khi có hơn 50 hoạt động vẫn đúng kỳ hiện tại/kỳ trước; leaderboard phân trang không trùng/mất và Tuần/Tháng cùng rating.
- [ ] Admin tạo/sửa/khóa user, sửa/phiên bản/xuất bản/archive câu, lọc/phân trang, audit và export đều phản ánh dữ liệu thật sau reload.
- [ ] File audio/FCM/Auth bổ sung chỉ nghiệm thu khi được đưa vào phạm vi và chạy thử end-to-end.
- [ ] Build release không đóng gói dữ liệu/nút demo; kiểm tra signing, domain admin, HTTPS và chính sách bảo mật trước phát hành.
- [ ] Deploy API và Rules theo trình tự tương thích, có rollback/backup; chạy smoke test sau deploy. Hosting admin là bước triển khai riêng, đăng ký Web App không tự publish website.
- [ ] Nghiệm thu giao diện với các frame Figma riêng. Backend/API chạy đúng không chứng minh UI đã giống thiết kế.

## Thứ tự thực hiện đề nghị

1. Chốt các điểm còn mở, đối chiếu cloud, chuẩn bị staging/backup và hợp đồng.
2. Provision tài khoản, kiểm tra quyền, đọc catalog/dashboard và sửa thứ tự khởi tạo ở lớp tích hợp.
3. Admin Users/Content để quản lý nội dung thật, giữ phiên bản câu hỏi bất biến.
4. Phiên học/test/daily, deadline, chấm bài, kết quả và chống thưởng lặp.
5. Thi đấu nhanh, tín hiệu kết nối, grace period, phân xử và ledger.
6. Bảng hạng, thống kê đầy đủ, thành tích, lịch sử, notification; hoàn thiện Dashboard/Analytics/admin audit/export.
7. Adapter admin thật, các bổ sung DTO/mobile cần thiết và tích hợp tùy phạm vi đã chốt.
8. Kiểm thử staging hai tài khoản/hai thiết bị, đối chiếu Figma, triển khai API/Rules và nghiệm thu dữ liệu thật.

Có thể bắt đầu backend từ checklist này. Chỉ xác nhận dự án hoàn tất khi dữ liệu thật đi qua toàn bộ luồng, quyền được kiểm thử, các lỗi tích hợp được xử lý và giao diện được nghiệm thu; việc có database và đăng nhập thành công chưa đủ.
