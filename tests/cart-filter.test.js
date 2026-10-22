const assert = require('assert');

console.log('--- BẮT ĐẦU BỘ KIỂM THỬ LỌC GIỎ HÀNG VÀ CHỐNG QUÉT SẢN PHẨM NGOÀI GIỎ ---');

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

// Giả lập logic lọc phần tử giỏ hàng như trong monitor.js
function filterCartNode({ className = '', parentClasses = [], text = '', hasCheckbox = true, isCheckboxDisabled = false }) {
  if (className.includes('checkout-shop') || className.includes('list-header') || className.includes('cart-item-list')) {
    return false;
  }

  // 1. Vùng gợi ý / recommendation
  const isInRecommendation = parentClasses.some(cls => 
    cls.includes('recommend') || cls.includes('just-for-you') || cls.includes('similar')
  );
  if (isInRecommendation) return false;

  // 2. Vô hiệu hóa / hết hàng / xóa
  if (className.includes('cart-item-disabled') || className.includes('item-del')) return false;
  const isParentDisabled = parentClasses.some(cls => 
    cls.includes('cart-item-list-disabled') || cls.includes('disabled-items') || cls.includes('unavailable') || cls.includes('disabled-item')
  );
  if (isParentDisabled) return false;

  const lowerText = text.toLowerCase();
  if (lowerText.includes('sản phẩm này tạm thời hết hàng') ||
      lowerText.includes('hết hàng') ||
      lowerText.includes('hàng không có sẵn') ||
      lowerText.includes('đã xóa')) {
    return false;
  }

  // 3. Phải có checkbox hợp lệ
  if (!hasCheckbox || isCheckboxDisabled) return false;

  return true;
}

test('Sản phẩm hợp lệ trong giỏ hàng: Giữ lại', () => {
  const result = filterCartNode({
    className: 'cart-item',
    parentClasses: ['cart-item-list'],
    text: 'Bàn phím cơ AULA F87 Pro 450.000 đ',
    hasCheckbox: true,
    isCheckboxDisabled: false
  });
  assert.strictEqual(result, true);
});

test('Sản phẩm trong khối Gợi ý ("recommend-list" / "just-for-you"): Loại bỏ, không quét', () => {
  const result = filterCartNode({
    className: 'cart-item',
    parentClasses: ['recommend-list', 'just-for-you-container'],
    text: 'Tai nghe Bluetooth 150.000 đ',
    hasCheckbox: true,
    isCheckboxDisabled: false
  });
  assert.strictEqual(result, false);
});

test('Sản phẩm đã bị xóa hoặc hết hàng ("cart-item-disabled" / "item-del"): Loại bỏ', () => {
  const res1 = filterCartNode({
    className: 'cart-item cart-item-disabled',
    text: 'Chuột không dây',
    hasCheckbox: true
  });
  assert.strictEqual(res1, false);

  const res2 = filterCartNode({
    className: 'cart-item item-del',
    text: 'Chuột Gaming',
    hasCheckbox: true
  });
  assert.strictEqual(res2, false);
});

test('Sản phẩm có nhãn chữ "hết hàng" hoặc "hàng không có sẵn": Loại bỏ', () => {
  const result = filterCartNode({
    className: 'cart-item',
    text: 'Sản phẩm này tạm thời hết hàng - Chọn sản phẩm khác',
    hasCheckbox: true
  });
  assert.strictEqual(result, false);
});

test('Sản phẩm không có ô checkbox để chọn mua: Loại bỏ', () => {
  const result = filterCartNode({
    className: 'cart-item',
    text: 'Sản phẩm hết quà tặng kèm',
    hasCheckbox: false
  });
  assert.strictEqual(result, false);
});

test('Sản phẩm có ô checkbox bị vô hiệu hóa (disabled): Loại bỏ', () => {
  const result = filterCartNode({
    className: 'cart-item',
    text: 'Sản phẩm không hỗ trợ giao hàng',
    hasCheckbox: true,
    isCheckboxDisabled: true
  });
  assert.strictEqual(result, false);
});

console.log('----------------------------------------------------');
console.log(`KẾT QUẢ KIỂM THỬ LỌC GIỎ HÀNG: ${passCount} Passed, ${failCount} Failed.`);
if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 TẤT CẢ KIỂM THỬ LỌC GIỎ HÀNG ĐÃ ĐẠT CHUẨN!');
}
