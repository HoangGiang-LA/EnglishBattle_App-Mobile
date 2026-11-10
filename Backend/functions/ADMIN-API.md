# Backend Admin Callable API v1

Ngày kiểm tra: 01/11/2026. Base HEAD 7f20694, nhánh Admin, working tree đã có thay đổi frontend/local từ trước. Chỉ kiểm thử trên demo-englishbattle; không deploy hoặc sửa cấu hình/dữ liệu Firebase cloud. Đây là trạng thái implementation mới, không dùng PASS từ tài liệu cũ.

## Hợp đồng và trạng thái

21 hàm được export từ src/index.ts, onCall v2, region asia-southeast1, timeout handler 60 giây. Nguồn tên/request/payload: frontend/contracts/admin.v1.json. Wire DTO tại src/admin/model.ts đối chiếu domain.ts và validator frontend trong integration test. Không có reset production, không thêm REST CRUD vào HTTP server.

SDK nhận result.data; return của handler chỉ là {serverNow,...payload}, không tự bọc result. HTTP Callable transport tự bọc {result:...}; getAdminSession HTTP vẫn trả role admin, còn AdminProfile.role là administrator.

| Callable | Request | Payload ngoài serverNow | Trạng thái |
| --- | --- | --- | --- |
| adminGetProfile | {} | profile | Đã triển khai |
| adminUpdateProfile | name, requestId | profile | Đã triển khai |
| adminGetOverview | range, categoryId? | overview | Đã triển khai; cần nguồn battle đã xác minh |
| adminListUsers | query | page | Đã triển khai |
| adminGetUser | id | user | Đã triển khai |
| adminSaveUser | input, id?, requestId | user | Đã triển khai |
| adminSetUserStatus | id, status, reason, requestId | không có | Đã triển khai |
| adminListQuestions | query | page | Đã triển khai |
| adminGetQuestion | id | question | Đã triển khai |
| adminSaveQuestion | input, id?, expectedVersion?, requestId | question | Đã triển khai |
| adminArchiveQuestion | id, expectedVersion, requestId | không có | Đã triển khai |
| adminGetCatalog | {} | catalog | Đã triển khai |
| adminSaveContent | input, requestId | không có | Đã triển khai |
| adminListBattles | query | page | Đã triển khai; cần nguồn battle đã xác minh |
| adminGetBattle | id | detail | Đã triển khai; cần nguồn battle đã xác minh |
| adminListActivities | query | page | Đã triển khai; cần nguồn battle đã xác minh |
| adminSearch | q | items | Đã triển khai |
| adminListNotifications | {} | items | Đã triển khai |
| adminMarkNotificationsRead | id?, requestId | không có | Đã triển khai |
| adminListAudit | query? | items | Đã triển khai |
| adminExportReport | kind, query, range | report | Đã triển khai; battles/analytics phụ thuộc nguồn battle |

Mỗi callable đã được kiểm thử từ chối anonymous/learner và kiểm tra response khớp wire schema khi có nguồn/fixture hợp lệ. Không coi fixture battle là battle engine hoạt động. Chi tiết số test cập nhật ở phần kiểm thử cuối tài liệu.

## Quyền và lỗi

Từng request kiểm tra request.auth, Bearer ID token bằng verifyIdToken(token,true), UID phải khớp request.auth.uid; token claim/request.auth.token/current Auth user custom claims đều admin === true, Auth không disabled, accountAccess/{uid}/status === active. Token bị thu hồi, hết hạn hoặc user biến mất bị từ chối; emulator không bỏ kiểm tra. Helper không provision và không tự mở khóa.

Actor luôn lấy từ Auth. Thao tác admin được kiểm tra quyền trước cả việc trả kết quả idempotency đã cache. Không log token/password hoặc trả stack trace. HTTP getAdminSession/BE1 không thay implementation.

| Mã HttpsError | Ví dụ |
| --- | --- |
| unauthenticated | Không token, token bị thu hồi/hết phiên |
| permission-denied | Learner, mất claim hiện tại, disabled, accountAccess không active |
| invalid-argument | Field thừa, role/rating/coins trong input, ngày/pageSize sai, option/answer sai |
| not-found | User/question/battle/notification không tồn tại |
| failed-precondition | Nguồn chưa sẵn sàng, parent chưa published, sửa/khôi phục deleted, điều hành admin, thiếu HMAC key |
| already-exists | Email trùng, requestId dùng payload khác, immutable version đã có |
| aborted | Request/target đang xử lý, version conflict (details.reason=version-conflict, currentVersion) |
| resource-exhausted | Vượt giới hạn snapshot/report; không trả prefix hoặc total giả |
| unavailable | Lỗi Auth/RTDB chưa hoàn tất; retry cùng requestId |

## Tạo và quản lý user

Theo quyết định của người dùng: Add User có tên/email/mật khẩu ban đầu riêng; người học vẫn tự đăng ký bằng app như trước. Hợp đồng mở rộng UserInput.password?:string, bắt buộc khi không có id, cấm khi edit. Mật khẩu 12–128 ký tự, có chữ hoa/thường, số và ký tự đặc biệt. Không tự phát sinh mật khẩu chung, không gửi email.

Ví dụ tạo:

~~~json
{"input":{"name":"Learner mới","email":"learner@example.test","password":"<mật khẩu riêng do admin nhập>"},"requestId":"uuid"}
~~~

Trả {serverNow,user:{id,code,name,email,status:active,createdAt,updatedAt,rating:0,coins:0}}. Password không có trong response, source RTDB, kế hoạch, audit hoặc log. Frontend chỉ hiện ô mật khẩu khi tạo bằng Firebase API; không hiện khi sửa/demo.

UID được dẫn xuất ổn định từ actor UID + requestId. Kế hoạch không chứa mật khẩu. Auth tạo ban đầu disabled; accountAccess tạm pending; sau khi Auth bật được, một atomic update RTDB công bố hồ sơ, defaults, access active, audit và kết quả. Khoảng giữa hai hệ thống luôn bị accountAccess chặn; không có giai đoạn user nhận thưởng rồi bị default 0 ghi đè. Retry sau Auth đã tạo sử dụng cùng UID, không tạo lại hoặc đặt lại mật khẩu. Không cấp admin. Rating/coins chỉ lấy userStats/wallets.

Password-bearing request dùng HMAC-SHA256 với ADMIN_REQUEST_HMAC_KEY phía server để ràng buộc toàn bộ payload mà không lưu mật khẩu hay hash xác thực mật khẩu. Cần key riêng random >=32 ký tự; không đưa vào biến VITE_, Git hoặc RTDB. Setup.ps1 tạo key emulator vào Backend/functions/.env.local nếu chưa có, giữ key hiện có. .env.example chỉ có placeholder. Khi deploy, người phụ trách phải cấu hình secret an toàn riêng cho cloud. Giữ key ổn định khi còn request cần replay; không tự xoay key hoặc copy key demo sang cloud.

Edit chỉ name/email, giữ balances. Email thay đổi được cập nhật Auth với emailVerified=false rồi RTDB theo kế hoạch; Auth/RTDB không được giả định là một transaction. Auth từ chối email trùng là lỗi không gây hiệu ứng, kế hoạch/khóa được giải phóng để sửa form bằng requestId mới. Lỗi không chắc chắn giữ khóa và kế hoạch để retry/recovery.

Moderation cần reason 5–500 ký tự. Tự khóa/xóa và điều hành mọi tài khoản admin đều bị chặn; vì vậy không thể xóa admin cuối cùng qua API này. Quản lý admin thuộc công cụ vận hành tin cậy, không có form cấp quyền. Deleted là xóa mềm: Auth disabled + revoke tokens, user displayName thành Deleted user, email trong userPrivate bị xóa; UID, ví, stats và liên kết lịch sử giữ lại. Email trong Auth vẫn được giữ theo chính sách retention hiện tại; không khẳng định đã xóa hết PII. Không khôi phục deleted qua API. Khôi phục banned phải là thao tác active rõ ràng có reason.

## Danh mục và câu hỏi

Nguồn chuẩn categories/topics/lessons; questions là metadata, questionVersions/{id}/vN và questionAnswers/{id}/vN là nội dung/đáp án bất biến. adminViews/questions là projection tìm kiếm/metadata tương thích seed; module đối chiếu currentVersion/updatedAt của view với metadata chuẩn. Danh sách/search chỉ hydrate trang hoặc kết quả cần hiển thị; view thiếu/lệch được đọc lại từ immutable version trước khi lọc.

Ví dụ sửa:

~~~json
{"id":"question_id","expectedVersion":1,"requestId":"uuid","input":{"categoryId":"vocabulary","topicId":"vocabulary_daily_life","lessonId":"","prompt":"Choose the correct answer","options":[{"id":"opt_1","text":"A"},{"id":"opt_2","text":"B"},{"id":"opt_3","text":"C"},{"id":"opt_4","text":"D"}],"correctOptionId":"opt_1","explanation":"Explanation","passage":"","audioUrl":"","audioText":"","difficulty":"easy","status":"draft"}}
~~~

Trả {serverNow,question:{...input,id,code,version:2,createdAt,updatedAt}}. Code mới dùng prefix/hash, không giả số thứ tự toàn cục.

- Đúng bốn option, ID/text không trùng (text chuẩn hóa), đáp án thuộc options. Sửa giữ bộ ID option, cho đổi thứ tự/text/đáp án.
- Quan hệ category → topic → lesson phải đúng. Published yêu cầu parent published, explanation, passage cho reading hoặc nội dung nghe cho listening. Không archive parent còn published children; không di chuyển parent đã được tham chiếu.
- Khóa content dùng chung cho question/catalog; expectedVersion được kiểm tra khi khóa đã giữ, rồi cùng atomic update ghi metadata vN+1, nội dung, đáp án, mapping lesson, projection, audit và receipt. Không transaction/read root Database.
- Archive cũng tăng version, sao chép nội dung sang bản mới mang trạng thái archived ở metadata; bản cũ và snapshots attempt/battle không bị sửa. Không hard-delete câu hỏi.
- lessonQuestions giữ order/version và thêm enabled để phản ánh publish/archive; BE1 vẫn phải kiểm tra questions.status. Những writer quản trị khác cần dùng cùng cơ chế khóa; không ghi tay cạnh tranh.
- Seed listening dùng audioAssetId: admin reader lấy speechText từ contentAssets. Bản admin ghi audioText/audioUrl trong version. Chỉ chấp nhận HTTPS, cấm data/base64. WireQuestion BE1 hiện chỉ phát audioText, vì vậy published listening mới cần audioText, kể cả có URL; file playback/mobile contract và Storage upload vẫn cần nhóm phụ trách làm tiếp.

Luồng mẫu sửa câu hỏi: verify token/claim/access → validate allowlist → reserve operation → khóa content → đọc metadata v1/đối chiếu expectedVersion → tạo plan v2 → atomic update versions/answers/currentVersion/lesson mapping/audit/result/unlock → frontend nhận question v2, phát admin:data và tải lại. Gửi lại cùng requestId trả receipt cũ; request khác dùng expectedVersion=1 nhận aborted. Attempt đang giữ v1 vẫn đọc đúng v1.

## Idempotency và phục hồi

adminOperations/{actorUid}/{action_encoded}/{requestId}: hash/HMAC binding, owner UUID, createdAt, planJson khi pending, resultJson khi hoàn tất. Dấu chấm trong action được mã hóa thành underscore. JSON strings giữ nguyên empty arrays và multi-path updates có slash, không lưu password. Operation không tự hết hạn/xóa để receipt vẫn replay được.

adminLocks/{target}: giá trị operation path; target user_<uid>, notifications_<uid>, hoặc content. Các request trùng đồng thời có thể nhận aborted/in-progress; không tạo hai user/version/audit. Caller retry chủ động cùng ID, không tự retry mutation. Cùng ID nhưng payload khác bị already-exists. Auth lỗi không chắc chắn giữ plan/target lock; Auth từ chối chắc chắn trước hiệu ứng được giải phóng. Banned/deleted áp trạng thái chặn trước nếu Auth/revoke chưa xong, để fail closed; intent và notification thật tồn tại để phục hồi, không giả thành mutation hoàn tất.

Không dùng lease tự hết hạn: worker cũ không được phép thức dậy ghi đè mutation mới. Worker bị ngắt cứng cần operator xác minh đã dừng rồi chạy công cụ **chỉ emulator**. Dry-run mặc định:

~~~powershell
. ./scripts/local/Local.Common.ps1
Invoke-LocalEnvironment {
  node Backend/functions/tools/recover-admin-operation.mjs --uid ADMIN_UID --action question_save --request-id UUID
  # Chỉ sau khi xác nhận worker đã chấm dứt, dùng owner từ dry-run:
  node Backend/functions/tools/recover-admin-operation.mjs --uid ADMIN_UID --action question_save --request-id UUID --apply --worker-stopped --expected-owner OWNER_UUID
}
~~~

Công cụ chỉ CAS trường owner, không xóa kế hoạch/target lock. Sau đó gửi lại nguyên payload/requestId để hoàn tất. Không tái sử dụng ID cho payload khác. Đây là công cụ local; quy trình recovery cloud cần người phụ trách thiết kế/xác nhận riêng.

## Truy vấn, nguồn monitoring và giới hạn

Không đọc root RTDB. Dùng các collection query orderByKey + limitToFirst(cap+1), point joins theo UID/currentVersion; nếu có cap+1 thì báo resource-exhausted trước khi tính total. PageSize 1–50, page 1–10000; page vượt cuối trả items rỗng nhưng total chính xác trên snapshot đầy đủ. Các page là dữ liệu live mỗi request, không đảm bảo cùng snapshot qua nhiều lần đổi trang khi có mutation khác.

| Nguồn | Giới hạn snapshot |
| --- | --- |
| users | 500; join userPrivate/accountAccess/userStats/wallets theo nhóm 20 |
| questions / adminViews/questions | 1000 mỗi nguồn; metadata + prompt view để tính total, chỉ hydrate page; export đầy đủ theo nhóm 20 |
| categories / topics / lessons | 4 / 300 / 500 |
| battleRooms | 500 |
| practiceAttempts | 200 mỗi user, tối đa 2000 toàn snapshot |
| notifications | 500 của đúng admin UID |
| audit | 200 mới nhất từ view indexed serverAt; tìm kiếm trong cửa sổ này |
| search | Tên/email/code user và prompt/code question, tối đa 20; chưa tìm battle qua global search |
| export | Tối đa 1000 hàng và 1 MB JSON rows; không chỉ xuất page hiện tại |

Đây là thiết kế có giới hạn cho quy mô hiện tại, không tuyên bố sẵn sàng thống kê hàng triệu bản ghi. Vượt giới hạn cần index/materialized aggregates/cursor được owner triển khai, không tăng cap vô hạn. RTDB có key index mặc định; thêm .indexOn serverAt cho adminAuditRecent, vẫn deny mọi client read/write vào nhánh mới. Không nới Rules.

Battle source đọc battleRooms + battleResults đã settled theo schema tham chiếu; playing/reconnecting → ongoing, completed/settled → completed, abandoned → abandoned. Chỉ xuất lifecycle logs được dựng từ startedAt/finishedAt, không trả submission/picked options/answer_accepted. Room phải có đúng hai participants; score là correctCounts đã công bố. Thiếu/khác schema báo failed-precondition.

Hiện repository chưa có battle engine được xác minh. Khi không có room, module yêu cầu owner của nguồn battle xác nhận systemStatus/adminSources/battles={initialized:true,schemaVersion:1}; module không tự tạo marker này. Không thêm marker chỉ để Dashboard hiện 0. Khi nguồn thật chưa sẵn sàng, battles/activities/overview/export battles hoặc analytics trả failed-precondition, details.reason=battle-source-unavailable. Test dùng room/result fixture riêng và xóa sau test, không gọi đây là engine battle chạy thật.

Activity được dựng từ account createdAt, practiceAttempts và battle lifecycle; không seed activity giả. Mỗi session là một event theo timestamp cuối: finishedAt nếu terminal, startedAt nếu chưa terminal. Active users đếm UID duy nhất, tính cả hai người trong trận. Completed battle đếm mỗi room đúng một lần; bài hoàn tất chỉ status completed. Accuracy bài dùng answeredCount/correctCount chuẩn; trận đã hoàn tất dùng số cơ hội được chấm = questionCount × 2 (bao gồm cơ hội bỏ lỡ), không dùng answer chưa công bố. Mixed-skill được tính chung, không tự chia vào từng kỹ năng; chart/category filter chỉ xét categoryId thực sự của session. Đây là giới hạn ngữ nghĩa hiện tại; phân rã TEST/DAILY/battle mixed theo từng câu cần aggregate khác.

Range 1–93 ngày, YYYY-MM-DD hợp lệ, từ 00:00 Asia/Ho_Chi_Minh ngày đầu đến trước 00:00 ngày sau ngày cuối. So sánh kỳ trước cùng độ dài. Mẫu số 0 trả null. Total users hiện tại loại deleted; new users tính createdAt; chuỗi users là số account hiện chưa deleted đã được tạo đến cuối ngày (không phục dựng lịch sử xóa). asOf là thời điểm response, không cam kết transaction toàn hệ thống.

## Notifications, audit và backfill

adminNotifications/{uid}/{id} theo schema type/title/body/createdAt/page/readAt/operationId. Reader chỉ lấy UID actor. Mark all read chỉ áp các notification đã thấy ở snapshot. Lỗi backend thực sự sau khi có plan có thể sinh operation_failed một lần theo operation ID; không tạo cảnh báo demo. Không có hệ thống push/email trong module này.

Mutation thành công đồng thời ghi adminAuditLogs/{dateKey}/{operationHash} và adminAuditRecent/{operationHash}, actor từ Auth, thời gian server, action/target/reason. Audit ID cố định nên retry không sinh bản trùng. View recent phục vụ bounded query; audit partition vẫn là lịch sử chuẩn. Không tự xóa lịch sử hoặc receipts.

Log cũ chưa có view cần backfill theo ngày, tối đa 31 ngày/lần, 1000 log/ngày; có --entry-id để thu hẹp. Script mặc định dry-run, chỉ cho demo/loopback sau assertEmulators; không đọc root, không ghi đè source hoặc view đang có. Apply ghi journal vào .local/admin-audit-backfill, có owner/hash để rollback chỉ các projection do batch tạo và chưa bị đổi. Kiểm tra schema cũ trước dùng; không nhập runtime-examples.reference.json.

~~~powershell
. ./scripts/local/Local.Common.ps1
Invoke-LocalEnvironment {
  node Backend/functions/tools/backfill-admin-audit.mjs --from 2026-11-01 --to 2026-11-01
  node Backend/functions/tools/backfill-admin-audit.mjs --from 2026-11-01 --to 2026-11-01 --apply
  node Backend/functions/tools/backfill-admin-audit.mjs --rollback ABSOLUTE_JOURNAL_PATH
  node Backend/functions/tools/backfill-admin-audit.mjs --rollback ABSOLUTE_JOURNAL_PATH --apply
}
~~~

Chỉ thực thi backfill fixture ở emulator trong lần này. Chưa chạy migration audit toàn bộ dữ liệu và không có migration/deploy cloud.

## Chạy và kiểm thử

Dùng scripts/local hiện có, không dựng bộ emulator thứ hai. Setup.ps1 chuẩn bị JDK 21/key local/dependencies, Start-Emulators → Seed → Start-AdminServer → Start-AdminWeb -DataSource firebase. Web 5173, HTTP 8080, Functions 5001, Auth 9099, Database 9000; project demo-englishbattle.

~~~powershell
npm.cmd --prefix Backend/functions run build
npm.cmd --prefix Backend/functions test
npm.cmd --prefix Backend/functions run lint
npm.cmd --prefix frontend/admin-web run build
npm.cmd --prefix frontend/admin-web test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/local/Test-Local.ps1 -AdminBrowser
~~~

Start-Emulators build trước khi mở watcher; Test-Local chỉ type-check --noEmit để không gây hot-reload giữa request đang chạy. Test-Local hiện chạy thêm suite admin; 4 bài server/local cũ không được coi là phủ 21 API. -AdminBrowser chạy playwright.admin.config.ts/admin.spec.ts với Web nguồn Firebase; -Browser giữ auth.spec.ts/config local cho Web mock. Không chọn cả hai. E2E mới không mock response, chỉ chặn URL ngoài loopback; API fixture và SDK thật, kiểm tra tạo/sửa/reload/version conflict, Add User và learner denial. Chỉ cleanup UID/question/operation/audit do test tạo, không reset root hoặc sửa tài khoản admin seed.

Luồng frontend xác thực hiện có trong working tree đã được thành viên đổi thành Auth → HTTP session read-only cho account đã provision; tôi giữ nguyên. auth.spec.ts cũ vẫn yêu cầu quan sát ensureUserProfile trong trình duyệt, nên có lệch với luồng hiện tại. Không bỏ assertion hoặc đổi implementation của thành viên khác để tạo PASS. Seed và app vẫn dùng BE1 ensureUserProfile. Cần nhóm thống nhất hợp đồng auth/test cũ trước khi coi suite đó là hồi quy browser hoàn chỉnh.

## Kết quả lần chạy mới

| Kiểm tra | Kết quả thực tế |
| --- | --- |
| npm --prefix Backend/functions run build | PASS |
| npm --prefix Backend/functions test | 5/5 unit PASS |
| ESLint src/admin và src/index.ts | PASS, 0 lỗi |
| npm --prefix Backend/functions run lint | FAIL do 394 lỗi/2 cảnh báo có sẵn trong BE1; không sửa hoặc tắt rule cho BE1. Báo cáo .local/functions-lint.json |
| npm --prefix frontend/admin-web run build | PASS, TypeScript + Vite |
| npm --prefix frontend/admin-web test | 81/81 PASS, 10 file; đây là unit/component, có transport/mock được ghi rõ |
| Test-Local.ps1 -AdminBrowser (lần cuối, exit 0) | PASS toàn bộ quy trình bên dưới |
| Hồi quy local Auth/BE1/HTTP/Rules/seed | 4/4 PASS, khoảng 5 giây |
| test/admin.integration.test.mjs | 13/13 PASS, khoảng 9,7 giây ở lần cuối đã warm; mọi callable kiểm tra Auth thực và response domain |
| playwright.admin.config.ts / e2e-local/admin.spec.ts | 3/3 PASS, khoảng 25 giây; Web SDK/Functions/RTDB/Auth thật, không mock response |
| Git diff --check | PASS; Git chỉ cảnh báo chính sách LF/CRLF hiện có |

Các bài mới đã kiểm tra filter/total/page vượt cuối; giới hạn snapshot không trả prefix; immutable version cũ; race request cùng ID và khác ID; version conflict; lessonQuestions chuyển v1→v2→v3 khi edit/archive; fallback khi view prompt lệch version; admin bị mất claim/disabled/banned/deleted/token revoked; không sửa role/rating/coins; tạo user bằng mật khẩu riêng, replay không tạo bản trùng và không lưu mật khẩu; notifications theo UID; xóa mềm giữ ví/lịch sử; CSV formula escaping; pending operation recovery; backfill dry-run/apply/rollback chỉ fixture.

E2E kiểm tra cả preview, payload gửi đi, response version 2, dữ liệu sau reload và stale version bị từ chối. Đã sửa modal dùng catalog từ trang Content để không ẩn/remount các ô draft trong lúc tải lại; thêm unit test direct Save không cần preview và giữ draft qua catalog refresh. Danh sách question hydrate đúng page thay vì đọc đáp án toàn ngân hàng trong mỗi lần mở trang.

Không chạy lại auth.spec.ts cũ trong lượt backend này vì nó còn assert provisioning trong trình duyệt trong khi working tree đã được đổi read-only; giữ nguyên source/assertion để nhóm quyết định. Không chạy bộ QA cũ project cloud, Android device, cloud, deploy hoặc migration production. Monitoring battle chỉ được kiểm chứng với fixture canonical, chưa có engine thật để chứng minh end-to-end battle.

Các lần chạy lỗi trước đã được sửa/rerun hoặc ghi riêng; không lấy một lần PASS cũ làm kết quả bản cuối. Fixture của từng run được dọn đúng UID/ID thuộc test. Screenshot E2E cuối: frontend/admin-web/test-results/admin-api-question-persisted.png; last-run.json status passed, failedTests rỗng.

Sự cố môi trường trong lượt chạy: CLI Emulator thoát trong lúc rebuild/hot-reload, Auth/Functions/Hub mất cổng, Java Database còn sống. Người dùng đã đồng ý sao lưu và khởi động lại. RTDB đang sống được export theo đúng định dạng Firebase CLI (487.594 byte, 250 câu hỏi), bản export trước giữ riêng tại .local/emulator-before-recovery-2026-11-01T16-43-18-018Z. Khôi phục Database mới cùng Auth snapshot gần nhất (20:30); không thể phục hồi tài khoản chỉ tồn tại trong RAM Auth sau snapshot khi tiến trình đã chết. Không tự tạo lại mật khẩu/tài khoản hoặc mở khóa để bù dữ liệu mất. Bản ghi phục hồi tại .local/last-emulator-recovery.json. Không xóa root để làm test PASS.

## File chính đã thay đổi

- src/admin/core.ts, validation.ts: quyền, input, bounded query, operation/lock/recovery, lỗi an toàn.
- src/admin/users.ts: hồ sơ, tạo/sửa learner, status, Auth/RTDB saga.
- src/admin/content.ts: catalog, snapshot có giới hạn, question/answer versions và archive.
- src/admin/monitoring.ts, reports.ts, model.ts và src/index.ts: đọc nguồn, analytics/search/notifications/audit/export và 21 exports.
- database.rules.json: chỉ thêm index adminAuditRecent.serverAt, không nới quyền.
- test/*.mjs và tools/*.mjs: unit/integration, recovery và backfill có dry-run/rollback.
- frontend domain/adapter/User form: password chỉ khi tạo; Content/QuestionEditor giữ catalog/draft; test mới.
- scripts/local/Setup.ps1, Test-Local.ps1: key local riêng, type-check không ghi lib và chọn browser suite.

## Cần người phụ trách làm sau

- Review và deploy Functions/Rules/index cùng secret cloud khi được phép; cung cấp URL HTTP getAdminSession đúng project. Không triển khai từ tác vụ này.
- Xác minh hoặc triển khai nguồn battle; không giả marker để che phần thiếu. Thiếu nguồn khiến Dashboard/Analytics chưa hiển thị đầy đủ dù CRUD Content/Users dùng API thật.
- Review định nghĩa session/mixed thống kê; bổ sung aggregates theo từng kỹ năng nếu sản phẩm cần tách mixed, và thiết kế cursor/views khi vượt caps.
- Chốt retention PII/Auth, vận hành recovery worker bị dừng, cleanup/TTL operations và cơ chế secret rotation. Không tự xóa receipt trước khi hết thời hạn retry được thống nhất.
- Upload audio Storage/file playback BE1/mobile còn ngoài phạm vi; hiện chỉ HTTPS URL được lưu và audioText là phần phát được của contract BE1 hiện tại.
- Cloud chưa được kiểm thử, không suy ra thành công cloud từ emulator PASS.

## Ví dụ request/response theo từng callable

Các ví dụ dưới đây chỉ mô tả hình dạng JSON, độc lập nhau, không phải seed để import hoặc kết quả production. Thay các ID/placeholder bằng bản ghi thật của môi trường; mật khẩu phải riêng cho từng user. Ví dụ monitoring chỉ hợp lệ khi nguồn đã được owner xác minh. Payload Catalog thực tế trả đủ các danh mục đang có; ví dụ rút gọn một category để dễ đọc. Timestamp là số epoch milliseconds.

### adminGetProfile

Request:

```json
{}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "profile": {
    "id": "admin_uid",
    "name": "Administrator",
    "email": "admin@example.test",
    "role": "administrator"
  }
}
```

### adminUpdateProfile

Request:

```json
{
  "name": "Administrator",
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "profile": {
    "id": "admin_uid",
    "name": "Administrator",
    "email": "admin@example.test",
    "role": "administrator"
  }
}
```

### adminGetOverview

Request:

```json
{
  "range": {
    "from": "2026-11-01",
    "to": "2026-11-01"
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "overview": {
    "totalUsers": 2,
    "newUsers": 1,
    "activeUsers": 2,
    "completedBattles": 1,
    "completedLessons": 0,
    "growth": {
      "users": null,
      "active": null,
      "battles": null
    },
    "series": [
      {
        "date": "2026-11-01",
        "users": 2,
        "previous": 1,
        "lessons": 0,
        "battles": 1,
        "active": 2
      }
    ],
    "categories": [
      {
        "id": "vocabulary",
        "name": "vocabulary",
        "lessons": 0,
        "battles": 0,
        "answered": 0,
        "correct": 0,
        "completed": 0,
        "started": 0
      },
      {
        "id": "grammar",
        "name": "grammar",
        "lessons": 0,
        "battles": 0,
        "answered": 0,
        "correct": 0,
        "completed": 0,
        "started": 0
      },
      {
        "id": "listening",
        "name": "listening",
        "lessons": 0,
        "battles": 0,
        "answered": 0,
        "correct": 0,
        "completed": 0,
        "started": 0
      },
      {
        "id": "reading",
        "name": "reading",
        "lessons": 0,
        "battles": 0,
        "answered": 0,
        "correct": 0,
        "completed": 0,
        "started": 0
      }
    ],
    "accuracy": 70,
    "completion": 100,
    "recent": [],
    "asOf": 1793494800000
  }
}
```

### adminListUsers

Request:

```json
{
  "query": {
    "q": "khong-khop",
    "page": 1,
    "pageSize": 10
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "page": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 10
  }
}
```

### adminGetUser

Request:

```json
{
  "id": "learner_uid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "user": {
    "id": "learner_uid",
    "code": "EB-learner_uid",
    "name": "Learner",
    "email": "learner@example.test",
    "status": "active",
    "createdAt": 1793494800000,
    "updatedAt": 1793494800000,
    "rating": 0,
    "coins": 0
  }
}
```

### adminSaveUser

Request:

```json
{
  "input": {
    "name": "Learner",
    "email": "learner@example.test",
    "password": "<mật khẩu riêng của tài khoản>"
  },
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "user": {
    "id": "learner_uid",
    "code": "EB-learner_uid",
    "name": "Learner",
    "email": "learner@example.test",
    "status": "active",
    "createdAt": 1793494800000,
    "updatedAt": 1793494800000,
    "rating": 0,
    "coins": 0
  }
}
```

### adminSetUserStatus

Request:

```json
{
  "id": "learner_uid",
  "status": "banned",
  "reason": "Moderation reason",
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000
}
```

### adminListQuestions

Request:

```json
{
  "query": {
    "q": "khong-khop",
    "page": 1,
    "pageSize": 10
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "page": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 10
  }
}
```

### adminGetQuestion

Request:

```json
{
  "id": "q_example"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "question": {
    "id": "q_example",
    "code": "Q-EXAMPLE",
    "categoryId": "vocabulary",
    "topicId": "vocabulary_daily_life",
    "lessonId": "",
    "prompt": "Choose the correct answer",
    "options": [
      {
        "id": "opt_1",
        "text": "Choice 1"
      },
      {
        "id": "opt_2",
        "text": "Choice 2"
      },
      {
        "id": "opt_3",
        "text": "Choice 3"
      },
      {
        "id": "opt_4",
        "text": "Choice 4"
      }
    ],
    "correctOptionId": "opt_1",
    "explanation": "Explanation",
    "passage": "",
    "audioUrl": "",
    "audioText": "",
    "difficulty": "easy",
    "status": "draft",
    "version": 1,
    "createdAt": 1793494800000,
    "updatedAt": 1793494800000
  }
}
```

### adminSaveQuestion

Request:

```json
{
  "id": "q_example",
  "input": {
    "categoryId": "vocabulary",
    "topicId": "vocabulary_daily_life",
    "lessonId": "",
    "prompt": "Choose the correct answer",
    "options": [
      {
        "id": "opt_1",
        "text": "Choice 1"
      },
      {
        "id": "opt_2",
        "text": "Choice 2"
      },
      {
        "id": "opt_3",
        "text": "Choice 3"
      },
      {
        "id": "opt_4",
        "text": "Choice 4"
      }
    ],
    "correctOptionId": "opt_1",
    "explanation": "Explanation",
    "passage": "",
    "audioUrl": "",
    "audioText": "",
    "difficulty": "easy",
    "status": "draft"
  },
  "expectedVersion": 1,
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "question": {
    "id": "q_example",
    "code": "Q-EXAMPLE",
    "categoryId": "vocabulary",
    "topicId": "vocabulary_daily_life",
    "lessonId": "",
    "prompt": "Choose the correct answer",
    "options": [
      {
        "id": "opt_1",
        "text": "Choice 1"
      },
      {
        "id": "opt_2",
        "text": "Choice 2"
      },
      {
        "id": "opt_3",
        "text": "Choice 3"
      },
      {
        "id": "opt_4",
        "text": "Choice 4"
      }
    ],
    "correctOptionId": "opt_1",
    "explanation": "Explanation",
    "passage": "",
    "audioUrl": "",
    "audioText": "",
    "difficulty": "easy",
    "status": "draft",
    "version": 2,
    "createdAt": 1793494800000,
    "updatedAt": 1793494800000
  }
}
```

### adminArchiveQuestion

Request:

```json
{
  "id": "q_example",
  "expectedVersion": 2,
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000
}
```

### adminGetCatalog

Request:

```json
{}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "catalog": {
    "categories": [
      {
        "id": "vocabulary",
        "name": "Vocabulary",
        "description": "",
        "status": "published"
      }
    ],
    "topics": [],
    "lessons": []
  }
}
```

### adminSaveContent

Request:

```json
{
  "input": {
    "kind": "topic",
    "title": "New topic",
    "description": "Description",
    "categoryId": "vocabulary",
    "status": "draft"
  },
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000
}
```

### adminListBattles

Request:

```json
{
  "query": {
    "q": "khong-khop",
    "page": 1,
    "pageSize": 10
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "page": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 10
  }
}
```

### adminGetBattle

Request:

```json
{
  "id": "battle_id"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "detail": {
    "battle": {
      "id": "battle_id",
      "code": "B-EXAMPLE",
      "player1": "learner_uid",
      "player2": "opponent_uid",
      "player1Name": "Learner",
      "player2Name": "Opponent",
      "score1": 0,
      "score2": 0,
      "status": "ongoing",
      "mode": "quick",
      "categoryId": "mixed",
      "startedAt": 1793494800000,
      "endedAt": null,
      "logs": [
        {
          "id": "started",
          "at": 1793494800000,
          "type": "started",
          "message": "Battle started"
        }
      ]
    },
    "player1": {
      "id": "learner_uid",
      "code": "EB-learner_uid",
      "name": "Learner",
      "email": "learner@example.test",
      "status": "active",
      "createdAt": 1793494800000,
      "updatedAt": 1793494800000,
      "rating": 0,
      "coins": 0
    },
    "player2": {
      "id": "opponent_uid",
      "code": "EB-learner_uid",
      "name": "Opponent",
      "email": "learner@example.test",
      "status": "active",
      "createdAt": 1793494800000,
      "updatedAt": 1793494800000,
      "rating": 0,
      "coins": 0
    }
  }
}
```

### adminListActivities

Request:

```json
{
  "query": {
    "q": "khong-khop",
    "page": 1,
    "pageSize": 10
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "page": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 10
  }
}
```

### adminSearch

Request:

```json
{
  "q": "Learner"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "items": [
    {
      "id": "user_learner_uid",
      "label": "Learner",
      "detail": "learner@example.test",
      "page": "users",
      "query": "EB-learner_uid"
    }
  ]
}
```

### adminListNotifications

Request:

```json
{}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "items": []
}
```

### adminMarkNotificationsRead

Request:

```json
{
  "id": "notification_id",
  "requestId": "request_uuid"
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000
}
```

### adminListAudit

Request:

```json
{
  "query": {
    "q": "question"
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "items": []
}
```

### adminExportReport

Request:

```json
{
  "kind": "users",
  "query": {
    "q": "khong-khop",
    "page": 1,
    "pageSize": 10
  },
  "range": {
    "from": "2026-11-01",
    "to": "2026-11-01"
  }
}
```

Response SDK data:

```json
{
  "serverNow": 1793494800000,
  "report": {
    "filename": "english-battle-users.csv",
    "columns": [
      "ID",
      "Name",
      "Email",
      "Status",
      "Rating",
      "Coins"
    ],
    "rows": []
  }
}
```
