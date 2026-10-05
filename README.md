Báo cáo Dự án: Ứng dụng Quản lý Rạp chiếu phim (Cine4u - Cinema Management System)
1. Mô tả ngắn gọn về Dự án: 
Dự án này tập trung vào việc phân tích và thiết kế kiến trúc tổng thể cho một hệ thống vận hành rạp chiếu phim (tương tự mô hình CGV, Lotte). Thay vì chỉ dừng ở lớp giao diện (Front-end), bài toán đặt ra là xây dựng bộ khung logic (Back-end) và cơ sở dữ liệu vững chắc để xử lý luồng dữ liệu phức tạp giữa Khách hàng (đặt vé, thanh toán trực tuyến) và Quản trị viên (quản lý lịch chiếu, soát vé, đối soát doanh thu), đảm bảo tính toàn vẹn dữ liệu và hiệu năng cao.

2. Mục tiêu và Kết quả đạt được
Mục tiêu:

Thiết kế lược đồ cơ sở dữ liệu (ERD) chặt chẽ, tối ưu hóa cho việc truy vấn lịch chiếu và quản lý trạng thái ghế ngồi theo thời gian thực.

Giải quyết bài toán xử lý đồng thời (Concurrency): Khóa ghế tạm thời (Seat locking) bằng Database Transactions để ngăn chặn tình trạng nhiều khách hàng đặt cùng một ghế.

Xây dựng hệ thống API bảo mật, phân quyền rành mạch (Role-Based Access Control) giữa Khách hàng, Nhân viên soát vé và Quản lý rạp.

Kết quả đạt được:

Hoàn thiện bản thiết kế kiến trúc hệ thống và luồng dữ liệu (Data Flow) từ lúc khởi tạo phim đến khi xuất vé điện tử thành công.

Thiết lập luồng xử lý giao dịch an toàn, tích hợp cơ chế tính giá động (phụ thu ghế VIP, cuối tuần, combo bắp nước).

Đóng gói các module nghiệp vụ sẵn sàng cho việc triển khai lên các dịch vụ đám mây.

3. Giải thích các module/hàm nghiệp vụ cốt lõi
Hệ thống được chia thành các phân hệ logic kinh doanh chính sau:

Module Quản lý Danh mục (Catalog & Inventory):

Hàm nghiệp vụ: Xử lý CRUD (Thêm, Đọc, Sửa, Xóa) dữ liệu Phim, Cụm rạp và Phòng chiếu.

Logic: Quản lý thuật toán xếp lịch chiếu (Showtime Mapping), đảm bảo thời gian chiếu của một phim không bị xung đột (overlap) với lịch dọn dẹp hoặc các phim khác trong cùng một phòng chiếu.

Module Đặt vé & Giao dịch (Booking & Transaction Engine):

Hàm nghiệp vụ: HoldSeat(), ReleaseSeat(), ConfirmBooking().

Logic: Khi người dùng chọn ghế, hệ thống gọi API để chuyển trạng thái ghế sang "Đang giữ" (Hold) trong một khoảng thời gian (ví dụ 10 phút). Nếu thanh toán thành công, transaction ghi nhận vé hợp lệ. Nếu hết giờ, hệ thống tự động nhả ghế (rollback) để người khác có thể đặt.

Module Xác thực & Quản lý Người dùng (Auth & IAM):

Hàm nghiệp vụ: Cấp phát token bảo mật (như JWT) cho các phiên đăng nhập.

Logic: Phân cấp quyền hạn. Admin có toàn quyền tạo lịch chiếu; Staff chỉ có quyền gọi hàm VerifyTicket() thông qua mã QR động; Khách hàng chỉ được xem và thao tác trên dữ liệu cá nhân (lịch sử vé, điểm thành viên).

Module Vận hành & Báo cáo (Operations & Analytics):

Hàm nghiệp vụ: Tổng hợp dữ liệu từ các bảng Đơn hàng (Orders) và Lịch chiếu.

Logic: Trả về API thống kê doanh thu theo ngày, tính toán tự động tỷ lệ lấp đầy (Occupancy Rate) của từng phòng chiếu, giúp Quản lý rạp đưa ra quyết định tăng/giảm suất chiếu theo thực tế.

4. Hình ảnh đầu ra (Output)
Thiết kế Dữ liệu & Kiến trúc:
Hình 1: Lược đồ Cơ sở dữ liệu (ERD) hiển thị quan hệ giữa Bảng Phim, Lịch chiếu, Đơn hàng và Ghế ngồi


Hình 2: Sơ đồ luồng dữ liệu (Data Flow Diagram) của quá trình Đặt vé và Khóa ghế


Kiểm thử Dịch vụ & Trạng thái:
Hình 3: Kết quả test API trả về danh sách lịch chiếu thành công trên Postman/Swagger


Hình 4: Màn hình log hệ thống ghi nhận giao dịch soát vé QR hợp lệ tại cửa phòng chiếu
