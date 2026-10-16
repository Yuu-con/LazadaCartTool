# Hướng Dẫn Sử Dụng & Tài Liệu Kỹ Thuật: Lazada Cart Price Monitor

Hệ thống theo dõi giá sản phẩm trong giỏ hàng Lazada Việt Nam tự động, tích hợp bảng điều khiển web trực quan, cảnh báo âm thanh Web Audio API (tự dừng sau 30s) và gửi thông báo đẩy đến điện thoại Android qua Telegram Bot.

---

## 1. Cấu Trúc Thư Mục Dự Án

```
FollowLazada/
├── package.json              # Khai báo dependency (Playwright, Express, ws)
├── server.js                # Máy chủ chính (Express REST API + WebSocket Server)
├── src/
│   ├── config.js            # Quản lý đọc/lưu cấu hình ngưỡng giá, chu kỳ, Telegram
│   ├── logger.js            # Quản lý lưu lịch sử quét, chống mất log, xuất CSV/JSON
│   ├── monitor.js           # Module Playwright tự động quét giỏ hàng Lazada & reload
│   ├── price-parser.js      # Bộ bóc tách giá tiền tệ VNĐ & logic kiểm tra chống trùng
│   └── telegram.js          # Module gửi thông báo đẩy đến điện thoại Android qua Telegram
├── public/
│   ├── index.html           # Giao diện Web Dashboard tiếng Việt
│   ├── style.css            # Giao diện hiện đại, responsive
│   ├── audio.js             # Quản lý âm thanh Web Audio API, đếm lùi 30s & nút dừng
│   └── app.js               # Logic điều khiển frontend & kết nối WebSocket realtime
├── data/
│   ├── config.json          # File lưu cấu hình người dùng
│   ├── history.json         # File lưu nhật ký quét qua các phiên làm việc
│   └── browser-profile/     # Thư mục lưu User Data Chromium (lưu phiên đăng nhập Lazada)
└── tests/
    └── price-checker.test.js # Bộ kiểm thử các trường hợp giá và logic chống trùng
```

---

## 2. Hướng Dẫn Cài Đặt Từng Bước

### Bước 1: Yêu cầu môi trường
- Máy tính chạy **Windows / macOS / Linux**.
- Đã cài đặt **Node.js** (Khuyến nghị phiên bản 18 trở lên). Kiểm tra bằng lệnh:
  ```bash
  node -v
  npm -v
  ```

### Bước 2: Cài đặt thư viện
Tại thư mục dự án `FollowLazada`, chạy:
```bash
npm install
```

### Bước 3: Cài đặt trình duyệt Chromium cho Playwright
Chạy lệnh để tải trình duyệt Chromium độc lập:
```bash
npx playwright install chromium
```

---

## 3. Hướng Dẫn Cấp Quyền & Đăng Nhập Lazada An Toàn

1. **Khởi động ứng dụng**:
   ```bash
   npm start
   ```
2. Mở trình duyệt truy cập bảng điều khiển tại: `http://localhost:3000`.
3. Bấm nút **▶️ BẮT ĐẦU GIÁM SÁT**:
   - Một cửa sổ trình duyệt Chromium sẽ tự động mở ra và truy cập vào trang `https://cart.lazada.vn/cart`.
   - Nếu bạn chưa đăng nhập, Lazada sẽ chuyển về màn hình đăng nhập.
   - **Tự tay đăng nhập an toàn**: Đăng nhập tài khoản Lazada của bạn (bằng SMS OTP, mật khẩu hoặc mã QR) trực tiếp trên cửa sổ này. Nếu Lazada hiển thị yêu cầu trượt mã kiểm tra (CAPTCHA), hãy thực hiện bằng tay.
4. **Cơ chế bảo mật tuyệt đối**:
   - Phiên làm việc (Session/Cookies) được lưu cục bộ trong thư mục `data/browser-profile/` trên máy tính của bạn.
   - **Không bao giờ** lưu mật khẩu, cookie vào log hoặc gửi ra bên ngoài.
   - Từ lần chạy sau, trình duyệt sẽ tự động duy trì phiên đăng nhập mà không cần gõ lại tài khoản.

---

## 4. Hướng Dẫn Cấu Hình Thông Báo Đẩy Android Qua Telegram

Để nhận thông báo tức thì trên màn hình khóa điện thoại Android:

### Bước 1: Tạo Bot Telegram
1. Mở ứng dụng Telegram trên Android hoặc máy tính, tìm kiếm **`@BotFather`** (có dấu tích xanh xác minh).
2. Gửi lệnh `/newbot`.
3. Đặt tên hiển thị cho bot (VD: `Lazada Price Alert Bot`).
4. Đặt username cho bot (kết thúc bằng `bot`, ví dụ: `my_lazada_cart_monitor_bot`).
5. `BotFather` sẽ cấp cho bạn một **HTTP API Token** (dạng `123456789:ABCdefGh...`).

### Bước 2: Kích hoạt Bot & Lấy Chat ID
1. Tìm tên bot bạn vừa tạo trên Telegram và bấm **Start** (gửi `/start`).
2. Mở bot **`@userinfobot`** trên Telegram và bấm **Start**. Bot sẽ trả về **Id** của bạn (dãy số gồm 9 - 10 chữ số, ví dụ: `987654321`). Đây chính là `Chat ID`.

### Bước 3: Cấu hình trên Web Dashboard
1. Trên giao diện `http://localhost:3000`, gạt bật công tắc **📱 Thông báo Android qua Telegram Bot**.
2. Nhập **Bot Token** và **Chat ID**.
3. Bấm **📲 GỬI THÔNG BÁO THỬ**:
   - Nếu đúng cấu hình, thông báo thử nghiệm sẽ rung chuông ngay lập tức trên điện thoại Android của bạn!
4. Bấm **💾 LƯU CẤU HÌNH** để hoàn tất.

---

## 5. Quy Trình Vận Hành & Sử Dụng Bảng Điều Khiển

- **Ngưỡng giá**: Mặc định là `550.000` VNĐ. Bạn có thể sửa thành bất kỳ số nào bạn muốn.
- **Khoảng thời gian quét**: Mặc định `60` giây. Sau khi quét hết mọi sản phẩm và tải lại trang, hệ thống sẽ chờ đủ 60 giây trước khi quét chu kỳ tiếp theo.
- **Nút "KIỂM TRA ÂM THANH"**: Bấm để nghe thử chuông cảnh báo Web Audio API của trình duyệt.
- **Nút "DỪNG THÔNG BÁO (TẮT CÒI)"**:
  - Khi có sản phẩm giá thấp hơn 550.000 VNĐ, còi báo động sẽ kêu liên tục trong 30 giây kèm bộ đếm ngược.
  - Bấm nút này sẽ lập tức tắt âm thanh ngay mà **không làm dừng tiến trình giám sát giá**.
- **Nút "DỪNG GIÁM SÁT"**: Dừng hoàn toàn vòng lặp quét và hủy các timer tải lại trang tiếp theo.
- **Lịch sử quét**:
  - Tự động hiển thị các chu kỳ quét mới nhất lên đầu.
  - Phân loại rõ: `ALERT` (Đỏ), `NORMAL` (Xanh lá), `UNKNOWN` (Tím), `ERROR` (Cam).
  - Có các nút **📥 Xuất CSV**, **📥 Xuất JSON** và **🗑️ Xóa nhật ký**.
  - Dữ liệu được lưu trong file `data/history.json`, không bị mất khi reload web hay khởi động lại app.

---

## 6. Giải Thích Các Giới Hạn Thực Tế Của Lazada & Giải Pháp

1. **Cơ chế giá động & Hydration**:
   - Lazada nạp trang bằng Single Page Application (SPA / React), giá đôi khi hiển thị sau một vài giây.
   - *Giải pháp*: Module tự động chờ trang nạp xong DOM và hydrate đầy đủ giá thực tế (`.current-price`), không lấy giá gạch ngang (`.origin-price`). Nếu không nhận diện được sẽ ghi nhận trạng thái `UNKNOWN`, tuyệt đối không suy đoán giá.
2. **Xác minh người dùng (Slider CAPTCHA)**:
   - Nếu gửi quá nhiều request trong thời gian ngắn hoặc IP lạ, Lazada có thể yêu cầu kéo thanh trượt xác minh.
   - *Giải pháp*: Ứng dụng chạy Chromium có giao diện đồ họa (`headless: false`) để bạn có thể nhìn thấy và kéo xác minh một lần dễ dàng; đồng thời áp dụng khoảng chờ mặc định 60 giây và thuật toán giãn nở thời gian (Exponential Backoff) khi gặp lỗi mạng để đảm bảo tính an toàn.
3. **Tuyệt đối không can thiệp mua hàng**:
   - Công cụ chỉ thực hiện các thao tác đọc DOM (`page.evaluate`) ở chế độ chỉ đọc (Read-only), không click vào các nút "Mua hàng", "Thanh toán" hoặc thay đổi số lượng sản phẩm.
