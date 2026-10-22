const assert = require('assert');
const { parseVNDPrice, evaluatePriceStatus } = require('../src/price-parser');

console.log('--- BẮT ĐẦU BỘ KIỂM THỬ GIÁ VÀ LOGIC CẢNH BÁO ---');

let passCount = 0;
let failCount = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${description}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${description}`);
    console.error(`   Lỗi: ${err.message}`);
    failCount++;
  }
}

// 1. Kiểm tra bộ bóc tách giá (Price Parser)
test('Parse: "549.999 ₫" -> 549999', () => {
  assert.strictEqual(parseVNDPrice('549.999 ₫'), 549999);
});

test('Parse: "₫ 550,000" -> 550000', () => {
  assert.strictEqual(parseVNDPrice('₫ 550,000'), 550000);
});

test('Parse: "600.000 VNĐ" -> 600000', () => {
  assert.strictEqual(parseVNDPrice('600.000 VNĐ'), 600000);
});

test('Parse: Chuỗi rỗng hoặc rác -> null (UNKNOWN)', () => {
  assert.strictEqual(parseVNDPrice(''), null);
  assert.strictEqual(parseVNDPrice(null), null);
  assert.strictEqual(parseVNDPrice('Liên hệ để biết giá'), null);
});

// Kiểm tra ưu tiên giá đã giảm theo yêu cầu người dùng
test('Parse: "1.043.000 Giá đã giảm" -> 1043000 (Lấy giá đã giảm)', () => {
  assert.strictEqual(parseVNDPrice('1.043.000 Giá đã giảm'), 1043000);
});

test('Parse: "1.940.000\\n1.043.000 Giá đã giảm" -> 1043000 (Lấy giá đã giảm thay vì giá gốc)', () => {
  assert.strictEqual(parseVNDPrice('1.940.000\n1.043.000 Giá đã giảm'), 1043000);
});

test('Parse: "1.940.000 1.043.000" -> 1043000 (2 mức giá thì chọn giá thấp hơn)', () => {
  assert.strictEqual(parseVNDPrice('1.940.000 1.043.000'), 1043000);
});

test('Parse: "619.200 Giá đã giảm" -> 619200', () => {
  assert.strictEqual(parseVNDPrice('619.200 Giá đã giảm'), 619200);
});

test('Parse: "2.955.000" -> 2955000 (Không có giảm thì giữ nguyên giá)', () => {
  assert.strictEqual(parseVNDPrice('2.955.000'), 2955000);
});

test('Parse: "Giảm 404.200 đ\\n1.849.000 đ" -> 1849000 (Loại bỏ số tiền voucher, lấy đúng đơn giá)', () => {
  assert.strictEqual(parseVNDPrice('Giảm 404.200 đ\n1.849.000 đ'), 1849000);
});

test('Parse: "Voucher -404.200 ₫ 2.499.000 ₫" -> 2499000 (Loại bỏ voucher âm)', () => {
  assert.strictEqual(parseVNDPrice('Voucher -404.200 ₫ 2.499.000 ₫'), 2499000);
});

// 2. Nghiệm thu Case 1: Giá 600.000 VNĐ -> Không cảnh báo (NORMAL)
test('Nghiệm thu 1: Giá 600.000 VNĐ với ngưỡng 550.000 -> NORMAL, không cảnh báo', () => {
  const res = evaluatePriceStatus(600000, 550000);
  assert.strictEqual(res.status, 'NORMAL');
  assert.strictEqual(res.isNewAlert, false);
});

// 3. Nghiệm thu Case 2: Giá 550.000 VNĐ -> Không cảnh báo (NORMAL vì điều kiện < ngưỡng)
test('Nghiệm thu 2: Giá 550.000 VNĐ với ngưỡng 550.000 -> NORMAL, không cảnh báo', () => {
  const res = evaluatePriceStatus(550000, 550000);
  assert.strictEqual(res.status, 'NORMAL');
  assert.strictEqual(res.isNewAlert, false);
});

// 4. Nghiệm thu Case 3: Giá 549.999 VNĐ -> Phát cảnh báo (ALERT, isNewAlert = true)
test('Nghiệm thu 3: Giá 549.999 VNĐ với ngưỡng 550.000 -> ALERT, phát cảnh báo mới', () => {
  const res = evaluatePriceStatus(549999, 550000);
  assert.strictEqual(res.status, 'ALERT');
  assert.strictEqual(res.isNewAlert, true);
});

// 5. Nghiệm thu Case 9: Giá không đọc được -> Ghi UNKNOWN, không cảnh báo
test('Nghiệm thu 9: Giá UNKNOWN (null) -> status UNKNOWN, không phát cảnh báo', () => {
  const res = evaluatePriceStatus(null, 550000);
  assert.strictEqual(res.status, 'UNKNOWN');
  assert.strictEqual(res.isNewAlert, false);
});

// 6. Nghiệm thu Chống Cảnh Báo Trùng (Bổ sung F3)
test('Chống trùng: Sản phẩm vẫn 549.999 VNĐ ở chu kỳ sau -> ALERT nhưng isNewAlert = false (không hú còi lại)', () => {
  const lastPrice = 549999;
  const currentPrice = 549999;
  const res = evaluatePriceStatus(currentPrice, 550000, lastPrice, false);
  assert.strictEqual(res.status, 'ALERT');
  assert.strictEqual(res.isNewAlert, false, 'Không được kích hoạt cảnh báo mới khi giá không đổi');
});

test('Chống trùng: Giá giảm sâu hơn nữa từ 549.999 -> 500.000 -> isNewAlert = true', () => {
  const lastPrice = 549999;
  const currentPrice = 500000;
  const res = evaluatePriceStatus(currentPrice, 550000, lastPrice, false);
  assert.strictEqual(res.status, 'ALERT');
  assert.strictEqual(res.isNewAlert, true, 'Giá giảm sâu hơn phải kích hoạt cảnh báo mới');
});

test('Chống trùng: Giá từ 600.000 giảm xuống 520.000 -> isNewAlert = true', () => {
  const lastPrice = 600000;
  const currentPrice = 520000;
  const res = evaluatePriceStatus(currentPrice, 550000, lastPrice, false);
  assert.strictEqual(res.status, 'ALERT');
  assert.strictEqual(res.isNewAlert, true);
});

console.log('----------------------------------------------------');
console.log(`KẾT QUẢ KIỂM THỬ: ${passCount} Passed, ${failCount} Failed.`);

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 TẤT CẢ CÁC TRƯỜNG HỢP KIỂM THỬ ĐÃ ĐẠT CHUẨN!');
}
