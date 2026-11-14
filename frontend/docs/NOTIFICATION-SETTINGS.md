# Cài đặt thông báo Android (MVVM)

## Trách nhiệm

- `data/NotificationSettingsRepository.kt`: lưu lựa chọn và mốc thông báo theo tài khoản; đọc quyền `POST_NOTIFICATIONS` cùng `NotificationManager.areNotificationsEnabled()`. Lịch sử đã hỏi quyền thuộc bản cài đặt vì quyền Android dùng chung giữa các tài khoản.
- `ui/NotificationSettingsViewModel.kt`: quản lý bật/tắt, xác nhận, kết quả cấp quyền, chuyển sang Cài đặt Android và điều kiện hiển thị thông báo. `SavedStateHandle` giữ thao tác đang chờ khi hệ thống tái tạo tiến trình.
- `ui/NotificationSettings.kt`: hiển thị công tắc/hộp thoại; Activity Result launcher mở yêu cầu quyền hoặc Cài đặt Android; lifecycle đồng bộ lại quyền khi app trở về foreground.
- `ui/App.kt`: dùng trạng thái của ViewModel để kiểm soát snackbar. Tắt thông báo sẽ đóng snackbar đang hiển thị. Trung tâm thông báo và trạng thái đã đọc vẫn hoạt động.

## Hành vi

1. Bản cài mới mặc định tắt. Mỗi lần bật đều hiện câu hỏi **Cho phép gửi thông báo?**. Chọn **Không đồng ý**, chạm ra ngoài hoặc Back đều giữ trạng thái tắt.
2. Chọn **Đồng ý**: Android 13+ hỏi quyền hệ thống nếu còn có thể hỏi. Công tắc chỉ bật sau khi quyền thật đã được cấp và Android cho phép thông báo. Từ chối hoặc đóng hộp thoại hệ thống giữ trạng thái tắt.
3. Nếu Android không cho hỏi quyền lại, mở trang thông báo của English Battle trong Cài đặt Android. Bật quyền rồi quay về app mới bật công tắc; quay về mà chưa cấp quyền vẫn tắt.
4. Khi tắt: lưu lựa chọn tắt, hủy thông báo thiết bị và ngừng snackbar ngay; mở Cài đặt Android để người dùng tắt cả **Cho phép thông báo**. Nếu quay về mà chưa tắt quyền hệ thống, công tắc trong app vẫn tắt và hiển thị rõ quyền Android còn bật. Có nút **Cài đặt thông báo Android** để mở lại trang này.
5. Bật lại luôn hỏi xác nhận. Nếu quyền Android còn được cấp, xác nhận đồng ý đủ để bật; nếu quyền đã bị thu hồi thì cần cấp lại qua hộp thoại hệ thống hoặc Cài đặt Android.
6. Thay đổi quyền bên ngoài app được đồng bộ khi quay về. Quyền bị thu hồi không tự bật lại lựa chọn đã tắt. Thông báo bị bỏ qua lúc tắt không hiện lại thành snackbar khi bật, nhưng vẫn có trong trung tâm thông báo.
7. Android 8–12 không có quyền runtime cho thông báo: dùng hộp thoại xác nhận trong app, kết hợp trạng thái thông báo trong Cài đặt Android.

## Giới hạn hệ điều hành và dịch vụ

Tùy chọn nay được đồng bộ qua `setNotificationPreference` với UID của tài khoản đang dùng. ViewModel chỉ báo bật khi server xác nhận, giữ thay đổi chờ đồng bộ và cho thử lại khi lỗi. Thông báo admin mới chỉ được thêm vào hộp thư sau khi backend kiểm tra opt-in; thiếu cấu hình được xem là tắt. Tin cũ được giữ, các đợt gửi đã bị bỏ qua không được gửi bù. Xem [thông báo và quà xu từ admin](../../Backend/functions/ADMIN-CAMPAIGNS.md).

Android không cung cấp API công khai để app đổi ngay công tắc quyền thông báo hệ thống khi vẫn đang chạy. Android 13+ có `revokeSelfPermissionOnKill`, nhưng việc thu hồi diễn ra bất đồng bộ khi app không còn foreground và hệ thống kết thúc các tiến trình của app. Luồng này dùng Cài đặt Android để người dùng quản lý quyền trực tiếp.

Android có thể ngừng hiển thị hộp thoại quyền sau nhiều lần từ chối. Hộp thoại xác nhận trong app luôn xuất hiện khi bật; hộp thoại quyền hệ thống tuân theo Android, có đường chuyển sang Cài đặt khi cần.

Đây là sửa chức năng cài đặt quyền và thông báo trong app. Dự án hiện chưa triển khai FCM gửi thông báo khi app đóng; thay đổi này không bổ sung dịch vụ push hoặc thay đổi mô hình API/Cloudflare/Firebase Spark.

Tài liệu chính thức: [quyền thông báo](https://developer.android.com/develop/ui/views/notifications/notification-permission), [từ chối quyền](https://developer.android.com/training/permissions/requesting#handle-denial), [tự thu hồi quyền](https://developer.android.com/reference/android/content/Context#revokeSelfPermissionOnKill(java.lang.String)).

## Kiểm thử

- `NotificationSettingsViewModelTest`: cấp/từ chối/hủy, không bật sớm, hỏi lại, quyền bị chặn, Android trước 13, thu hồi quyền bên ngoài, khôi phục thao tác chờ, lỗi mở hệ thống và điều kiện hiển thị snackbar.
- `NotificationSettingsScreenTest`: thao tác công tắc, nút đồng ý/không đồng ý, xác nhận lại sau khi tắt và cấp quyền bằng hộp thoại Android thật. Kiểm thử hộp thoại hệ thống cần Android 13+ và bản cài chưa được cấp quyền; trường hợp đã có quyền sẽ được bỏ qua.

Chạy từ `frontend`:

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug assembleDebugAndroidTest
.\gradlew.bat connectedDebugAndroidTest '-Pandroid.testInstrumentationRunnerArguments.class=com.englishbattle.app.NotificationSettingsScreenTest'
```

Trên thiết bị Android 13+: thử lần lượt đồng ý và từ chối quyền; tắt quyền trong Cài đặt Android; quay lại, bật lại; từ chối nhiều lần; tắt quyền khi app ở background rồi quay lại. Trên Android 8–12: kiểm tra bật/tắt qua trang Cài đặt Android và quay về app.
