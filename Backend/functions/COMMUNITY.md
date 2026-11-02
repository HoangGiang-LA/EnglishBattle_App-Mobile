# Bảng xếp hạng và thông báo trong app

## Bảng xếp hạng

`getLeaderboard({period: "week" | "month", cursor?})` trả cùng bảng rating
tích lũy hiện tại cho hai tab. Thứ tự: rating giảm dần, UID tăng dần. Không
lọc hoạt động theo kỳ, không reset rating. Theo quyết định người dùng, tài
khoản bị khóa vẫn được xếp hạng, tài khoản đã xóa bị ẩn khỏi bảng mới.
Tài khoản gọi API phải còn active và Auth không bị disabled.

`leaderboardPlayers/{uid}` chỉ chứa tên công khai, rating và phiên bản nguồn.
Provision/sync hồ sơ và settlement thi đấu cập nhật view trước khi thành công.
Worker duyệt 100 hồ sơ/lượt, giữ cursor/lease, phục hồi dữ liệu cũ và đối chiếu
lại mỗi 60 giây. Bootstrap chưa xong trả UNAVAILABLE để không công bố bảng
thiếu người. Lỗi thông báo một tài khoản không chặn bootstrap bảng hạng.

Lượt xem đầu tạo bản chụp riêng của UID, 25 mục/trang, có vị trí bản thân dù
ngoài trang hiện tại. Các trang sau đọc cùng snapshot 10 phút nên thay đổi
rating không gây trùng/mất người. Tải lại tạo snapshot theo dữ liệu mới;
snapshot còn hạn được dùng lại khi nội dung không đổi. Cursor là UUID lưu
server, ràng buộc UID/loại truy vấn/tab; không nhận offset/rating/UID client.
Tài khoản bị xóa sau khi chụp được ẩn tên trong trang cũ, giữ thứ hạng đã chụp.
Cursor hết hạn cần tải lại từ trang đầu. App giữ danh sách cũ khi lỗi tải thêm.

## Thông báo

`getNotifications({cursor?})` tải 25 mục, mới nhất trước, theo cặp
createdAt/key của RTDB. Cursor gắn UID, hạn 10 phút. Thông báo mới không đẩy
lệch trang đang đọc; làm mới để xem đầu danh sách. Backend lọc destination
theo danh sách màn hình cho phép và đọc bù qua bản ghi không hợp lệ, có giới
hạn mỗi lượt. Dashboard vẫn tối đa 50 mục; unreadNotificationCount là tổng
chưa đọc của tài khoản, bao gồm các mục nằm ngoài danh sách này.

`notificationCounts/{uid}` lưu các sự kiện đã tính, tổng số/chưa đọc và ý định
đọc đang chờ projection. Tạo thông báo dùng ID sự kiện ổn định; gửi lại không
tạo thêm thông báo, không tăng bộ đếm hai lần và không đặt lại readAt.
Ý định đọc và bộ đếm được chốt cùng transaction trước khi chiếu readAt;
worker phục hồi pendingReads sau crash. Danh sách dùng trạng thái đọc đã chốt,
kể cả khi projection đang chờ. Mỗi lượt worker chiếu tối đa 50 readAt/UID.

`markNotificationsRead({ids: [...]})` tối đa 50 ID; hoặc `{all: true}` đánh
dấu toàn bộ thông báo của chính tài khoản đã được ghi nhận ở thời điểm xử lý.
Hai dạng loại trừ nhau. Thông báo mới đến sau thao tác toàn bộ vẫn chưa đọc.
SDK chia các yêu cầu danh sách lớn thành nhóm 50. App bỏ phản hồi tải trang cũ
sau khi đổi tab/tài khoản hoặc sau xác nhận đọc để tránh khôi phục trạng thái cũ.

Xác nhận các readAt đã chiếu được gộp theo transaction gốc notificationCounts,
tránh tranh chấp giữa transaction cha và con. SDK thử lại có giới hạn khi
gặp maxretry; readAt đầu tiên và quyết định đọc vẫn bất biến qua lần gửi lại.

Thông báo hiện phát sinh từ thành tích thi đấu, thành tích luyện tập 20 lần
và thành tích hoàn thành thử thách hằng ngày.
Payload thông báo luyện tập được lưu cùng quyết định mở khóa; lỗi giữa chừng
được retry trước marker settlement. Worker cũng bổ sung sự kiện cho thành
tích cũ. Thông báo chỉ dẫn tới màn hình cho phép và không phát sinh thêm xu.
Đây là trung tâm thông báo trong app; FCM là phạm vi triển khai riêng.

## Thành tích thử thách hằng ngày

Điều kiện `completed_daily_challenge_count` (seed: `seven_daily_challenges`)
đếm các ngày hoàn tất hợp lệ, không yêu cầu liên tiếp. Mỗi ngày chỉ đếm một
slot của UID; slot phải trỏ tới kết quả daily hoàn tất 5 câu trong đúng ngày
Việt Nam. Phiên bỏ dở, sai chế độ, thiếu nguồn hoặc quá ngày không được đếm.

Server duyệt slot theo trang 25, không lấy số liệu từ 50 lịch sử dashboard.
Tiến độ dừng tại mốc lớn nhất đang xuất bản. Transaction giữ tiến độ tăng và
quyết định mở khóa trước một lần tải cũ đến muộn. Thông báo được lưu cùng
quyết định mở khóa, tiếp tục phục hồi được sau khi định nghĩa bị archive.
Không cộng thêm xu cho thành tích, kể cả khi cấu hình có `rewardCoins`.

Settlement daily thực hiện phần này trước marker hoàn tất. Dashboard và
community worker dựng lại thành tích còn thiếu từ kết quả hiện có; không
thay đổi điểm, ví hay kết quả nguồn. Không cần index hoặc quyền client mới.

## Vận hành

`npm.cmd run dev:local` chạy thêm community maintenance cùng hai engine học tập
và thi đấu. Scheduler maintainCommunity dành cho lần deploy sau; hiện dùng
worker local, Firebase Auth/Realtime Database thật. Rules giữ default-deny;
chỉ thêm index expiresAt cho communityCursors và communityRankings để dọn tối
đa 25 bản ghi hết hạn mỗi loại/lượt. Không tạo quyền client ghi điểm/thông báo.

Kiểm thử backend cộng đồng: Backend/tests/be1/community.test.mjs, trên project
demo-englishbattle-finalization, Auth 9199/Database 9100. Các dữ liệu nhiều tài
khoản/nhiều thông báo chỉ được tạo trong emulator riêng.
