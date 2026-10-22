/**
 * Trình phân tích chuỗi giá tiền tệ Việt Nam thành số nguyên (VND)
 * Xử lý: "549.999 ₫", "₫ 549,999", "549.000đ", "1.200.000", "550000"
 */
function parseVNDPrice(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  // Cắt tỉa và chuẩn hóa
  const clean = rawText.trim();
  if (!clean) return null;

  // 1. Ưu tiên cao nhất: Nếu chuỗi chứa "Giá đã giảm" / "đã giảm", trích xuất số giá gắn liền với cụm từ này
  const discountMatch = clean.match(/([\d.,]{3,})\s*(?:₫\s*)?(?:\n|\r|\s)*(?:Giá\s+)?đã\s*giảm/i)
                     || clean.match(/(?:Giá\s+)?đã\s*giảm\s*(?:₫\s*)?(?:\n|\r|\s)*([\d.,]{3,})/i);
  if (discountMatch && discountMatch[1]) {
    const digits = discountMatch[1].replace(/[^0-9]/g, '');
    const num = parseInt(digits, 10);
    if (!isNaN(num) && num > 0) {
      return num;
    }
  }

  // 1.1. Loại bỏ các giá trị thuộc nhãn voucher / mã giảm giá (ví dụ: "Giảm 404.200 đ", "Voucher -404.200", "Tiết kiệm 50.000")
  // Không được nhầm số tiền giảm voucher với đơn giá sản phẩm.
  const textWithoutVouchers = clean.replace(/(?:voucher|giảm\s*(?!đã)|mã\s*giảm|tiết\s*kiệm|-)\s*(?:₫\s*)?[\d.,]{3,}\s*(?:₫|đ|vnđ)?/gi, ' ');

  // 2. Nếu chuỗi chứa nhiều số giá (ví dụ cả giá gốc và giá đã giảm như "1.940.000 \n 1.043.000"):
  // Người dùng yêu cầu: lấy giá đã giảm chứ đừng lấy giá gốc -> Lấy giá THẤP HƠN!
  const targetTextForMultiple = textWithoutVouchers.trim() ? textWithoutVouchers : clean;
  const allNumberMatches = targetTextForMultiple.match(/[\d.,]{3,}/g);
  if (allNumberMatches && allNumberMatches.length > 1) {
    const candidates = allNumberMatches
      .map(str => parseInt(str.replace(/[^0-9]/g, ''), 10))
      .filter(num => !isNaN(num) && num >= 1000);
    if (candidates.length > 0) {
      return Math.min(...candidates);
    }
  }

  // 3. Chuẩn hóa chuỗi giá đơn thông thường
  // Loại bỏ các ký hiệu tiền tệ và chữ cái thừa
  // "₫", "đ", "VND", "vnđ", v.v.
  const withoutCurrency = targetTextForMultiple
    .replace(/[₫đĐ]/gi, '')
    .replace(/\bvnd\b/gi, '')
    .trim();

  // Loại bỏ dấu chấm, dấu phẩy phân cách phần nghìn
  const digitsOnly = withoutCurrency.replace(/[^0-9]/g, '');

  if (!digitsOnly) {
    return null;
  }

  const parsed = parseInt(digitsOnly, 10);
  if (isNaN(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Đánh giá kết quả kiểm tra giá so với ngưỡng
 * @param {number|null} price - Giá hiện tại của sản phẩm
 * @param {number} threshold - Ngưỡng cảnh báo (mặc định 550000)
 * @param {number|null} lastPrice - Giá ghi nhận ở chu kỳ trước của sản phẩm
 * @param {boolean} repeatAlertOnSameLowPrice - Có cảnh báo lại nếu giá vẫn thấp
 * @returns {{
 *   status: 'NORMAL'|'ALERT'|'UNKNOWN'|'ERROR',
 *   isNewAlert: boolean,
 *   reason: string
 * }}
 */
function evaluatePriceStatus(price, threshold, lastPrice = null, repeatAlertOnSameLowPrice = false) {
  if (price === null || price === undefined || isNaN(price)) {
    return {
      status: 'UNKNOWN',
      isNewAlert: false,
      reason: 'Không thể nhận diện giá chính xác từ phần tử giao diện'
    };
  }

  // Điều kiện kích hoạt cảnh báo: Giá THẤP HƠN ngưỡng (price < threshold)
  // Tiêu chí:
  // 600.000 >= 550.000 -> NORMAL
  // 550.000 >= 550.000 -> NORMAL (không cảnh báo vì điều kiện là nhỏ hơn ngưỡng)
  // 549.999 < 550.000 -> ALERT
  if (price < threshold) {
    // Cơ chế chống cảnh báo trùng:
    // Chỉ tạo cảnh báo mới khi:
    // 1. Sản phẩm lần đầu được xác định có giá thấp hơn ngưỡng (lastPrice == null hoặc lastPrice >= threshold);
    // 2. Hoặc giá giảm sâu hơn nữa;
    // 3. Hoặc người dùng bật tùy chọn repeatAlertOnSameLowPrice.
    let isNewAlert = false;
    if (lastPrice === null || lastPrice === undefined) {
      isNewAlert = true; // Lần đầu quét thấy giá dưới ngưỡng
    } else if (lastPrice >= threshold) {
      isNewAlert = true; // Vừa giảm từ trên ngưỡng xuống dưới ngưỡng
    } else if (price < lastPrice) {
      isNewAlert = true; // Giá tiếp tục giảm sâu hơn chu kỳ trước
    } else if (repeatAlertOnSameLowPrice) {
      isNewAlert = true; // Người dùng cho phép lặp lại
    }

    return {
      status: 'ALERT',
      isNewAlert: isNewAlert,
      reason: `Giá ${price.toLocaleString('vi-VN')} ₫ thấp hơn ngưỡng ${threshold.toLocaleString('vi-VN')} ₫`
    };
  }

  return {
    status: 'NORMAL',
    isNewAlert: false,
    reason: `Giá ${price.toLocaleString('vi-VN')} ₫ đạt hoặc cao hơn ngưỡng ${threshold.toLocaleString('vi-VN')} ₫`
  };
}

module.exports = {
  parseVNDPrice,
  evaluatePriceStatus
};
