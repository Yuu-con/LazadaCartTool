const assert = require('assert');
const { trimLogs } = require('../src/logger');

console.log('--- BẮT ĐẦU BỘ KIỂM THỬ TỰ ĐỘNG DỌN DẸP / XÓA BỚT LOG ---');

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

// 1. Kiểm tra giới hạn số lượng log tối đa (maxEntries)
test('Tự động cắt tỉa khi vượt quá maxEntries (ví dụ: 10 bản ghi, tối đa 5)', () => {
  const dummyLogs = Array.from({ length: 10 }, (_, i) => ({
    id: `log_${i}`,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    status: 'NORMAL'
  }));

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { maxEntries: 5, logRetentionDays: 3 });
  assert.strictEqual(trimmedLogs.length, 5, 'Số lượng log sau khi cắt phải bằng maxEntries');
  assert.strictEqual(removedCount, 5, 'Phải xóa bớt đúng 5 log cũ nhất');
  assert.strictEqual(trimmedLogs[0].id, 'log_0', 'Log mới nhất phải được giữ lại');
});

// 2. Kiểm tra ưu tiên giữ lại ALERT và xóa bớt NORMAL
test('Ưu tiên giữ lại các log ALERT (giá giảm) và xóa bớt NORMAL cũ khi đầy', () => {
  const dummyLogs = [
    { id: 'normal_new', timestamp: new Date(Date.now() - 1000).toISOString(), status: 'NORMAL' },
    { id: 'alert_1', timestamp: new Date(Date.now() - 2000).toISOString(), status: 'ALERT' },
    { id: 'normal_mid', timestamp: new Date(Date.now() - 3000).toISOString(), status: 'NORMAL' },
    { id: 'alert_2', timestamp: new Date(Date.now() - 4000).toISOString(), status: 'ALERT' },
    { id: 'normal_old', timestamp: new Date(Date.now() - 5000).toISOString(), status: 'NORMAL' }
  ];

  // Giới hạn maxEntries = 3, tự động dọn NORMAL cũ
  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { maxEntries: 3, autoCleanNormalLogs: true });
  assert.strictEqual(trimmedLogs.length, 3);
  assert.strictEqual(removedCount, 2);

  // Đảm bảo 2 alert vẫn được giữ lại nguyên vẹn
  const keptAlertIds = trimmedLogs.filter(l => l.status === 'ALERT').map(l => l.id);
  assert.deepStrictEqual(keptAlertIds, ['alert_1', 'alert_2']);

  // Chỉ giữ lại 1 normal mới nhất ('normal_new')
  assert.strictEqual(trimmedLogs.some(l => l.id === 'normal_new'), true);
  assert.strictEqual(trimmedLogs.some(l => l.id === 'normal_old'), false);
});

// 3. Kiểm tra tự động xóa log hết hạn theo số ngày (logRetentionDays)
test('Tự động xóa log cũ hơn số ngày lưu trữ (logRetentionDays)', () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

  const dummyLogs = [
    { id: 'recent_log', timestamp: oneDayAgo, status: 'NORMAL' },
    { id: 'expired_log', timestamp: fourDaysAgo, status: 'NORMAL' }
  ];

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { maxEntries: 100, logRetentionDays: 3 });
  assert.strictEqual(trimmedLogs.length, 1);
  assert.strictEqual(removedCount, 1);
  assert.strictEqual(trimmedLogs[0].id, 'recent_log');
});

// 4. Kiểm tra khi số lượng log ít hơn ngưỡng -> không xóa nhầm
test('Không xóa gì nếu số lượng log chưa vượt quá maxEntries và chưa hết hạn', () => {
  const dummyLogs = [
    { id: 'log_1', timestamp: new Date().toISOString(), status: 'NORMAL' },
    { id: 'log_2', timestamp: new Date().toISOString(), status: 'ALERT' }
  ];

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { maxEntries: 10, logRetentionDays: 3 });
  assert.strictEqual(trimmedLogs.length, 2);
  assert.strictEqual(removedCount, 0);
});

// 5. Kiểm tra tự động xóa tất cả log không khớp với ngưỡng giá (NORMAL / UNKNOWN) khi bật onlyAlerts
test('Tự động xóa tất cả log không khớp với ngưỡng giá (NORMAL / UNKNOWN) khi bật onlyAlerts', () => {
  const dummyLogs = [
    { id: 'normal_1', timestamp: new Date().toISOString(), status: 'NORMAL' },
    { id: 'alert_1', timestamp: new Date().toISOString(), status: 'ALERT' },
    { id: 'normal_2', timestamp: new Date().toISOString(), status: 'NORMAL' },
    { id: 'unknown_1', timestamp: new Date().toISOString(), status: 'UNKNOWN' },
    { id: 'alert_2', timestamp: new Date().toISOString(), status: 'ALERT' }
  ];

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { onlyAlerts: true });
  assert.strictEqual(trimmedLogs.length, 2, 'Chỉ được giữ lại 2 log ALERT khớp ngưỡng');
  assert.strictEqual(removedCount, 3, 'Phải xóa bỏ đúng 3 log không khớp ngưỡng');
  assert.deepStrictEqual(trimmedLogs.map(l => l.id), ['alert_1', 'alert_2']);
});

// 6. Kiểm tra giữ lại SUCCESS (Tổng kết chu kỳ), ALERT và ERROR khi bật onlyAlerts, loại bỏ NORMAL/UNKNOWN
test('Giữ lại các log SUCCESS, ALERT và ERROR, đồng thời xóa các log NORMAL/UNKNOWN khi bật onlyAlerts', () => {
  const dummyLogs = [
    { id: 'success_cycle_1', timestamp: new Date().toISOString(), status: 'SUCCESS' },
    { id: 'normal_item', timestamp: new Date().toISOString(), status: 'NORMAL' },
    { id: 'alert_item', timestamp: new Date().toISOString(), status: 'ALERT' },
    { id: 'unknown_item', timestamp: new Date().toISOString(), status: 'UNKNOWN' },
    { id: 'error_cycle_2', timestamp: new Date().toISOString(), status: 'ERROR' }
  ];

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { onlyAlerts: true });
  assert.strictEqual(trimmedLogs.length, 3, 'Phải giữ lại 3 log: SUCCESS, ALERT và ERROR');
  assert.strictEqual(removedCount, 2, 'Phải xóa bỏ 2 log NORMAL và UNKNOWN');
  assert.deepStrictEqual(trimmedLogs.map(l => l.id), ['success_cycle_1', 'alert_item', 'error_cycle_2']);
});

// 7. Kiểm tra giữ lại ORDER_PLACED (Đã đặt hàng) và ưu tiên như ALERT
test('Giữ lại các log ORDER_PLACED khi bật onlyAlerts và ưu tiên khi đầy bộ nhớ', () => {
  const dummyLogs = [
    { id: 'order_1', timestamp: new Date(Date.now() - 1000).toISOString(), status: 'ORDER_PLACED' },
    { id: 'normal_item', timestamp: new Date(Date.now() - 2000).toISOString(), status: 'NORMAL' },
    { id: 'alert_1', timestamp: new Date(Date.now() - 3000).toISOString(), status: 'ALERT' }
  ];

  const { trimmedLogs, removedCount } = trimLogs(dummyLogs, { onlyAlerts: true });
  assert.strictEqual(trimmedLogs.length, 2);
  assert.strictEqual(removedCount, 1);
  assert.deepStrictEqual(trimmedLogs.map(l => l.id), ['order_1', 'alert_1']);
});

console.log('----------------------------------------------------');
console.log(`KẾT QUẢ KIỂM THỬ: ${passCount} Passed, ${failCount} Failed.`);

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('🎉 TẤT CẢ KIỂM THỬ DỌN DẸP LOG ĐÃ ĐẠT CHUẨN!');
}
