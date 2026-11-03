# Bước 3 — danh mục và ngân hàng câu hỏi

Cập nhật 03/11/2026. Triển khai local/Spark, dùng guard/operation/audit của Bước 1.
Không deploy hoặc thay dữ liệu Firebase thật trong quá trình kiểm thử.

## API và nguồn dữ liệu

| API | Nguồn / hành vi |
|---|---|
| `adminGetCatalog` | Đọc categories/topics/lessons, trả revision số nguyên, chỉ 4 skill cố định |
| `adminSaveContent` | Tạo topic/lesson hoặc sửa skill/topic/lesson với expectedRevision |
| `adminListQuestions` | Index server, lọc text/ID/code, skill, difficulty, status; snapshot có tổng chính xác |
| `adminGetQuestion` | Metadata hiện tại + version + answer; ánh xạ DTO theo allowlist |
| `adminSaveQuestion` | Tạo UID ổn định hoặc version tiếp theo, cần expectedVersion khi sửa |
| `adminArchiveQuestion` | Version tiếp theo với status archived; không xóa version/answer cũ |

Nguồn runtime là `categories`, `topics`, `lessons`, `questions`, `questionVersions`,
`questionAnswers`; dữ liệu seed không phải nguồn của adapter thật. Web giữ bố cục
Content hiện có, dùng đủ 6 API này. Export/search toàn workspace vẫn chờ Bước 6.

## Quan hệ và xuất bản

- Chỉ có vocabulary/grammar/listening/reading. Không tạo skill thứ năm. Sửa skill giữ
  icon, sortOrder, englishName và metadata khác đang được app dùng.
- `vocabulary_idioms` và topic mang tên `Idioms & Phrases` phải thuộc Vocabulary.
- Topic bắt buộc có skill hợp lệ. Lesson bắt buộc có topic hợp lệ; server suy ra
  categoryId từ topic, từ chối categoryId gửi kèm nếu mâu thuẫn.
- Published topic cần skill published. Published lesson cần topic và skill published.
  Published question cần đủ cả 3 cấp published, đúng skill → topic → lesson.
- Draft/archive cha **không cascade** trạng thái con. Engine người dùng vốn kiểm tra
  đủ chuỗi cha khi chọn câu cho phiên mới; phiên đã bắt đầu giữ snapshot cũ. Khi xuất
  bản lại cha, con có status published có thể dùng lại. UI nêu rõ quy tắc này.
- Topic đã có lesson/question không chuyển sang skill khác. Lesson đã có question
  không chuyển topic. Nội dung rỗng được chuyển nếu quan hệ mới hợp lệ.
- Tên topic không trùng trong skill; tên lesson không trùng trong topic (NFKC, trim,
  không phân biệt hoa thường). Không xóa cứng danh mục/câu có lịch sử.
- Catalog giới hạn 4 skill, 500 topic, 5.000 lesson và response 2 MiB. Vượt giới hạn
  báo lỗi; không tự tải root hoặc cắt dữ liệu. Không tự import seed khi nguồn trống.
  Lỗi giới hạn trước hiệu ứng kết thúc failed và nhả khóa, không treo các thao tác khác.

## Version và đồng thời

Ba mutation nội dung dùng chung resource lock `content/catalog` bên cạnh target lock.
Mọi kiểm tra quan hệ/revision xảy ra dưới khóa trước hiệu ứng. Lock bền tới kết quả
cuối để parent status hoặc reparent không xen giữa preflight và commit câu hỏi.

Catalog legacy chưa có revision được coi là 0. `ctx.mutateRecord` kiểm tra revision,
giữ metadata hiện có, tăng một lần và ghi receipt trong cùng transaction. UID tạo
topic/lesson lấy từ operation ID. Hai admin sửa một revision chỉ một thay đổi được nhận.

Question mới dùng UID `q_admin_` + 40 ký tự đầu operation ID. Integer 1 ánh xạ `v1`.
Mọi sửa hoặc archive đều tăng version; archive không để một form cũ republish câu.

1. Lưu plan có ID/version/payload cố định trong operation.
2. Tạo immutable `questionVersions/{id}/vN` và `questionAnswers/{id}/vN` bằng
   create-if-missing transaction, xác minh nội dung trùng nếu đã có.
3. Chỉ sau khi đủ cả hai bản mới, CAS metadata `questions/{id}/currentVersion` từ
   version kỳ vọng sang vN. `lastAdminOperation` là receipt chống lặp khi mất ACK.
4. Đồng bộ `lessonQuestions` và `adminQuestionIndex`, rồi hoàn tất audit.

Lỗi giữa version/answer không đổi pointer cũ. Lỗi index hoặc mất ACK retry cùng
requestId tiếp tục plan cũ, không tạo vN+1. Orphan vN có nội dung khác bị chặn, giữ
lock để operator đối soát; không overwrite để che dữ liệu hỏng. Actor bị revoke
giữa chừng cũng không được tiếp tục ghi. Không có CLI bỏ qua khóa hoặc xóa version.

Lesson index giữ adminVersion fence; quan hệ cũ khi chuyển câu sang lesson khác được
đánh dấu archived/removed, không dùng lại như một liên kết đang hoạt động. Engine
hiện tại chọn câu từ metadata chính và kiểm tra quan hệ, không dựa vào index này.

Không sửa đáp án/snapshot cũ, không ghi kết quả, grant, ledger, xu, rating hoặc tiến độ.
Learning tiếp tục dùng đáp án đúng theo vN đã giao; battle giữ câu/keys riêng của trận.

## Nội dung câu và Listening

- Đúng 4 option, ID bắt đầu bằng chữ hoặc `_` rồi là chữ/số/`_`/`-` (tối đa 128 ký tự).
  Không đổi ID khi chỉ sửa text; cấm ID thuần số để RTDB không đổi map thành array.
- Text option không rỗng/không trùng sau NFKC/trim/lowercase; đáp án thuộc 4 ID.
  Array ánh xạ sang map theo ID, order 1..4 và ngược lại.
- Published cần explanation; Reading cần passage; Listening cần audioText.
  Server chạy lại chính `playableQuestion` của backend người dùng trước khi ghi.
- Metadata type ánh xạ single_choice/reading_single_choice/listening_single_choice;
  version có language en, questionTimeLimitSeconds 30; answer giữ scoring 1/0.
- Listening giai đoạn này chỉ TTS. Legacy asset kind tts được resolve thành audioText
  khi đọc; version mới dùng inline audioText, giữ nguyên asset/version cũ.
  Web thật ẩn URL/upload; schema yêu cầu audioUrl rỗng. Audio file là luồng riêng.

## Index, snapshot và retry web

Worker backfill `questions` theo key, 50 câu/lượt, checkpoint/lease 90 giây và tối đa
5 tác vụ đọc song song. Ready chỉ bật sau lượt quét đầy đủ. Có lỗi nguồn thì ready
tắt và báo đang chuẩn bị, không công bố một tổng chưa hoàn chỉnh. Worker chạy lại
không tăng bản ghi. Writer chết hơn 90 giây buộc rebuild từ đầu.

Mỗi cập nhật index có writer ticket và version trước/sau. Snapshot quét từng 100
index row, tối đa 10.000 câu/8 MiB, từ chối nếu writer/version đổi giữa lượt đọc.
Lọc theo index, sắp updatedAt giảm dần, UID tăng dần. Snapshot giữ 15 phút, ràng
buộc UID admin + bộ lọc + page size; trang 2+ cần snapshot/cursor phù hợp.

Snapshot cũ tiếp tục là ảnh chụp cùng tập kết quả; mở editor/archive luôn đọc detail
mới. Mutation thành công xóa cache snapshot web và reload dữ liệu. Form giữ revision/
version gốc; lỗi conflict không tự tải bản mới rồi ghi đè. RequestId/payload lưu theo
UID trong sessionStorage, phục hồi sau reload/timeout như nhóm Users.

Rules chặn client đọc trực tiếp đáp án, version, index/snapshot/audit kể cả admin.
Đáp án chỉ trả qua callable admin đã guard. Rules/index thay đổi chưa deploy thật.

## Kiểm thử

Chạy trong `Backend/functions`:

```powershell
npm.cmd run test:admin
npm.cmd run test:admin:web
# Chạy riêng kiểm thử nội dung khi phát triển:
node tools/run-admin-tests.mjs --content
```

Tất cả fixture/tiêm lỗi dùng project demo-englishbattle-admin, Auth 19299, DB 19200,
Functions 15003; SDK/browser thật nối Emulator. Web QA import các nhánh content seed
chỉ vào namespace QA. Không chạy các lệnh này với dữ liệu production.
QA làm nóng từng callable bằng request không xác thực và kiểm tra bị từ chối trước
hiệu ứng. Việc này tách thời gian khởi động worker của Emulator khỏi timeout 30 giây
của SDK trong trình duyệt. Launcher `dev:local` cũng chờ đủ callable đã triển khai
trước khi mở web; các request này không có token nên không ghi nghiệp vụ. Web vẫn
hiển thị lỗi/retry khi API timeout.

## Biên bản nghiệm thu local — 03/11/2026

| Bộ kiểm tra | Kết quả |
|---|---|
| Functions lint + TypeScript, schema JSON khớp nguồn | Đạt |
| Schema request/response của 21 API admin | 7/7 đạt |
| Admin Emulator Bước 1–3 | 65/65 đạt, trong đó 20 ca Content |
| Web unit/component/adapter | 54/54 đạt |
| SDK Firebase + trình duyệt nối Emulator | 6/6 đạt, trong đó 3 ca Content |
| Giao diện demo desktop/mobile, 5 trang | 20/20 đạt |
| Build web, format các file TypeScript thay đổi | Đạt |
| Backend người dùng BE1 | 193 ca hồi quy + 10 ca HTTP/worker đạt |
| Hợp đồng frontend/mobile và kiểm tra export | 9/9 đạt |

Đã kiểm chứng tạo topic/lesson/câu mới, mở luyện tập bằng 10 câu vừa xuất bản, reload,
form conflict không mất nội dung, TTS, source/index bị gián đoạn, mất ACK, hai admin
sửa cùng version, archive giữ snapshot/keys của học và battle, parent gating, scan
hơn 50 câu, snapshot owner/filter/expiry, stale writer và giới hạn danh mục không treo khóa.
Ảnh chụp Content Firebase được kiểm tra trực quan trong artifact Playwright riêng.

Chưa nghiệm thu nội dung đồng bộ trên Android thiết bị thật, Firebase thật, deploy
Rules/Functions hoặc audio upload. Launcher dùng dữ liệu thật cần credential hợp lệ;
đợt này kiểm thử bằng project Emulator tách biệt và không gửi dữ liệu seed lên cloud.
