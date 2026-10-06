# 🎬 Cinema Management System

> A comprehensive cinema ticket booking and theater management solution.

Hệ thống quản lý và đặt vé rạp chiếu phim trực tuyến, hỗ trợ khách hàng đặt vé nhanh chóng, lựa chọn ghế theo thời gian thực, thanh toán trực tuyến và sử dụng vé điện tử QR.

Hệ thống được xây dựng với hai ứng dụng di động chính:

- 🎟️ **Customer App** – Ứng dụng dành cho khách hàng đặt vé và quản lý tài khoản.
- 🏢 **Admin/Staff App** – Ứng dụng dành cho quản lý và nhân viên vận hành rạp.

Backend cung cấp RESTful API, xử lý xác thực, đặt vé, khóa ghế, thanh toán, quản lý lịch chiếu, doanh thu và dữ liệu người dùng.

---

## 📌 Project Overview

### 🎯 Objectives

- Xây dựng hệ thống đặt vé xem phim trực tuyến với cơ chế **Real-time Seat Locking**.
- Ngăn chặn tình trạng **trùng ghế** khi nhiều khách hàng cùng đặt vé.
- Cung cấp giao diện Mobile App trực quan và dễ sử dụng.
- Hỗ trợ **Dark Mode** cho Customer App.
- Hỗ trợ **Light Mode & Card-based UI** cho Admin/Staff App.
- Quản lý phim, phòng chiếu, lịch chiếu, ghế ngồi và vé.
- Hỗ trợ vé điện tử **QR Code** để xác thực tại rạp.
- Theo dõi doanh thu và tỷ lệ lấp đầy phòng chiếu.
- Quản lý khách hàng, nhân viên và hệ thống thành viên.

---

## ✨ Key Features

### 🎟️ Customer App

| Feature | Description |
|---|---|
| 🔐 Authentication | Đăng ký, đăng nhập và quản lý tài khoản |
| 🎬 Movie Discovery | Xem phim đang chiếu và phim sắp chiếu |
| 🎞️ Movie Details | Xem thông tin phim, trailer, thể loại và độ tuổi |
| 🕐 Showtime | Xem lịch chiếu theo phim và rạp |
| 💺 Seat Selection | Chọn ghế trực quan theo sơ đồ phòng chiếu |
| 🔒 Seat Locking | Khóa ghế tạm thời trong quá trình đặt vé |
| 🍿 Food & Beverage | Đặt bắp nước và các sản phẩm đi kèm |
| 💳 Online Payment | Thanh toán đơn hàng trực tuyến |
| 🎫 E-Ticket | Nhận vé điện tử sau khi thanh toán |
| 📱 QR Ticket | Sử dụng QR Code để xác thực vé |
| ⭐ Membership | Tích lũy và sử dụng điểm thành viên |
| 📜 Booking History | Xem lịch sử đặt vé và giao dịch |
| 🔔 Notifications | Nhận thông báo về vé và giao dịch |

---

### 🏢 Admin / Staff App

| Feature | Description |
|---|---|
| 📊 Dashboard | Theo dõi doanh thu và hoạt động hệ thống |
| 🎫 Ticket Management | Quản lý vé và trạng thái đặt vé |
| 📱 QR Scanner | Quét và xác thực vé điện tử |
| 🎬 Movie Management | Quản lý danh sách phim |
| 🕐 Showtime Management | Tạo và quản lý lịch chiếu |
| 🏠 Cinema Management | Quản lý phòng chiếu |
| 💺 Seat Management | Quản lý sơ đồ và trạng thái ghế |
| 📦 Inventory | Quản lý sản phẩm bắp nước |
| 👥 Customer Management | Tra cứu và quản lý khách hàng |
| 👨‍💼 Staff Management | Quản lý nhân viên và ca làm việc |
| 💰 Revenue Analytics | Theo dõi doanh thu theo phim và thời gian |
| 📈 Occupancy Rate | Theo dõi tỷ lệ lấp đầy phòng chiếu |

---

## 💻 Tech Stack

| Component | Technology |
|---|---|
| Backend | Java Spring Boot |
| Database | MongoDB Atlas |
| Authentication | JWT |
| Cloud Storage | Cloudinary |
| Customer Mobile | React Native / Flutter |
| Admin Mobile | React Native / Flutter |
| UI/UX Design | Figma |
| API Testing | Postman |
| API Documentation | Swagger / OpenAPI |
| Version Control | Git & GitHub |
| Development Tools | IntelliJ IDEA / VS Code / Android Studio |
| Database Testing | MongoDB Compass |
| Mobile Testing | Android Emulator / Physical Device |

> **Note:** Framework Mobile sẽ được xác định chính thức trong quá trình phát triển dự án.

---

# 🧱 System Architecture

Hệ thống được xây dựng theo mô hình **Client – REST API – Database**.

```text
┌───────────────────────────────┐
│        Customer App           │
│       Mobile Application      │
└───────────────┬───────────────┘
                │
                │ REST API / JSON
                ▼
┌───────────────────────────────┐
│        Backend API            │
│       Java Spring Boot        │
│                               │
│ Authentication                │
│ Booking Management            │
│ Seat Locking                  │
│ Showtime Management           │
│ Payment Processing            │
│ Ticket & QR Validation        │
└───────────────┬───────────────┘
                │
       ┌────────┴─────────┐
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ MongoDB Atlas│   │  Cloudinary  │
│   Database   │   │ Image/Media  │
└──────────────┘   └──────────────┘
                ▲
                │
         REST API / JSON
                │
┌───────────────┴───────────────┐
│        Admin / Staff App      │
│       Mobile Application      │
└───────────────────────────────┘
