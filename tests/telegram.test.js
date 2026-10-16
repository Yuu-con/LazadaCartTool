const assert = require('assert');
const { parseChatIds } = require('../src/telegram');

console.log('--- BẮT ĐẦU BỘ KIỂM THỬ TELEGRAM MULTI-CHAT ID ---');

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

// 1. Phân tích 1 Chat ID đơn
test('parseChatIds: Chuỗi đơn "123456789" -> ["123456789"]', () => {
  const res = parseChatIds('123456789');
  assert.deepStrictEqual(res, ['123456789']);
});

// 2. Phân tích nhiều Chat ID cách nhau bằng dấu phẩy
test('parseChatIds: Cách nhau bằng dấu phẩy "123456, 789012, 112233" -> 3 ID', () => {
  const res = parseChatIds('123456, 789012, 112233');
  assert.deepStrictEqual(res, ['123456', '789012', '112233']);
});

// 3. Phân tích cách nhau bằng dấu chấm phẩy, khoảng trắng, xuống dòng
test('parseChatIds: Cách nhau bằng dấu chấm phẩy và xuống dòng "123; 456\n-100789"', () => {
  const res = parseChatIds('123; 456\n-100789');
  assert.deepStrictEqual(res, ['123', '456', '-100789']);
});

// 4. Phân tích mảng có sẵn
test('parseChatIds: Mảng [123, "456"] -> ["123", "456"]', () => {
  const res = parseChatIds([123, '456']);
  assert.deepStrictEqual(res, ['123', '456']);
});

// 5. Chuỗi rỗng hoặc null -> []
test('parseChatIds: Chuỗi rỗng hoặc rác -> []', () => {
  assert.deepStrictEqual(parseChatIds(''), []);
  assert.deepStrictEqual(parseChatIds(null), []);
  assert.deepStrictEqual(parseChatIds('   ,  ;  '), []);
});

// 6. Định dạng tin nhắn tự động đặt hàng thành công
const { formatOrderSuccessMessage } = require('../src/telegram');
test('formatOrderSuccessMessage: Tạo tin nhắn đặt hàng thành công đầy đủ thông tin', () => {
  const msg = formatOrderSuccessMessage({
    productName: 'Bàn phím cơ AULA',
    currentPrice: 637700,
    productUrl: 'https://lazada.vn/item.html'
  }, 1000000);

  assert(msg.includes('TỰ ĐỘNG ĐẶT HÀNG THÀNH CÔNG'));
  assert(msg.includes('Bàn phím cơ AULA'));
  assert(msg.includes('637.700 VNĐ'));
  assert(msg.includes('1.000.000 VNĐ'));
  assert(msg.includes('https://lazada.vn/item.html'));
});

console.log('----------------------------------------------------');
console.log(`KẾT QUẢ KIỂM THỬ TELEGRAM: ${passCount} Passed, ${failCount} Failed.`);

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 TẤT CẢ KIỂM THỬ MULTI-CHAT ID ĐÃ ĐẠT CHUẨN!');
}
